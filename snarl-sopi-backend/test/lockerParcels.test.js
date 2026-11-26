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

// ── 6.127.0: what the dashboard is shown, and what is forgotten ───────────────────────────────

test('the dashboard sees the last four digits of the phone, and the code only by asking', () => {
  const p = stored(A1, 'small');
  const view = parcels.boxView(A1).boxes.find(b => b.n === p.box.n).parcel;
  assert.equal(view.phoneTail, '0100');
  assert.equal(view.phone, undefined);
  assert.equal(parcels.boxView(A1).model, 'LK-AGV19');
  const shown = call('POST', '/parcels/:id/code', { params: { id: p.parcelId } });
  assert.equal(shown.body.data.code, p.code);
  assert.deepEqual(shown.guards, ['requireAuth', 'requireMachineAccess']);
  const last = parcels.getParcel(A1, p.parcelId).events.at(-1);
  assert.equal(last.type, 'code_shown');
  assert.equal(last.actor, 'op@example.test');
  assert.equal(parcels.revealCode(A2, p.parcelId, 'x').code, 'parcel_not_found');
  parcels.markCollected(A1, p.parcelId, 'op@example.test');
  assert.equal(call('POST', '/parcels/:id/code', { params: { id: p.parcelId } }).status, 409);
});

test('thirty days after a parcel left its box its personal data is blanked; one still in a box is kept', () => {
  const DAY = 86400000, t0 = Date.parse('2026-06-01T12:00:00Z');
  const gone = stored(A2, 'small', t0), still = stored(A2, 'small', t0);
  parcels.markCollected(A2, gone.parcelId, 'op@example.test', t0 + DAY);
  parcels.registerOrder('op-parcel-a', { orderNumber: 'NEVER-CAME', phone: '5550120', firstName: 'Gunnar' }, t0);

  parcels.forgetOldPersonalData(t0 + 30 * DAY);            // 29 days after it was collected
  assert.equal(parcels.getParcel(A2, gone.parcelId).parcel.phoneTail, '0100');

  const r = parcels.forgetOldPersonalData(t0 + 32 * DAY);
  assert.ok(r.parcels >= 1 && r.orders >= 1);
  const after = parcels.getParcel(A2, gone.parcelId).parcel;
  assert.equal(after.phoneTail, '');
  assert.equal(after.firstName, '');
  assert.equal(after.orderNumber, gone.orderNumber, 'the order number and the history stay');
  assert.deepEqual(parcels._secretsOf(gone.parcelId), { code: null, token: null });
  const order = parcels.listOrders('op-parcel-a', { limit: 500 }).find(o => o.orderNumber === gone.orderNumber);
  assert.equal(order.phone, '');

  // Still in its box after 32 days: untouched, and its code still opens the door.
  assert.equal(parcels.getParcel(A2, still.parcelId).parcel.phoneTail, '0100');
  assert.equal(parcels.startPickup(A2, { code: still.code }, t0 + 32 * DAY).ok, true);
  const stillOrder = parcels.listOrders('op-parcel-a', { limit: 500 }).find(o => o.orderNumber === still.orderNumber);
  assert.equal(stillOrder.phone, '+3545550100');

  // An order that never came is kept for ninety days, then withdrawn and blanked.
  const never = () => parcels.listOrders('op-parcel-a', { limit: 500 }).find(o => o.orderNumber === 'NEVER-CAME');
  assert.equal(never().status, 'expected');
  parcels.forgetOldPersonalData(t0 + 91 * DAY);
  assert.equal(never().status, 'cancelled');
  assert.equal(never().phone, '');
  assert.equal(parcels.getParcel(A2, still.parcelId).parcel.phoneTail, '0100', 'ninety days on, the parcel still in its box is intact');
  empty(A2);
});

test('the orders list shows phone endings and counts per status, never a whole number', () => {
  const added = call('POST', '/orders', { body: { orderNumber: '70050', phone: '555 0177', firstName: 'Guðrún' } });
  assert.equal(added.body.data.order.phoneTail, '0177');
  assert.equal(added.body.data.order.phone, undefined);
  const list = call('GET', '/orders', { query: { status: 'expected' } }).body.data;
  assert.ok(list.orders.every(o => o.phone === undefined && o.status === 'expected'));
  assert.equal(JSON.stringify(list).includes('5550177'), false);
  assert.equal(list.counts.expected, list.orders.length);
  assert.ok(list.counts.deposited >= 1 && list.counts.cancelled >= 1);
  const order = list.orders.find(o => o.orderNumber === '70050');
  assert.equal(call('POST', '/orders/:id/cancel', { params: { id: String(order.id) } }).body.data.order.phone, undefined);
});

