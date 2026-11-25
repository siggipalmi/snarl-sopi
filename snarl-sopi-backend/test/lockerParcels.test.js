/**
 * Locker parcels (6.126.0): orders, deposits, pickups and the operator's actions, through the
 * module and through the routes as the router would call them. Invented data throughout.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-parcels-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');
const parcels = require('../src/parcels');

function machine(deviceCode, operatorId, model = 'LK-AGV19') {
  return { deviceCode, deviceName: 'Skápur ' + deviceCode, location: 'Prufugata 1', operatorId, model, isKioskModel: 0,
    isOnline: 1, isRunning: 1, kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1,
    settings: { locker: { info: {}, boxes: [
      { n: 1, size: 'middle', board: 1, lock: 1 }, { n: 2, size: 'small', board: 1, lock: 2 },
      { n: 3, size: 'small', board: 1, lock: 3 }, { n: 4, size: 'big', board: 1, lock: 4 } ] } },
    profile: { operatorName: 'Test', machineLabel: deviceCode }, featured: [], ads: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
for (const id of ['op-parcel-a', 'op-parcel-b']) {
  storage.upsertOperator({ id, name: id, isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
}
const A1 = machine('LKP-A1', 'op-parcel-a'), A2 = machine('LKP-A2', 'op-parcel-a'), B1 = machine('LKP-B1', 'op-parcel-b');
const COIL = machine('VMP-1', 'op-parcel-a', 'VM-WM55DL');
for (const m of [A1, A2, B1, COIL]) { storage.upsertMachine(m); machines[m.deviceCode] = m; }

const T0 = Date.parse('2026-11-25T12:00:00Z');
let seq = 0;
/** Reports an order and stores it in a box of `m`; returns the parcel id and its secrets. */
function stored(m, size = 'small', at = T0) {
  const orderNumber = 'T' + (++seq);
  assert.ok(parcels.registerOrder(m.operatorId, { orderNumber, phone: '5550100', firstName: 'Anna Jónsdóttir' }, at).ok);
  const s = parcels.startDeposit(m, { orderNumber, size }, at);
  assert.ok(s.ok, JSON.stringify(s));
  assert.equal(parcels.finishDeposit(m, s.parcelId, { outcome: 'stored' }, at).state, 'stored');
  return { orderNumber, parcelId: s.parcelId, box: s.box, ...parcels._secretsOf(s.parcelId) };
}
/** Empties a locker between tests, as an operator would. */
function empty(m) {
  for (const b of parcels.boxView(m).boxes) if (b.parcel) parcels.clearParcel(m, b.parcel.id, 'test', {});
}

test('phone numbers, order numbers, first names and scans are read as intended', () => {
  assert.equal(parcels.normalizePhone('555 0100'), '+3545550100');
  assert.equal(parcels.normalizePhone('354 555-0100'), '+3545550100');
  assert.equal(parcels.normalizePhone('00354 5550100'), '+3545550100');
  assert.equal(parcels.normalizePhone('+45 12 34 56 78'), '+4512345678');
  assert.equal(parcels.normalizePhone('12345'), null);
  assert.equal(parcels.normalizeOrderNumber(' #48213 '), '48213');
  assert.equal(parcels.normalizeOrderNumber(''), null);
  assert.equal(parcels.firstNameOf('Anna  María Jónsdóttir'), 'Anna');
  assert.equal(parcels.tokenFromScan('https://sms.agvending.is/p/abcdefgh2345'), 'abcdefgh2345');
  // Two reads of the same link run together into one string still give the token.
  assert.equal(parcels.tokenFromScan('https://sms.agvending.is/p/abcdefgh2345https://sms.agvending.is/p/abcdefgh2345'), 'abcdefgh2345');
  assert.equal(parcels.tokenFromScan('ABCDEFGH2345'), 'abcdefgh2345');
  assert.equal(parcels.tokenFromScan('48213'), null);
  assert.match(parcels.newCode(), /^\d{6}$/);
  assert.match(parcels.newToken(), /^[a-hjkmnp-z2-9]{12}$/);
});

