/**
 * Daily sales to the operator's own accounting system (Siggi, 2026-11-02).
 *
 * An operator picks its accounting software, connects it with its own credentials and maps three
 * ledger accounts. Once a day the backend sends yesterday's sales as ONE journal entry: the gross
 * per VAT rate credited to the sales accounts (the system splits out the VAT), the total debited
 * to a Nayax clearing account. Payday is the first system; DK, Konto and Business Central are
 * listed and not yet built.
 *
 * Rules this module keeps, whoever calls it:
 *   - Nothing is sent for an operator that has not switched it on. Default entry status is DRAFT,
 *     so the operator's bookkeeper posts it.
 *   - A day is sent once. The scheduler never re-sends a sent day; if its sales change later
 *     (a late Weimi sync), the history shows the difference and a person decides.
 *   - A day with a sold product that has no VAT rate is HELD, not guessed. The profit report
 *     assumes 11% for those; a ledger must not.
 *   - Lines the machine did not dispense are not sales (same rule as the reports).
 *   - Credentials are stored encrypted (ACCOUNTING_ENC_KEY) and never returned to the browser.
 *   - A send whose outcome is unknown (timeout, connection lost) is marked "uncertain" and is
 *     not retried automatically: the entry may exist, and a second one would double the sales.
 *
 * Days are Iceland days, which are UTC days (no DST).
 */
const crypto = require('crypto');
const storage = require('./storage');
const paydayLedger = require('./accountingPayday');
const kontoLedger = require('./accountingKonto');

const db = storage.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS accounting_connections (
    operatorId  TEXT PRIMARY KEY,
    configJson  TEXT NOT NULL DEFAULT '{}',
    secretEnc   TEXT,
    updatedAt   INTEGER,
    updatedBy   TEXT
  );
  CREATE TABLE IF NOT EXISTS accounting_exports (
    operatorId    TEXT NOT NULL,
    day           TEXT NOT NULL,              -- YYYY-MM-DD
    provider      TEXT NOT NULL,
    status        TEXT NOT NULL,              -- sending|sent|empty|held|failed|uncertain
    grossKr       INTEGER,
    byRateJson    TEXT,                       -- {"11": kr, "24": kr} as booked so far (incl. corrections)
    externalId    TEXT,                       -- the journal entry's id in their system
    entryStatus   TEXT,                       -- DRAFT|POST as sent
    reason        TEXT,                       -- why held / failed
    attempts      INTEGER NOT NULL DEFAULT 0,
    lastAttemptAt INTEGER,
    sentAt        INTEGER,
    sentBy        TEXT,                       -- 'scheduled' or a user id
    correctionsJson TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (operatorId, day)
  );
