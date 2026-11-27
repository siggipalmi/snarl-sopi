'use strict';
/**
 * Orders from an operator's web shop, on their way to a locker.
 *
 * An operator connects a shop: the backend makes an address and a secret, and the shop's order
 * webhook is pointed at that address with that secret. Each order the shop then reports, if it
 * is to be delivered through a locker, becomes an expected order (src/parcels.js), which is
 * what lets staff put it in a box. An order cancelled or moved to another delivery method in
 * the shop is withdrawn again, unless it is already in a box.
 *
 * Only WooCommerce is spoken so far. It signs each delivery with the secret (HMAC-SHA256 of
 * the body, base64, in X-WC-Webhook-Signature); that signature is the only authentication.
 *
 * The secret is kept sealed with ACCOUNTING_ENC_KEY, as the accounting logins are, and is
 * shown once, when it is made.
 */
const crypto = require('crypto');
const storage = require('./storage');
const parcels = require('./parcels');

const db = storage.db;
db.exec(`
  CREATE TABLE IF NOT EXISTS locker_shops (
    id            TEXT PRIMARY KEY,
    operatorId    TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'woocommerce',
    name          TEXT NOT NULL DEFAULT '',
    shippingMatch TEXT NOT NULL DEFAULT '',
    secretSealed  TEXT NOT NULL,
    createdAt     TEXT NOT NULL,
    createdBy     TEXT,
    lastAt        TEXT,
    lastResult    TEXT,
    received      INTEGER NOT NULL DEFAULT 0,
    stored        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_locker_shops_operator ON locker_shops(operatorId);
`);

// A second list of shipping methods (6.144.0): orders the customer fetches in the shop, which
// staff may put in a locker instead. They are taken as expected orders, marked optional.
if (!db.prepare('PRAGMA table_info(locker_shops)').all().some(c => c.name === 'optionalMatch')) {
  db.exec("ALTER TABLE locker_shops ADD COLUMN optionalMatch TEXT NOT NULL DEFAULT ''");
}

