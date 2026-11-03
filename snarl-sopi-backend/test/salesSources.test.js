const test = require('node:test');
const assert = require('node:assert');
const { salesSources } = require('../src/salesSources');

const T = Date.parse('2026-11-02T12:00:00Z');
const o = (tradeNo, amountKr, at, extra = {}) => ({ tradeNo, amountKr, createTime: at, status: 1, ...extra });

test('a kiosk sale with no order_items line is reported as missing from accounting', () => {
  const r = salesSources({ orders: [o('S1#0', 590, T), o('S1#1', 390, T)], items: [], fromMs: T - 1, toMs: T + 1, days: 1 });
  assert.strictEqual(r.bySource.kiosk.orders, 1);
  assert.strictEqual(r.bySource.kiosk.rows, 2);
  assert.strictEqual(r.kioskSalesWithoutOrderItems.count, 1);
  assert.strictEqual(r.kioskSalesWithoutOrderItems.kr, 980);
  assert.strictEqual(r.weimiOrdersMatchingKioskSales.count, 0);
});

test('a Weimi order of the same total within minutes is flagged as the same purchase, once', () => {
  const r = salesSources({
    orders: [o('S1#0', 1180, T), o('W1', 1180, T + 60000), o('W2', 1180, T + 90000), o('W3', 500, T)],
    items: [{ tradeNo: 'W1', payAmount: 118000, shipmentStatus: 1, createTime: T + 60000 }],
    fromMs: T - 1, toMs: T + 100000, days: 1,
  });
  assert.strictEqual(r.weimiOrdersMatchingKioskSales.count, 1);
  assert.strictEqual(r.weimiOrdersMatchingKioskSales.sample[0].weimiOrder, 'W1');
  assert.strictEqual(r.orderItems.deliveredKr, 1180);
});

test('far apart or different totals do not match; failed orders are ignored; fridge is its own source', () => {
  const r = salesSources({
    orders: [o('S1#0', 590, T), o('W1', 590, T + 10 * 60000), o('W2', 600, T), o('S2#0', 590, T, { status: 2 }), o('F1', 900, T)],
    isFridgeOrder: x => x.tradeNo === 'F1', fromMs: T - 1, toMs: T + 1, days: 1,
  });
  assert.strictEqual(r.weimiOrdersMatchingKioskSales.count, 0);
  assert.strictEqual(r.bySource.kiosk.orders, 1);
  assert.strictEqual(r.bySource.fridge.kr, 900);
  assert.strictEqual(r.bySource.weimi.orders, 2);
});
