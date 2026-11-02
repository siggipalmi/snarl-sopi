/**
 * Payday read-only client.
 *
 * Pulls a customer's invoices and payments from Payday so the operator billing
 * portal can show them. READ ONLY — this module never creates or changes
 * anything in Payday.
 *
 * Auth: POST clientId + clientSecret to /auth/token → a Bearer token valid for
 * 24 hours; we cache it and re-fetch when it expires. Set in Railway:
 *   PAYDAY_CLIENT_ID, PAYDAY_CLIENT_SECRET   (from Payday → company settings)
 *   PAYDAY_API_BASE  (optional — https://api.test.payday.is to use sandbox)
 *
 * ── CONFIRM AGAINST LIVE API ──────────────────────────────────────────────
 * The exact token URL, list paths, query-param names and response field names
 * below are taken from the public docs/model and are env-overridable. They are
 * marked CONFIRM and should be checked against one real response before relying
 * on the numbers (same discipline we used for the Weimi order API). Each can be
 * overridden by an env var so finalising needs no code change if a path differs.
 */
const https = require('https');

const API_BASE   = process.env.PAYDAY_API_BASE   || 'https://api.payday.is';
const TOKEN_URL  = process.env.PAYDAY_TOKEN_URL  || `${API_BASE}/auth/token`;     // confirmed: POST clientId/clientSecret
const API_VER    = process.env.PAYDAY_API_VERSION || 'alpha';
const CLIENT_ID     = process.env.PAYDAY_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYDAY_CLIENT_SECRET;

// CONFIRM: resource paths + the param used to filter by customer.
const PATH_INVOICES = process.env.PAYDAY_PATH_INVOICES || '/invoices';            // confirmed
const PATH_CUSTOMERS = process.env.PAYDAY_PATH_CUSTOMERS || '/customers';         // confirmed
const PATH_INVOICE_PDF = process.env.PAYDAY_PATH_INVOICE_PDF || '/invoices/{id}/pdf'; // plural-consistent; verify via download
const CUSTOMER_PARAM = process.env.PAYDAY_CUSTOMER_PARAM || 'customerId';         // CONFIRM

function paydayConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// ── token cache ───────────────────────────────────────────────────────────
let _token = null;        // { accessToken, expiresAt(ms) }

