'use strict';
/**
 * What is in each box of a parcel locker, and how it got there and left.
 *
 *   order    something a shop has said will be put in a locker: an order number with the
 *            customer's phone and first name. Orders belong to an operator, not to one locker.
 *   parcel   one stay of one order in one box. It is `opening` from the moment a box is given
 *            to it until the locker says the door closed on it, then `stored`, then `collected`
 *            (the customer or the operator took it), `cleared` (the operator emptied the box)
 *            or `cancelled` (the deposit never completed).
 *
 * Rules that live here:
 *   - a deposit starts only from an order the shop has reported, and each order once
 *   - a pickup starts only from the parcel's six-digit code or its link token; neither is
 *     derived from the order number, so knowing an order number opens nothing
 *   - a box holds one parcel; a box out of service is never given to a new one
 *   - wrong pickup codes are counted per locker and refused for a while past a limit
 *
 * The box list and the locker's own details are in src/lockers.js (settings.locker). This
 * module keeps its own tables. It sends nothing: the SMS and the pickup page read from it.
 */
const crypto = require('crypto');
const storage = require('./storage');
const lockers = require('./lockers');

const db = storage.db;

db.exec(`
  CREATE TABLE IF NOT EXISTS locker_orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operatorId  TEXT NOT NULL,
    orderNumber TEXT NOT NULL COLLATE NOCASE,
    phone       TEXT NOT NULL,
    firstName   TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    status      TEXT NOT NULL DEFAULT 'expected',
    createdAt   TEXT NOT NULL,
    updatedAt   TEXT NOT NULL,
    UNIQUE (operatorId, orderNumber)
  );
  CREATE TABLE IF NOT EXISTS locker_parcels (
    id          TEXT PRIMARY KEY,
    deviceCode  TEXT NOT NULL,
    operatorId  TEXT NOT NULL,
    boxN        INTEGER NOT NULL,
    orderId     INTEGER,
    orderNumber TEXT NOT NULL,
    phone       TEXT NOT NULL,
    firstName   TEXT NOT NULL DEFAULT '',
    code        TEXT,
    token       TEXT,
    state       TEXT NOT NULL,
    createdAt   TEXT NOT NULL,
    storedAt    TEXT,
    endedAt     TEXT,
    endedBy     TEXT,
    endReason   TEXT,
    notifiedAt  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_locker_parcels_device ON locker_parcels(deviceCode, state);
  CREATE INDEX IF NOT EXISTS idx_locker_parcels_order  ON locker_parcels(orderId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_locker_parcels_token ON locker_parcels(token) WHERE token IS NOT NULL;
  CREATE TABLE IF NOT EXISTS locker_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceCode TEXT NOT NULL,
    parcelId   TEXT,
    boxN       INTEGER,
    type       TEXT NOT NULL,
    actor      TEXT,
    detail     TEXT,
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_locker_events_device ON locker_events(deviceCode, at);
  CREATE INDEX IF NOT EXISTS idx_locker_events_parcel ON locker_events(parcelId);
  CREATE TABLE IF NOT EXISTS locker_sms (
    sid        TEXT PRIMARY KEY,
    parcelId   TEXT NOT NULL,
    deviceCode TEXT NOT NULL,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL,
    errorCode  TEXT,
    createdAt  TEXT NOT NULL,
    updatedAt  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_locker_sms_parcel ON locker_sms(parcelId, createdAt);
  CREATE TABLE IF NOT EXISTS locker_box_state (
    deviceCode   TEXT NOT NULL,
    boxN         INTEGER NOT NULL,
    outOfService INTEGER NOT NULL DEFAULT 0,
    reason       TEXT,
    by           TEXT,
    at           TEXT NOT NULL,
    PRIMARY KEY (deviceCode, boxN)
  );
`);

