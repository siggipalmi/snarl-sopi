// skraning.agvending.is — lease registration.
//
// The form is static (public/index.html). This Worker answers /api/* and runs a
// cron. A submission is written to D1 first, then walked through three steps,
// each of which is saved before the next starts, so a failure anywhere is
// retried from where it stopped instead of being lost or done twice:
//
//   received ──claim serials──▶ claimed ──build fields──▶ ready ──POST to Zap──▶ sent
//
// Zapier gets ONE webhook with every template field already computed; the Zap
// only has to copy fields into "Create Document From Template".

import {
  MACHINES, MAX_ATTEMPTS, addressLookupQuery, backoffMinutes, buildContractPayload, buildCpiQuery,
  claimShortfall, dedupeKey, firstOfNextMonth, formatKennitala, formatLongDate, isValidKennitala, isoDate,
  normalizeKennitala, parseCpiOverride, pickLatestCpi, registeredAddress, validateForm,
} from './lib.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/config' && request.method === 'GET') return handleConfig(env);
      if (url.pathname === '/api/company' && request.method === 'GET') return await handleCompany(url, env);
      if (url.pathname === '/api/address' && request.method === 'GET') return await handleAddress(url, env);
      if (url.pathname === '/api/submit' && request.method === 'POST') return await handleSubmit(request, env, ctx);
      if (url.pathname === '/api/cpi' && request.method === 'GET') return await handleCpi(env);
      if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(request, url, env, ctx);
      if (url.pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error('[skraning] unhandled', url.pathname, e && e.stack || e);
      return json({ error: 'server_error' }, 500);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(retryDue(env));
  },
};

// ─── Upstream lookups ─────────────────────────────────────────────────────────
// Service bindings when configured (no public hop), public workers.dev otherwise.
function upstream(env, binding, base, path) {
  const svc = env[binding];
  if (svc && typeof svc.fetch === 'function') return svc.fetch('https://internal' + path, { headers: { Accept: 'application/json' } });
  return fetch(base.replace(/\/$/, '') + path, { headers: { Accept: 'application/json' } });
}

async function lookupCompany(env, kennitala) {
  const res = await upstream(env, 'COMPANY', env.COMPANY_API, '/company?nationalId=' + encodeURIComponent(kennitala));
  if (!res.ok) throw new Error('company lookup ' + res.status);
  const c = await res.json();
  return c && c.companyName ? c : null;
}

async function lookupAddresses(env, q) {
  const res = await upstream(env, 'ADDRESS', env.ADDRESS_API, '/?address=' + encodeURIComponent(q));
  if (!res.ok) throw new Error('address lookup ' + res.status);
  const data = await res.json();
  return (data.results || []).map(r => ({ full: r.full, street: r.street, house: r.house, zip: r.zip, city: r.city }));
}

// ─── Public API ───────────────────────────────────────────────────────────────
function handleConfig(env) {
  const now = new Date();
  return json({
    machines: MACHINES,
    // Leases always start on the first of the coming month; shown, not chosen.
    startDate: isoDate(firstOfNextMonth(now)),
    startLabel: formatLongDate(firstOfNextMonth(now)),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
  });
}

async function handleCompany(url, env) {
  const kt = normalizeKennitala(url.searchParams.get('kt'));
  if (!isValidKennitala(kt)) return json({ error: 'invalid_kennitala' }, 400);
  let c;
  try { c = await lookupCompany(env, kt); } catch (e) {
    console.warn('[company]', e.message);
    return json({ error: 'lookup_failed' }, 502);
  }
  if (!c) return json({ error: 'not_found' }, 404);
  return json({
    companyName: c.companyName,
    registeredAddress: registeredAddress(c),
    managerName: c.managerName || '',
    managerNationalId: c.managerNationalId ? formatKennitala(c.managerNationalId) : '',
    hasManager: Boolean(c.managerName),
  });
}

async function handleAddress(url, env) {
  const q = String(url.searchParams.get('q') || '').trim();
  if (q.length < 3) return json({ results: [] });
  try { return json({ results: await lookupAddresses(env, q) }); } catch (e) {
    console.warn('[address]', e.message);
    return json({ results: [], error: 'lookup_failed' }, 502);
  }
}