// ── 6.130.0: collecting with no connection, and the locker's config ───────────────────────────

test('the offline list lets the locker check a code or a link itself, and holds neither', () => {
  const crypto = require('node:crypto');
  const p = stored(A2, 'small');
  parcels.registerOrder('op-parcel-a', { orderNumber: 'OFF-OPENING', phone: '5550130' }, T0);
  parcels.startDeposit(A2, { orderNumber: 'OFF-OPENING', size: 'big' }, T0);       // not stored: not listed
  const r = call('GET', '/offline', { deviceCode: 'LKP-A2' });
  assert.deepEqual(r.guards, ['requireMachineKey']);
  const list = r.body.data;
  assert.match(list.salt, /^[0-9a-f]{32}$/);
  assert.equal(list.parcels.length, 1);
  const e = list.parcels[0];
  assert.equal(e.parcelId, p.parcelId);
  assert.deepEqual(e.box, { n: p.box.n, board: 1, lock: p.box.lock });
  const h = (v) => crypto.createHmac('sha256', list.salt).update(v, 'utf8').digest('hex');
  assert.equal(e.codeHash, h(p.code));
  assert.equal(e.tokenHash, h(p.token));
  const text = JSON.stringify(list);
  assert.equal(text.includes(p.code) || text.includes(p.token) || text.includes('5550100'), false);
  assert.notEqual(call('GET', '/offline', { deviceCode: 'LKP-A2' }).body.data.salt, list.salt, 'a new salt every time');
  assert.equal(call('GET', '/offline', { deviceCode: 'LKP-B1' }).body.data.parcels.length, 0, 'another locker\'s parcels are not in it');
  empty(A2);
});

test('a pickup made offline is taken when it is reported, dated when it happened, and never refused', () => {
  const t0 = Date.parse('2026-11-26T08:00:00Z'), H = 3600000;
  const res = (m, id, body, now) => parcels.finishPickup(m, id, body, now);

  const a = stored(A2, 'small', t0);
  const done = res(A2, a.parcelId, { opened: true, offline: true, at: new Date(t0 + 2 * H).toISOString() }, t0 + 5 * H);
  assert.deepEqual([done.ok, done.state], [true, 'collected']);
  const view = parcels.getParcel(A2, a.parcelId);
  assert.equal(view.parcel.endedAt, new Date(t0 + 2 * H).toISOString(), 'dated when the customer was there');
  assert.equal(view.events.at(-1).type, 'collected');
  assert.equal(view.events.at(-1).detail, 'offline');
  // The same report again (the answer was lost): still 200, nothing changes.
  assert.equal(res(A2, a.parcelId, { opened: true, offline: true, at: new Date(t0 + 2 * H).toISOString() }, t0 + 6 * H).state, 'collected');

  // A locker clock that is wrong is not believed.
  const b = stored(A2, 'small', t0);
  res(A2, b.parcelId, { opened: true, offline: true, at: '2019-01-01T00:00:00Z' }, t0 + 3 * H);
  assert.equal(parcels.getParcel(A2, b.parcelId).parcel.endedAt, new Date(t0 + 3 * H).toISOString());
  const c = stored(A2, 'small', t0);
  res(A2, c.parcelId, { opened: true, offline: true, at: 'nonsense' }, t0 + 3 * H);
  assert.equal(parcels.getParcel(A2, c.parcelId).parcel.endedAt, new Date(t0 + 3 * H).toISOString());

  // The operator cleared the box while the locker was offline; the customer still opened it.
  const d = stored(A2, 'small', t0);
  parcels.clearParcel(A2, d.parcelId, 'op@example.test', {}, t0 + H);
  const late = res(A2, d.parcelId, { opened: true, offline: true, at: new Date(t0 + 2 * H).toISOString() }, t0 + 4 * H);
  assert.deepEqual([late.ok, late.state], [true, 'cleared'], 'answered, and the operator\'s action stands');
  assert.equal(parcels.getParcel(A2, d.parcelId).events.at(-1).type, 'offline_pickup_after');

  // The door did not open offline: recorded, the parcel stays.
  const e = stored(A2, 'small', t0);
  assert.equal(res(A2, e.parcelId, { opened: false, offline: true, at: new Date(t0 + H).toISOString() }, t0 + 2 * H).state, 'stored');
  assert.equal(parcels.getParcel(A2, e.parcelId).events.at(-1).detail, 'offline');
  // Another locker's parcel is still not this locker's to report on.
  assert.equal(res(A1, e.parcelId, { opened: true, offline: true }, t0 + 2 * H).code, 'parcel_not_found');
  // Online, a result for a cleared parcel is still a refusal.
  assert.equal(res(A2, d.parcelId, { opened: true }, t0 + 4 * H).code, 'wrong_state');
  empty(A2);
});