const ACTIVE = ['opening', 'stored'];          // states in which a parcel holds its box
const WRONG_CODE_LIMIT = 5;                    // wrong codes at one locker ...
const WRONG_CODE_WINDOW_MS = 5 * 60 * 1000;    // ... within this long, before codes are refused
const TOKEN_LENGTH = 12;
// No 0/o, 1/l/i: the token is also read aloud to support and typed from a screenshot.
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const q = {
  orderByNumber: db.prepare('SELECT * FROM locker_orders WHERE operatorId = ? AND orderNumber = ?'),
  orderById: db.prepare('SELECT * FROM locker_orders WHERE id = ?'),
  insertOrder: db.prepare(`INSERT INTO locker_orders (operatorId, orderNumber, phone, firstName, source, status, createdAt, updatedAt)
                           VALUES (?, ?, ?, ?, ?, 'expected', ?, ?)`),
  updateOrder: db.prepare('UPDATE locker_orders SET phone = ?, firstName = ?, source = ?, updatedAt = ? WHERE id = ?'),
  setOrderStatus: db.prepare('UPDATE locker_orders SET status = ?, updatedAt = ? WHERE id = ?'),
  listOrders: db.prepare('SELECT * FROM locker_orders WHERE operatorId = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?'),

  parcelById: db.prepare('SELECT * FROM locker_parcels WHERE id = ?'),
  activeAtDevice: db.prepare(`SELECT * FROM locker_parcels WHERE deviceCode = ? AND state IN ('opening','stored') ORDER BY boxN`),
  activeForOrder: db.prepare(`SELECT * FROM locker_parcels WHERE orderId = ? AND state IN ('opening','stored')`),
  storedByCode: db.prepare(`SELECT * FROM locker_parcels WHERE deviceCode = ? AND state = 'stored' AND code = ?`),
  byToken: db.prepare('SELECT * FROM locker_parcels WHERE token = ?'),
  insertParcel: db.prepare(`INSERT INTO locker_parcels (id, deviceCode, operatorId, boxN, orderId, orderNumber, phone, firstName, state, createdAt)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'opening', ?)`),
  storeParcel: db.prepare(`UPDATE locker_parcels SET state = 'stored', code = ?, token = ?, storedAt = ? WHERE id = ?`),
  endParcel: db.prepare('UPDATE locker_parcels SET state = ?, endedAt = ?, endedBy = ?, endReason = ? WHERE id = ?'),
  listParcels: db.prepare(`SELECT * FROM locker_parcels WHERE deviceCode = ? AND (? IS NULL OR state = ?) ORDER BY createdAt DESC LIMIT ?`),

  insertEvent: db.prepare('INSERT INTO locker_events (deviceCode, parcelId, boxN, type, actor, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  eventsOfParcel: db.prepare('SELECT type, actor, detail, boxN, at FROM locker_events WHERE parcelId = ? ORDER BY id'),
  wrongCodesSince: db.prepare(`SELECT COUNT(*) AS c FROM locker_events WHERE deviceCode = ? AND type = 'wrong_code' AND at >= ?`),

  insertSms: db.prepare('INSERT OR IGNORE INTO locker_sms (sid, parcelId, deviceCode, kind, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  smsBySid: db.prepare('SELECT * FROM locker_sms WHERE sid = ?'),
  updateSms: db.prepare('UPDATE locker_sms SET status = ?, errorCode = ?, updatedAt = ? WHERE sid = ?'),
  lastSms: db.prepare('SELECT kind, status, errorCode, createdAt, updatedAt FROM locker_sms WHERE parcelId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1'),
  setNotified: db.prepare('UPDATE locker_parcels SET notifiedAt = COALESCE(notifiedAt, ?) WHERE id = ?'),
  needReminder: db.prepare(`SELECT id FROM locker_parcels p WHERE state = 'stored' AND storedAt < ?
                            AND NOT EXISTS (SELECT 1 FROM locker_events e WHERE e.parcelId = p.id AND e.type = 'reminder_attempted')`),
  boxStates: db.prepare('SELECT * FROM locker_box_state WHERE deviceCode = ?'),
  setBoxState: db.prepare(`INSERT INTO locker_box_state (deviceCode, boxN, outOfService, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT(deviceCode, boxN) DO UPDATE SET outOfService = excluded.outOfService, reason = excluded.reason, by = excluded.by, at = excluded.at`),
};

// ── Small pure pieces ─────────────────────────────────────────────────────────────────────────

function fail(status, code, error, extra) { return { ok: false, status, code, error, ...(extra || {}) }; }
const iso = (ms) => new Date(ms).toISOString();

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** An order number as it is matched: trimmed, a leading # dropped. Staff sometimes use a word. */
function normalizeOrderNumber(value) {
  const s = cleanText(value, 80).replace(/^#\s*/, '');
  return s.length >= 1 && s.length <= 40 ? s : null;
}

/** A phone number as +<digits>. Seven digits are an Icelandic number. Null when it is not one. */
function normalizePhone(value) {
  let s = String(value == null ? '' : value).replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\d{7}$/.test(s)) return '+354' + s;
  if (/^354\d{7}$/.test(s)) return '+' + s;
  if (/^\+\d{8,15}$/.test(s)) return s;
  return null;
}

/** The first word of a name: enough to recognise a parcel by, and no more than that. */
function firstNameOf(value) {
  return cleanText(value, 80).split(' ')[0].slice(0, 40);
}

function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

function newToken() {
  let s = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) s += TOKEN_ALPHABET[crypto.randomInt(0, TOKEN_ALPHABET.length)];
  return s;
}

/**
 * The token in what a scanner read: the link from the SMS page (possibly read twice and run
 * together) or the bare token. Null when the scan holds none.
 */
function tokenFromScan(scan) {
  const s = String(scan == null ? '' : scan).trim();
  const link = s.match(/\/p\/([a-z0-9]{12})(?![a-z0-9])/i);
  if (link) return link[1].toLowerCase();
  return /^[a-z0-9]{12}$/i.test(s) ? s.toLowerCase() : null;
}

/** The lowest-numbered box of `size` that is neither held by a parcel nor out of service. */
function pickBox(boxes, busy, closed, size) {
  for (const b of boxes || []) {
    if (b.size === size && !busy.has(b.n) && !closed.has(b.n)) return b;
  }
  return null;
}

function freeCounts(boxes, busy, closed) {
  const counts = { small: 0, middle: 0, big: 0 };
  for (const b of boxes || []) if (!busy.has(b.n) && !closed.has(b.n) && counts[b.size] !== undefined) counts[b.size]++;
  return counts;
}

// ── Reading a locker's state ──────────────────────────────────────────────────────────────────

function boxesOf(machine) { return lockers.lockerRecord(machine).boxes; }

function occupancy(machine) {
  const active = q.activeAtDevice.all(machine.deviceCode);
  const busy = new Set(active.map(p => p.boxN));
  const states = q.boxStates.all(machine.deviceCode);
  const closed = new Set(states.filter(s => s.outOfService).map(s => s.boxN));
  return { active, busy, closed, states };
}

function event(deviceCode, parcelId, boxN, type, actor, detail, now) {
  q.insertEvent.run(deviceCode, parcelId || null, boxN == null ? null : boxN, type, actor || null, detail || null, iso(now));
}

function wiring(machine, boxN) {
  const b = boxesOf(machine).find(x => x.n === boxN);
  return b ? { n: b.n, size: b.size, board: b.board, lock: b.lock } : { n: boxN, size: null, board: null, lock: null };
}

/** A parcel as the dashboard shows it: the last four digits of the phone, and no pickup code. */
function parcelView(p, now) {
  if (!p) return null;
  return {
    id: p.id, deviceCode: p.deviceCode, boxN: p.boxN, orderNumber: p.orderNumber, firstName: p.firstName, phoneTail: p.phone ? p.phone.slice(-4) : '',
    state: p.state, createdAt: p.createdAt, storedAt: p.storedAt, endedAt: p.endedAt, endedBy: p.endedBy, endReason: p.endReason,
    notifiedAt: p.notifiedAt, sms: q.lastSms.get(p.id) || null,
    hoursStored: p.state === 'stored' && p.storedAt ? Math.floor((now - Date.parse(p.storedAt)) / 3600000) : null,
  };
}

function orderView(o) {
  return o && { id: o.id, orderNumber: o.orderNumber, phone: o.phone, firstName: o.firstName, source: o.source, status: o.status,
                createdAt: o.createdAt, updatedAt: o.updatedAt };
}

/**
 * Every box of a locker with what is in it: the operator's view.
 * A box is `occupied` (a parcel is stored), `opening` (given to a deposit the locker has not
 * confirmed yet), `out_of_service` or `vacant`.
 */
function boxView(machine, now = Date.now()) {
  const { active, states } = occupancy(machine);
  const byBox = new Map(active.map(p => [p.boxN, p]));
  const stateOf = new Map(states.map(s => [s.boxN, s]));
  const counts = { vacant: 0, occupied: 0, opening: 0, out_of_service: 0 };
  const boxes = boxesOf(machine).map(b => {
    const p = byBox.get(b.n) || null;
    const s = stateOf.get(b.n);
    const out = !!(s && s.outOfService);
    const state = p ? (p.state === 'stored' ? 'occupied' : 'opening') : out ? 'out_of_service' : 'vacant';
    counts[state]++;
    byBox.delete(b.n);
    return { n: b.n, size: b.size, state, outOfService: out ? { reason: s.reason || '', by: s.by || null, at: s.at } : null,
             parcel: parcelView(p, now) };
  });
  // Parcels in a box number the box list no longer has: never hidden.
  const unplaced = [...byBox.values()].map(p => parcelView(p, now));
  return { deviceCode: machine.deviceCode, model: machine.model || '', boxes, counts, unplaced };
}

function getParcel(machine, parcelId, now = Date.now()) {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  return { ok: true, parcel: parcelView(p, now), events: q.eventsOfParcel.all(p.id) };
}

/**
 * The pickup code of a stored parcel, for an operator helping a customer at the locker. Asking
 * is written to the parcel's history with who asked.
 */
function revealCode(machine, parcelId, who, now = Date.now()) {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  if (p.state !== 'stored') return fail(409, 'wrong_state', `This parcel is ${p.state}; it has no working code.`);
  event(machine.deviceCode, p.id, p.boxN, 'code_shown', who || 'operator', null, now);
  return { ok: true, code: p.code };
}

function listParcels(machine, { state, limit } = {}, now = Date.now()) {
  const st = state ? String(state) : null;
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return q.listParcels.all(machine.deviceCode, st, st, n).map(p => parcelView(p, now));
}

// ── Orders ────────────────────────────────────────────────────────────────────────────────────

/**
 * Records that an order is coming to a locker. Reporting an order again before it is deposited
 * corrects its phone and name; after that it changes nothing.
 */
function registerOrder(operatorId, input, now = Date.now()) {
  if (!operatorId) return fail(400, 'bad_request', 'operatorId is required.');
  const orderNumber = normalizeOrderNumber(input && input.orderNumber);
  if (!orderNumber) return fail(400, 'bad_order_number', 'orderNumber must be 1 to 40 characters.');
  const phone = normalizePhone(input && input.phone);
  if (!phone) return fail(400, 'bad_phone', 'phone must be a phone number: 7 digits, or with a country code.');
  const firstName = firstNameOf(input && input.firstName);
  const source = cleanText((input && input.source) || 'manual', 20) || 'manual';
  const existing = q.orderByNumber.get(operatorId, orderNumber);
  if (!existing) {
    const r = q.insertOrder.run(operatorId, orderNumber, phone, firstName, source, iso(now), iso(now));
    return { ok: true, created: true, order: orderView(q.orderById.get(r.lastInsertRowid)) };
  }
  if (existing.status === 'expected' && !q.activeForOrder.get(existing.id)) {
    q.updateOrder.run(phone, firstName, source, iso(now), existing.id);
    return { ok: true, created: false, order: orderView(q.orderById.get(existing.id)) };
  }
  return { ok: true, created: false, unchanged: true, order: orderView(existing) };
}

function listOrders(operatorId, { status, limit } = {}) {
  const st = status ? String(status) : null;
  return q.listOrders.all(operatorId, st, st, Math.max(1, Math.min(500, Number(limit) || 100))).map(orderView);
}

/** How many of an operator's orders are in each status: { expected, deposited, cancelled }. */
function orderCounts(operatorId) {
  const out = { expected: 0, deposited: 0, cancelled: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM locker_orders WHERE operatorId = ? GROUP BY status').all(operatorId)) out[r.status] = r.c;
  return out;
}

/** Withdraws an order that has not been put in a locker. */
function cancelOrder(operatorId, orderId, now = Date.now()) {
  const o = q.orderById.get(Number(orderId));
  if (!o || o.operatorId !== operatorId) return fail(404, 'order_not_found', 'No such order.');
  if (o.status !== 'expected' || q.activeForOrder.get(o.id)) return fail(409, 'order_used', 'This order is already in a locker or has been.');
  q.setOrderStatus.run('cancelled', iso(now), o.id);
  return { ok: true, order: orderView(q.orderById.get(o.id)) };
}

// ── Deposit (the locker) ──────────────────────────────────────────────────────────────────────

function expectedOrder(machine, rawOrderNumber) {
  const orderNumber = normalizeOrderNumber(rawOrderNumber);
  if (!orderNumber) return fail(400, 'bad_order_number', 'orderNumber must be 1 to 40 characters.');
  const o = q.orderByNumber.get(machine.operatorId, orderNumber);
  if (!o || o.status === 'cancelled') return fail(404, 'order_not_found', 'This order has not been reported for a locker.');
  if (o.status !== 'expected') return fail(409, 'order_used', 'This order has already been put in a locker.');
  return { ok: true, order: o };
}

/** What the locker shows after a scan: whose order it is and which sizes are free. */
function lookupForDeposit(machine, rawOrderNumber) {
  const r = expectedOrder(machine, rawOrderNumber);
  if (!r.ok) return r;
  const { busy, closed } = occupancy(machine);
  const held = q.activeForOrder.get(r.order.id);
  if (held && held.deviceCode !== machine.deviceCode) return fail(409, 'order_used', 'This order is being put in another locker.');
  return { ok: true, order: { orderNumber: r.order.orderNumber, firstName: r.order.firstName },
           free: freeCounts(boxesOf(machine), busy, closed), resume: held ? { parcelId: held.id, box: wiring(machine, held.boxN) } : null };
}

/**
 * Gives the order a box and tells the locker which door to open. A deposit of the same order
 * that was started here and never finished gets its box back, so a parcel already behind that
 * door is not left there while a second box is opened.
 */
const startDeposit = db.transaction((machine, input, now = Date.now()) => {
  const r = expectedOrder(machine, input && input.orderNumber);
  if (!r.ok) return r;
  const o = r.order;
  const held = q.activeForOrder.get(o.id);
  if (held) {
    if (held.deviceCode !== machine.deviceCode) return fail(409, 'order_used', 'This order is being put in another locker.');
    event(machine.deviceCode, held.id, held.boxN, 'deposit_resumed', 'locker', null, now);
    return { ok: true, resumed: true, parcelId: held.id, box: wiring(machine, held.boxN) };
  }
  const size = input && input.size;
  if (!lockers.BOX_SIZES.includes(size)) return fail(400, 'bad_size', `size must be one of ${lockers.BOX_SIZES.join(', ')}.`);
  const { busy, closed } = occupancy(machine);
  const boxes = boxesOf(machine);
  const box = pickBox(boxes, busy, closed, size);
  if (!box) return fail(409, 'no_free_box', `No free ${size} box.`, { free: freeCounts(boxes, busy, closed) });
  const id = 'pcl_' + crypto.randomBytes(8).toString('hex');
  q.insertParcel.run(id, machine.deviceCode, machine.operatorId, box.n, o.id, o.orderNumber, o.phone, o.firstName, iso(now));
  event(machine.deviceCode, id, box.n, 'deposit_started', 'locker', size, now);
  return { ok: true, resumed: false, parcelId: id, box: { n: box.n, size: box.size, board: box.board, lock: box.lock } };
});

/**
 * The locker reports how a deposit ended: `stored` (the door closed on the parcel) or
 * `cancelled` (the door did not open, or it was closed empty or given up). Storing makes the
 * pickup code and link token. Reporting the same outcome twice is harmless.
 */
const finishDeposit = db.transaction((machine, parcelId, input, now = Date.now()) => {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  const outcome = input && input.outcome;
  if (outcome !== 'stored' && outcome !== 'cancelled') return fail(400, 'bad_outcome', 'outcome must be stored or cancelled.');
  if (p.state !== 'opening') {
    if (p.state === outcome) return { ok: true, repeated: true, parcelId: p.id, state: p.state };
    return fail(409, 'wrong_state', `This parcel is ${p.state}.`);
  }
  if (outcome === 'cancelled') {
    const reason = cleanText(input.reason, 60) || 'cancelled';
    q.endParcel.run('cancelled', iso(now), 'locker', reason, p.id);
    event(machine.deviceCode, p.id, p.boxN, 'deposit_cancelled', 'locker', reason, now);
    return { ok: true, parcelId: p.id, state: 'cancelled' };
  }
  let code = newCode();
  for (let i = 0; i < 50 && q.storedByCode.get(machine.deviceCode, code); i++) code = newCode();
  let token = newToken();
  for (let i = 0; i < 5 && q.byToken.get(token); i++) token = newToken();
  q.storeParcel.run(code, token, iso(now), p.id);
  if (p.orderId != null) q.setOrderStatus.run('deposited', iso(now), p.orderId);
  event(machine.deviceCode, p.id, p.boxN, 'stored', 'locker', null, now);
  return { ok: true, parcelId: p.id, state: 'stored' };
});

// ── Pickup (the locker) ───────────────────────────────────────────────────────────────────────

/**
 * A customer gave a code on the keypad or scanned their link. Answers with the door to open.
 * The parcel stays stored until the locker reports that the door opened.
 */
function startPickup(machine, input, now = Date.now()) {
  const dev = machine.deviceCode;
  const wrong = q.wrongCodesSince.get(dev, iso(now - WRONG_CODE_WINDOW_MS)).c;
  if (wrong >= WRONG_CODE_LIMIT) return fail(429, 'too_many_attempts', 'Too many wrong codes. Wait a few minutes.', { retryAfterSeconds: Math.ceil(WRONG_CODE_WINDOW_MS / 1000) });

  let p = null, how = null;
  if (input && input.scan !== undefined) {
    how = 'scan';
    const token = tokenFromScan(input.scan);
    p = token ? q.byToken.get(token) : null;
    if (p && p.deviceCode !== dev && p.state === 'stored') {
      const other = storage.getMachine(p.deviceCode);
      event(dev, null, null, 'wrong_locker', 'customer', null, now);
      return fail(409, 'other_locker', 'This parcel is in another locker.', { locker: other ? lockers.publicInfo(other) : null });
    }
    if (p && (p.deviceCode !== dev || p.state !== 'stored')) {
      const used = p.deviceCode === dev && p.state === 'collected';
      event(dev, used ? p.id : null, null, used ? 'used_link' : 'wrong_code', 'customer', how, now);
      return used ? fail(410, 'already_collected', 'This parcel has already been collected.')
                  : fail(404, 'wrong_code', 'This code is not recognised.');
    }
  } else if (input && input.code !== undefined) {
    how = 'code';
    const code = String(input.code).replace(/\s/g, '');
    if (/^\d{6}$/.test(code)) p = q.storedByCode.get(dev, code);
  } else {
    return fail(400, 'bad_request', 'Send code or scan.');
  }
  if (!p) {
    event(dev, null, null, 'wrong_code', 'customer', how, now);
    return fail(404, 'wrong_code', 'This code is not recognised.', { attemptsLeft: Math.max(0, WRONG_CODE_LIMIT - wrong - 1) });
  }
  event(dev, p.id, p.boxN, 'pickup_started', 'customer', how, now);
  return { ok: true, parcelId: p.id, box: wiring(machine, p.boxN) };
}

/** The locker reports whether the door opened. Opened means collected; the link and code die. */
const finishPickup = db.transaction((machine, parcelId, input, now = Date.now()) => {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  if (!input || typeof input.opened !== 'boolean') return fail(400, 'bad_request', 'opened must be true or false.');
  if (p.state === 'collected' && input.opened) return { ok: true, repeated: true, parcelId: p.id, state: 'collected' };
  if (p.state !== 'stored') return fail(409, 'wrong_state', `This parcel is ${p.state}.`);
  if (!input.opened) {
    // The customer stands at a door that stayed shut: the parcel is still theirs to collect.
    event(machine.deviceCode, p.id, p.boxN, 'door_did_not_open', 'locker', null, now);
    return { ok: true, parcelId: p.id, state: 'stored' };
  }
  q.endParcel.run('collected', iso(now), 'customer', 'pickup', p.id);
  event(machine.deviceCode, p.id, p.boxN, 'collected', 'customer', null, now);
  return { ok: true, parcelId: p.id, state: 'collected' };
});

// ── The operator's actions ────────────────────────────────────────────────────────────────────

/** The operator handed the parcel over by other means, or saw the box empty. */
const markCollected = db.transaction((machine, parcelId, who, now = Date.now()) => {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  if (p.state !== 'stored') return fail(409, 'wrong_state', `This parcel is ${p.state}, not stored.`);
  q.endParcel.run('collected', iso(now), who || 'operator', 'marked by operator', p.id);
  event(machine.deviceCode, p.id, p.boxN, 'collected', who || 'operator', 'marked by operator', now);
  return { ok: true, parcel: parcelView(q.parcelById.get(p.id), now) };
});

/**
 * The operator frees a box: a stored parcel taken back out (`cleared`), or a deposit that never
 * completed (`cancelled`). With `again`, the order may be deposited once more; an unfinished
 * deposit always may.
 */
const clearParcel = db.transaction((machine, parcelId, who, input, now = Date.now()) => {
  const p = q.parcelById.get(String(parcelId));
  if (!p || p.deviceCode !== machine.deviceCode) return fail(404, 'parcel_not_found', 'No such parcel at this locker.');
  if (!ACTIVE.includes(p.state)) return fail(409, 'wrong_state', `This parcel is ${p.state}; its box is already free.`);
  const reason = cleanText(input && input.reason, 120) || 'cleared by operator';
  const next = p.state === 'stored' ? 'cleared' : 'cancelled';
  q.endParcel.run(next, iso(now), who || 'operator', reason, p.id);
  const again = p.state === 'opening' || !!(input && input.again);
  if (p.orderId != null && p.state === 'stored' && again) q.setOrderStatus.run('expected', iso(now), p.orderId);
  event(machine.deviceCode, p.id, p.boxN, next, who || 'operator', reason + (again && p.state === 'stored' ? ' (order may be deposited again)' : ''), now);
  return { ok: true, parcel: parcelView(q.parcelById.get(p.id), now) };
});

/** Takes a box out of use for new deposits, or puts it back. A parcel already in it stays. */
function setBoxService(machine, boxN, input, who, now = Date.now()) {
  const n = Number(boxN);
  if (!boxesOf(machine).some(b => b.n === n)) return fail(404, 'box_not_found', `This locker has no box ${boxN}.`);
  if (!input || typeof input.outOfService !== 'boolean') return fail(400, 'bad_request', 'outOfService must be true or false.');
  const reason = input.outOfService ? cleanText(input.reason, 120) : '';
  q.setBoxState.run(machine.deviceCode, n, input.outOfService ? 1 : 0, reason, who || null, iso(now));
  event(machine.deviceCode, null, n, input.outOfService ? 'box_out_of_service' : 'box_in_service', who || 'operator', reason, now);
  return { ok: true };
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────
// The sending is in src/lockerSms.js. What is kept here is the record: each message Twilio
// accepted, and every delivery report Twilio sends about it, in the parcel's history.

const SMS_RANK = { queued: 1, accepted: 1, scheduled: 1, sending: 2, sent: 3, delivered: 4, undelivered: 4, failed: 4 };

/** Everything needed to write a parcel's message. Never leaves the backend. */
function smsFacts(parcelId) {
  const p = q.parcelById.get(String(parcelId));
  return p ? { id: p.id, deviceCode: p.deviceCode, boxN: p.boxN, state: p.state, orderNumber: p.orderNumber, phone: p.phone,
               code: p.code, token: p.token, lastSms: q.lastSms.get(p.id) || null } : null;
}
function noteEvent(parcelId, type, actor, detail, now = Date.now()) {
  const p = q.parcelById.get(String(parcelId));
  if (p) event(p.deviceCode, p.id, p.boxN, type, actor, detail, now);
}
/** Twilio took the message: it has a SID, and its delivery reports will name it. */
function smsAccepted(parcelId, sid, kind, status, actor, now = Date.now()) {
  const p = q.parcelById.get(String(parcelId));
  if (!p) return;
  q.insertSms.run(String(sid), p.id, p.deviceCode, kind, String(status || 'queued'), iso(now), iso(now));
  q.setNotified.run(iso(now), p.id);
  event(p.deviceCode, p.id, p.boxN, 'sms_accepted', actor || 'backend', kind, now);
}
/**
 * A delivery report from Twilio. Reports can arrive out of order, so a message never goes back
 * from a later state to an earlier one; each new state is one line in the parcel's history.
 */
function smsReport(sid, status, errorCode, now = Date.now()) {
  const m = q.smsBySid.get(String(sid));
  if (!m) return { ok: false, unknown: true };
  const st = String(status || '').toLowerCase();
  if (!SMS_RANK[st]) return { ok: true, ignored: true };
  if (st === m.status || SMS_RANK[st] < (SMS_RANK[m.status] || 0)) return { ok: true, ignored: true };
  q.updateSms.run(st, errorCode ? String(errorCode).slice(0, 12) : null, iso(now), m.sid);
  const p = q.parcelById.get(m.parcelId);
  if (p) event(p.deviceCode, p.id, p.boxN, 'sms_' + st, 'twilio', m.kind + (errorCode ? ', error ' + String(errorCode).slice(0, 12) : ''), now);
  return { ok: true, parcelId: m.parcelId, status: st };
}
/** Stored parcels older than `hours` for which no reminder has been attempted. */
function parcelsNeedingReminder(hours, now = Date.now()) {
  return q.needReminder.all(iso(now - hours * 3600000)).map(r => r.id);
}
/** For the pickup page: the parcel behind a link token, with its locker. */
function byToken(token) {
  const p = token ? q.byToken.get(String(token).toLowerCase()) : null;
  return p ? { state: p.state, orderNumber: p.orderNumber, code: p.code, token: p.token, deviceCode: p.deviceCode } : null;
}

// ── Forgetting ────────────────────────────────────────────────────────────────────────────────

const KEEP_PERSONAL_DAYS = 30;
const DROP_EXPECTED_DAYS = 90;
const forget = {
  stale: db.prepare(`UPDATE locker_orders SET status = 'cancelled', phone = '', firstName = '', updatedAt = ?
                     WHERE status = 'expected' AND updatedAt < ?
                       AND NOT EXISTS (SELECT 1 FROM locker_parcels p WHERE p.orderId = locker_orders.id AND p.state IN ('opening','stored'))`),
  parcels: db.prepare(`UPDATE locker_parcels SET phone = '', firstName = '', code = NULL, token = NULL
                       WHERE state NOT IN ('opening','stored') AND endedAt < ? AND (phone <> '' OR firstName <> '' OR code IS NOT NULL OR token IS NOT NULL)`),
  orders: db.prepare(`UPDATE locker_orders SET phone = '', firstName = ''
                      WHERE status <> 'expected' AND updatedAt < ? AND (phone <> '' OR firstName <> '')
                        AND NOT EXISTS (SELECT 1 FROM locker_parcels p WHERE p.orderId = locker_orders.id AND p.state IN ('opening','stored'))`),
};
/**
 * Thirty days after a parcel has left its box, the customer's phone number and first name are
 * blanked on it and on its order, and its code and token dropped. The order number, the box
 * and the times stay, so the history still reads. A parcel still in a box is never touched.
 * An order reported and never brought to a locker is withdrawn and blanked after ninety days.
 */
function forgetOldPersonalData(now = Date.now()) {
  const before = iso(now - KEEP_PERSONAL_DAYS * 86400000);
  const stale = forget.stale.run(iso(now), iso(now - DROP_EXPECTED_DAYS * 86400000)).changes;
  return { parcels: forget.parcels.run(before).changes, orders: forget.orders.run(before).changes, stale };
}
function forgetTick() {
  try {
    const r = forgetOldPersonalData();
    if (r.parcels || r.orders || r.stale) console.log(`[LOCKER] personal data blanked on ${r.parcels} parcel(s) and ${r.orders} order(s); ${r.stale} stale order(s) withdrawn`);
  } catch (e) { console.error('[LOCKER] forgetting failed:', e.message); }
}
setTimeout(forgetTick, 60 * 1000).unref();
setInterval(forgetTick, 24 * 3600 * 1000).unref();

module.exports = {
  KEEP_PERSONAL_DAYS, forgetOldPersonalData, revealCode,
  smsFacts, noteEvent, smsAccepted, smsReport, parcelsNeedingReminder, byToken,
  WRONG_CODE_LIMIT, WRONG_CODE_WINDOW_MS,
  normalizeOrderNumber, normalizePhone, firstNameOf, newCode, newToken, tokenFromScan, pickBox, freeCounts,
  boxView, getParcel, listParcels,
  registerOrder, listOrders, orderCounts, cancelOrder,
  lookupForDeposit, startDeposit, finishDeposit, startPickup, finishPickup,
  markCollected, clearParcel, setBoxService,
  // For the SMS and the pickup page, which are built on this next. Never sent to the dashboard.
  _secretsOf(parcelId) { const p = q.parcelById.get(String(parcelId)); return p ? { code: p.code, token: p.token } : null; },
};