async function handleCpi(env) {
  try { return json(await getCpi(env, { fresh: true, debug: true })); } catch (e) {
    return json({ error: 'cpi_failed', message: e.message }, 502);
  }
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip || '' }),
  });
  const out = await res.json().catch(() => ({}));
  return out.success === true;
}

async function handleSubmit(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }

  // Honeypot: a bot filled the hidden field. Answer like a success so it moves on.
  if (body.vefsida) return json({ ok: true, id: 'ignored' });

  if (!(await verifyTurnstile(env, body.turnstile, request.headers.get('CF-Connecting-IP')))) {
    return json({ error: 'captcha', message: 'Staðfesting mistókst. Endurhlaðið síðuna og reynið aftur.' }, 400);
  }

  const now = new Date();
  const { errors, value: form } = validateForm(body, now);

  // The browser showed these, but the contract uses what the registries say now.
  let company = null;
  if (!errors.kennitala) {
    try { company = await lookupCompany(env, form.kennitala); } catch (e) {
      return json({ error: 'upstream', message: 'Ekki tókst að sækja upplýsingar úr fyrirtækjaskrá. Reynið aftur eftir smá stund.' }, 502);
    }
    if (!company) errors.kennitala = 'Engar upplýsingar fundust fyrir þessa kennitölu í fyrirtækjaskrá.';
    else if (!company.managerName) {
      // No manager in the registry: the signer has to be named here, with a kennitala
      // that rafræn skilríki can match.
      if (!form.undirritandi.nafn) errors.undirritandi_nafn = 'Skráðu nafn þess sem undirritar.';
      if (!isValidKennitala(form.undirritandi.kennitala)) errors.undirritandi_kt = 'Kennitala er ekki gild.';
    }
  }
  if (!errors.heimilisfang) {
    let matches = [];
    try { matches = await lookupAddresses(env, addressLookupQuery(form.heimilisfang)); } catch (e) {
      return json({ error: 'upstream', message: 'Ekki tókst að staðfesta heimilisfang. Reynið aftur eftir smá stund.' }, 502);
    }
    if (!matches.some(m => m.full === form.heimilisfang)) errors.heimilisfang = 'Veldu staðsetningu úr listanum.';
  }
  if (Object.keys(errors).length) return json({ error: 'validation', errors }, 400);

  // A double click, a back-and-resubmit or a retrying browser lands here.
  const key = dedupeKey(form);
  const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  const dup = await env.DB.prepare('SELECT id FROM submissions WHERE dedupe_key = ? AND created_at > ? LIMIT 1')
    .bind(key, since).first();
  if (dup) return json({ ok: true, id: dup.id, duplicate: true });

  const id = 'skr_' + now.toISOString().slice(0, 10).replace(/-/g, '') + '_' + crypto.randomUUID().slice(0, 8);
  // next_attempt_at is pushed out so the cron leaves this row to the request that owns it.
  await env.DB.prepare(`INSERT INTO submissions
      (id, created_at, updated_at, kennitala, dedupe_key, status, attempts, next_attempt_at, form_json, company_json)
      VALUES (?, ?, ?, ?, ?, 'received', 0, ?, ?, ?)`)
    .bind(id, now.toISOString(), now.toISOString(), form.kennitala, key,
      new Date(now.getTime() + 3 * 60000).toISOString(), JSON.stringify(form), JSON.stringify(company))
    .run();

  // Run the pipeline now, but the customer's answer does not wait on Zapier:
  // the registration is safely stored, and anything that fails is retried by the cron.
  ctx.waitUntil(processSubmission(env, id).catch(e => console.error('[pipeline]', id, e.message)));
  return json({ ok: true, id });
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────
async function loadRow(env, id) {
  return env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
}