test('a deposit takes the lowest free box of the size asked for, and the box view shows it', () => {
  const p = stored(A1, 'small');
  assert.deepEqual(p.box, { n: 2, size: 'small', board: 1, lock: 2 });
  const view = parcels.boxView(A1, T0 + 3 * 3600000);
  assert.deepEqual(view.counts, { vacant: 3, occupied: 1, opening: 0, out_of_service: 0 });
  const box = view.boxes.find(b => b.n === 2);
  assert.equal(box.state, 'occupied');
  assert.equal(box.parcel.orderNumber, p.orderNumber);
  assert.equal(box.parcel.firstName, 'Anna');
  assert.equal(box.parcel.hoursStored, 3);
  assert.equal(box.parcel.code, undefined, 'the pickup code is not in the dashboard view');
  assert.equal(box.parcel.token, undefined);
  assert.match(p.code, /^\d{6}$/);
  assert.equal(stored(A1, 'small').box.n, 3);
  const full = parcels.startDeposit(A1, { orderNumber: 'nope', size: 'small' }, T0);
  assert.equal(full.code, 'order_not_found');
  parcels.registerOrder('op-parcel-a', { orderNumber: 'FULL', phone: '5550101' }, T0);
  const none = parcels.startDeposit(A1, { orderNumber: 'FULL', size: 'small' }, T0);
  assert.equal(none.code, 'no_free_box');
  assert.deepEqual(none.free, { small: 0, middle: 1, big: 1 });
  empty(A1);
});

test('an order is deposited once, only by its own operator, and never from a pickup code', () => {
  const p = stored(A1);
  assert.equal(parcels.lookupForDeposit(A1, p.orderNumber).code, 'order_used');
  assert.equal(parcels.startDeposit(A2, { orderNumber: p.orderNumber, size: 'small' }, T0).code, 'order_used');
  assert.equal(parcels.lookupForDeposit(B1, p.orderNumber).code, 'order_not_found', 'another operator\'s locker does not know the order');
  assert.equal(parcels.lookupForDeposit(A1, p.code).code, 'order_not_found', 'a pickup code starts no deposit');
  assert.equal(parcels.lookupForDeposit(A1, p.token).code, 'order_not_found');
  // Still used after it is collected.
  const s = parcels.startPickup(A1, { code: p.code }, T0);
  parcels.finishPickup(A1, s.parcelId, { opened: true }, T0);
  assert.equal(parcels.lookupForDeposit(A1, p.orderNumber).code, 'order_used');
});

test('reporting an order again corrects it until it is deposited', () => {
  const first = parcels.registerOrder('op-parcel-a', { orderNumber: '#R1', phone: '5550102', firstName: 'Jon' }, T0);
  assert.equal(first.created, true);
  const again = parcels.registerOrder('op-parcel-a', { orderNumber: 'r1', phone: '5550103', firstName: 'Jón Jónsson' }, T0);
  assert.equal(again.created, false);
  assert.equal(again.order.phone, '+3545550103');
  assert.equal(again.order.firstName, 'Jón');
  assert.equal(parcels.registerOrder('op-parcel-a', { orderNumber: 'R1', phone: 'x' }).code, 'bad_phone');
  const s = parcels.startDeposit(A1, { orderNumber: 'R1', size: 'big' }, T0);
  parcels.finishDeposit(A1, s.parcelId, { outcome: 'stored' }, T0);
  const late = parcels.registerOrder('op-parcel-a', { orderNumber: 'R1', phone: '5550104' }, T0);
  assert.equal(late.unchanged, true);
  assert.equal(late.order.phone, '+3545550103');
  assert.equal(parcels.cancelOrder('op-parcel-a', late.order.id).code, 'order_used');
  empty(A1);
});