test('after a cancelled deposit, a bigger box is a new parcel; the reasons are kept', () => {
  parcels.registerOrder('op-parcel-a', { orderNumber: 'BIGGER', phone: '5550131' }, T0);
  const first = parcels.startDeposit(A2, { orderNumber: 'BIGGER', size: 'small' }, T0);
  parcels.finishDeposit(A2, first.parcelId, { outcome: 'cancelled', reason: 'bigger_box' }, T0);
  assert.equal(parcels.lookupForDeposit(A2, 'BIGGER').resume, null, 'the cancelled parcel is not offered again');
  const second = parcels.startDeposit(A2, { orderNumber: 'BIGGER', size: 'big' }, T0);
  assert.equal(second.resumed, false);
  assert.notEqual(second.parcelId, first.parcelId);
  assert.equal(second.box.size, 'big');
  assert.equal(parcels.getParcel(A2, first.parcelId).events.at(-1).detail, 'bigger_box');
  empty(A2);
});

test('a locker\'s config carries what it shows and its doors; a coil machine\'s does not', () => {
  const cfg = (deviceCode) => {
    let text = '';
    routes.find(r => r.method === 'GET' && r.pattern === '/api/v1/machines/:deviceCode/config')
      .handler({ params: { deviceCode }, headers: {}, query: {} }, { writeHead() {}, setHeader() {}, end(b) { text = b ? b.toString() : ''; } });
    return JSON.parse(text).data;
  };
  const locker = cfg('LKP-A1').locker;
  assert.equal(locker.name, 'Skápur LKP-A1');
  assert.equal(locker.address, 'Prufugata 1');
  assert.deepEqual(locker.boxes[0], { n: 1, size: 'middle', board: 1, lock: 1 });
  assert.equal(locker.boxes.length, 4);
  assert.equal(JSON.stringify(locker).includes('messagingServiceSid'), false, 'the SMS sender is not the locker\'s business');
  assert.equal(cfg('VMP-1').locker, undefined);
});

// ── 6.131.0: an operator opens a door from the dashboard ──────────────────────────────────────

