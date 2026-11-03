/**
 * A sale line can be several of one product: the kiosk sends { goodsId, qty: 2, amountIsk: 1180 }.
 * The quantity has to survive storage, or the line reads as ONE unit at the line total
 * (Lava Show, 2026-11-02: "1 Pepsi Max costs 1180 ISK").
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'sale-qty-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const storage = require('../src/storage');
const { summarize } = require('../src/accounting')._test;

test('an order row keeps its quantity; a row without one stores NULL', () => {
  const base = { deviceCode: 'Q1', goodsId: 'pepsi', productName: 'Pepsi Max', status: 1, statusLabel: 'success', createTime: Date.now() };
  storage.insertOrder({ ...base, tradeNo: 'sale-1#0', amountKr: 1180, totalAmount: 118000, quantity: 2 });
  storage.insertOrder({ ...base, tradeNo: 'sale-2#0', amountKr: 590, totalAmount: 59000 });
  assert.strictEqual(storage.getOrder('sale-1#0').quantity, 2);
  assert.strictEqual(storage.getOrder('sale-2#0').quantity, null);
});

test('an order line item keeps its quantity, and a later upsert without one does not wipe it', () => {
  const it = { tradeNo: 't1', lineIndex: 0, deviceCode: 'Q1', goodsId: 'pepsi', productName: 'Pepsi Max', payAmount: 118000, shipmentStatus: 1, createTime: Date.now() };
  storage.upsertOrderItem({ ...it, quantity: 2 });
  storage.upsertOrderItem({ ...it });
  const rows = storage.reportItems(0, Date.now() + 1000, ['Q1']);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].quantity, 2);
});

test('the day summary counts units, not lines', () => {
  const s = summarize('2026-11-02', [
    { tradeNo: 'a', deviceCode: 'M1', goodsId: 'pepsi', name: 'Pepsi Max', payAmount: 118000, vatRate: 11, quantity: 2 },
    { tradeNo: 'b', deviceCode: 'M1', goodsId: 'pepsi', name: 'Pepsi Max', payAmount: 59000, vatRate: 11 },
  ]);
  assert.strictEqual(s.units, 3);
  assert.strictEqual(s.orders, 2);
  assert.strictEqual(s.grossKr, 1770);
  assert.strictEqual(s.byMachine[0].units, 3);
});
