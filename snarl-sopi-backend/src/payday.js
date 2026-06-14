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
const PATH_INVOICES = process.env.PAYDAY_PATH_INVOICES || '/invoice';             // CONFIRM
const PATH_PAYMENTS = process.env.PAYDAY_PATH_PAYMENTS || '/payment';             // CONFIRM
const PATH_INVOICE_PDF = process.env.PAYDAY_PATH_INVOICE_PDF || '/invoice/{id}/pdf'; // CONFIRM
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

// Pull a list, following pagination if present. CONFIRM: response envelope.
async function listAll(path, customerId, extra = {}) {
  const out = [];
  let page = 1; const perpage = 100;
  for (let i = 0; i < 50; i++) {                              // hard safety cap
    const query = { [CUSTOMER_PARAM]: customerId, page, perpage, ...extra };
    const json = await apiGet(path, query);
    const rows = json.lines || json.data || json.items || json.results || (Array.isArray(json) ? json : []); // CONFIRM
    out.push(...rows);
    const total = Number(json.total || json.totalCount || 0);
    if (!rows.length || (total && out.length >= total) || rows.length < perpage) break;
    page++;
  }
  return out;
}

async function getCustomerInvoices(customerId) {
  return listAll(PATH_INVOICES, customerId);
}
async function getCustomerPayments(customerId) {
  return listAll(PATH_PAYMENTS, customerId);
}
async function getInvoicePdf(invoiceId) {
  return apiGet(PATH_INVOICE_PDF.replace('{id}', encodeURIComponent(invoiceId)), null, { raw: true });
}

/**
 * Merge invoices (debits) and payments (credits) into a chronological ledger
 * with a running balance. Field names are best-guess and CONFIRM-able; the
 * normaliser tolerates a few common spellings so a real sample needs only the
 * mapping tweaked, not the logic.
 */
function buildLedger(invoices = [], payments = []) {
  const num  = v => Number(v || 0);
  const when = o => o.date || o.createdAt || o.created || o.issuedAt || o.paymentDate || o.dueDate || null;
  const moves = [];
  for (const inv of invoices) {
    moves.push({ ts: when(inv), kind: 'invoice',
      ref: inv.number || inv.invoiceNumber || inv.id,
      desc: inv.description || inv.subject || 'Invoice',
      amount: num(inv.total || inv.amount || inv.totalAmount) });          // debit (+)
  }
  for (const pay of payments) {
    moves.push({ ts: when(pay), kind: 'payment',
      ref: pay.number || pay.id,
      desc: pay.description || 'Payment',
      amount: -Math.abs(num(pay.amount || pay.total)) });                  // credit (−)
  }
  moves.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));         // oldest→newest
  let bal = 0;
  for (const m of moves) { bal += m.amount; m.balance = bal; }
  return moves.reverse();                                                   // newest first for display
}

module.exports = {
  paydayConfigured, getCustomerInvoices, getCustomerPayments, getInvoicePdf, buildLedger,
  _meta: { API_BASE, TOKEN_URL, PATH_INVOICES, PATH_PAYMENTS, PATH_INVOICE_PDF, CUSTOMER_PARAM },
};