test('open box: the backend names the lock, the locker answers, and both are in the history', () => {
  const find = (m, p) => routes.find(r => r.method === m && r.pattern === p);
  const send = (deviceCode, params, role = 'operator_admin') => {
    let status = 0, text = '';
    find('POST', '/api/v1/machines/:deviceCode/commands').handler(
      { params: { deviceCode }, body: { type: 'open_box', params }, query: {}, headers: {}, user: { role, email: 'op@example.test', operatorId: 'op-parcel-a', name: 'Op' } },
      { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } });
    return { status, body: text ? JSON.parse(text) : null };
  };
  const pending = (deviceCode) => {
    let text = '';
    find('GET', '/api/v1/machines/:deviceCode/commands').handler({ params: { deviceCode }, headers: {}, query: {} }, { writeHead() {}, end(b) { text = b.toString(); } });
    return JSON.parse(text).data.commands.filter(c => c.type === 'open_box');
  };
  const answer = (deviceCode, id, body) => {
    let status = 0;
    find('POST', '/api/v1/machines/:deviceCode/commands/:id/result').handler({ params: { deviceCode, id }, body, headers: {}, query: {} }, { writeHead(s) { status = s; }, end() {} });
    return status;
  };

  assert.equal(send('VMP-1', { n: 1 }).status, 400, 'not on a coil machine');
  assert.equal(send('LKP-A2', { n: 99 }).status, 400, 'not a box this locker has');
  assert.equal(send('LKP-A2', {}).status, 400);

  // A box with a parcel: the parcel stays stored and its code keeps working.
  const p = stored(A2, 'big');
  assert.equal(send('LKP-A2', { n: p.box.n, board: 9, lock: 9, extra: 'x' }).status, 200);
  const cmd = pending('LKP-A2').at(-1);
  assert.deepEqual(cmd.params, { n: 4, board: 1, lock: 4 }, 'the lock comes from the box list, whatever the caller sent');
  assert.equal(answer('LKP-A2', cmd.id, { status: 'ok', opened: true }), 200);
  const view = parcels.getParcel(A2, p.parcelId);
  assert.deepEqual(view.events.slice(-2).map(e => [e.type, e.actor]), [['open_requested', 'op@example.test'], ['opened_by_operator', 'locker']]);
  assert.equal(view.parcel.state, 'stored');
  assert.equal(parcels.startPickup(A2, { code: p.code }, Date.now()).ok, true);

  // The door did not open: said so, with the locker's reason.
  send('LKP-A2', { n: p.box.n });
  answer('LKP-A2', pending('LKP-A2').at(-1).id, { status: 'failed', opened: false, detail: 'open reply 00' });
  const last = parcels.getParcel(A2, p.parcelId).events.at(-1);
  assert.deepEqual([last.type, last.detail], ['open_failed', 'open reply 00']);

  // An empty box: the history is the box's own.
  send('LKP-A2', { n: 1 });
  answer('LKP-A2', pending('LKP-A2').at(-1).id, { status: 'unsupported' });
  const box = parcels.boxView(A2).boxes.find(b => b.n === 1);
  assert.deepEqual(box.recent.map(e => e.type), ['open_failed', 'open_requested']);
  assert.match(box.recent[0].detail, /does not know/);
  assert.deepEqual(parcels.boxView(A2).boxes.find(b => b.n === 4).recent, [], 'a box with a parcel shows the parcel\'s history instead');
  empty(A2);
});

// ── 6.133.0: a door that does not open ────────────────────────────────────────────────────────

test('a box whose door did not open on a deposit is taken out of service and not offered again', () => {
  parcels.registerOrder('op-parcel-a', { orderNumber: 'STUCK', phone: '5550140' }, T0);
  const first = call('POST', '/deposit/start', { deviceCode: 'LKP-A2', body: { orderNumber: 'STUCK', size: 'small' } }).body.data;
  assert.equal(first.box.n, 2);
  const res = call('POST', '/deposit/:id/result', { deviceCode: 'LKP-A2', params: { id: first.parcelId }, body: { outcome: 'cancelled', reason: 'not_opened' } }).body.data;
  assert.equal(res.boxClosed, true);
  const box = parcels.boxView(A2).boxes.find(b => b.n === 2);
  assert.equal(box.state, 'out_of_service');
  assert.match(box.outOfService.reason, /did not open/);
  assert.equal(box.outOfService.by, 'locker');
  // The same order, straight away: another box, not the broken one.
  const second = call('POST', '/deposit/start', { deviceCode: 'LKP-A2', body: { orderNumber: 'STUCK', size: 'small' } }).body.data;
  assert.equal(second.box.n, 3);
  assert.notEqual(second.parcelId, first.parcelId);
  const alert = storage.db.prepare("SELECT title, detail, severity FROM alerts WHERE type = 'locker_door_failed' AND deviceCode = 'LKP-A2'").all();
  assert.equal(alert.length, 1);
  assert.match(alert[0].title, /Box 2 did not open/);
  // Giving up for another reason leaves the box in service.
  call('POST', '/deposit/:id/result', { deviceCode: 'LKP-A2', params: { id: second.parcelId }, body: { outcome: 'cancelled', reason: 'staff_cancel' } });
  assert.equal(parcels.boxView(A2).boxes.find(b => b.n === 3).state, 'vacant');
  parcels.setBoxService(A2, 2, { outOfService: false }, 'op@example.test');
});

