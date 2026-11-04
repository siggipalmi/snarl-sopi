/**
 * The "no sales for N h" check reads sale times from storage. A coil machine selling through our
 * own app writes `orders` only (no order_items), and must not read as silent (Grótta, 2026-11-04).
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'saletimes-test-' + process.pid + '.db');
const storage = require('../src/storage');

const H = 3600000;
const now = Date.parse('2026-11-04T09:00:00Z');

test('kiosk sales (orders only) count, one time per sale, failed orders do not', () => {
  const t1 = now - 2 * H, t2 = now - 1 * H;
  // one kiosk sale of two lines, same timestamp
  storage.insertOrder({ tradeNo: 'SSa#0', deviceCode: 'K1', status: 1, amountKr: 299, createTime: t1 });
  storage.insertOrder({ tradeNo: 'SSa#1', deviceCode: 'K1', status: 1, amountKr: 189, createTime: t1 });
  storage.insertOrder({ tradeNo: 'SSb#0', deviceCode: 'K1', status: 1, amountKr: 499, createTime: t2 });
  storage.insertOrder({ tradeNo: 'W-fail', deviceCode: 'K1', status: 0, amountKr: 499, createTime: now - 10 * 60000 });
  const times = storage.saleTimesSince('K1', now - 28 * 24 * H, false).sort();
  assert.deepEqual(times, [t1, t2]);
});

test('a Weimi order in both tables is one sale; order_items-only history still counts', () => {
  const t1 = now - 5 * H, old = now - 20 * 24 * H;
  storage.insertOrder({ tradeNo: 'W1', deviceCode: 'W9', status: 1, amountKr: 350, createTime: t1 });
  storage.upsertOrderItem({ tradeNo: 'W1', lineIndex: 0, deviceCode: 'W9', payAmount: 35000, shipmentStatus: 1, createTime: t1 });
  storage.upsertOrderItem({ tradeNo: 'W0', lineIndex: 0, deviceCode: 'W9', payAmount: 35000, shipmentStatus: 1, createTime: old });
  const times = storage.saleTimesSince('W9', now - 28 * 24 * H, false).sort();
  assert.deepEqual(times, [old, t1]);
});

test('outside the window and other machines are left out', () => {
  storage.insertOrder({ tradeNo: 'SSold#0', deviceCode: 'K2', status: 1, amountKr: 1, createTime: now - 40 * 24 * H });
  assert.deepEqual(storage.saleTimesSince('K2', now - 28 * 24 * H, false), []);
});
