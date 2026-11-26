/**
 * Web shops reporting locker orders (6.132.0). Invented shop, orders and numbers.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-shops-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');
const parcels = require('../src/parcels');
const shops = require('../src/lockerShops');

for (const id of ['op-shop-a', 'op-shop-b']) {
  storage.upsertOperator({ id, name: id, isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
}
const M = { deviceCode: 'LKSH-1', deviceName: 'Skápur', location: '', operatorId: 'op-shop-a', model: 'LK-AGV19', isKioskModel: 0, isOnline: 1, isRunning: 1,
  kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1, settings: { locker: { info: {}, boxes: [{ n: 1, size: 'small', board: 1, lock: 1 }] } },
  profile: {}, featured: [], ads: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
storage.upsertMachine(M); machines[M.deviceCode] = M;

const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
function order(number, extra) {
  return JSON.stringify({ id: 9000 + Number(number), number: String(number), status: 'processing',
    billing: { first_name: 'Guðrún Ósk', last_name: 'Prufudóttir', phone: '555 0177' },
    shipping_lines: [{ method_id: 'local_pickup', method_title: 'Sótt í afhendingarkassa í anddyri - þegar þér hentar' }], ...(extra || {}) });
}
const expected = (op, n) => parcels.listOrders(op, { limit: 500 }).find(o => o.orderNumber === String(n));

const made = shops.create('op-shop-a', { name: 'shop.example.test', shippingMatch: 'afhendingarkassa' }, 'op@example.test');
const { shop, secret } = made;
const deliver = (body, sig, id = shop.id) => shops.handleDelivery(id, body, sig);
const last = () => shops.list('op-shop-a').find(s => s.id === shop.id);

test('connecting a shop gives an address and a secret once; the list never holds the secret', () => {
  assert.equal(made.ok, true);
  assert.match(secret, /^[0-9a-f]{48}$/);
  assert.equal(shop.url, 'https://admin.agvending.is/api/v1/shops/woo/' + shop.id);
  assert.equal(JSON.stringify(shops.list('op-shop-a')).includes(secret), false);
  assert.equal(storage.db.prepare('SELECT secretSealed FROM locker_shops WHERE id = ?').get(shop.id).secretSealed.includes(secret), false, 'sealed at rest');
  assert.equal(shops.create('op-shop-a', { name: '' }, 'x').code, 'bad_name');
  assert.deepEqual(shops.list('op-shop-b'), []);
});

test('a signed locker order becomes an expected order with the phone and the first name only', () => {
  const body = order(58801);
  const r = deliver(body, sign(body, secret));
  assert.deepEqual([r.status, r.body.status], [200, 'stored']);
  const o = expected('op-shop-a', 58801);
  assert.deepEqual([o.status, o.phone, o.firstName, o.source], ['expected', '+3545550177', 'Guðrún', 'woocommerce']);
  assert.equal(last().lastResult, 'order 58801 received');
  assert.equal(JSON.stringify(last()).includes('5550177') || JSON.stringify(last()).includes('Guðrún'), false, 'the connection\'s log holds no personal data');
  assert.deepEqual([last().received, last().stored], [1, 1]);
  // The locker can now take it.
  assert.equal(parcels.lookupForDeposit(M, '58801').ok, true);
});

test('WooCommerce\'s test ping is accepted; anything unsigned or wrongly signed is refused and says why', () => {
  assert.equal(deliver('webhook_id=12', undefined).status, 200);
  const body = order(58802);
  assert.equal(deliver(body, undefined).status, 401);
  assert.match(last().lastResult, /no signature/);
  assert.equal(deliver(body, sign(body, 'another-secret')).status, 401);
  assert.match(last().lastResult, /does not match/);
  assert.equal(deliver(body + ' ', sign(body, secret)).status, 401, 'a changed body does not pass');
  assert.equal(expected('op-shop-a', 58802), undefined);
  assert.equal(deliver(body, sign(body, secret), 'nosuchhook').status, 404);
  assert.equal(deliver('not json', sign('not json', secret)).status, 400);
});

test('orders by another delivery method are not taken; a cancelled or changed one is withdrawn', () => {
  const counter = order(58803, { shipping_lines: [{ method_id: 'local_pickup', method_title: 'Sótt í afgreiðslu' }] });
  assert.equal(deliver(counter, sign(counter, secret)).body.status, 'ignored');
  assert.equal(expected('op-shop-a', 58803), undefined);

  const cancelled = order(58801, { status: 'cancelled' });
  deliver(cancelled, sign(cancelled, secret));
  assert.equal(expected('op-shop-a', 58801).status, 'cancelled');
  assert.match(last().lastResult, /58801 withdrawn/);
  assert.equal(parcels.lookupForDeposit(M, '58801').code, 'order_not_found');
  // The shop un-cancels it: expected again.
  const back = order(58801);
  deliver(back, sign(back, secret));
  assert.equal(expected('op-shop-a', 58801).status, 'expected');
});

test('an order already in a box is not touched by later news from the shop', () => {
  const s = parcels.startDeposit(M, { orderNumber: '58801', size: 'small' });
  parcels.finishDeposit(M, s.parcelId, { outcome: 'stored' });
  const cancelled = order(58801, { status: 'refunded' });
  deliver(cancelled, sign(cancelled, secret));
  assert.equal(expected('op-shop-a', 58801).status, 'deposited');
  assert.equal(parcels.boxView(M).boxes[0].state, 'occupied');
  const again = order(58801, { billing: { first_name: 'Annar', phone: '5550199' } });
  assert.equal(deliver(again, sign(again, secret)).body.status, 'stored');
  assert.equal(expected('op-shop-a', 58801).phone, '+3545550177', 'the number the SMS went to stays');
  assert.match(last().lastResult, /already in a locker/);
});

test('an order with no usable mobile number is not taken, and the log says so', () => {
  const body = order(58804, { billing: { first_name: 'Jón', phone: '' } });
  assert.equal(deliver(body, sign(body, secret)).body.reason, 'bad_phone');
  assert.match(last().lastResult, /58804 not taken: it has no usable mobile number/);
});

test('until a shipping method is named nothing is taken, and the log lists what the shop sent', () => {
  const b = shops.create('op-shop-b', { name: 'other.example.test' }, 'x');
  const body = order(58805);
  const r = shops.handleDelivery(b.shop.id, body, sign(body, b.secret));
  assert.equal(r.body.status, 'ignored');
  assert.match(shops.list('op-shop-b')[0].lastResult, /Sótt í afhendingarkassa/);
  assert.equal(expected('op-shop-b', 58805), undefined);
  // One operator's secret does not open another's connection.
  assert.equal(shops.handleDelivery(b.shop.id, body, sign(body, secret)).status, 401);
  assert.equal(shops.update('op-shop-a', b.shop.id, { shippingMatch: 'x' }).code, 'shop_not_found');
  assert.equal(shops.update('op-shop-b', b.shop.id, { shippingMatch: 'afhendingarkassa' }).shop.shippingMatch, 'afhendingarkassa');
  assert.equal(shops.handleDelivery(b.shop.id, body, sign(body, b.secret)).body.status, 'stored');
});

test('a new secret replaces the old one at once; a removed connection answers nothing', () => {
  const fresh = shops.newSecretFor('op-shop-a', shop.id);
  assert.notEqual(fresh.secret, secret);
  const body = order(58806);
  assert.equal(deliver(body, sign(body, secret)).status, 401);
  assert.equal(deliver(body, sign(body, fresh.secret)).status, 200);
  assert.equal(shops.newSecretFor('op-shop-b', shop.id).code, 'shop_not_found');
  assert.equal(shops.remove('op-shop-b', shop.id).code, 'shop_not_found');
  assert.equal(shops.remove('op-shop-a', shop.id).ok, true);
  assert.equal(deliver(body, sign(body, fresh.secret)).status, 404);
});

test('routes: deliveries are open and signed; managing connections needs an operator admin', () => {
  const find = (m, p) => routes.find(r => r.method === m && r.pattern === p);
  assert.deepEqual(find('POST', '/api/v1/shops/woo/:hookId').middleware, []);
  const base = '/api/v1/operators/:operatorId/locker-shops';
  // Staff see nothing of the connection: its address is half of what a shop needs to post orders.
  for (const [m, t] of [['GET', ''], ['POST', ''], ['PUT', '/:id'], ['POST', '/:id/secret'], ['DELETE', '/:id']]) {
    assert.deepEqual(find(m, base + t).middleware.map(f => f.name), ['requireAuth', 'requireOperatorAccess', 'requireOperatorAdmin'], m + ' ' + t);
  }
  // Through the route: created, listed without the secret, and a delivery lands.
  const call = (m, p, req) => { let status = 0, text = ''; find(m, p).handler({ query: {}, headers: {}, user: { role: 'operator_admin', email: 'op@example.test', operatorId: 'op-shop-a' }, ...req }, { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } }); return { status, body: text ? JSON.parse(text) : null }; };
  const created = call('POST', base, { params: { operatorId: 'op-shop-a' }, body: { name: 'route.example.test', shippingMatch: 'afhendingarkassa' } }).body.data;
  assert.equal(JSON.stringify(call('GET', base, { params: { operatorId: 'op-shop-a' } }).body).includes(created.secret), false);
  const body = order(58807);
  const r = call('POST', '/api/v1/shops/woo/:hookId', { params: { hookId: created.shop.id }, rawBody: body, headers: { 'x-wc-webhook-signature': sign(body, created.secret) } });
  assert.deepEqual([r.status, r.body.status], [200, 'stored']);
});