async function processSubmission(env, id) {
  let row = await loadRow(env, id);
  if (!row || row.status === 'sent' || row.status === 'failed') return row;
  const form = JSON.parse(row.form_json);
  const company = JSON.parse(row.company_json);

  try {
    if (row.status === 'received') {
      const claim = await claimSerials(env, id, form, company);
      await env.DB.prepare(`UPDATE submissions SET status='claimed', claim_json=?, updated_at=? WHERE id=?`)
        .bind(JSON.stringify(claim), new Date().toISOString(), id).run();
      row = await loadRow(env, id);
    }
    if (row.status === 'claimed') {
      const cpi = await getCpi(env);
      const payload = buildContractPayload({
        id, form, company, claim: JSON.parse(row.claim_json), cpi, now: new Date(row.created_at),
      });
      await env.DB.prepare(`UPDATE submissions SET status='ready', payload_json=?, updated_at=? WHERE id=?`)
        .bind(JSON.stringify(payload), new Date().toISOString(), id).run();
      row = await loadRow(env, id);
    }
    if (row.status === 'ready') {
      await sendToZapier(env, JSON.parse(row.payload_json));
      const t = new Date().toISOString();
      await env.DB.prepare(`UPDATE submissions SET status='sent', sent_at=?, updated_at=?, last_error=NULL WHERE id=?`)
        .bind(t, t, id).run();
      console.log('[pipeline] sent', id);
    }
  } catch (e) {
    const attempts = (row.attempts || 0) + 1;
    const giveUp = attempts >= MAX_ATTEMPTS || e.noRetry === true;
    const next = new Date(Date.now() + backoffMinutes(attempts) * 60000).toISOString();
    console.error('[pipeline]', id, 'step', row.status, 'attempt', attempts, e.message);
    await env.DB.prepare(`UPDATE submissions SET attempts=?, last_error=?, next_attempt_at=?, updated_at=?,
        status = CASE WHEN ? THEN 'failed' ELSE status END WHERE id=?`)
      .bind(attempts, `[${row.status}] ${e.message}`.slice(0, 1000), next, new Date().toISOString(), giveUp ? 1 : 0, id)
      .run();
  }
  return loadRow(env, id);
}

async function claimSerials(env, id, form, company) {
  if (!env.LEASE_CLAIM_SECRET) throw new Error('LEASE_CLAIM_SECRET is not set');
  const res = await fetch(env.BACKEND_URL.replace(/\/$/, '') + '/api/v1/leases/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lease-Key': env.LEASE_CLAIM_SECRET },
    body: JSON.stringify({
      requestId: id,                          // makes a retried claim return the same units
      allOrNothing: true,                     // backend ≥ 6.32.5: a short claim takes nothing
      einfaldur: form.counts.einfaldur,
      tvofaldur: form.counts.tvofaldur,
      skjar: form.counts.skjar,
      assignedTo: company.companyName,
      kennitala: form.kennitala,
    }),
  });
  const text = await res.text();
  // 409: not enough machines in stock. Nothing was claimed, so retrying later is safe
  // and succeeds once stock is added or freed.
  if (!res.ok) throw new Error(`lease claim ${res.status}: ${text.slice(0, 300)}`);
  const out = JSON.parse(text);
  const data = out && out.data !== undefined ? out.data : out;   // tolerate an {ok,data} envelope
  if (!data || data.radnumer_sjalfsala === undefined) throw new Error('lease claim: unexpected response ' + text.slice(0, 200));
  // An older backend claims what it can and reports the rest as a warning. Never send a
  // contract without serials, and do not retry: a retry would claim more machines.
  const short = claimShortfall(form.counts, data);
  if (short.length) {
    const e = new Error('Ekki nægar vélar á lager (' + short.join('; ') + '). Losið vélar sem voru teknar og reynið aftur.');
    e.noRetry = true;
    throw e;
  }
  return data;
}