test('an unfinished deposit keeps its box: a rescan reopens the same door, a cancel frees it', () => {
  parcels.registerOrder('op-parcel-a', { orderNumber: 'U1', phone: '5550105' }, T0);
  const s = parcels.startDeposit(A1, { orderNumber: 'U1', size: 'middle' }, T0);
  assert.equal(parcels.boxView(A1).boxes.find(b => b.n === 1).state, 'opening');
  const look = parcels.lookupForDeposit(A1, 'U1');
  assert.equal(look.resume.parcelId, s.parcelId);
  const again = parcels.startDeposit(A1, { orderNumber: 'U1', size: 'big' }, T0);
  assert.equal(again.resumed, true);
  assert.equal(again.box.n, 1, 'the same box, whatever size is asked for now');
  assert.equal(parcels.startDeposit(A2, { orderNumber: 'U1', size: 'middle' }, T0).code, 'order_used');
  assert.equal(parcels.finishDeposit(A2, s.parcelId, { outcome: 'stored' }, T0).code, 'parcel_not_found', 'another locker cannot finish it');
  assert.equal(parcels.finishDeposit(A1, s.parcelId, { outcome: 'cancelled', reason: 'door did not open' }, T0).state, 'cancelled');
  assert.equal(parcels.finishDeposit(A1, s.parcelId, { outcome: 'cancelled' }, T0).repeated, true);
  assert.equal(parcels.finishDeposit(A1, s.parcelId, { outcome: 'stored' }, T0).code, 'wrong_state');
  assert.equal(parcels.boxView(A1).boxes.find(b => b.n === 1).state, 'vacant');
  // The order is still expected, and takes a fresh box.
  const fresh = parcels.startDeposit(A1, { orderNumber: 'U1', size: 'middle' }, T0);
  assert.equal(fresh.resumed, false);
  assert.notEqual(fresh.parcelId, s.parcelId);
  empty(A1);
});

test('pickup by code and by scanned link opens the right door, once', () => {
  const a = stored(A1, 'small'), b = stored(A1, 'big');
  const byCode = parcels.startPickup(A1, { code: a.code }, T0);
  assert.deepEqual(byCode.box, a.box);
  // The door staying shut leaves the parcel the customer's to collect.
  assert.equal(parcels.finishPickup(A1, byCode.parcelId, { opened: false }, T0).state, 'stored');
  assert.equal(parcels.startPickup(A1, { code: a.code }, T0).parcelId, a.parcelId);
  assert.equal(parcels.finishPickup(A1, a.parcelId, { opened: true }, T0).state, 'collected');
  assert.equal(parcels.finishPickup(A1, a.parcelId, { opened: true }, T0).repeated, true);
  assert.equal(parcels.startPickup(A1, { code: a.code }, T0).code, 'wrong_code', 'the code is dead once collected');
  assert.equal(parcels.boxView(A1).boxes.find(x => x.n === a.box.n).state, 'vacant');

  const byScan = parcels.startPickup(A1, { scan: 'https://sms.agvending.is/p/' + b.token }, T0);
  assert.equal(byScan.box.n, 4);
  parcels.finishPickup(A1, byScan.parcelId, { opened: true }, T0);
  assert.equal(parcels.startPickup(A1, { scan: b.token }, T0).code, 'already_collected');
  const events = parcels.getParcel(A1, b.parcelId).events.map(e => e.type);
  assert.deepEqual(events, ['deposit_started', 'stored', 'pickup_started', 'collected', 'used_link']);
  assert.equal(parcels.startPickup(A1, {}, T0).code, 'bad_request');
});

test('a link scanned at the wrong locker names the right one; a code from another locker is just wrong', () => {
  const p = stored(A2, 'small', T0 + 3600000);
  const r = parcels.startPickup(A1, { scan: 'https://sms.agvending.is/p/' + p.token }, T0 + 3600000);
  assert.equal(r.code, 'other_locker');
  assert.equal(r.locker.name, 'Skápur LKP-A2');
  assert.equal(parcels.startPickup(A1, { code: p.code }, T0 + 3600000).code, 'wrong_code');
  empty(A2);
});

test('wrong codes are refused for a while past the limit, and a right code does not get through meanwhile', () => {
  const t = T0 + 10 * 3600000;
  const p = stored(B1, 'small', t);
  for (let i = 0; i < parcels.WRONG_CODE_LIMIT; i++) {
    const r = parcels.startPickup(B1, { code: '000000' === p.code ? '000001' : '000000' }, t + i);
    assert.equal(r.code, 'wrong_code');
    assert.equal(r.attemptsLeft, parcels.WRONG_CODE_LIMIT - i - 1);
  }
  assert.equal(parcels.startPickup(B1, { code: p.code }, t + 1000).code, 'too_many_attempts');
  assert.equal(parcels.startPickup(B1, { code: p.code }, t + parcels.WRONG_CODE_WINDOW_MS + 1000).ok, true);
  empty(B1);
});

