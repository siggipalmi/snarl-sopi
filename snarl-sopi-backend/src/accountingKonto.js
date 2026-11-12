/**
 * Konto as an operator's accounting system (Konto Agent API, docs.konto.is, read 2026-11-12).
 *
 * Konto has no journal entries in its agent API, so a day's sales go in as ONE INVOICE to the
 * operator's cash customer ("Sjálfsalar – staðgreiðsla"), one line per VAT rate, stored as a
 * draft. There is no way to delete or edit an invoice through the API.
 *
 * What the reference says, and what this module relies on:
 *   - OAuth 2.1 authorization code. GET /strax/agent/authorize → the user signs in and consents →
 *     our redirect_uri gets ?code&state. POST /strax/agent/token (JSON) exchanges it:
 *     {access_token, refresh_token, expires_in: 3600}. The refresh token ROTATES: every refresh
 *     returns a new one, and the old one is dead, so the new one is saved before it is used.
 *   - A 401 is not always an expired token. Refresh only when the error says token/expired.
 *   - Resource answers are {status, message, result}. A refusal is HTTP 200 with status false.
 *   - Writes carry their object in `data` (a JSON string is the universal form).
 *   - POST /api/v1/agent/invoices: amount = Σ lines + VAT to 2 dp; unit_price is EXCLUDING VAT;
 *     tax S = 24 %, AA = 11 %; save: 1 stores a draft and sends nothing. An Idempotency-Key
 *     header makes a retry safe. A free line needs item_number, description, qty, uom, tax.
 *   - Clients are per environment. The sandbox, dev.konto.is, needs en4_maint_code on every call
 *     and serves a self-signed certificate.
 */
const https = require('https');

const BASES = { live: 'https://konto.is', test: 'https://dev.konto.is' };
const SCOPES = 'dashboard_data,manage_customers,nav,create_invoice';