function httpsRequest(method, urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers, timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('Payday request timed out')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// POST clientId + clientSecret to /auth/token → Bearer token valid ~24h.
async function fetchToken() {
  if (!paydayConfigured()) throw new Error('Payday not configured');
  const body = JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  const res = await httpsRequest('POST', TOKEN_URL,
    { 'Content-Type': 'application/json', 'Api-Version': API_VER, 'Content-Length': Buffer.byteLength(body) }, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Payday token request failed (HTTP ${res.status})`);
  }
  let json; try { json = JSON.parse(res.body.toString('utf8')); } catch (e) { throw new Error('Payday token: bad JSON'); }
  const token = json.token || json.accessToken || json.access_token;         // CONFIRM exact field
  if (!token) throw new Error('Payday token: no token in response');
  _token = { accessToken: token, expiresAt: Date.now() + 23 * 3600 * 1000 };  // 24h life, refresh early
  return token;
}

async function getAccessToken() {
  if (_token && Date.now() < _token.expiresAt) return _token.accessToken;
  return fetchToken();
}

// Authenticated GET, with one 401 retry after a forced refresh.
async function apiGet(path, query, { raw = false } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${API_BASE}${path}${qs}`;
  const doCall = async () => {
    const token = await getAccessToken();
    return httpsRequest('GET', url, { 'Api-Version': API_VER, 'Authorization': `Bearer ${token}`, 'Accept': raw ? '*/*' : 'application/json' }, null);
  };
  let res = await doCall();
  if (res.status === 401) { _token = null; res = await doCall(); }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Payday GET ${path} → HTTP ${res.status}`);
  }
  if (raw) return res.body;                                   // PDF bytes
  try { return JSON.parse(res.body.toString('utf8')); } catch (e) { throw new Error(`Payday GET ${path}: bad JSON`); }
}

// Pull a list, following pagination via the `pages` field. Envelope keys confirmed
// against the live API: invoices → {invoices,...}, customers → {customers,...}.
async function listAll(path, query = {}) {
  const out = [];
  let page = 1, pages = 1;
  for (let i = 0; i < 60; i++) {                              // hard safety cap
    const json = await apiGet(path, { ...query, page });
    const rows = json.invoices || json.customers || json.payments || json.data || json.items || json.results || (Array.isArray(json) ? json : []);
    out.push(...rows);
    pages = Number(json.pages || 1);
    if (page >= pages || !rows.length) break;
    page++;
  }
  return out;
}

async function getCustomerInvoices(customerId) {
  return listAll(PATH_INVOICES, { [CUSTOMER_PARAM]: customerId });
}
// Payday has no top-level /payments endpoint; payment status is carried on each
// invoice (paidDate + status PAID). Kept as a no-op so older callers don't break.
async function getCustomerPayments() { return []; }

// Resolve a Payday customer from a kennitala by scanning /customers (no ssn filter
// param exists; the customer list is small) and matching on ssn.
async function findCustomerBySsn(ssn) {
  const clean = String(ssn || '').replace(/\D/g, '');
  if (!clean) return null;
  const all = await listAll(PATH_CUSTOMERS, {});
  return all.find(c => String(c.ssn || '').replace(/\D/g, '') === clean) || null;
}

async function getInvoicePdf(invoiceId) {
  return apiGet(PATH_INVOICE_PDF.replace('{id}', encodeURIComponent(invoiceId)), null, { raw: true });
}

/**
 * Build a chronological ledger with a running balance from invoices alone.
 * Payday exposes no /payments collection, so each invoice contributes a debit on
 * its invoiceDate (+gross) and, when paid/credited, an offsetting credit on the
 * paidDate/creditDate (−gross). Cancelled invoices are skipped. Returns newest-first.
 */
/**
 * What state is this invoice actually in?
 *
 * One definition, used by both the ledger and the invoice list, because they disagreed: the
 * ledger skipped cancelled invoices while the list was never told they were cancelled, so an
 * operator saw a balance of one figure and a pile of "overdue" rows adding up to another.
 * A cancelled or credited invoice is not money anybody owes.
 *
 *   cancelled  withdrawn; owed nothing, and it is not overdue however old it is
 *   credited   cancelled out by a credit note (or itself a credit note: a negative amount)
 *   paid       settled
 *   open       still owed; the caller decides whether it is also overdue, from the due date
 */
function invoiceState(inv) {
  const status = String((inv && inv.status) || '').toUpperCase();
  if (inv && (inv.cancelledDate || status === 'CANCELLED')) return 'cancelled';
  if (inv && (inv.creditDate || inv.refundDate || status === 'CREDITED' || status === 'REFUNDED')) {
    return 'credited';
  }
  // A negative amount IS a credit note. It can never be overdue, whatever its due date says.
  const gross = Number((inv && (inv.amountIncludingVat != null ? inv.amountIncludingVat
    : (inv.total || inv.amount))) || 0);
  if (gross < 0) return 'credited';
  if (inv && (inv.paidDate || status === 'PAID' || status === 'SETTLED')) return 'paid';
  return 'open';
}

/** Does this invoice still represent money owed? */
function invoiceIsLive(inv) { return invoiceState(inv) === 'open'; }

/**
 * A ledger derived from invoices.
 *
 * This is an APPROXIMATION of Payday's own account statement and cannot be made exact from
 * invoice data alone. Payday's claim carries a seðilgjald — 199 kr per claim on this account —
 * which is not part of amountIncludingVat, so a balance built from invoices is short by that fee
 * for every open claim. It also cannot see a part-payment, or a payment not tied to one invoice.
 *
 * GET /customers/:id/accountStatement returns the real thing, fees and all. Use that where it
 * can be reached; this remains the fallback for when it cannot.
 */
// ─── Payday's own account statement ───────────────────────────────────────────
//
// GET /customers/:id/accountStatement is the ledger Payday itself shows, and the only source
// that is right: it carries the seðilgjald on each claim and any part-payment, neither of which
// can be recovered from invoice amounts. On one real account the invoice-derived figure was
// 50.770 kr short of it (Siggi, 2026-11-02).
//
// The documented collection carries no response example for this endpoint, so the field names
// below are read tolerantly rather than assumed, and parseStatement reports ok:false instead of
// guessing when it cannot find what it needs. The caller falls back to buildLedger on a false.

const PATH_ACCOUNT_STATEMENT = process.env.PAYDAY_PATH_ACCOUNT_STATEMENT
  || '/customers/{id}/accountStatement';

function _ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return null;
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

/** Raw statement for a customer. Dates are inclusive and default to the last two years. */
async function getAccountStatement(customerId, { from, to } = {}) {
  const path = PATH_ACCOUNT_STATEMENT.replace('{id}', encodeURIComponent(String(customerId)));
  const now = new Date();
  const dateTo = _ymd(to) || _ymd(now);
  const dateFrom = _ymd(from)
    || _ymd(new Date(now.getFullYear() - 2, now.getMonth(), 1));
  const out = [];
  let page = 1, pages = 1;
  for (let i = 0; i < 60; i++) {
    const json = await apiGet(path, { dateFrom, dateTo, perpage: 100, page });
    const rows = json.lines || json.entries || json.movements || json.transactions
      || json.data || json.items || json.results || (Array.isArray(json) ? json : []);
    out.push(...rows);
    pages = Number(json.pages || 1);
    if (page >= pages || !rows.length) break;
    page++;
  }
  return { rows: out, dateFrom, dateTo };
}

// Key names are read case-insensitively and with the spellings Payday might plausibly use,
// Icelandic included, because the response shape is not documented.
function _pick(row, names) {
  const keys = Object.keys(row || {});
  for (const want of names) {
    const k = keys.find(k2 => k2.toLowerCase() === want.toLowerCase());
    if (k != null && row[k] != null && row[k] !== '') return row[k];
  }
  return null;
}
function _money(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  // "50.372 kr." / "50,372" — Icelandic groups with dots and decimals with a comma.
  const cleaned = String(v).replace(/[^\d,.\-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a statement into the movement shape the dashboard already renders.
 * Returns { ok, movements, closingBalance, reason } — ok:false means use the fallback.
 */
function parseStatement(raw) {
  const rows = (raw && raw.rows) || (Array.isArray(raw) ? raw : null);
  if (!Array.isArray(rows)) return { ok: false, reason: 'no rows', movements: [], closingBalance: 0 };
  if (!rows.length) return { ok: true, movements: [], closingBalance: 0, empty: true };

  const moves = [];
  for (const r of rows) {
    const debit = _money(_pick(r, ['debit', 'debet', 'amountDebit', 'debitAmount']));
    const credit = _money(_pick(r, ['credit', 'kredit', 'amountCredit', 'creditAmount']));
    let amount = null;
    if (debit != null || credit != null) amount = (debit || 0) - (credit || 0);
    else amount = _money(_pick(r, ['amount', 'upphaed', 'value', 'total']));
    if (amount == null) continue;                       // not a movement row
    const balance = _money(_pick(r, ['balance', 'runningBalance', 'stada', 'staða', 'total']));
    const ts = _pick(r, ['date', 'transactionDate', 'entryDate', 'created', 'dags', 'dagsetning']);
    const desc = _pick(r, ['description', 'text', 'name', 'lysing', 'lýsing']) || '';
    const doc = _pick(r, ['voucher', 'documentNumber', 'document', 'reference', 'fylgiskjal',
      'invoiceNumber', 'number']);
    moves.push({
      ts: ts || null, kind: amount >= 0 ? 'invoice' : 'payment',
      ref: doc != null ? String(doc) : '', desc: String(desc),
      amount, balance: balance != null ? balance : null,
    });
  }
  if (!moves.length) return { ok: false, reason: 'no amounts found', movements: [], closingBalance: 0 };

  // Never assume which way round the rows came. Reading them newest-first while trusting a
  // balance column gives the OLDEST row's balance as the closing figure — 51.314 instead of
  // 154.808 on the real account. Sorting by date first makes the order irrelevant.
  const dated = moves.filter(m => m.ts && !isNaN(new Date(m.ts)));
  const ordered = dated.length === moves.length
    ? moves.slice().sort((a, b) => new Date(a.ts) - new Date(b.ts))
    : moves.slice();                       // undated rows: leave them as they came

  let running = 0, hadBalance = false;
  for (const m of ordered) {
    running += m.amount;
    if (m.balance == null) m.balance = running;
    else { hadBalance = true; running = m.balance; }
  }
  const closingBalance = ordered[ordered.length - 1].balance;
  return { ok: true, movements: ordered.slice().reverse(), closingBalance, hadBalance,
           rowsSeen: rows.length, rowsRead: ordered.length };
}

function buildLedger(invoices = []) {
  const num = v => Number(v || 0);
  const moves = [];
  // A cancelled invoice is dropped, and the credit note that cancelled it has to go with it.
  // Counting the credit on its own subtracts the same money twice: on a real account that
  // understated the balance by 50.173 kr against Payday's own ledger (Siggi, 2026-11-02).
  //
  // Payday gives no link between the two documents, so they are paired by magnitude: each
  // cancelled invoice absorbs one credit note of the same size. A credit note left unpaired is
  // a real credit against the account and still counts — which is the case where the invoice
  // was left open rather than cancelled.
  const grossOf = (i) => num(i.amountIncludingVat != null ? i.amountIncludingVat : (i.total || i.amount));
  const unpaired = new Map();   // |amount| → how many cancelled invoices of that size
  for (const i of invoices) {
    if (invoiceState(i) !== 'cancelled') continue;
    const k = Math.abs(grossOf(i));
    unpaired.set(k, (unpaired.get(k) || 0) + 1);
  }

  for (const inv of invoices) {
    const state = invoiceState(inv);
    if (state === 'cancelled') continue;      // withdrawn: it never counted
    const grossRaw = grossOf(inv);
    if (grossRaw < 0) {
      const k = Math.abs(grossRaw), left = unpaired.get(k) || 0;
      if (left > 0) { unpaired.set(k, left - 1); continue; }   // it cancelled a dropped invoice
      // otherwise it is a credit standing against the account, and it counts
    }
    const gross = grossRaw;
    const ref = inv.number != null ? inv.number : inv.id;
    moves.push({ ts: inv.invoiceDate || inv.created || inv.dueDate || null, kind: 'invoice', ref, desc: inv.description || '', amount: gross });
    if (state === 'paid') {
      moves.push({ ts: inv.paidDate || inv.invoiceDate || null, kind: 'payment', ref, desc: '', amount: -Math.abs(gross) });
    } else if (state === 'credited' && gross > 0) {
      // Only an invoice that was itself credited needs an offsetting line. A credit note is a
      // negative document: it IS the offset, and giving it one as well counts it twice.
      moves.push({ ts: inv.creditDate || inv.refundDate || null, kind: 'credit', ref, desc: '', amount: -Math.abs(gross) });
    }
  }
  moves.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));         // oldest→newest
  let bal = 0;
  for (const m of moves) { bal += m.amount; m.balance = bal; }
  return moves.reverse();                                                   // newest first for display
}

// Read-only probe for setup: confirms the token works and shows the raw shape of
// invoices/payments so field mappings can be locked. Never returns the token value.
function _redact(obj) {
  const o = {};
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    o[k] = (typeof v === 'string' && v.length > 48) ? v.slice(0, 48) + '…' : (v && typeof v === 'object' ? '{…}' : v);
  }
  return o;
}
async function debugProbe(customerId, ssn) {
  const out = { configured: paydayConfigured(), apiBase: API_BASE, tokenUrl: TOKEN_URL, customerParam: CUSTOMER_PARAM };
  if (!out.configured) { out.note = 'Set PAYDAY_CLIENT_ID + PAYDAY_CLIENT_SECRET in Railway'; return out; }
  try {
    const body = JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const res = await httpsRequest('POST', TOKEN_URL, { 'Content-Type': 'application/json', 'Api-Version': API_VER, 'Content-Length': Buffer.byteLength(body) }, body);
    let j = {}; try { j = JSON.parse(res.body.toString('utf8')); } catch (e) {}
    const field = j.token ? 'token' : j.accessToken ? 'accessToken' : j.access_token ? 'access_token' : null;
    out.token = { httpStatus: res.status, responseKeys: Object.keys(j || {}), tokenField: field };
    if (!field) { out.token.bodyPreview = res.body.toString('utf8').slice(0, 200); return out; }
  } catch (e) { out.token = { error: String(e.message || e) }; return out; }
  // Discover the real list endpoints empirically (Weimi-style). No customer filter needed to find the path;
  // bare GET returns the default first page, which is enough to read the field shape.
  const scan = async (candidates) => {
    const tried = [];
    for (const p of candidates) {
      try {
        const raw = await apiGet(p, null);
        const arr = Array.isArray(raw) ? raw : (raw.lines || raw.data || raw.items || raw.results || raw.invoices || raw.payments || raw.records || null);
        tried.push({ path: p, status: 200,
          topLevelKeys: Array.isArray(raw) ? '(array)' : Object.keys(raw || {}),
          rowsFound: Array.isArray(arr) ? arr.length : null,
          firstKeys: (arr && arr[0]) ? Object.keys(arr[0]) : [],
          firstSample: (arr && arr[0]) ? _redact(arr[0]) : null });
        return tried; // stop at first success
      } catch (e) {
        const m = String(e.message || e); const code = (m.match(/HTTP (\d+)/) || [])[1];
        tried.push({ path: p, status: code ? Number(code) : m });
      }
    }
    return tried;
  };
  out.invoiceScan = await scan(['/invoices', '/invoice', '/sales/invoices', '/salesInvoices', '/v1/invoices', '/api/invoices']);
  out.paymentScan = await scan(['/payments', '/payment', '/sales/payments', '/v1/payments']);
  // Customers: confirm the resource + which query param looks one up by kennitala (ssn),
  // so an operator only needs to enter the ssn and we resolve their Payday id automatically.
  out.customerScan = await scan(['/customers', '/customer', '/clients']);

  // The account statement, whose response shape the published collection does not show. Report
  // the first row's keys and how our parser read it, so the live shape can be confirmed without
  // anyone pasting customer data around.
  try {
    const cust = (out.customerScan || []).find(t => t.firstSample) || {};
    const cid = cust.firstSample && (cust.firstSample.id || cust.firstSample.customerId);
    if (cid) {
      const raw = await getAccountStatement(cid);
      const parsed = parseStatement(raw);
      out.accountStatement = {
        path: PATH_ACCOUNT_STATEMENT, dateFrom: raw.dateFrom, dateTo: raw.dateTo,
        rowsFound: raw.rows.length,
        firstKeys: raw.rows[0] ? Object.keys(raw.rows[0]) : [],
        firstSample: raw.rows[0] ? _redact(raw.rows[0]) : null,
        parsed: { ok: parsed.ok, reason: parsed.reason || null, movements: parsed.movements.length,
                  closingBalance: parsed.closingBalance, carriedItsOwnBalance: !!parsed.hadBalance },
      };
    } else {
      out.accountStatement = { note: 'no customer id to probe with' };
    }
  } catch (e) {
    out.accountStatement = { error: String(e.message || e) };
  }

  // Deep tests (self-contained): use a real customer taken from the first invoice to learn
  // (a) the invoice→customer field shape, (b) which param filters /invoices by customer,
  // (c) which param filters /customers by ssn. No external input needed.
  const invPath = (out.invoiceScan.find(t => t.status === 200) || {}).path;
  if (invPath) {
    try {
      const sample = await apiGet(invPath, { page: 1 });
      const firstInv = ((sample && sample.invoices) || (Array.isArray(sample) ? sample : []))[0];
      const cust = firstInv && firstInv.customer;
      const cid = cust && cust.id;
      const cssn = (cust && cust.ssn) ? String(cust.ssn).replace(/\D/g, '') : null;
      out.invoiceCustomerShape = cust ? { keys: Object.keys(cust), id: cust.id, ssn: cust.ssn, name: cust.name }
        : (firstInv ? 'customer field missing' : 'no invoices on page 1');
      out.invoicePaymentsShape = (firstInv && firstInv.payments && typeof firstInv.payments === 'object')
        ? { keys: Object.keys(firstInv.payments) } : (firstInv ? String(firstInv.payments) : null);

      if (cid) {
        out.invoiceFilterTest = [];
        for (const param of ['customerId', 'customer', 'payorId']) {
          try {
            const raw = await apiGet(invPath, { [param]: cid, page: 1 });
            const arr = (raw && raw.invoices) || [];
            const allMatch = arr.length > 0 && arr.every(iv => iv.customer && iv.customer.id === cid);
            out.invoiceFilterTest.push({ param, total: raw && raw.total, returned: arr.length, allMatch });
          } catch (e) { const m = String(e.message || e); const c = (m.match(/HTTP (\d+)/) || [])[1]; out.invoiceFilterTest.push({ param, status: c ? Number(c) : m }); }
        }
      }
      if (cssn) {
        out.customerFilterTest = [];
        for (const param of ['ssn', 'kennitala', 'query', 'search', 'name']) {
          try {
            const raw = await apiGet('/customers', { [param]: cssn, page: 1 });
            const arr = (raw && raw.customers) || [];
            const allMatch = arr.length > 0 && arr.every(c => String(c.ssn || '').replace(/\D/g, '') === cssn);
            out.customerFilterTest.push({ param, total: raw && raw.total, returned: arr.length, allMatch });
          } catch (e) { const m = String(e.message || e); const c = (m.match(/HTTP (\d+)/) || [])[1]; out.customerFilterTest.push({ param, status: c ? Number(c) : m }); }
        }
      }
    } catch (e) { out.deepError = String(e.message || e); }
  }
  return out;
}

module.exports = {
  invoiceState, invoiceIsLive, getAccountStatement, parseStatement,
  paydayConfigured, getCustomerInvoices, getCustomerPayments, findCustomerBySsn, getInvoicePdf, buildLedger, debugProbe,
  _meta: { API_BASE, TOKEN_URL, PATH_INVOICES, PATH_CUSTOMERS, PATH_INVOICE_PDF, CUSTOMER_PARAM },
};