async function sendToZapier(env, payload) {
  if (!env.ZAPIER_HOOK_URL) throw new Error('ZAPIER_HOOK_URL is not set');
  const res = await fetch(env.ZAPIER_HOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`zapier ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function retryDue(env) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(`SELECT id FROM submissions
      WHERE status IN ('received','claimed','ready') AND next_attempt_at <= ? ORDER BY created_at LIMIT 20`)
    .bind(now).all();
  for (const r of results || []) {
    // Take a short lease on the row; if another run took it first, skip it.
    const lease = new Date(Date.now() + 3 * 60000).toISOString();
    const taken = await env.DB.prepare('UPDATE submissions SET next_attempt_at=? WHERE id=? AND next_attempt_at <= ?')
      .bind(lease, r.id, now).run();
    if (taken.meta && taken.meta.changes === 1) await processSubmission(env, r.id);
  }
}

// ─── Consumer price index ─────────────────────────────────────────────────────
async function getCpi(env, { fresh = false, debug = false } = {}) {
  const override = parseCpiOverride(env.CPI_OVERRIDE);
  if (override) return { ...override, source: 'CPI_OVERRIDE' };

  if (!fresh) {
    const cached = await env.DB.prepare("SELECT value, fetched_at FROM kv WHERE k = 'cpi'").first();
    if (cached && Date.now() - Date.parse(cached.fetched_at) < 6 * 3600 * 1000) return JSON.parse(cached.value);
  }

  const tableUrl = 'https://px.hagstofa.is/pxis/api/v1/is/' + env.CPI_TABLE;
  const metaRes = await fetch(tableUrl, { headers: { Accept: 'application/json' } });
  if (!metaRes.ok) throw new Error('Hagstofa metadata ' + metaRes.status);
  const meta = await metaRes.json();
  const { query, picks, timeCode } = buildCpiQuery(meta);
  const dataRes = await fetch(tableUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(query),
  });
  if (!dataRes.ok) throw new Error('Hagstofa data ' + dataRes.status);
  const cpi = { ...pickLatestCpi(await dataRes.json(), timeCode), source: 'hagstofa:' + env.CPI_TABLE };

  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, value, fetched_at) VALUES ('cpi', ?, ?)")
    .bind(JSON.stringify(cpi), new Date().toISOString()).run();
  return debug ? { ...cpi, table: meta.title, picks } : cpi;
}

// ─── Admin (Authorization: Bearer ADMIN_TOKEN) ────────────────────────────────
async function handleAdmin(request, url, env, ctx) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.ADMIN_TOKEN || auth !== 'Bearer ' + env.ADMIN_TOKEN) return json({ error: 'unauthorized' }, 401);

  // GET /api/admin/submissions?status=failed — newest first
  if (url.pathname === '/api/admin/submissions' && request.method === 'GET') {
    const status = url.searchParams.get('status');
    const stmt = status
      ? env.DB.prepare('SELECT id, created_at, status, attempts, last_error, sent_at, kennitala FROM submissions WHERE status = ? ORDER BY created_at DESC LIMIT 100').bind(status)
      : env.DB.prepare('SELECT id, created_at, status, attempts, last_error, sent_at, kennitala FROM submissions ORDER BY created_at DESC LIMIT 100');
    return json({ submissions: (await stmt.all()).results });
  }

  // GET /api/admin/submissions/:id — the full row, including the payload Zapier got
  const one = url.pathname.match(/^\/api\/admin\/submissions\/([\w-]+)$/);
  if (one && request.method === 'GET') {
    const row = await loadRow(env, one[1]);
    return row ? json(row) : json({ error: 'not_found' }, 404);
  }

  // POST /api/admin/submissions/:id/retry — re-run from the step it stopped at.
  // A 'failed' row goes back to the step it failed on; 'sent' is resent to Zapier.
  const retry = url.pathname.match(/^\/api\/admin\/submissions\/([\w-]+)\/retry$/);
  if (retry && request.method === 'POST') {
    const row = await loadRow(env, retry[1]);
    if (!row) return json({ error: 'not_found' }, 404);
    const step = row.payload_json ? 'ready' : row.claim_json ? 'claimed' : 'received';
    await env.DB.prepare(`UPDATE submissions SET status=?, attempts=0, next_attempt_at=?, updated_at=? WHERE id=?`)
      .bind(step, new Date(Date.now() + 3 * 60000).toISOString(), new Date().toISOString(), row.id).run();
    return json(await processSubmission(env, row.id));
  }

  return json({ error: 'not_found' }, 404);
}
