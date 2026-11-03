/**
 * Payday as an OPERATOR'S accounting system: one client per set of credentials.
 *
 * Not to be confused with src/payday.js, which is AG Vending's own Payday account (the lease
 * invoices operators see under Billing). This module talks to the operator's company, with the
 * operator's credentials, and writes exactly one kind of thing: a journal entry.
 *
 * Confirmed from Payday's published reference (apidoc.payday.is, read 2026-11-03):
 *   POST /auth/token            {clientId, clientSecret} → {accessToken, expiresIn: 86400}
 *   GET  /accounting/accounts   [{id, code, name, type, defaultVatPercentType, archived}]
 *   POST /accounting/journal    {date, description(≤100), status: DRAFT|POST, lines[]}
 *        line: {amount, vatPercentType?: NoVAT|ReducedVAT|StandardVAT, ledgerAccountId}
 *        "If vatPercentType is set then the amount includes VAT" — Payday splits the VAT out
 *        onto its own VAT account. Negative = credit, positive = debit (their own example
 *        books sales income as −1000 StandardVAT).
 *   DELETE /accounting/journal/:id   only while the entry is still a draft
 *   GET  /accounting/journal         unposted (draft) entries
 * Every call carries Api-Version: alpha.
 *
 * NOT confirmed (the reference shows no response body for the create): what the create returns.
 * createJournal() reads an id from the usual places and, failing that, finds the entry among the
 * drafts by its description, which carries our own reference.
 */
const https = require('https');

const API_VER = 'alpha';
const BASES = { live: 'https://api.payday.is', test: 'https://api.test.payday.is' };

function httpsRequest(method, urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Payday request timed out')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Payday's own words from an error body, short enough for a log line and the history row. */
function errText(status, body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = j.message || j.error || j.title || (j.errors && JSON.stringify(j.errors)) || ''; } catch (e) { msg = body; }
  return `HTTP ${status}${msg ? ': ' + String(msg).slice(0, 300) : ''}`;
}

function client({ environment = 'live', clientId, clientSecret }) {
  const base = BASES[environment] || BASES.live;
  let token = null; // { value, expiresAt }

  async function getToken(force) {
    if (!force && token && Date.now() < token.expiresAt) return token.value;
    if (!clientId || !clientSecret) throw new Error('Payday: client ID and secret are both needed');
    const body = JSON.stringify({ clientId, clientSecret });
    const r = await httpsRequest('POST', base + '/auth/token',
      { 'Content-Type': 'application/json', 'Api-Version': API_VER, 'Content-Length': Buffer.byteLength(body) }, body);
    if (r.status < 200 || r.status >= 300) throw new Error('Payday sign-in failed (' + errText(r.status, r.body) + ')');
    let j; try { j = JSON.parse(r.body); } catch (e) { throw new Error('Payday sign-in: unreadable answer'); }
    const v = j.accessToken || j.token || j.access_token;
    if (!v) throw new Error('Payday sign-in: no token in the answer');
    const life = Number(j.expiresIn) > 0 ? Number(j.expiresIn) * 1000 : 86400 * 1000;
    token = { value: v, expiresAt: Date.now() + life - 3600 * 1000 };
    return v;
  }

  async function call(method, path, payload) {
    const body = payload == null ? null : JSON.stringify(payload);
    const go = async (force) => {
      const t = await getToken(force);
      const h = { 'Api-Version': API_VER, Authorization: 'Bearer ' + t, Accept: 'application/json' };
      if (body) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(body); }
      return httpsRequest(method, base + path, h, body);
    };
    let r = await go(false);
    if (r.status === 401) r = await go(true);
    if (r.status < 200 || r.status >= 300) {
      const e = new Error(`Payday ${method} ${path} → ${errText(r.status, r.body)}`);
      e.status = r.status;
      throw e;
    }
    if (!r.body) return null;
    try { return JSON.parse(r.body); } catch (e) { return r.body; }
  }

  const rowsOf = (j, key) => Array.isArray(j) ? j : (j && (j[key] || j.data || j.items || j.results)) || [];

  return {
    environment: BASES[environment] ? environment : 'live',

    async company() {
      try { return await call('GET', '/companies/me'); } catch (e) { return null; }
    },

    /** Ledger accounts, unarchived, as {id, code, name, type, vat}. */
    async accounts() {
      const j = await call('GET', '/accounting/accounts');
      return rowsOf(j, 'accounts').filter(a => a && a.id && !a.archived).map(a => ({
        id: a.id, code: String(a.code || ''), name: a.name || '', type: a.type || '',
        vat: a.defaultVatPercentType || null,
      })).sort((a, b) => a.code.localeCompare(b.code, 'is', { numeric: true }));
    },

    async drafts() { return rowsOf(await call('GET', '/accounting/journal'), 'journals'); },

    /** Create a journal entry. Resolves to { id|null, raw }. */
    async createJournal(entry) {
      const raw = await call('POST', '/accounting/journal', entry);
      let id = raw && typeof raw === 'object' ? (raw.id || raw.journalId || (raw.journal && raw.journal.id) || null) : null;
      if (!id && entry.status !== 'POST') {
        // Find our own draft by the reference we put in its description.
        try {
          const found = (await this.drafts()).find(d => d && d.description === entry.description && String(d.date || '').slice(0, 10) === entry.date);
          if (found) id = found.id || null;
        } catch (e) { /* the entry exists either way; the id only lets a re-send replace it */ }
      }
      return { id, raw };
    },

    async deleteJournal(id) { return call('DELETE', '/accounting/journal/' + encodeURIComponent(id)); },
  };
}

/**
 * The journal entry for one day. Pure, so it can be tested and previewed without Payday.
 *   summary: { day, byRate: { '11': grossKr, '24': grossKr }, orders }
 *   accounts: { clearing, sales11, sales24 } — Payday ledger account ids
 * Sales lines are credits (negative) carrying the VAT type, so Payday splits out the VAT; the
 * clearing account takes the whole gross as a debit. Zero lines are left out.
 */
function buildJournal({ summary, accounts, status, reference, label }) {
  const lines = [];
  const g11 = Math.round(summary.byRate['11'] || 0), g24 = Math.round(summary.byRate['24'] || 0);
  if (g11) lines.push({ amount: -g11, vatPercentType: 'ReducedVAT', ledgerAccountId: accounts.sales11 });
  if (g24) lines.push({ amount: -g24, vatPercentType: 'StandardVAT', ledgerAccountId: accounts.sales24 });
  const total = g11 + g24;
  if (total) lines.push({ amount: total, ledgerAccountId: accounts.clearing });
  const description = `${label || 'Sala sjálfsala'} ${summary.day} [${reference}]`.slice(0, 100);
  return { date: summary.day, description, status: status === 'POST' ? 'POST' : 'DRAFT', lines };
}

module.exports = { client, buildJournal, BASES };