`);

const PROVIDERS = [
  { id: 'payday', name: 'Payday', available: true },
  { id: 'dk', name: 'DK', available: false },
  { id: 'konto', name: 'Konto', available: true },
  { id: 'businesscentral', name: 'Business Central', available: false },
];

const SEND_HOUR_UTC = Number(process.env.ACCOUNTING_SEND_HOUR_UTC) >= 0 ? Number(process.env.ACCOUNTING_SEND_HOUR_UTC) : 6;
const CATCH_UP_DAYS = 7;          // after downtime, the scheduler fills in at most this many days
const MAX_AUTO_ATTEMPTS = 6;      // a failing day is retried hourly this many times, then left to a person
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SENDABLE = new Set(['payday', 'konto']);
const provName = (id) => (PROVIDERS.find(p => p.id === id) || { name: id }).name;

// ─── Encryption ──────────────────────────────────────────────────────────────

function encKey() {
  const raw = process.env.ACCOUNTING_ENC_KEY || '';
  if (raw.length < 32) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}
function encryptionReady() { return !!encKey(); }

function seal(obj) {
  const key = encKey();
  if (!key) throw new Error('ACCOUNTING_ENC_KEY is not set');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}
function open(sealed) {
  const key = encKey();
  if (!key || !sealed || !sealed.startsWith('v1:')) return null;
  try {
    const buf = Buffer.from(sealed.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
  } catch (e) { return null; }       // wrong key or tampered: treated as no credentials
}

// ─── Connections ─────────────────────────────────────────────────────────────

const st = {
  getConn: db.prepare('SELECT * FROM accounting_connections WHERE operatorId = ?'),
  allConns: db.prepare('SELECT * FROM accounting_connections'),
  putConn: db.prepare(`INSERT INTO accounting_connections (operatorId, configJson, secretEnc, updatedAt, updatedBy)
    VALUES (@operatorId, @configJson, @secretEnc, @updatedAt, @updatedBy)
    ON CONFLICT(operatorId) DO UPDATE SET configJson=excluded.configJson, secretEnc=excluded.secretEnc,
      updatedAt=excluded.updatedAt, updatedBy=excluded.updatedBy`),
  getExp: db.prepare('SELECT * FROM accounting_exports WHERE operatorId = ? AND day = ?'),
  listExp: db.prepare('SELECT * FROM accounting_exports WHERE operatorId = ? ORDER BY day DESC LIMIT ?'),
  putExp: db.prepare(`INSERT INTO accounting_exports
      (operatorId, day, provider, status, grossKr, byRateJson, externalId, entryStatus, reason, attempts, lastAttemptAt, sentAt, sentBy, correctionsJson)
    VALUES (@operatorId, @day, @provider, @status, @grossKr, @byRateJson, @externalId, @entryStatus, @reason, @attempts, @lastAttemptAt, @sentAt, @sentBy, @correctionsJson)
    ON CONFLICT(operatorId, day) DO UPDATE SET provider=excluded.provider, status=excluded.status, grossKr=excluded.grossKr,
      byRateJson=excluded.byRateJson, externalId=excluded.externalId, entryStatus=excluded.entryStatus, reason=excluded.reason,
      attempts=excluded.attempts, lastAttemptAt=excluded.lastAttemptAt, sentAt=excluded.sentAt, sentBy=excluded.sentBy,
      correctionsJson=excluded.correctionsJson`),
};

const DEFAULT_CONFIG = {
  provider: 'none', enabled: false, environment: 'live', credentialSource: 'own',
  accounts: { clearing: null, sales11: null, sales24: null },
  accountLabels: { clearing: '', sales11: '', sales24: '' },
  entryStatus: 'DRAFT', startDate: null,
  konto: { customerGuid: null, customerLabel: '' },     // Konto: the cash customer the daily invoice goes to
};

function loadConn(operatorId) {
  const row = st.getConn.get(operatorId);
  let cfg = {};
  try { cfg = row ? JSON.parse(row.configJson || '{}') : {}; } catch (e) { cfg = {}; }
  const config = { ...DEFAULT_CONFIG, ...cfg,
    accounts: { ...DEFAULT_CONFIG.accounts, ...(cfg.accounts || {}) },
    accountLabels: { ...DEFAULT_CONFIG.accountLabels, ...(cfg.accountLabels || {}) },
    konto: { ...DEFAULT_CONFIG.konto, ...(cfg.konto || {}) } };
  return { config, secretEnc: row ? row.secretEnc : null, updatedAt: row ? row.updatedAt : null, updatedBy: row ? row.updatedBy : null };
}

/** What the browser may see: everything but the secret, plus whether one is stored. */
function publicView(operatorId, { isAg } = {}) {
  const c = loadConn(operatorId);
  const creds = credentialsFor(c);
  return {
    config: c.config,
    credentials: {
      stored: !!c.secretEnc,
      readable: c.secretEnc ? !!open(c.secretEnc) : false,
      clientIdHint: (() => { const o = c.secretEnc && open(c.secretEnc); return o && o.clientId ? '…' + String(o.clientId).slice(-4) : null; })(),
      usable: !!creds,
    },
    providers: PROVIDERS,
    encryptionReady: encryptionReady(),
    railwayTestAvailable: !!isAg && !!(process.env.PAYDAY_CLIENT_ID_TEST && process.env.PAYDAY_CLIENT_SECRET_TEST),
    konto: {
      connected: c.config.provider === 'konto' && !!creds,
      appReady: { live: kontoLedger.appCredentials('live').ready, test: !!isAg && kontoLedger.appCredentials('test').ready },
    },
    sendHourUtc: SEND_HOUR_UTC,
    updatedAt: c.updatedAt,
  };
}

/** A value pasted into Railway or the dashboard: surrounding whitespace and quotes are not part of it. */
function cleanSecret(v) {
  return String(v == null ? '' : v).trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
}

/** What a credential looks like, never what it is: for diagnosing invalid_client. */
function shapeOf(raw) {
  const v = raw == null ? '' : String(raw);
  const c = cleanSecret(v);
  return { set: v.length > 0, length: c.length, guidShaped: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c),
    hadWhitespace: v !== v.trim(), hadQuotes: /^\s*['"]/.test(v) };
}

/**
 * AG-only: are the Railway test credentials well-formed, and which Payday accepts them?
 * Only POST /auth/token is called, against test and live; nothing is read or written.
 */
async function diagnoseRailwayTest() {
  const rawId = process.env.PAYDAY_CLIENT_ID_TEST, rawSecret = process.env.PAYDAY_CLIENT_SECRET_TEST;
  const out = { clientId: shapeOf(rawId), clientSecret: shapeOf(rawSecret), signIn: {} };
  for (const environment of ['test', 'live']) {
    try {
      await paydayLedger.client({ environment, clientId: cleanSecret(rawId), clientSecret: cleanSecret(rawSecret) }).accounts();
      out.signIn[environment] = 'accepted';
    } catch (e) { out.signIn[environment] = String(e.message || e).slice(0, 200); }
  }
  return out;
}

function credentialsFor(conn) {
  const cfg = conn.config;
  if (cfg.provider === 'konto') {
    const o = conn.secretEnc && open(conn.secretEnc);
    return o && o.konto && o.konto.refreshToken ? { environment: cfg.environment === 'test' ? 'test' : 'live', tokens: o.konto } : null;
  }
  if (cfg.provider !== 'payday') return null;
  if (cfg.credentialSource === 'railway-test') {
    const id = cleanSecret(process.env.PAYDAY_CLIENT_ID_TEST), secret = cleanSecret(process.env.PAYDAY_CLIENT_SECRET_TEST);
    return id && secret ? { environment: 'test', clientId: id, clientSecret: secret } : null;
  }
  const o = conn.secretEnc && open(conn.secretEnc);
  return o && o.clientId && o.clientSecret ? { environment: cfg.environment === 'test' ? 'test' : 'live', clientId: o.clientId, clientSecret: o.clientSecret } : null;
}

/**
 * Save settings. `patch` is what the browser sent; isAg unlocks the test environment and the
 * Railway test credentials. Returns { ok, error?, view? }.
 */
function saveConnection(operatorId, patch, { by, isAg }) {
  const cur = loadConn(operatorId);
  const next = { ...cur.config };
  let secretEnc = cur.secretEnc;
  const p = patch || {};

  if (p.provider !== undefined) {
    const prov = PROVIDERS.find(x => x.id === p.provider);
    if (p.provider !== 'none' && !prov) return { ok: false, error: 'unknown_provider' };
    if (prov && !prov.available) return { ok: false, error: 'provider_not_available' };
    if (p.provider !== next.provider) {         // a different system: its accounts and login do not carry over
      next.accounts = { ...DEFAULT_CONFIG.accounts }; next.accountLabels = { ...DEFAULT_CONFIG.accountLabels };
      next.enabled = false; secretEnc = null; next.credentialSource = 'own'; next.environment = 'live';
      next.konto = { ...DEFAULT_CONFIG.konto };
    }
    next.provider = p.provider;
  }
  if (p.environment !== undefined || p.credentialSource !== undefined) {
    if (!isAg) return { ok: false, error: 'ag_only' };
    if (p.environment !== undefined) {
      const env = p.environment === 'test' ? 'test' : 'live';
      // A Konto consent belongs to one environment: changing it drops the connection.
      if (next.provider === 'konto' && env !== next.environment) { secretEnc = null; next.enabled = false; next.konto = { ...DEFAULT_CONFIG.konto }; }
      next.environment = env;
    }
    if (p.credentialSource !== undefined) next.credentialSource = p.credentialSource === 'railway-test' ? 'railway-test' : 'own';
    if (next.credentialSource === 'railway-test') next.environment = 'test';
  }
  if (p.clientId !== undefined || p.clientSecret !== undefined) {
    const id = String(p.clientId || '').trim(), secret = String(p.clientSecret || '').trim();
    if (!id || !secret) return { ok: false, error: 'credentials_incomplete' };
    if (!encryptionReady()) return { ok: false, error: 'encryption_not_ready' };
    secretEnc = seal({ clientId: id, clientSecret: secret });
    // A login an operator pastes is for their real company; only AG keeps a test environment.
    if (!isAg) next.environment = 'live';
    next.credentialSource = 'own';
  }
  if (p.forgetCredentials === true) { secretEnc = null; next.enabled = false; }
  if (p.accounts && typeof p.accounts === 'object') {
    for (const k of ['clearing', 'sales11', 'sales24']) {
      if (p.accounts[k] !== undefined) next.accounts[k] = p.accounts[k] ? String(p.accounts[k]).slice(0, 80) : null;
    }
  }
  if (p.accountLabels && typeof p.accountLabels === 'object') {
    for (const k of ['clearing', 'sales11', 'sales24']) {
      if (p.accountLabels[k] !== undefined) next.accountLabels[k] = String(p.accountLabels[k] || '').slice(0, 120);
    }
  }
  if (p.kontoCustomer && typeof p.kontoCustomer === 'object') {
    next.konto = { customerGuid: p.kontoCustomer.guid ? String(p.kontoCustomer.guid).slice(0, 80) : null,
      customerLabel: String(p.kontoCustomer.label || '').slice(0, 120) };
  }
  if (p.entryStatus !== undefined) next.entryStatus = p.entryStatus === 'POST' ? 'POST' : 'DRAFT';
  if (next.provider === 'konto') next.entryStatus = 'DRAFT';      // Konto invoices always go in as drafts
  if (p.startDate !== undefined) {
    if (p.startDate !== null && !DAY_RE.test(String(p.startDate))) return { ok: false, error: 'bad_start_date' };
    next.startDate = p.startDate || null;
  }
  if (p.enabled !== undefined) next.enabled = p.enabled === true;

  if (next.enabled) {
    const a = next.accounts;
    if (next.provider === 'none') return { ok: false, error: 'no_provider' };
    if (next.provider === 'konto') {
      if (!next.konto.customerGuid) return { ok: false, error: 'konto_customer_missing' };
    } else {
      if (!a.clearing || !a.sales11 || !a.sales24) return { ok: false, error: 'accounts_incomplete' };
      // One sales account for both rates is fine (each line names its VAT type); the clearing
      // account booked against itself is not.
      if (a.clearing === a.sales11 || a.clearing === a.sales24) {
        return { ok: false, error: 'accounts_overlap' };
      }
    }
    if (!credentialsFor({ config: next, secretEnc })) return { ok: false, error: 'no_credentials' };
    // Switching on with no start date starts with today's sales, sent tomorrow. Never backfills
    // by surprise; a past start date has to be chosen.
    if (!next.startDate) next.startDate = todayUtc();
  }

  st.putConn.run({ operatorId, configJson: JSON.stringify(next), secretEnc, updatedAt: Date.now(), updatedBy: by || null });
  return { ok: true, view: publicView(operatorId, { isAg }) };
}

function clientFor(operatorId) {
  const conn = loadConn(operatorId);
  const creds = credentialsFor(conn);
  if (!creds) { const e = new Error('No usable credentials for ' + conn.config.provider); e.code = 'no_credentials'; throw e; }
  return { conn, api: paydayLedger.client(creds) };
}

// ── Konto: OAuth consent, and rotating tokens ────────────────────────────────

/** Store a Konto token set for an operator, leaving its settings alone. */
function saveKontoTokens(operatorId, tokens) {
  const row = st.getConn.get(operatorId);
  if (!row) throw new Error('No accounting connection to store Konto tokens on');
  st.putConn.run({ operatorId, configJson: row.configJson, secretEnc: seal({ konto: tokens }), updatedAt: Date.now(), updatedBy: row.updatedBy });
}

// Konto's refresh token is single-use, so two calls refreshing at once would kill the chain.
// Everything that talks to Konto for an operator runs one at a time, on the tokens as stored.
const kontoQueue = new Map();
function kontoRun(operatorId, fn) {
  const prev = kontoQueue.get(operatorId) || Promise.resolve();
  const p = prev.catch(() => {}).then(async () => {
    const conn = loadConn(operatorId);
    const creds = credentialsFor(conn);
    if (conn.config.provider !== 'konto' || !creds) { const e = new Error('Konto is not connected'); e.code = 'no_credentials'; throw e; }
    const api = kontoLedger.client({ environment: creds.environment, tokens: creds.tokens, saveTokens: (t) => saveKontoTokens(operatorId, t) });
    return fn(api, conn);
  });
  kontoQueue.set(operatorId, p);
  return p;
}

const kontoStates = new Map();   // state → { operatorId, by, environment, expiresAt }; one use, 15 minutes

/** Start the consent: returns the Konto URL the operator's browser goes to. */
function kontoBeginConnect(operatorId, { by, isAg }) {
  const conn = loadConn(operatorId);
  if (conn.config.provider !== 'konto') return { ok: false, error: 'no_provider' };
  if (!encryptionReady()) return { ok: false, error: 'encryption_not_ready' };
  const environment = isAg && conn.config.environment === 'test' ? 'test' : 'live';
  if (!kontoLedger.appCredentials(environment).ready) return { ok: false, error: 'konto_not_configured' };
  if (!st.getConn.get(operatorId)) return { ok: false, error: 'no_provider' };
  const now = Date.now();
  for (const [k, v] of kontoStates) if (v.expiresAt < now) kontoStates.delete(k);
  const state = crypto.randomBytes(24).toString('hex');
  kontoStates.set(state, { operatorId, by, environment, expiresAt: now + 15 * 60 * 1000 });
  return { ok: true, url: kontoLedger.authorizeUrl({ environment, state }) };
}

/** Konto sent the browser back with ?code&state. Resolves to { operatorId } or throws. */
async function kontoFinishConnect({ code, state }) {
  const st0 = kontoStates.get(String(state || ''));
  kontoStates.delete(String(state || ''));
  if (!st0 || st0.expiresAt < Date.now()) { const e = new Error('This Konto sign-in has expired or was already used. Start again from the Accounting page.'); e.code = 'bad_state'; throw e; }
  if (!code) { const e = new Error('Konto did not return a code. Consent may have been declined.'); e.code = 'no_code'; throw e; }
  const tokens = await kontoLedger.exchangeCode(st0.environment, String(code));
  const conn = loadConn(st0.operatorId);
  if (conn.config.provider !== 'konto') { const e = new Error('The operator is no longer set to Konto.'); e.code = 'no_provider'; throw e; }
  const cfg = { ...conn.config, environment: st0.environment };
  st.putConn.run({ operatorId: st0.operatorId, configJson: JSON.stringify(cfg), secretEnc: seal({ konto: tokens }), updatedAt: Date.now(), updatedBy: st0.by || null });
  console.log(`[ACCOUNTING] ${st0.by} connected operator ${st0.operatorId} to Konto (${st0.environment})`);
  return { operatorId: st0.operatorId };
}

/** Sign in and list what the pickers need: Payday's ledger accounts, or Konto's customers. */
async function testConnection(operatorId) {
  if (loadConn(operatorId).config.provider === 'konto') {
    return kontoRun(operatorId, async (api) => {
      const who = await api.company();
      const customers = await api.customers();
      return { environment: api.environment, company: who ? { name: who.company_name || null, ssn: who.registration_no || null } : null, customers };
    });
  }
  const { api } = clientFor(operatorId);
  const accounts = await api.accounts();
  const company = await api.company();
  return {
    environment: api.environment,
    company: company ? { name: company.name || null, ssn: company.ssn || company.kennitala || null } : null,
    accounts,
  };
}

/**
 * What a provider is sent for a day (or for a difference), and how it is sent. Payday gets a
 * journal entry; Konto a draft invoice. `doc.status` is what the history shows.
 */
function buildDoc(cfg, { summary, reference: ref, label }) {
  if (cfg.provider === 'konto') {
    const b = kontoLedger.buildInvoice({ day: summary.day, byRate: summary.byRate, customerGuid: cfg.konto.customerGuid, reference: ref, label });
    return { ...b, status: 'DRAFT', reference: ref };
  }
  return paydayLedger.buildJournal({ summary, accounts: cfg.accounts, status: cfg.entryStatus, reference: ref, label });
}
function senderFor(operatorId, conn) {
  if (conn.config.provider === 'konto') {
    return {
      canReplace: false,
      // The reference doubles as the idempotency key: a retried day cannot become two invoices.
      create: (doc) => kontoRun(operatorId, (api) => api.createInvoice(doc.invoice, doc.reference)),
    };
  }
  const api = paydayLedger.client(credentialsFor(conn) || {});
  return { canReplace: true, create: (doc) => api.createJournal(doc), remove: (id) => api.deleteJournal(id) };
}
/** Is everything the provider needs chosen? Returns a reason, or null. */
function notReady(cfg) {
  if (cfg.provider === 'konto') return cfg.konto.customerGuid ? null : 'No cash customer chosen: pick one under Connection.';
  return (cfg.accounts.clearing && cfg.accounts.sales11 && cfg.accounts.sales24) ? null
    : 'No saved accounts: choose all three under Accounts (each is saved when chosen).';
}

// ─── The day's sales ─────────────────────────────────────────────────────────

function todayUtc() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

/**
 * Pure summariser: line rows (as storage.reportItems returns them, payAmount in cents) → totals.
 * Kept free of storage so the tests can feed it rows.
 */
function summarize(day, rows, { notDispensed = [], nameByCode = {} } = {}) {
  const cents = { '11': 0, '24': 0 };
  const unknown = {};
  const byMachine = {};
  const orders = new Set();
  let units = 0;
  for (const r of rows) {
    const c = Number(r.payAmount) || 0;
    const q = Number(r.quantity) > 0 ? Number(r.quantity) : 1;   // a line can be several units
    orders.add(r.tradeNo); units += q;
    const m = byMachine[r.deviceCode] || (byMachine[r.deviceCode] = { deviceCode: r.deviceCode, name: nameByCode[r.deviceCode] || r.deviceCode, cents: 0, units: 0 });
    m.cents += c; m.units += q;
    if (r.vatRate === 11 || r.vatRate === 24) { cents[String(r.vatRate)] += c; continue; }
    const k = r.goodsId || ('_' + (r.name || ''));
    const u = unknown[k] || (unknown[k] = { goodsId: r.goodsId || null, name: r.name || '(unnamed)', units: 0, cents: 0 });
    u.units += q; u.cents += c;
  }
  const kr = c => Math.round(c / 100);
  const byRate = { '11': kr(cents['11']), '24': kr(cents['24']) };
  const unknownVat = Object.values(unknown).map(u => ({ goodsId: u.goodsId, name: u.name, units: u.units, grossKr: kr(u.cents) }));
  const unknownKr = unknownVat.reduce((s, u) => s + u.grossKr, 0);
  return {
    day, orders: orders.size, units,
    byRate,
    grossKr: byRate['11'] + byRate['24'] + unknownKr,
    unknownVat,
    notDispensed: { count: notDispensed.length, grossKr: kr(notDispensed.reduce((s, r) => s + (Number(r.payAmount) || 0), 0)) },
    byMachine: Object.values(byMachine).map(m => ({ deviceCode: m.deviceCode, name: m.name, units: m.units, grossKr: kr(m.cents) }))
      .sort((a, b) => b.grossKr - a.grossKr),
  };
}

function daySummary(operatorId, day) {
  const machines = storage.listMachines().filter(m => m.operatorId === operatorId);
  const codes = machines.map(m => m.deviceCode);
  const nameByCode = {}; machines.forEach(m => { nameByCode[m.deviceCode] = m.deviceName; });
  const from = Date.parse(day + 'T00:00:00Z'), to = from + 86400000;
  if (!codes.length) return summarize(day, []);
  return summarize(day, storage.reportItems(from, to, codes), { notDispensed: storage.dispenseIssues(from, to, codes), nameByCode });
}

function reference(operatorId, day) { return `SNARL-${operatorId}-${day}`; }

/** What would be sent for [day], without sending it. */
function preview(operatorId, day) {
  const conn = loadConn(operatorId);
  const summary = daySummary(operatorId, day);
  const prev = st.getExp.get(operatorId, day);
  const held = summary.unknownVat.length > 0;
  let journal = null;
  if (summary.grossKr && !held) {
    const doc = buildDoc(conn.config, { summary, reference: reference(operatorId, day) });
    if (conn.config.provider === 'konto') {
      // Shown in the same table as a journal: one line per rate, and the customer it is billed to.
      const vt = { AA: 'ReducedVAT', S: 'StandardVAT' };
      journal = { description: doc.invoice.description + ' [' + doc.reference + ']', status: 'DRAFT', kind: 'invoice', roundingKr: doc.roundingKr,
        lines: doc.invoice.items.map(i => ({ text: i.description, vatPercentType: vt[i.tax], netKr: i.unit_price,
          amount: -Math.round(summary.byRate[i.tax === 'AA' ? '11' : '24']) }))
          .concat([{ text: conn.config.konto.customerLabel || 'Konto customer', amount: Math.round(doc.invoice.amount) }]) };
    } else journal = doc;
  }
  return { summary, held, journal, accountLabels: conn.config.accountLabels, previous: prev ? exportView(prev, summary) : null };
}

function exportView(row, current) {
  let byRate = {}; try { byRate = JSON.parse(row.byRateJson || '{}'); } catch (e) {}
  let corrections = []; try { corrections = JSON.parse(row.correctionsJson || '[]'); } catch (e) {}
  const out = {
    day: row.day, provider: row.provider, status: row.status, grossKr: row.grossKr, byRate,
    externalId: row.externalId, entryStatus: row.entryStatus, reason: row.reason, attempts: row.attempts,
    sentAt: row.sentAt, sentBy: row.sentBy, lastAttemptAt: row.lastAttemptAt, corrections,
  };
  if (current && (row.status === 'sent' || row.status === 'empty')) {
    const booked = (byRate['11'] || 0) + (byRate['24'] || 0);
    const now = current.byRate['11'] + current.byRate['24'];
    out.drift = (now - booked) || 0;
    out.driftUnknownVat = current.unknownVat.length > 0;
  }
  return out;
}

function history(operatorId, limit = 45) {
  return st.listExp.all(operatorId, limit).map(r => exportView(r, (r.status === 'sent' || r.status === 'empty') ? daySummary(operatorId, r.day) : null));
}

// ─── Sending ─────────────────────────────────────────────────────────────────

const busy = new Set();      // operatorId: one send at a time per operator, scheduler or person

function record(operatorId, day, fields) {
  const prev = st.getExp.get(operatorId, day) || {};
  const row = {
    operatorId, day, provider: loadConn(operatorId).config.provider, status: 'failed', grossKr: null, byRateJson: null, externalId: null,
    entryStatus: null, reason: null, attempts: 0, lastAttemptAt: null, sentAt: null, sentBy: null, correctionsJson: '[]',
    ...prev, ...fields,
  };
  st.putExp.run(row);
  return row;
}

/**
 * Send [day] for [operatorId]. by = 'scheduled' or a user id.
 * Outcomes: sent | replaced | corrected | unchanged | empty | held | failed | uncertain.
 */
async function sendDay(operatorId, day, { by = 'scheduled', force = false } = {}) {
  if (!DAY_RE.test(day)) throw new Error('bad day');
  if (day >= todayUtc()) return { outcome: 'refused', reason: 'Only a finished day can be sent.' };
  if (busy.has(operatorId)) return { outcome: 'busy' };
  busy.add(operatorId);
  try {
    const conn = loadConn(operatorId);
    const cfg = conn.config;
    if (!SENDABLE.has(cfg.provider)) return { outcome: 'refused', reason: 'No accounting system is chosen.' };
    const missing = notReady(cfg);
    if (missing) return { outcome: 'refused', reason: missing };
    const sys = provName(cfg.provider);
    const prev = st.getExp.get(operatorId, day);
    // A 'sending' row outlives its send only if the process died mid-call: after ten minutes it
    // is as uncertain as a timeout.
    const stale = prev && prev.status === 'sending' && Date.now() - (prev.lastAttemptAt || 0) > 10 * 60 * 1000;
    if (prev && prev.status === 'sending' && !stale) {
      return { outcome: 'refused', reason: 'A send for this day is already in progress.' };
    }
    if (prev && (prev.status === 'uncertain' || stale) && !force) {
      return { outcome: 'refused', reason: `The last send may have reached ${sys}. Check its drafts before sending again.` };
    }

    const summary = daySummary(operatorId, day);
    const attempts = (prev && prev.attempts || 0) + 1;
    const now = Date.now();
    if (summary.unknownVat.length) {
      // A day already sent stays sent; only an unsent day is held.
      if (prev && (prev.status === 'sent' || prev.status === 'empty')) {
        return { outcome: 'refused', reason: 'Sales on this day now include products with no VAT rate. Set them first.', summary };
      }
      record(operatorId, day, { status: 'held', reason: 'No VAT rate: ' + summary.unknownVat.map(u => u.name).join(', ').slice(0, 300),
        grossKr: summary.grossKr, attempts, lastAttemptAt: now });
      return { outcome: 'held', summary };
    }

    const sender = senderFor(operatorId, conn);
    const ref = reference(operatorId, day);
    const target = { '11': summary.byRate['11'], '24': summary.byRate['24'] };

    // ── A day already booked: replace the draft, or book the difference.
    if (prev && (prev.status === 'sent' || prev.status === 'empty')) {
      let booked = {}; try { booked = JSON.parse(prev.byRateJson || '{}'); } catch (e) {}
      const delta = { '11': target['11'] - (booked['11'] || 0), '24': target['24'] - (booked['24'] || 0) };
      if (!delta['11'] && !delta['24']) return { outcome: 'unchanged', summary };
      if (!credentialsFor(conn)) return { outcome: 'refused', reason: 'The connection has no usable credentials.' };
      let corrections = []; try { corrections = JSON.parse(prev.correctionsJson || '[]'); } catch (e) {}

      if (sender.canReplace && prev.externalId && prev.entryStatus === 'DRAFT' && !corrections.length) {
        let deleted = false;
        try { await sender.remove(prev.externalId); deleted = true; } catch (e) { /* posted meanwhile: book the difference */ }
        if (deleted) {
          record(operatorId, day, { status: 'sending', lastAttemptAt: now, attempts });
          return await createAndRecord({ operatorId, day, sender, cfg, summary, ref, by, attempts, outcome: 'replaced' });
        }
      }
      // An invoice cannot be negative, and the API can neither edit nor delete one: a day whose
      // sales went DOWN has to be adjusted in Konto by hand.
      if (cfg.provider === 'konto' && (delta['11'] < 0 || delta['24'] < 0)) {
        return { outcome: 'refused', summary,
          reason: `Sales for this day went down (11%: ${delta['11']} kr, 24%: ${delta['24']} kr). Konto invoices cannot be reduced from here: adjust the draft in Konto.` };
      }
      const n = corrections.length + 1;
      const journal = buildDoc(cfg, { summary: { day, byRate: delta }, reference: ref + '-L' + n, label: 'Leiðrétting sölu' });
      record(operatorId, day, { status: 'sending', lastAttemptAt: now });
      try {
        const res = await sender.create(journal);
        corrections.push({ at: Date.now(), by, byRate: delta, externalId: res.id, entryStatus: journal.status });
        record(operatorId, day, { status: 'sent', grossKr: target['11'] + target['24'], byRateJson: JSON.stringify(target),
          correctionsJson: JSON.stringify(corrections), reason: null });
        console.log(`[ACCOUNTING] ${operatorId} ${day}: correction ${n} booked (${delta['11']} / ${delta['24']} kr)`);
        return { outcome: 'corrected', summary, delta };
      } catch (e) {
        // The day stays sent with its old totals; the correction did not land (or may have).
        record(operatorId, day, { status: 'sent', reason: (e.status ? 'Correction failed: ' : `Correction outcome unknown, check ${sys}: `) + e.message });
        return { outcome: e.status ? 'failed' : 'uncertain', reason: e.message, summary };
      }
    }

    // ── First send of this day.
    if (!credentialsFor(conn)) {
      record(operatorId, day, { status: 'failed', reason: 'No usable credentials', attempts, lastAttemptAt: now });
      return { outcome: 'failed', reason: 'No usable credentials' };
    }
    if (!summary.grossKr) {
      record(operatorId, day, { status: 'empty', grossKr: 0, byRateJson: JSON.stringify(target), reason: null, attempts, lastAttemptAt: now, sentAt: now, sentBy: by });
      return { outcome: 'empty', summary };
    }
    record(operatorId, day, { status: 'sending', lastAttemptAt: now, attempts });
    return await createAndRecord({ operatorId, day, sender, cfg, summary, ref, by, attempts, outcome: 'sent' });
  } finally {
    busy.delete(operatorId);
  }
}

async function createAndRecord({ operatorId, day, sender, cfg, summary, ref, by, attempts, outcome }) {
  const journal = buildDoc(cfg, { summary, reference: ref });
  const target = { '11': summary.byRate['11'], '24': summary.byRate['24'] };
  try {
    const res = await sender.create(journal);
    record(operatorId, day, { status: 'sent', grossKr: target['11'] + target['24'], byRateJson: JSON.stringify(target),
      externalId: res.id, entryStatus: journal.status, reason: null, attempts, sentAt: Date.now(), sentBy: by, correctionsJson: '[]' });
    console.log(`[ACCOUNTING] ${operatorId} ${day}: ${outcome}, ${target['11'] + target['24']} kr as ${journal.status}${res.id ? ' (' + res.id + ')' : ''}`);
    return { outcome, summary, externalId: res.id };
  } catch (e) {
    // An HTTP answer means the accounting system refused it: nothing was created, a retry is safe. No answer
    // means it may or may not exist, and only a person looking there can tell. (A Konto token
    // failure has no status either, but is thrown before the invoice is sent: see below.)
    const status = (e.status || e.code === 'no_credentials' || e.code === 'konto_not_configured') ? 'failed' : 'uncertain';
    record(operatorId, day, { status, reason: String(e.message || e).slice(0, 500), attempts });
    console.warn(`[ACCOUNTING] ${operatorId} ${day}: ${status}: ${e.message}`);
    // What was sent, so a refusal can be read against it. Ledger ids and amounts only, no login.
    console.warn(`[ACCOUNTING] ${operatorId} ${day}: sent body ${JSON.stringify(journal)}`);
    return { outcome: status, reason: e.message, summary };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/** Days the scheduler should try now for one operator: unsent, held, or failed-and-due. */
function dueDays(config, rowsByDay, today, nowMs) {
  if (!config.enabled || !SENDABLE.has(config.provider) || !config.startDate) return [];
  const out = [];
  for (let i = CATCH_UP_DAYS; i >= 1; i--) {
    const day = addDays(today, -i);
    if (day < config.startDate) continue;
    const r = rowsByDay[day];
    if (!r) { out.push(day); continue; }
    const hourAgo = !r.lastAttemptAt || nowMs - r.lastAttemptAt >= 3600 * 1000;
    if (r.status === 'held' && hourAgo) out.push(day);
    else if (r.status === 'failed' && hourAgo && (r.attempts || 0) < MAX_AUTO_ATTEMPTS) out.push(day);
    // sent / empty / uncertain / sending: never automatically
  }
  return out;
}

async function tick() {
  const now = new Date();
  if (now.getUTCHours() < SEND_HOUR_UTC) return;
  const today = now.toISOString().slice(0, 10);
  for (const row of st.allConns.all()) {
    const { config } = loadConn(row.operatorId);
    const rows = {};
    st.listExp.all(row.operatorId, CATCH_UP_DAYS + 2).forEach(r => { rows[r.day] = r; });
    for (const day of dueDays(config, rows, today, Date.now())) {
      try { await sendDay(row.operatorId, day, { by: 'scheduled' }); }
      catch (e) { console.error(`[ACCOUNTING] ${row.operatorId} ${day} tick error:`, e && e.message); }
    }
  }
}

function startScheduler() {
  let inFlight = false;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try { await tick(); } catch (e) { console.error('[ACCOUNTING] tick failed:', e && e.message); }
    finally { inFlight = false; }
  };
  setTimeout(run, 3 * 60 * 1000);
  setInterval(run, 10 * 60 * 1000).unref();
  console.log(`[ACCOUNTING] daily send enabled (from ${String(SEND_HOUR_UTC).padStart(2, '0')}:00 UTC; key ${encryptionReady() ? 'set' : 'NOT set'})`);
}

module.exports = {
  PROVIDERS, publicView, saveConnection, testConnection, preview, history, sendDay, startScheduler,
  encryptionReady, diagnoseRailwayTest, kontoBeginConnect, kontoFinishConnect,
  _test: { summarize, dueDays, seal, open, addDays },
};