test('a door that does not open for a customer raises an alert, and their parcel stays theirs', () => {
  const p = stored(A2, 'middle');
  const s = call('POST', '/pickup', { deviceCode: 'LKP-A2', body: { code: p.code } }).body.data;
  const r = call('POST', '/pickup/:id/result', { deviceCode: 'LKP-A2', params: { id: s.parcelId }, body: { opened: false } }).body.data;
  assert.equal(r.state, 'stored');
  const alerts = storage.db.prepare("SELECT severity, detail FROM alerts WHERE type = 'locker_door_failed' AND deviceCode = 'LKP-A2' AND severity = 'critical'").all();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /still inside/);
  assert.equal(JSON.stringify(alerts).includes(p.code), false);
  // A second failure the same day is the same alert.
  call('POST', '/pickup/:id/result', { deviceCode: 'LKP-A2', params: { id: s.parcelId }, body: { opened: false } });
  assert.equal(storage.db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE type = 'locker_door_failed' AND deviceCode = 'LKP-A2' AND severity = 'critical'").get().c, 1);
  empty(A2);
});

// ── 6.134.0: which doors stand open ───────────────────────────────────────────────────────────

test('the locker reports its open doors: shown per box, kept out of new deposits, and forgotten when the news is old', () => {
  const MIN = 60000, t0 = Date.now() - 60 * MIN;
  const report = (open, now) => parcels.reportDoors(A2, { open, at: new Date(now).toISOString() }, now);
  const box = (n, now) => parcels.boxView(A2, now).boxes.find(b => b.n === n);

  assert.equal(parcels.boxView(A2, t0).doors.known, false, 'before any report nothing is known');
  assert.equal(report([2], t0).ok, true);
  assert.equal(box(2, t0).doorOpenSince, new Date(t0).toISOString());
  assert.equal(box(3, t0).doorOpenSince, null);
  assert.equal(parcels.boxView(A2, t0).doors.known, true);

  // A small order goes to box 3: box 2's door is standing open.
  parcels.registerOrder('op-parcel-a', { orderNumber: 'DOORS', phone: '5550150' }, t0);
  assert.equal(parcels.lookupForDeposit(A2, 'DOORS').ok, true);
  const s = parcels.startDeposit(A2, { orderNumber: 'DOORS', size: 'small' }, t0 + MIN);
  assert.equal(s.box.n, 3);
  parcels.finishDeposit(A2, s.parcelId, { outcome: 'cancelled', reason: 'staff_cancel' }, t0 + MIN);

  // Still open at the next reports: the first-seen time is kept, and after ten minutes it is named.
  assert.deepEqual(report([2], t0 + 5 * MIN).tooLong, []);
  assert.deepEqual(report([2, 4], t0 + 10 * MIN).tooLong, [2]);
  assert.equal(box(2, t0 + 10 * MIN).doorOpenSince, new Date(t0).toISOString());
  // Shut again: gone, and the box is offered again.
  assert.deepEqual(report([], t0 + 11 * MIN).open, []);
  assert.equal(box(2, t0 + 11 * MIN).doorOpenSince, null);
  assert.equal(parcels.startDeposit(A2, { orderNumber: 'DOORS', size: 'small' }, t0 + 11 * MIN).box.n, 2);
  empty(A2);

  // No news for more than ten minutes: an old "open" no longer blocks a box or shows as fact.
  report([3], t0 + 12 * MIN);
  assert.equal(box(3, t0 + 30 * MIN).doorOpenSince, null);
  assert.equal(parcels.boxView(A2, t0 + 30 * MIN).doors.known, false);
  // ...and when it is seen open again after the gap, the clock starts over.
  assert.deepEqual(report([3], t0 + 31 * MIN).tooLong, []);
  assert.equal(box(3, t0 + 31 * MIN).doorOpenSince, new Date(t0 + 31 * MIN).toISOString());

  assert.equal(report([99], t0 + 32 * MIN).code, 'box_not_found');
  assert.equal(parcels.reportDoors(A2, {}, t0).code, 'bad_request');
  report([], Date.now());
});

test('the doors route takes the report with the machine key and raises one alert for a door left open', () => {
  assert.deepEqual(routes.find(r => r.method === 'POST' && r.pattern === BASE + '/doors').middleware.map(f => f.name), ['requireMachineKey']);
  const MIN = 60000;
  // As a locker does: seen open 11 minutes ago, reported again at the 5-minute mark, and now.
  parcels.reportDoors(B1, { open: [4] }, Date.now() - 11 * MIN);
  parcels.reportDoors(B1, { open: [4] }, Date.now() - 6 * MIN);
  const r = call('POST', '/doors', { deviceCode: 'LKP-B1', body: { open: [4], at: new Date().toISOString() } });
  assert.deepEqual([r.status, r.body.data.open], [200, [4]]);
  call('POST', '/doors', { deviceCode: 'LKP-B1', body: { open: [4] } });
  const alerts = storage.db.prepare("SELECT title FROM alerts WHERE type = 'locker_door_left_open' AND deviceCode = 'LKP-B1'").all();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /Box 4 has been open over 10 minutes/);
  assert.equal(call('POST', '/doors', { deviceCode: 'LKP-B1', body: { open: 'all' } }).status, 400);
  assert.equal(call('POST', '/doors', { deviceCode: 'VMP-1', body: { open: [] } }).body.error.code, 'not_a_locker');
  call('POST', '/doors', { deviceCode: 'LKP-B1', body: { open: [] } });
});