const q = {
  byId: db.prepare('SELECT * FROM locker_shops WHERE id = ?'),
  ofOperator: db.prepare('SELECT * FROM locker_shops WHERE operatorId = ? ORDER BY createdAt'),
  insert: db.prepare('INSERT INTO locker_shops (id, operatorId, kind, name, shippingMatch, secretSealed, createdAt, createdBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  update: db.prepare('UPDATE locker_shops SET name = ?, shippingMatch = ?, optionalMatch = ? WHERE id = ?'),
  setSecret: db.prepare('UPDATE locker_shops SET secretSealed = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM locker_shops WHERE id = ?'),
  note: db.prepare('UPDATE locker_shops SET lastAt = ?, lastResult = ?, received = received + ?, stored = stored + ? WHERE id = ?'),
};

const DEAD_STATUSES = ['cancelled', 'refunded', 'failed', 'trash'];
const MAX_SHOPS = 10;
const PATH = '/api/v1/shops/woo/';

// ── Sealing (same key and form as src/accounting.js) ──────────────────────────────────────────

function encKey() {
  const raw = process.env.ACCOUNTING_ENC_KEY || '';
  return raw.length < 32 ? null : crypto.createHash('sha256').update(raw, 'utf8').digest();
}
function seal(text) {
  const key = encKey();
  if (!key) throw new Error('ACCOUNTING_ENC_KEY is not set');
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}
function unseal(sealed) {
  const key = encKey();
  if (!key || !sealed || !sealed.startsWith('v1:')) return null;
  try {
    const buf = Buffer.from(sealed.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ── Connections ───────────────────────────────────────────────────────────────────────────────

function fail(status, code, error) { return { ok: false, status, code, error }; }
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// Letters and digits only: WooCommerce stores some other characters differently from how they were typed.
const newSecret = () => crypto.randomBytes(24).toString('hex');
const baseUrl = () => (process.env.APP_URL || 'https://admin.agvending.is').replace(/\/+$/, '');

/** A connection as the dashboard shows it: never the secret. */
function view(s) {
  return s && { id: s.id, kind: s.kind, name: s.name, shippingMatch: s.shippingMatch, optionalMatch: s.optionalMatch || '', url: baseUrl() + PATH + s.id,
                createdAt: s.createdAt, createdBy: s.createdBy, lastAt: s.lastAt, lastResult: s.lastResult, received: s.received, stored: s.stored };
}
function list(operatorId) { return q.ofOperator.all(operatorId).map(view); }

function owned(operatorId, id) {
  const s = q.byId.get(String(id));
  return s && s.operatorId === operatorId ? s : null;
}

/** Connects a shop. The answer carries the secret, this once. */
function create(operatorId, input, who, now = Date.now()) {
  if (!operatorId) return fail(400, 'bad_request', 'operatorId is required.');
  if (!encKey()) return fail(503, 'not_configured', 'The backend cannot keep secrets yet (ACCOUNTING_ENC_KEY is not set).');
  if (q.ofOperator.all(operatorId).length >= MAX_SHOPS) return fail(409, 'too_many', `At most ${MAX_SHOPS} shops per operator.`);
  const name = clean(input && input.name, 60);
  if (!name) return fail(400, 'bad_name', 'Give the shop a name, such as its web address.');
  const id = crypto.randomBytes(12).toString('hex'), secret = newSecret();
  q.insert.run(id, operatorId, 'woocommerce', name, clean(input && input.shippingMatch, 200), seal(secret), new Date(now).toISOString(), who || null);
  return { ok: true, shop: view(q.byId.get(id)), secret };
}

function update(operatorId, id, input) {
  const s = owned(operatorId, id);
  if (!s) return fail(404, 'shop_not_found', 'No such shop connection.');
  const name = input && input.name !== undefined ? clean(input.name, 60) : s.name;
  if (!name) return fail(400, 'bad_name', 'Give the shop a name, such as its web address.');
  q.update.run(name, input && input.shippingMatch !== undefined ? clean(input.shippingMatch, 200) : s.shippingMatch,
               input && input.optionalMatch !== undefined ? clean(input.optionalMatch, 200) : (s.optionalMatch || ''), s.id);
  return { ok: true, shop: view(q.byId.get(s.id)) };
}

/** A new secret; the old one stops working at once. Shown this once. */
function newSecretFor(operatorId, id) {
  const s = owned(operatorId, id);
  if (!s) return fail(404, 'shop_not_found', 'No such shop connection.');
  const secret = newSecret();
  q.setSecret.run(seal(secret), s.id);
  return { ok: true, shop: view(q.byId.get(s.id)), secret };
}

function remove(operatorId, id) {
  const s = owned(operatorId, id);
  if (!s) return fail(404, 'shop_not_found', 'No such shop connection.');
  q.remove.run(s.id);
  return { ok: true };
}

// ── Deliveries ────────────────────────────────────────────────────────────────────────────────

function signatureMatches(body, given, secret) {
  if (!given || !secret) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64'));
  const actual = Buffer.from(String(given));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const names = (v) => String(v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

/**
 * One delivery from a shop: { status, body }. What happened is kept on the connection as a
 * short line without the customer's name or number, so the operator can see it working, or
 * see why it is not.
 */
function handleDelivery(hookId, rawBody, signature, now = Date.now()) {
  const s = q.byId.get(String(hookId || ''));
  if (!s) return { status: 404, body: { error: 'Unknown shop connection.' } };
  const at = new Date(now).toISOString();
  const done = (status, result, body, stored) => { q.note.run(at, result.slice(0, 300), 1, stored ? 1 : 0, s.id); return { status, body: body || { status: result } }; };
  const body = String(rawBody || '');

  // WooCommerce sends "webhook_id=<n>", unsigned, when a webhook is saved.
  if (/^webhook_id=\d+$/.test(body.trim())) return done(200, 'test delivery received', { status: 'ok' });

  if (!signatureMatches(body, signature, unseal(s.secretSealed))) {
    return done(401, signature ? 'refused: the signature does not match. The secret in the shop is not this connection\'s secret.'
                               : 'refused: the delivery carried no signature.', { error: 'Unauthorized' });
  }
  let order;
  try { order = JSON.parse(body); } catch (e) { return done(400, 'refused: the delivery was not JSON.', { error: 'Invalid JSON' }); }
  const number = parcels.normalizeOrderNumber(order && (order.number != null ? order.number : order.id));
  if (!number) return done(400, 'refused: the delivery had no order number.', { error: 'No order number' });

  const shipping = (Array.isArray(order.shipping_lines) ? order.shipping_lines : []).map(l => ({ id: String((l && l.method_id) || ''), title: String((l && l.method_title) || '') }));
  const status = String(order.status || '');
  const wanted = names(s.shippingMatch), maybe = names(s.optionalMatch);
  if (!wanted.length && !maybe.length) {
    const seen = shipping.map(x => clean(x.title || x.id, 80)).filter(Boolean).join(' | ') || 'none';
    return done(200, `order ${number} not taken: no locker shipping method is set for this shop yet. Its shipping: ${seen}`, { status: 'ignored' });
  }
  const has = (list) => shipping.some(x => list.some(n => n === x.id.toLowerCase() || x.title.toLowerCase().includes(n)));
  // A locker method wins when an order somehow matches both lists.
  const forLocker = has(wanted), optional = !forLocker && has(maybe), isLocker = forLocker || optional;
  if (!isLocker || DEAD_STATUSES.includes(status)) {
    // It may have been a locker order before it was changed or cancelled in the shop.
    const withdrawn = parcels.withdrawOrderByNumber(s.operatorId, number, now);
    return done(200, `order ${number} ${withdrawn ? 'withdrawn' : 'not taken'}: ${isLocker ? 'it is ' + clean(status, 20) : 'not a locker order'}`, { status: 'ignored' });
  }
  const billing = order.billing || {}, ship = order.shipping || {};
  const r = parcels.registerOrder(s.operatorId, { orderNumber: number, phone: billing.phone || ship.phone, firstName: billing.first_name || ship.first_name, source: 'woocommerce', optional }, now);
  if (!r.ok) return done(200, `order ${number} not taken: ${r.code === 'bad_phone' ? 'it has no usable mobile number' : r.error}`, { status: 'ignored', reason: r.code });
  return done(200, `order ${number} ${r.unchanged ? 'already in a locker, left as it is' : r.created ? 'received' : 'updated'}${optional && !r.unchanged ? ' (shop pickup, may go in the locker)' : ''}`, { status: 'stored' }, !r.unchanged);
}

module.exports = { PATH, list, create, update, newSecretFor, remove, handleDelivery, signatureMatches };