test('the operator marks a parcel collected, clears a box, and takes a box out of service', () => {
  const a = stored(A1, 'small'), b = stored(A1, 'small');
  assert.equal(parcels.markCollected(A2, a.parcelId, 'op@example.test').code, 'parcel_not_found');
  const done = parcels.markCollected(A1, a.parcelId, 'op@example.test', T0);
  assert.equal(done.parcel.state, 'collected');
  assert.equal(done.parcel.endedBy, 'op@example.test');
  assert.equal(parcels.markCollected(A1, a.parcelId, 'op@example.test').code, 'wrong_state');
  assert.equal(parcels.startPickup(A1, { code: a.code }, T0).code, 'wrong_code');

  const cleared = parcels.clearParcel(A1, b.parcelId, 'op@example.test', { reason: 'returned to the shop' }, T0);
  assert.equal(cleared.parcel.state, 'cleared');
  assert.equal(parcels.lookupForDeposit(A1, b.orderNumber).code, 'order_used', 'cleared without "again": the order stays used');
  assert.equal(parcels.clearParcel(A1, b.parcelId, 'op@example.test', {}).code, 'wrong_state');
  const c = stored(A1, 'small');
  parcels.clearParcel(A1, c.parcelId, 'op@example.test', { again: true }, T0);
  assert.equal(parcels.lookupForDeposit(A1, c.orderNumber).ok, true, 'cleared with "again": it may be deposited once more');

  assert.equal(parcels.setBoxService(A1, 99, { outOfService: true }, 'op@example.test').code, 'box_not_found');
  assert.equal(parcels.setBoxService(A1, 2, { outOfService: true, reason: 'lock broken' }, 'op@example.test', T0).ok, true);
  const view = parcels.boxView(A1);
  assert.equal(view.boxes.find(x => x.n === 2).state, 'out_of_service');
  assert.equal(view.boxes.find(x => x.n === 2).outOfService.reason, 'lock broken');
  assert.equal(parcels.lookupForDeposit(A1, c.orderNumber).free.small, 1);
  assert.equal(parcels.startDeposit(A1, { orderNumber: c.orderNumber, size: 'small' }, T0).box.n, 3, 'box 2 is skipped');
  parcels.setBoxService(A1, 2, { outOfService: false }, 'op@example.test', T0);
  assert.equal(parcels.boxView(A1).boxes.find(x => x.n === 2).state, 'vacant');
  empty(A1);
});

// ── The routes ──────────────────────────────────────────────────────────────────────────────

const BASE = '/api/v1/machines/:deviceCode/locker';
function call(method, tail, { deviceCode = 'LKP-A1', params = {}, body, query = {} } = {}) {
  const route = routes.find(r => r.method === method && r.pattern === BASE + tail);
  assert.ok(route, method + ' ' + tail);
  let status = 0, text = '';
  const res = { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } };
  const req = { params: { deviceCode, ...params }, body, query, headers: {}, user: { role: 'operator_admin', email: 'op@example.test', operatorId: 'op-parcel-a' } };
  route.handler(req, res);
  return { status, body: text ? JSON.parse(text) : null, guards: route.middleware.map(f => f.name) };
}

test('dashboard routes need a signed-in user with access to the machine; locker routes need its key', () => {
  const dash = [['GET', '/boxes'], ['POST', '/boxes/:n/service'], ['GET', '/parcels'], ['GET', '/parcels/:id'],
    ['POST', '/parcels/:id/collected'], ['POST', '/parcels/:id/clear'], ['GET', '/orders'], ['POST', '/orders'], ['POST', '/orders/:id/cancel']];
  const app = [['POST', '/deposit/lookup'], ['POST', '/deposit/start'], ['POST', '/deposit/:id/result'], ['POST', '/pickup'], ['POST', '/pickup/:id/result']];
  for (const [m, t] of dash) assert.deepEqual(routes.find(r => r.method === m && r.pattern === BASE + t).middleware.map(f => f.name), ['requireAuth', 'requireMachineAccess'], t);
  for (const [m, t] of app) assert.deepEqual(routes.find(r => r.method === m && r.pattern === BASE + t).middleware.map(f => f.name), ['requireMachineKey'], t);
});

