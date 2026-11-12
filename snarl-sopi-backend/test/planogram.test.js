/**
 * Planogram owned by us (6.116.0): bay edits write our layout with a ledger row each, the Weimi
 * diff compares product/price/capacity and never counts, and the config carries the layout for a
 * Kiosk-catalog machine.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = path.join(os.tmpdir(), 'planogram-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);
const storage = require('../src/storage');
const planogram = require('../src/planogram');

const CODE = 'P1';
storage.upsertOperator({ id: 'op-ag', name: 'AG', isAGVending: 1, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
storage.db.prepare('INSERT OR REPLACE INTO products (goodsId, name, salePriceIsk, imgUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('p-kitkat', 'KitKat', 350, 'https://img/kitkat.png', 1, 1);
storage.db.prepare('INSERT OR REPLACE INTO products (goodsId, name, salePriceIsk, imgUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('p-pepsi', 'Pepsi Max', 450, 'https://img/pepsi.png', 1, 1);
function layout() {
  return [{ layer: 'A', bays: [
    { code: '0-A00', goodsId: 'p-kitkat', name: 'KitKat', image: '', priceIsk: 350, currStock: 4, maxStock: 8, shippingMode: 1 },
    { code: '0-A01', goodsId: 'p-pepsi', name: 'Pepsi Max', image: '', priceIsk: 450, currStock: 2, maxStock: 10, shippingMode: 1 },
  ] }];
}
const causes = (code) => storage.listStockLedger(code).map(r => r.cause);

test('editing a bay: product from our list, price, capacity — the count stays, each change is a ledger row', () => {
  planogram.writeLayout(storage, CODE, layout());
  let r = planogram.editBay(storage, CODE, '0-A01', { goodsId: 'p-kitkat' }, 'siggi@example.is');
  assert.ok(r.ok);
  assert.deepStrictEqual([r.bay.name, r.bay.image, r.bay.priceIsk, r.bay.currStock], ['KitKat', 'https://img/kitkat.png', 350, 2]);
  r = planogram.editBay(storage, CODE, '0-A01', { priceIsk: 390, maxStock: 12 }, 'siggi@example.is');
  assert.deepStrictEqual(r.changed, ['priceIsk', 'maxStock']);
  assert.deepStrictEqual(causes(CODE), ['capacity_changed', 'price_changed', 'product_changed']);
  assert.strictEqual(storage.listStockLedger(CODE)[2].ref, 'Pepsi Max → KitKat');
  assert.strictEqual(planogram.editBay(storage, CODE, '0-A01', { goodsId: 'nope' }).error, 'unknown_product');
  assert.strictEqual(planogram.editBay(storage, CODE, '0-A07', { priceIsk: 1 }).error, 'no_such_bay');
  // clearing a bay empties its count too
  r = planogram.editBay(storage, CODE, '0-A01', { goodsId: '' }, 'siggi@example.is');
  assert.deepStrictEqual([r.bay.goodsId, r.bay.currStock], ['', 0]);
});

test('adding and removing bays: next free position, nine lanes at most, layers created and dropped', () => {
  const C = 'P2';
  planogram.writeLayout(storage, C, layout());
  let r = planogram.addBay(storage, C, 'A', {}, 'siggi@example.is');
  assert.ok(r.ok); assert.strictEqual(r.bay.code, '0-A02'); assert.strictEqual(r.bay.needsCount, true);
  r = planogram.addBay(storage, C, 'B', { goodsId: 'p-pepsi', priceIsk: 460, maxStock: 10 }, 'siggi@example.is');
  assert.ok(r.ok); assert.deepStrictEqual([r.bay.code, r.bay.name, r.bay.priceIsk, r.bay.maxStock], ['0-B00', 'Pepsi Max', 460, 10]);
  for (let i = 3; i <= 8; i++) assert.ok(planogram.addBay(storage, C, 'A', {}).ok);
  assert.strictEqual(planogram.addBay(storage, C, 'A', {}).error, 'layer_full');
  assert.strictEqual(planogram.addBay(storage, C, 'G', {}).error, 'bad_layer');
  assert.strictEqual(planogram.addBay(storage, C, 'A', { code: '0-A00' }).error, 'bay_exists');
  r = planogram.removeBay(storage, C, '0-B00', 'siggi@example.is');
  assert.ok(r.ok);
  const l = planogram.readLayout(storage, C);
  assert.deepStrictEqual(l.map(x => x.layer), ['A']);
  assert.strictEqual(l[0].bays.length, 9);
  assert.ok(causes(C).includes('slot_added') && causes(C).includes('slot_removed'));
  assert.strictEqual(planogram.removeBay(storage, C, '0-B00').error, 'no_such_bay');
});

const INFO = { cabinets: [{ layers: [{ layer: 'A', aisles: [
  { code: '0-A00', goodsId: 'p-kitkat', goodsName: 'KitKat', price: 35000, currStock: 99, maxStock: 8 },        // same (count differs: ignored)
  { code: '0-A01', goodsId: 'p-snickers', goodsName: 'Snickers', price: 39000, currStock: 3, maxStock: 10 },  // product + price differ
  { code: '0-A02', goodsId: 'p-pepsi', goodsName: 'Pepsi Max', price: 45000, currStock: 6, maxStock: 10 },    // new in Weimi
] }, { layer: 'B', aisles: [
  { code: '0-B00', goodsId: 'p-pepsi', goodsName: 'Pepsi Max', price: 45000, currStock: 1, maxStock: 10, shippingMode: 2 },
] }] }] };

test('the Weimi diff names what differs per bay and never compares counts', () => {
  const lay = layout(); lay.push({ layer: 'C', bays: [{ code: '0-C00', goodsId: 'p-kitkat', name: 'KitKat', priceIsk: 350, currStock: 5, maxStock: 8 }] });
  const rows = planogram.weimiDiff(lay, INFO);
  const by = {}; rows.forEach(r => { by[r.code] = r; });
  assert.strictEqual(by['0-A00'].action, null);
  assert.deepStrictEqual(by['0-A01'].diffs, ['product', 'price']);
  assert.strictEqual(by['0-A01'].action, 'take');
  assert.strictEqual(by['0-A02'].action, 'add'); assert.strictEqual(by['0-A02'].ours, null);
  assert.strictEqual(by['0-B00'].action, 'add'); assert.strictEqual(by['0-B00'].layer, 'B');
  assert.strictEqual(by['0-C00'].action, 'remove'); assert.strictEqual(by['0-C00'].weimi, null);
});

test('applying a diff keeps our counts, flags added bays, and writes an import row per change', () => {
  const C = 'P3';
  const lay = layout(); lay.push({ layer: 'C', bays: [{ code: '0-C00', goodsId: 'p-kitkat', name: 'KitKat', priceIsk: 350, currStock: 5, maxStock: 8 }] });
  planogram.writeLayout(storage, C, lay);
  const r = planogram.applyWeimiDiff(storage, C, INFO, [
    { code: '0-A01', action: 'take' }, { code: '0-A02', action: 'add' }, { code: '0-B00', action: 'add' }, { code: '0-C00', action: 'remove' },
    { code: '0-A00', action: 'take' }, // nothing differs but Weimi has it: still a take (no-op values)
    { code: '0-Z09', action: 'add' },   // not in Weimi: skipped
  ], 'siggi@example.is');
  assert.deepStrictEqual(r.skipped, ['0-Z09']);
  const l = planogram.readLayout(storage, C);
  const by = {}; l.forEach(x => x.bays.forEach(b => { by[b.code] = b; }));
  assert.deepStrictEqual([by['0-A01'].name, by['0-A01'].priceIsk, by['0-A01'].currStock], ['Snickers', 390, 2]);
  assert.deepStrictEqual([by['0-A02'].currStock, by['0-A02'].needsCount], [0, true]);
  assert.strictEqual(by['0-B00'].shippingMode, 2);
  assert.strictEqual(by['0-C00'], undefined);
  assert.deepStrictEqual(l.map(x => x.layer), ['A', 'B']);
  const c = causes(C).sort();
  assert.deepStrictEqual(c, ['import_add', 'import_add', 'import_remove', 'import_take', 'import_take']);
});

test('the config block carries every bay with hosted images first, and the machine products follow the layout', () => {
  const block = planogram.configBlock(layout(), { A: 'push' }, { 'p-kitkat': { url: 'https://r2/kitkat.png' } });
  assert.strictEqual(block[0].type, 'push');
  assert.deepStrictEqual(block[0].bays[0], { code: '0-A00', goodsId: 'p-kitkat', name: 'KitKat', priceIsk: 350, image: 'https://r2/kitkat.png', maxStock: 8, currStock: 4 });
  assert.strictEqual(block[0].bays[1].image, null);
  const ps = planogram.productsFromLayout(layout());
  assert.deepStrictEqual(ps.map(p => [p.id, p.name, p.stock, p.maxStock, p.slots]), [['p-kitkat', 'kitkat', 4, 8, ['0-A00']], ['p-pepsi', 'pepsi max', 2, 10, ['0-A01']]]);
});

test('a Kiosk-catalog machine gets the planogram in its config; a Weimi-catalog one does not', () => {
  const db = require('../src/db');
  const C = 'P4';
  planogram.writeLayout(storage, C, layout());
  const base = { deviceCode: C, deviceName: 'Planogram test', location: '', operatorId: 'op-ag', model: 'WM55', products: [], stockSource: 'kiosk',
    configVersion: '1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  storage.upsertMachine({ ...base, catalogSource: 'kiosk' });
  db.machines[C] = storage.getMachine(C);
  let cfg = db.buildConfigResponse(db.machines[C]);
  assert.strictEqual(cfg.catalogSource, 'kiosk');
  assert.strictEqual(cfg.planogram.length, 1);
  assert.strictEqual(cfg.planogram[0].bays.length, 2);
  assert.strictEqual(JSON.parse(JSON.stringify(cfg)).planogram[0].bays[1].currStock, 2);
  storage.upsertMachine({ ...base, catalogSource: 'weimi' });
  db.machines[C] = storage.getMachine(C);
  cfg = db.buildConfigResponse(db.machines[C]);
  assert.strictEqual(cfg.catalogSource, 'weimi');
  assert.strictEqual(JSON.parse(JSON.stringify(cfg)).planogram, undefined);
  assert.strictEqual(storage.getMachine(C).catalogSource, 'weimi');
});
