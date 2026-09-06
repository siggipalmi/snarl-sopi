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
function buildLedger(invoices = []) {
  const num = v => Number(v || 0);
  const moves = [];
  for (const inv of invoices) {
    const status = String(inv.status || '').toUpperCase();
    if (inv.cancelledDate || status === 'CANCELLED') continue;
    const gross = num(inv.amountIncludingVat != null ? inv.amountIncludingVat : (inv.total || inv.amount));
    const ref = inv.number != null ? inv.number : inv.id;
    moves.push({ ts: inv.invoiceDate || inv.created || inv.dueDate || null, kind: 'invoice', ref, desc: inv.description || '', amount: gross });
    if (inv.paidDate || status === 'PAID') {
      moves.push({ ts: inv.paidDate || inv.invoiceDate || null, kind: 'payment', ref, desc: '', amount: -Math.abs(gross) });
    } else if (inv.creditDate || status === 'CREDITED' || inv.refundDate || status === 'REFUNDED') {
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
  paydayConfigured, getCustomerInvoices, getCustomerPayments, findCustomerBySsn, getInvoicePdf, buildLedger, debugProbe,
  _meta: { API_BASE, TOKEN_URL, PATH_INVOICES, PATH_CUSTOMERS, PATH_INVOICE_PDF, CUSTOMER_PARAM },
};