// ── 6.135.0: the parcel log ───────────────────────────────────────────────────────────────────

test('the parcel log lists every parcel with its times and how it left, searchable and paged', () => {
  const H = 3600000, t0 = Date.parse('2027-02-01T09:00:00Z');
  const mk = (n, at) => { parcels.registerOrder('op-parcel-b', { orderNumber: n, phone: '5550160', firstName: 'Log' }, at); const s = parcels.startDeposit(B1, { orderNumber: n, size: 'small' }, at); parcels.finishDeposit(B1, s.parcelId, { outcome: 'stored' }, at + 60000); return { ...s, ...parcels._secretsOf(s.parcelId) }; };
  const a = mk('LOG-100', t0);
  const pa = parcels.startPickup(B1, { code: a.code }, t0 + 5 * H); parcels.finishPickup(B1, pa.parcelId, { opened: true }, t0 + 5 * H);
  const b = mk('LOG-101', t0 + 24 * H);
  const pb = parcels.startPickup(B1, { scan: 'https://sms.agvending.is/p/' + b.token }, t0 + 26 * H); parcels.finishPickup(B1, pb.parcelId, { opened: true }, t0 + 26 * H);
  const c = mk('LOG-102', t0 + 48 * H);
  parcels.finishPickup(B1, c.parcelId, { opened: true, offline: true, at: new Date(t0 + 49 * H).toISOString() }, t0 + 50 * H);
  const d = mk('LOG-103', t0 + 72 * H); parcels.markCollected(B1, d.parcelId, 'op@example.test', t0 + 73 * H);
  const e = mk('LOG-104', t0 + 96 * H); parcels.clearParcel(B1, e.parcelId, 'op@example.test', {}, t0 + 97 * H);

  const log = (query) => call('GET', '/parcels', { deviceCode: 'LKP-B1', query: { log: '1', ...query } }).body.data;
  const mine = log({ q: 'log-10' });
  assert.deepEqual(mine.parcels.map(p => p.orderNumber), ['LOG-104', 'LOG-103', 'LOG-102', 'LOG-101', 'LOG-100'], 'newest first, whatever the case typed');
  assert.deepEqual(mine.parcels.map(p => [p.state, p.how]), [['cleared', null], ['collected', 'operator'], ['collected', 'offline'], ['collected', 'scan'], ['collected', 'code']]);
  const first = mine.parcels.at(-1);
  assert.equal(first.createdAt, new Date(t0).toISOString());
  assert.equal(first.storedAt, new Date(t0 + 60000).toISOString());
  assert.equal(first.endedAt, new Date(t0 + 5 * H).toISOString());
  assert.equal(first.hoursInBox, 5);
  assert.equal(first.phone, undefined);
  assert.equal(first.code, undefined);

  assert.deepEqual(log({ q: '#LOG-102' }).parcels.map(p => p.orderNumber), ['LOG-102']);
  assert.deepEqual(log({ q: 'log-10', state: 'cleared' }).parcels.map(p => p.orderNumber), ['LOG-104']);
  assert.deepEqual(log({ q: 'log-10', from: '2027-02-02', to: '2027-02-03' }).parcels.map(p => p.orderNumber), ['LOG-102', 'LOG-101']);
  assert.equal(log({ q: '100%' }).parcels.length, 0, 'a % typed in the search is a character, not a wildcard');

  const page1 = log({ q: 'log-10', limit: '2' });
  assert.deepEqual([page1.parcels.length, page1.more], [2, true]);
  const page2 = log({ q: 'log-10', limit: '2', before: page1.next });
  assert.deepEqual(page2.parcels.map(p => p.orderNumber), ['LOG-102', 'LOG-101']);
  const page3 = log({ q: 'log-10', limit: '2', before: page2.next });
  assert.deepEqual([page3.parcels.map(p => p.orderNumber), page3.more], [['LOG-100'], false]);
  // Another locker's log does not hold them.
  assert.equal(call('GET', '/parcels', { deviceCode: 'LKP-A1', query: { log: '1', q: 'log-10' } }).body.data.parcels.length, 0);
  // Without ?log the route answers as before.
  assert.ok(Array.isArray(call('GET', '/parcels', { deviceCode: 'LKP-B1' }).body.data.parcels));
});

