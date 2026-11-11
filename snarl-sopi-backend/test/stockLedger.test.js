/**
 * Count ledger (6.115.0). Grótta vinstri, 2026-11-10: eight bays read 0 in the dashboard while
 * holding 4–10 products each, and nothing could say how they got there. Every change to a bay's
 * count on a Kiosk-stock machine is now written with its cause, and the Weimi sync writes Weimi's
 * numbers nowhere for such a machine.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'stock-ledger-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const storage = require('../src/storage');
const weimi = require('../src/weimi');
const weimiSync = require('../src/weimiSync');

let CODE = 'L1';
function machine(extra) {
  return { deviceCode: CODE, deviceName: 'Ledger test', location: '', operatorId: 'op-ag', model: 'WM55', isKioskModel: 0,
    isOnline: 1, isRunning: 1, kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra };
}
function layout() {
  return [
    { layer: 'A', bays: [
      { code: '0-A01', goodsId: 'g1', name: 'KitKat', currStock: 4, maxStock: 8, priceIsk: 350 },
      { code: '0-A02', goodsId: 'g1', name: 'KitKat', currStock: 2, maxStock: 8, priceIsk: 350 },
      { code: '0-A03', goodsId: 'g2', name: 'Pepsi Max', currStock: 0, maxStock: 10, priceIsk: 450 },
    ] },
  ];
}

storage.upsertOperator({ id: 'op-ag', name: 'AG', isAGVending: 1, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });

test('a sale writes the bay it came from, spills to a second bay, and says when nothing was left', () => {
  storage.upsertMachine(machine());
  storage.setMeta('layout:' + CODE, JSON.stringify(layout()));
  const t = Date.now();
  storage.applySaleToLayout(CODE, 'g1', 1, t, '0-A01', 'sale-1');
  storage.applySaleToLayout(CODE, 'g1', 4, t + 1, '0-A02', 'sale-2'); // 2 from A02, 2 spill from A01
  storage.applySaleToLayout(CODE, 'g2', 1, t + 2, '0-A03', 'sale-3'); // nothing to take

  const rows = storage.listStockLedger(CODE).reverse();
  assert.deepStrictEqual(rows.map(r => [r.cause, r.aisleCode, r.before, r.after, r.delta]), [
    ['sale', '0-A01', 4, 3, -1],
    ['sale', '0-A02', 2, 0, -2],
    ['sale_spill', '0-A01', 3, 1, -2],
    ['sale_unmatched', '0-A03', null, null, 0],
  ]);
  assert.strictEqual(rows[3].ref, 'sale-3 ×1');
  assert.strictEqual(rows[0].productName, 'KitKat');
  const l = JSON.parse(storage.getMeta('layout:' + CODE));
  assert.deepStrictEqual(l[0].bays.map(b => b.currStock), [1, 0, 0]);
});

test('a sale older than the bay\'s refill is written but not counted', () => {
  CODE = 'L2'; storage.upsertMachine(machine());
  storage.setMeta('layout:' + CODE, JSON.stringify(layout()));
  const before = Date.now() - 60000;
  storage.applyRestockToLayout(CODE, [{ aisleCode: '0-A01', currStock: 8 }], 'siggi@example.is');
  storage.applySaleToLayout(CODE, 'g1', 1, before, '0-A01', 'queued-sale');
  const rows = storage.listStockLedger(CODE, { aisle: '0-A01' });
  // newest first: the sale happened before the restock, so it sorts after it
  assert.strictEqual(rows[0].cause, 'restock');
  assert.strictEqual(rows[0].actor, 'siggi@example.is');
  assert.deepStrictEqual([rows[0].before, rows[0].after], [4, 8]);
  assert.strictEqual(rows[1].cause, 'sale_skipped');
  assert.deepStrictEqual([rows[1].before, rows[1].after], [8, 8]);
  const l = JSON.parse(storage.getMeta('layout:' + CODE));
  assert.strictEqual(l[0].bays[0].currStock, 8);
});

test('a restock dates the machine\'s last visit and clears the "set its count" flag', () => {
  CODE = 'L3'; storage.upsertMachine(machine());
  const lay = layout(); lay[0].bays[2].needsCount = true;
  storage.setMeta('layout:' + CODE, JSON.stringify(lay));
  const t0 = Date.now();
  storage.applyRestockToLayout(CODE, [{ aisleCode: '0-A03', currStock: 10 }], 'siggi@example.is');
  const l = JSON.parse(storage.getMeta('layout:' + CODE));
  assert.strictEqual(l[0].bays[2].needsCount, undefined);
  assert.strictEqual(l[0].bays[2].currStock, 10);
  assert.ok(storage.getLastRestockAt(CODE) >= t0);
  // sold-out tracking read our layout: Pepsi Max is in stock again
  assert.strictEqual(storage.getCurrentStock(CODE, 'g2').stock, 10);
});

test('the Weimi sync leaves a Kiosk machine\'s counts and restock dates alone, flags a new bay at 0, and writes removals and swaps', async () => {
  CODE = 'L4';
  const lay = layout();
  lay[0].bays[0].restockAt = '2026-11-01T10:00:00.000Z';
  storage.setMeta('layout:' + CODE, JSON.stringify(lay));
  storage.upsertMachine(machine());
  const original = weimi.deviceInfo;
  weimi.deviceInfo = async () => ({
    deviceName: 'Ledger test',
    cabinets: [{ layers: [{ layer: 'A', aisles: [
      { code: '0-A01', goodsId: 'g1', goodsName: 'KitKat', currStock: 99, maxStock: 8, price: 35000, isEnable: true, isBroken: false },
      // A02 swapped to a different product in Weimi; A03 gone; A04 brand new with a stale Weimi count
      { code: '0-A02', goodsId: 'g3', goodsName: 'Snickers', currStock: 7, maxStock: 8, price: 35000, isEnable: true, isBroken: false },
      { code: '0-A04', goodsId: 'g2', goodsName: 'Pepsi Max', currStock: 6, maxStock: 10, price: 45000, isEnable: true, isBroken: false },
    ] }] }],
  });
  try {
    const sinceMs = Date.now() - 1000;
    await weimiSync.syncDeviceProducts(CODE);
    const l = JSON.parse(storage.getMeta('layout:' + CODE));
    const by = {}; l[0].bays.forEach(b => { by[b.code] = b; });
    assert.strictEqual(by['0-A01'].currStock, 4, 'our count kept, not Weimi\'s 99');
    assert.strictEqual(by['0-A01'].restockAt, '2026-11-01T10:00:00.000Z', 'restock date survives a sync');
    assert.strictEqual(by['0-A02'].currStock, 2, 'a product swap keeps the count');
    assert.strictEqual(by['0-A02'].name, 'Snickers');
    assert.strictEqual(by['0-A04'].currStock, 0, 'a new bay starts at 0, not at Weimi\'s number');
    assert.strictEqual(by['0-A04'].needsCount, true);
    assert.strictEqual(by['0-A03'], undefined);
    const causes = storage.listStockLedger(CODE, { sinceMs }).map(r => r.cause + ':' + r.aisleCode).sort();
    assert.deepStrictEqual(causes, ['sync_bay_removed:0-A03', 'sync_new_bay:0-A04', 'sync_product_changed:0-A02']);
    const m = storage.getMachine(CODE);
    assert.strictEqual(m.totalCurrStock, 6, 'machine total from our layout (4 + 2 + 0)');
    // stock history for this machine never carries a weimi_sync row
    const hist = storage.db.prepare("SELECT COUNT(*) n FROM stock_history WHERE deviceCode = ? AND source = 'weimi_sync'").get(CODE);
    assert.strictEqual(hist.n, 0);
  } finally {
    weimi.deviceInfo = original;
  }
});

test('a Weimi-stock machine still takes Weimi\'s counts and writes no ledger', async () => {
  const W = 'W1';
  storage.upsertMachine(machine({ deviceCode: W, stockSource: 'weimi' }));
  const original = weimi.deviceInfo;
  weimi.deviceInfo = async () => ({ cabinets: [{ layers: [{ layer: 'A', aisles: [
    { code: '0-A01', goodsId: 'g1', goodsName: 'KitKat', currStock: 5, maxStock: 8, price: 35000, isEnable: true, isBroken: false },
  ] }] }] });
  try {
    await weimiSync.syncDeviceProducts(W);
    const l = JSON.parse(storage.getMeta('layout:' + W));
    assert.strictEqual(l[0].bays[0].currStock, 5);
    assert.strictEqual(storage.listStockLedger(W).length, 0);
    assert.strictEqual(storage.getMachine(W).totalCurrStock, 5);
  } finally {
    weimi.deviceInfo = original;
  }
});