test('a parcel goes from an order entered in the dashboard to collected, through the routes', () => {
  const added = call('POST', '/orders', { body: { orderNumber: '70001', phone: '555 0110', firstName: 'Björn Test' } });
  assert.equal(added.status, 200);
  assert.equal(added.body.data.order.firstName, 'Björn');
  assert.equal(call('POST', '/orders', { body: { orderNumber: '70002', phone: 'none' } }).status, 400);
  assert.equal(call('GET', '/orders', { query: { status: 'expected' } }).body.data.orders.some(o => o.orderNumber === '70001'), true);

  const look = call('POST', '/deposit/lookup', { body: { orderNumber: '70001' } });
  assert.equal(look.body.data.order.firstName, 'Björn');
  assert.equal(look.body.data.order.phone, undefined, 'the locker is not sent the phone number');
  const missing = call('POST', '/deposit/lookup', { body: { orderNumber: '79999' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'order_not_found');
  assert.equal(missing.body.error.message, 'Pöntun fannst ekki.');

  const start = call('POST', '/deposit/start', { body: { orderNumber: '70001', size: 'middle' } });
  assert.deepEqual(start.body.data.box, { n: 1, size: 'middle', board: 1, lock: 1 });
  const id = start.body.data.parcelId;
  const fin = call('POST', '/deposit/:id/result', { params: { id }, body: { outcome: 'stored' } });
  assert.equal(fin.body.data.state, 'stored');
  assert.equal(JSON.stringify(fin.body).includes(parcels._secretsOf(id).code), false, 'the locker is not sent the pickup code');

  const boxes = call('GET', '/boxes').body.data;
  assert.equal(boxes.boxes[0].parcel.orderNumber, '70001');
  assert.equal(boxes.counts.occupied, 1);
  assert.equal(call('GET', '/parcels', { query: { state: 'stored' } }).body.data.parcels.length, 1);

  const wrong = call('POST', '/pickup', { body: { code: '12' } });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.body.error.code, 'wrong_code');
  const pick = call('POST', '/pickup', { body: { code: parcels._secretsOf(id).code } });
  assert.equal(pick.body.data.box.lock, 1);
  assert.equal(call('POST', '/pickup/:id/result', { params: { id }, body: { opened: true } }).body.data.state, 'collected');

  const detail = call('GET', '/parcels/:id', { params: { id } }).body.data;
  assert.equal(detail.parcel.state, 'collected');
  assert.equal(detail.events.at(-1).type, 'collected');
  assert.equal(call('POST', '/parcels/:id/collected', { params: { id } }).status, 409);
  assert.equal(call('GET', '/parcels/:id', { params: { id: 'pcl_none' } }).status, 404);
});

test('the operator routes act on boxes and parcels', () => {
  call('POST', '/orders', { body: { orderNumber: '70003', phone: '5550111' } });
  const id = call('POST', '/deposit/start', { body: { orderNumber: '70003', size: 'big' } }).body.data.parcelId;
  call('POST', '/deposit/:id/result', { params: { id }, body: { outcome: 'stored' } });
  const cleared = call('POST', '/parcels/:id/clear', { params: { id }, body: { reason: 'wrong parcel', again: true } });
  assert.equal(cleared.body.data.parcel.state, 'cleared');
  const svc = call('POST', '/boxes/:n/service', { params: { n: '4' }, body: { outOfService: true, reason: 'dented door' } });
  assert.equal(svc.body.data.boxes.find(b => b.n === 4).state, 'out_of_service');
  assert.equal(call('POST', '/deposit/start', { body: { orderNumber: '70003', size: 'big' } }).body.error.code, 'no_free_box');
  assert.equal(call('POST', '/boxes/:n/service', { params: { n: '4' }, body: {} }).status, 400);
  call('POST', '/boxes/:n/service', { params: { n: '4' }, body: { outOfService: false } });
  const order = call('GET', '/orders').body.data.orders.find(o => o.orderNumber === '70003');
  assert.equal(call('POST', '/orders/:id/cancel', { params: { id: String(order.id) } }).body.data.order.status, 'cancelled');
  assert.equal(call('POST', '/deposit/lookup', { body: { orderNumber: '70003' } }).status, 404);
});

test('a machine that is not a locker has no parcels', () => {
  assert.equal(call('GET', '/boxes', { deviceCode: 'VMP-1' }).status, 400);
  assert.equal(call('POST', '/pickup', { deviceCode: 'VMP-1', body: { code: '123456' } }).body.error.code, 'not_a_locker');
  assert.equal(call('GET', '/boxes', { deviceCode: 'NOPE' }).status, 404);
});
