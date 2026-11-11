/**
 * A basket over the card's limit (fridge 0.70.13): the app charges up to the limit, asks for another
 * tap, and reports what it collected. The backend keeps the shortfall and alerts — on the final
 * report only, since the interim one comes while the kiosk is still asking.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'fridge-unpaid-test-' + process.pid + '.db');

const { routes } = require('../src/router');
const storage = require('../src/storage');
const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/machines/:deviceCode/fridge/settlement');

function post(deviceCode, body) {
  let status = 0, payload = null;
  const res = {
    setHeader() {}, writeHead(s) { status = s; },
    end(buf) { payload = buf ? JSON.parse(String(buf)) : null; },
  };
  route.handler({ params: { deviceCode }, body, query: {}, headers: {}, socket: {} }, res);
  return { status, payload };
}

// Any registered machine will do: the handler needs one, the planogram can be empty.
function aMachine() {
  const listed = storage.listMachines ? storage.listMachines() : [];
  const m = listed.find(x => x && x.deviceCode);
  return m && m.deviceCode;
}

const base = (orderId, extra) => Object.assign({
  orderId, startedAt: '2026-11-10T12:00:00Z', closedAt: '2026-11-10T12:01:00Z',
  cabinetsOpened: ['A'], totalIsk: 9350, nayaxRef: null, lines: [], anomalies: [],
}, extra);

test('interim partial payment is stored without an alert; the final one alerts once', (t) => {
  const code = aMachine();
  if (!code) return t.skip('no seeded machine in this database');
  const orderId = 'fr-test-' + Date.now();
  const alertId = 'alert_fridge_unpaid_' + code + '_' + orderId;

  let r = post(code, base(orderId, { outcome: 'partially_paid', paidIsk: 8000, final: false, paymentRefs: ['111'] }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(storage.getAlert(alertId), null, 'no alert while the kiosk is still asking');
  const interim = storage.getFridgeSettlement(code, orderId);
  const a1 = JSON.parse(interim.anomalies).find(a => a.reason === 'unpaid_balance');
  assert.deepStrictEqual([a1.paidIsk, a1.unpaidIsk, a1.final], [8000, 1350, false]);

  r = post(code, base(orderId, { outcome: 'partially_paid', paidIsk: 8000, final: true, paymentRefs: ['111'],
    paymentTrail: ['card allowed 8000 kr, session open 95s, reader ready=true, sent 8000 kr → approved 8000 kr (Nayax 111)'] }));
  assert.strictEqual(r.status, 200);
  const alert = storage.getAlert(alertId);
  assert.ok(alert, 'the final report raises the alert');
  assert.strictEqual(alert.type, 'fridge_unpaid_balance');
  assert.match(alert.detail, /1\.350 kr is unpaid/);
  assert.match(alert.detail, /Payment: card allowed 8000 kr, session open 95s/, 'the alert carries the payment trail');

  post(code, base(orderId, { outcome: 'partially_paid', paidIsk: 8000, final: true }));   // replayed
  assert.ok(storage.getAlert(alertId), 'still one alert after a replay');
});

test('a partly paid order is revenue at what was paid; paying the rest rewrites it in full', (t) => {
  const code = aMachine();
  if (!code) return t.skip('no seeded machine in this database');
  const orderId = 'fr-test-rev-' + Date.now();
  const lines = [
    { cabinet: 'A', basket: 1, productId: null, quantity: 4, lineIsk: 2050, startWeightG: 400, endWeightG: 180 },
    { cabinet: 'A', basket: 2, productId: null, quantity: 1, lineIsk: 7300, startWeightG: 900, endWeightG: 250 },
  ];
  post(code, base(orderId, { lines, outcome: 'partially_paid', paidIsk: 8000, final: true }));
  let o = storage.getOrder(orderId);
  assert.ok(o, 'the partly paid order is in orders');
  assert.strictEqual(o.amountKr, 8000);
  assert.strictEqual(o.statusLabel, 'partially_paid');
  const items = storage.orderItemsInRange(code, 0, Date.now() + 86400000).filter(i => i.tradeNo === orderId);
  assert.strictEqual(items.reduce((s, i) => s + i.payAmount, 0), 800000, 'lines add up to what was paid (cents)');

  post(code, base(orderId, { lines, outcome: 'charged', paidIsk: 9350, final: true }));
  o = storage.getOrder(orderId);
  assert.strictEqual(o.amountKr, 9350);
  assert.strictEqual(o.statusLabel, 'charged');
});

test('paid in full over two taps: no shortfall, no alert', (t) => {
  const code = aMachine();
  if (!code) return t.skip('no seeded machine in this database');
  const orderId = 'fr-test-full-' + Date.now();
  const r = post(code, base(orderId, { outcome: 'charged', paidIsk: 9350, final: true, paymentRefs: ['1', '2'] }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(storage.getAlert('alert_fridge_unpaid_' + code + '_' + orderId), null);
  const s = storage.getFridgeSettlement(code, orderId);
  assert.ok(!JSON.parse(s.anomalies).some(a => a.reason === 'unpaid_balance'));
});

test('an older app (no paidIsk) is recorded exactly as before', (t) => {
  const code = aMachine();
  if (!code) return t.skip('no seeded machine in this database');
  const orderId = 'fr-test-old-' + Date.now();
  const r = post(code, base(orderId, { outcome: 'charged' }));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(storage.getFridgeSettlement(code, orderId).anomalies), []);
});