// ── 6.139.0: the photo taken at pickup ────────────────────────────────────────────────────────

test('the locker hands in a pickup photo; only an admin may see it, each look is recorded, and it is deleted after 30 days', () => {
  const DAY = 86400000, t0 = Date.parse('2027-04-01T10:00:00Z');
  // A tiny stand-in for a JPEG: the right first bytes, invented content.
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('invented picture bytes')]);
  const image = jpeg.toString('base64');
  const p = stored(A2, 'small', t0);
  const s = parcels.startPickup(A2, { code: p.code }, t0 + 3600000);
  parcels.finishPickup(A2, s.parcelId, { opened: true }, t0 + 3600000);

  const store = routes.find(r => r.method === 'POST' && r.pattern === BASE + '/pickup/:id/photo');
  const view = routes.find(r => r.method === 'POST' && r.pattern === BASE + '/parcels/:id/photo');
  assert.deepEqual(store.middleware.map(f => f.name), ['requireMachineKey']);
  assert.deepEqual(view.middleware.map(f => f.name), ['requireAuth', 'requireMachineAccess', 'requireOperatorAdmin'], 'staff and managers are stopped before the handler');

  // Refused: not a JPEG, too big, another locker's parcel.
  assert.equal(parcels.storePhoto(A2, p.parcelId, { image: Buffer.from('not a picture').toString('base64') }, t0 + 3600000).code, 'bad_image');
  assert.equal(parcels.storePhoto(A2, p.parcelId, { image: '<script>' }, t0 + 3600000).code, 'bad_image');
  const big = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(parcels.PHOTO_MAX_BYTES)]).toString('base64');
  assert.equal(parcels.storePhoto(A2, p.parcelId, { image: big }, t0 + 3600000).code, 'too_large');
  assert.equal(parcels.storePhoto(A1, p.parcelId, { image }, t0 + 3600000).code, 'parcel_not_found');
  assert.equal(parcels.getParcel(A2, p.parcelId).parcel.photoAt, null);

  const ok = call('POST', '/pickup/:id/photo', { deviceCode: 'LKP-A2', params: { id: p.parcelId }, body: { image, at: new Date().toISOString() } });
  assert.deepEqual([ok.status, ok.body.data.stored], [200, true]);
  const viewOf = parcels.getParcel(A2, p.parcelId);
  assert.ok(viewOf.parcel.photoAt);
  assert.equal(JSON.stringify(viewOf).includes(image), false, 'the picture is not part of the parcel or its history');
  assert.equal(JSON.stringify(parcels.parcelLog(A2, {})).includes(image), false);

  const seen = call('POST', '/parcels/:id/photo', { deviceCode: 'LKP-A2', params: { id: p.parcelId } });
  assert.equal(seen.body.data.image, 'data:image/jpeg;base64,' + image);
  const last = parcels.getParcel(A2, p.parcelId).events.at(-1);
  assert.deepEqual([last.type, last.actor], ['photo_viewed', 'op@example.test']);
  assert.equal(parcels.viewPhoto(A1, p.parcelId, 'x').code, 'parcel_not_found');
  const none = stored(A2, 'small', t0);
  assert.equal(parcels.viewPhoto(A2, none.parcelId, 'x').code, 'no_photo');

  // Kept while the 30 days run, gone after; a parcel still in its box keeps its (none) data.
  storage.db.prepare('UPDATE locker_photos SET createdAt = createdAt WHERE parcelId = ?').run(p.parcelId);
  assert.equal(parcels.forgetOldPersonalData(t0 + 29 * DAY).photos, 0);
  assert.ok(parcels.forgetOldPersonalData(t0 + 32 * DAY).photos >= 1);
  assert.equal(parcels.viewPhoto(A2, p.parcelId, 'x').code, 'no_photo');
  assert.equal(parcels.getParcel(A2, p.parcelId).parcel.photoAt, null);
  empty(A2);
});
