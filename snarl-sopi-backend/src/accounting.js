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
  { id: 'konto', name: 'Konto', available: false },
  { id: 'businesscentral', name: 'Business Central', available: false },
];

const SEND_HOUR_UTC = Number(process.env.ACCOUNTING_SEND_HOUR_UTC) >= 0 ? Number(process.env.ACCOUNTING_SEND_HOUR_UTC) : 6;
const CATCH_UP_DAYS = 7;          // after downtime, the scheduler fills in at most this many days
const MAX_AUTO_ATTEMPTS = 6;      // a failing day is retried hourly this many times, then left to a person
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
};

function loadConn(operatorId) {
  const row = st.getConn.get(operatorId);
  let cfg = {};
  try { cfg = row ? JSON.parse(row.configJson || '{}') : {}; } catch (e) { cfg = {}; }
  const config = { ...DEFAULT_CONFIG, ...cfg,
    accounts: { ...DEFAULT_CONFIG.accounts, ...(cfg.accounts || {}) },
    accountLabels: { ...DEFAULT_CONFIG.accountLabels, ...(cfg.accountLabels || {}) } };
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
    }
    next.provider = p.provider;
  }
  if (p.environment !== undefined || p.credentialSource !== undefined) {
    if (!isAg) return { ok: false, error: 'ag_only' };
    if (p.environment !== undefined) next.environment = p.environment === 'test' ? 'test' : 'live';
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
  if (p.entryStatus !== undefined) next.entryStatus = p.entryStatus === 'POST' ? 'POST' : 'DRAFT';
  if (p.startDate !== undefined) {
    if (p.startDate !== null && !DAY_RE.test(String(p.startDate))) return { ok: false, error: 'bad_start_date' };
    next.startDate = p.startDate || null;
  }
  if (p.enabled !== undefined) next.enabled = p.enabled === true;

  if (next.enabled) {
    const a = next.accounts;
    if (next.provider === 'none') return { ok: false, error: 'no_provider' };
    if (!a.clearing || !a.sales11 || !a.sales24) return { ok: false, error: 'accounts_incomplete' };
    // One sales account for both rates is fine (each line names its VAT type); the clearing
    // account booked against itself is not.
    if (a.clearing === a.sales11 || a.clearing === a.sales24) {
      return { ok: false, error: 'accounts_overlap' };
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

/** Sign in and list ledger accounts: the "test connection" button, and the account pickers. */
async function testConnection(operatorId) {
  const { api } = clientFor(operatorId);
  const accounts = await api.accounts();
  const company = await api.company();
  return {
    environment: api.environment,
    company: company ? { name: company.name || null, ssn: company.ssn || company.kennitala || null } : null,
    accounts,
  };
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
    orders.add(r.tradeNo); units++;
    const m = byMachine[r.deviceCode] || (byMachine[r.deviceCode] = { deviceCode: r.deviceCode, name: nameByCode[r.deviceCode] || r.deviceCode, cents: 0, units: 0 });
    m.cents += c; m.units++;
    if (r.vatRate === 11 || r.vatRate === 24) { cents[String(r.vatRate)] += c; continue; }
    const k = r.goodsId || ('_' + (r.name || ''));
    const u = unknown[k] || (unknown[k] = { goodsId: r.goodsId || null, name: r.name || '(unnamed)', units: 0, cents: 0 });
    u.units++; u.cents += c;
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
  const journal = summary.grossKr && !held
    ? paydayLedger.buildJournal({ summary, accounts: conn.config.accounts, status: conn.config.entryStatus, reference: reference(operatorId, day) })
    : null;
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
    operatorId, day, provider: 'payday', status: 'failed', grossKr: null, byRateJson: null, externalId: null,
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
    if (cfg.provider !== 'payday') return { outcome: 'refused', reason: 'No accounting system is chosen.' };
    if (!cfg.accounts.clearing || !cfg.accounts.sales11 || !cfg.accounts.sales24) {
      return { outcome: 'refused', reason: 'No saved accounts: choose all three under Accounts (each is saved when chosen).' };
    }
    const prev = st.getExp.get(operatorId, day);
    // A 'sending' row outlives its send only if the process died mid-call: after ten minutes it
    // is as uncertain as a timeout.
    const stale = prev && prev.status === 'sending' && Date.now() - (prev.lastAttemptAt || 0) > 10 * 60 * 1000;
    if (prev && prev.status === 'sending' && !stale) {
      return { outcome: 'refused', reason: 'A send for this day is already in progress.' };
    }
    if (prev && (prev.status === 'uncertain' || stale) && !force) {
      return { outcome: 'refused', reason: 'The last send may have reached Payday. Check its drafts before sending again.' };
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

    const api = paydayLedger.client(credentialsFor(conn) || {});
    const ref = reference(operatorId, day);
    const target = { '11': summary.byRate['11'], '24': summary.byRate['24'] };

    // ── A day already booked: replace the draft, or book the difference.
    if (prev && (prev.status === 'sent' || prev.status === 'empty')) {
      let booked = {}; try { booked = JSON.parse(prev.byRateJson || '{}'); } catch (e) {}
      const delta = { '11': target['11'] - (booked['11'] || 0), '24': target['24'] - (booked['24'] || 0) };
      if (!delta['11'] && !delta['24']) return { outcome: 'unchanged', summary };
      if (!credentialsFor(conn)) return { outcome: 'refused', reason: 'The connection has no usable credentials.' };
      let corrections = []; try { corrections = JSON.parse(prev.correctionsJson || '[]'); } catch (e) {}

      if (prev.externalId && prev.entryStatus === 'DRAFT' && !corrections.length) {
        let deleted = false;
        try { await api.deleteJournal(prev.externalId); deleted = true; } catch (e) { /* posted meanwhile: book the difference */ }
        if (deleted) {
          record(operatorId, day, { status: 'sending', lastAttemptAt: now, attempts });
          return await createAndRecord({ operatorId, day, api, cfg, summary, ref, by, attempts, outcome: 'replaced' });
        }
      }
      const n = corrections.length + 1;
      const journal = paydayLedger.buildJournal({ summary: { day, byRate: delta }, accounts: cfg.accounts, status: cfg.entryStatus,
        reference: ref + '-L' + n, label: 'Leiðrétting sölu' });
      record(operatorId, day, { status: 'sending', lastAttemptAt: now });
      try {
        const res = await api.createJournal(journal);
        corrections.push({ at: Date.now(), by, byRate: delta, externalId: res.id, entryStatus: journal.status });
        record(operatorId, day, { status: 'sent', grossKr: target['11'] + target['24'], byRateJson: JSON.stringify(target),
          correctionsJson: JSON.stringify(corrections), reason: null });
        console.log(`[ACCOUNTING] ${operatorId} ${day}: correction ${n} booked (${delta['11']} / ${delta['24']} kr)`);
        return { outcome: 'corrected', summary, delta };
      } catch (e) {
        // The day stays sent with its old totals; the correction did not land (or may have).
        record(operatorId, day, { status: 'sent', reason: (e.status ? 'Correction failed: ' : 'Correction outcome unknown, check Payday: ') + e.message });
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
    return await createAndRecord({ operatorId, day, api, cfg, summary, ref, by, attempts, outcome: 'sent' });
  } finally {
    busy.delete(operatorId);
  }
}

async function createAndRecord({ operatorId, day, api, cfg, summary, ref, by, attempts, outcome }) {
  const journal = paydayLedger.buildJournal({ summary, accounts: cfg.accounts, status: cfg.entryStatus, reference: ref });
  const target = { '11': summary.byRate['11'], '24': summary.byRate['24'] };
  try {
    const res = await api.createJournal(journal);
    record(operatorId, day, { status: 'sent', grossKr: target['11'] + target['24'], byRateJson: JSON.stringify(target),
      externalId: res.id, entryStatus: journal.status, reason: null, attempts, sentAt: Date.now(), sentBy: by, correctionsJson: '[]' });
    console.log(`[ACCOUNTING] ${operatorId} ${day}: ${outcome}, ${target['11'] + target['24']} kr as ${journal.status}${res.id ? ' (' + res.id + ')' : ''}`);
    return { outcome, summary, externalId: res.id };
  } catch (e) {
    // An HTTP answer means Payday refused it: nothing was created, a retry is safe. No answer
    // means it may or may not exist, and only a person looking at Payday can tell.
    const status = e.status ? 'failed' : 'uncertain';
    record(operatorId, day, { status, reason: String(e.message || e).slice(0, 500), attempts });
    console.warn(`[ACCOUNTING] ${operatorId} ${day}: ${status}: ${e.message}`);
    return { outcome: status, reason: e.message, summary };
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/** Days the scheduler should try now for one operator: unsent, held, or failed-and-due. */
function dueDays(config, rowsByDay, today, nowMs) {
  if (!config.enabled || config.provider !== 'payday' || !config.startDate) return [];
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
  encryptionReady, diagnoseRailwayTest,
  _test: { summarize, dueDays, seal, open, addDays },
};