function clean(v) { return String(v == null ? '' : v).trim().replace(/^(['"])(.*)\1$/s, '$2').trim(); }

/** AG's agent client for an environment, from Railway. The operator only consents. */
function appCredentials(environment) {
  const t = environment === 'test';
  const clientId = clean(process.env[t ? 'KONTO_CLIENT_ID_TEST' : 'KONTO_CLIENT_ID']);
  const clientSecret = clean(process.env[t ? 'KONTO_CLIENT_SECRET_TEST' : 'KONTO_CLIENT_SECRET']);
  const maint = t ? clean(process.env.KONTO_MAINT_CODE) : '';
  return { clientId, clientSecret, maint, ready: !!(clientId && clientSecret && (!t || maint)) };
}

function redirectUri() {
  return clean(process.env.KONTO_REDIRECT_URI)
    || (clean(process.env.APP_URL) || 'https://admin.agvending.is').replace(/\/+$/, '') + '/api/v1/accounting/konto/callback';
}

function withMaint(url, environment) {
  if (environment !== 'test') return url;
  const m = appCredentials('test').maint;
  return url + (url.includes('?') ? '&' : '?') + 'en4_maint_code=' + encodeURIComponent(m);
}

function authorizeUrl({ environment, state }) {
  const app = appCredentials(environment);
  const q = new URLSearchParams({ client_id: app.clientId, scope: SCOPES, redirect_uri: redirectUri(), state });
  return withMaint((BASES[environment] || BASES.live) + '/strax/agent/authorize?' + q.toString(), environment);
}

function httpsRequest(method, urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const opts = { method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 25000 };
    // The sandbox serves a self-signed certificate (Konto's own reference says so). Only that one
    // host is exempt; konto.is is verified like everything else.
    if (u.hostname === 'dev.konto.is') opts.rejectUnauthorized = false;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Konto request timed out')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parse(body) { try { return JSON.parse(body); } catch (e) { return null; } }
function short(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 600); }

/** Exchange an authorization code or a refresh token. Resolves to our token record. */
async function tokenRequest(environment, payload) {
  const app = appCredentials(environment);
  if (!app.ready) { const e = new Error('Konto ' + environment + ' client is not configured on the server'); e.code = 'konto_not_configured'; throw e; }
  const body = JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...payload });
  const r = await httpsRequest('POST', withMaint((BASES[environment] || BASES.live) + '/strax/agent/token', environment),
    { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  const j = parse(r.body) || {};
  if (r.status < 200 || r.status >= 300 || !j.access_token) {
    const e = new Error(`Konto token request failed (HTTP ${r.status}: ${short(j.error_description || j.error || j.message || r.body)})`);
    e.status = r.status; e.code = j.error || 'token_failed';
    throw e;
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || payload.refresh_token || null,
    accessExpiresAt: Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600) * 1000,
    scope: j.scope || null,
  };
}

function exchangeCode(environment, code) {
  return tokenRequest(environment, { grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

/**
 * A client for one operator. tokens: {accessToken, refreshToken, accessExpiresAt}.
 * saveTokens(next) is called with every new token set BEFORE it is used, because the refresh
 * token it replaces is already dead.
 */
function client({ environment = 'live', tokens, saveTokens }) {
  const env = BASES[environment] ? environment : 'live';
  const base = BASES[env];
  let tok = tokens ? { ...tokens } : null;

  async function refresh() {
    if (!tok || !tok.refreshToken) { const e = new Error('Konto is not connected: no refresh token'); e.code = 'no_credentials'; throw e; }
    const next = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: tok.refreshToken });
    tok = next;
    if (saveTokens) await saveTokens(next);
    return next.accessToken;
  }
  async function access() {
    if (tok && tok.accessToken && Date.now() < (tok.accessExpiresAt || 0) - 120 * 1000) return tok.accessToken;
    return refresh();
  }

  async function call(method, path, { data, idempotencyKey } = {}) {
    const body = data === undefined ? null : JSON.stringify({ data: JSON.stringify(data) });
    const go = async (token) => {
      const h = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
      if (body) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(body); }
      if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;
      return httpsRequest(method, withMaint(base + path, env), h, body);
    };
    let r = await go(await access());
    if (r.status === 401 && /expired|token/i.test(r.body)) r = await go(await refresh());
    const j = parse(r.body);
    if (r.status < 200 || r.status >= 300) {
      const e = new Error(`Konto ${method} ${path} → HTTP ${r.status}: ${short((j && (j.message || j.error)) || r.body) || '(empty reply)'}`);
      e.status = r.status; throw e;
    }
    if (!j || j.status === false) {
      // A refusal comes as HTTP 200 with status false: Konto answered, nothing was created.
      const e = new Error(`Konto ${method} ${path} refused: ${short((j && (j.message || j.error_code)) || r.body) || '(empty reply)'}`);
      e.status = r.status; e.code = j && j.error_code; throw e;
    }
    return j.result;
  }

  const listOf = (res) => Array.isArray(res) ? res : (res && (res.data || res.items || res.customers || res.list)) || [];

  return {
    environment: env,
    async company() { return call('GET', '/api/v1/agent/status'); },
    async customers(search) {
      const q = search ? '?search=' + encodeURIComponent(search) : '';
      return listOf(await call('GET', '/api/v1/agent/customers' + q)).map(c => ({
        id: c.guid || c.id, name: c.name || '', kennitala: c.kennitala || c.registration_no || '',
      })).filter(c => c.id);
    },
    async createInvoice(obj, idempotencyKey) {
      const id = await call('POST', '/api/v1/agent/invoices', { data: obj, idempotencyKey });
      return { id: typeof id === 'string' ? id : (id && (id.guid || id.id)) || null };
    },
  };
}

const RATE = { '11': { tax: 'AA', r: 0.11 }, '24': { tax: 'S', r: 0.24 } };
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * The invoice for a day (or a correction). Pure, for the preview and the tests.
 *   byRate: {'11': grossKr, '24': grossKr} — VAT included, as our sales are. Konto wants each
 *     line's price without VAT, so net = gross / (1 + r) to 2 dp, VAT = net × r to 2 dp.
 *     Their sum can differ from our gross by a few aurar; `roundingKr` says by how much.
 */
function buildInvoice({ day, byRate, customerGuid, reference, label }) {
  const items = [];
  let amount = 0, gross = 0;
  for (const k of ['11', '24']) {
    const g = Math.abs(Math.round(byRate[k] || 0));
    if (!g) continue;
    // Of the nets a cent either side, take the one whose net + VAT lands nearest our gross.
    // Some totals cannot be hit exactly (350 kr at 11% is 349,99 or 350,01).
    const base = r2(g / (1 + RATE[k].r));
    let net = base, vat = r2(base * RATE[k].r);
    for (const c of [r2(base - 0.01), r2(base + 0.01)]) {
      const v = r2(c * RATE[k].r);
      if (Math.abs(c + v - g) < Math.abs(net + vat - g) - 1e-9) { net = c; vat = v; }
    }
    // A free line: nothing is added to the catalogue, and no catalogue price is rewritten.
    items.push({ item_number: `${reference}-${k}`.slice(0, 60), description: `${label || 'Sala sjálfsala'} ${day} (${k}% VSK)`,
      qty: 1, uom: 'C62', unit_price: net, tax: RATE[k].tax });
    amount = r2(amount + net + vat);
    gross += g;
  }
  // Always a draft (save: 1): issuing would deliver the invoice to the customer, and a day's
  // vending sales have nobody to deliver to. The bookkeeper issues or books it in Konto.
  const inv = {
    type: 'invoice', amount, currency: 'ISK', customer: { guid: customerGuid },
    issue_date: day, due_date: day, settlement_date: day,
    description: `${label || 'Sala sjálfsala'} ${day}`.slice(0, 100),
    booking: reference, save: 1, items,
  };
  return { invoice: inv, roundingKr: r2(amount - gross) };
}

module.exports = { client, exchangeCode, authorizeUrl, appCredentials, redirectUri, buildInvoice, BASES, SCOPES, _test: { withMaint } };
