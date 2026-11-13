/**
 * The product search is what the slot picker asks, so it decides what an operator can put in a
 * machine. Two things it got wrong, both reported through TUC Mini Sýrður Rjómi in November 2026.
 *
 * 1. With no machines= parameter it searched EVERY machine in the fleet, so an operator's result
 *    carried stock and prices read off other operators' planograms.
 * 2. It reported no placement count, so the picker could not tell a product already in the user's
 *    machines from one that has never been placed — and the picker was therefore built on the
 *    placement list instead, which is why an operator could only ever pick what she had already
 *    stocked, and nobody could introduce a new product through that screen at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'product-search-test-' + process.pid + '.db');
const storage = require('../src/storage');

storage.upsertOperator({ id: 'ag',  name: 'AG Vending' });
storage.upsertOperator({ id: 'alh', name: 'Alhlida lausnir' });
storage.upsertMachine({ deviceCode: 'AG1',  deviceName: 'Grotta haegri', operatorId: 'ag' });
storage.upsertMachine({ deviceCode: 'AG2',  deviceName: 'Grotta vinstri', operatorId: 'ag' });
storage.upsertMachine({ deviceCode: 'ALH1', deviceName: 'Alhlida machine', operatorId: 'alh' });

// Both TUC products sit in AG's two machines. Alhlida stocks neither.
const bay = (goodsId, name, priceIsk) => ({ goodsId, name, priceIsk, currStock: 4, code: goodsId });
for (const code of ['AG1', 'AG2']) {
  storage.setMeta('layout:' + code, JSON.stringify([{ bays: [
    bay('ORIG-PLACED', 'TUC Mini Original 100gr', 299),
    bay('SYRD-PLACED', 'TUC Mini Syrdur Rjomi 100g', 299),
  ]}]));
}
storage.setMeta('layout:ALH1', JSON.stringify([{ bays: [bay('OTHER', 'Something else', 199)] }]));

// Four catalog rows: the two that are placed, and the two duplicates seen on the live catalog.
const P = (o) => storage.upsertProduct(Object.assign(
  { weimiId: null, goodsCode: null, customCode: null, salePriceIsk: 299, vatRate: 11,
    measurement: 0, barcode: null, imgUrl: null, weightGrams: null, costPriceIsk: null }, o));
P({ goodsId: 'ORIG-PLACED', name: 'TUC Mini Original 100gr',    salePriceIsk: null, imgUrl: 'o.png' });
P({ goodsId: 'ORIG-DUP',    name: 'TUC Mini Original 100gr',    salePriceIsk: 299 });
P({ goodsId: 'SYRD-PLACED', name: 'TUC Mini Syrdur Rjomi 100g', salePriceIsk: null, imgUrl: 's.png' });
P({ goodsId: 'SYRD-SEED',   name: 'TUC Mini Syrdur Rjomi 100g', salePriceIsk: 299 });

const { handleProductSearch } = require('../src/router');

const AG  = { id: 'u1', email: 'ag@t.is',  role: 'ag_admin',       operatorId: 'ag' };
const ALH = { id: 'u2', email: 'alh@t.is', role: 'operator_admin', operatorId: 'alh' };

function search(user, query) {
  const cap = { body: null };
  const res = { writeHead(){}, setHeader(){}, end(b) { try { cap.body = JSON.parse(b); } catch { cap.body = b; } } };
  handleProductSearch({ query, user }, res);
  const d = cap.body && cap.body.data;
  return Array.isArray(d) ? d : [];
}
const tuc = rows => rows.filter(r => /tuc/i.test(r.name || ''));

// ─── What each account can find ───────────────────────────────────────────────

test('an operator finds a product she has never stocked', () => {
  // The reported case. Her machines hold no TUC at all, and she must still be able to pick one.
  const rows = tuc(search(ALH, { q: 'tuc' }));
  assert.ok(rows.length >= 2, 'both TUC products must be findable, got ' + rows.length);
  assert.ok(rows.some(r => /Syrdur/i.test(r.name)), 'including TUC Mini Syrdur Rjomi');
});

test('she is told the product is in none of her machines', () => {
  for (const r of tuc(search(ALH, { q: 'tuc' }))) {
    assert.strictEqual(r.machineCount, 0, r.name + ' is in none of HER machines');
  }
});

test('the AG admin sees the real placement count', () => {
  const rows = tuc(search(AG, { q: 'tuc' }));
  assert.ok(rows.every(r => r.machineCount === 2), 'both TUC products sit in two machines');
});

// ─── Scoping ──────────────────────────────────────────────────────────────────

test('an operator never gets stock read off another operator\'s machines', () => {
  // Before the fix the fallback was the whole fleet, so these came back stocked.
  for (const r of tuc(search(ALH, { q: 'tuc' }))) {
    assert.ok(!(r.stock > 0), r.name + ' is not stocked in any machine she can reach');
  }
});

test('asking for a machine that is not yours contributes nothing', () => {
  const rows = tuc(search(ALH, { q: 'tuc', machines: 'AG1,AG2' }));
  assert.ok(rows.every(r => !(r.stock > 0) && !r.machineCount),
    'a foreign device code must not answer for its operator');
});

test('asking for your own machine still works', () => {
  const rows = tuc(search(AG, { q: 'tuc', machines: 'AG1' }));
  assert.ok(rows.every(r => r.machineCount === 1), 'scoped to the one machine asked for');
});

// ─── Behaviour that must not regress ──────────────────────────────────────────

test('duplicate rows for one product collapse to a single entry', () => {
  // Four catalog rows, two products. A picker offering four would be offering the same cracker
  // twice. The in-stock record wins and donates nothing it already has.
  const names = tuc(search(AG, { q: 'tuc' })).map(r => r.name).sort();
  assert.deepStrictEqual(names, ['TUC Mini Original 100gr', 'TUC Mini Syrdur Rjomi 100g']);
});

test('a short query returns nothing rather than the whole catalogue', () => {
  assert.deepStrictEqual(search(AG, { q: 'tu' }), []);
});

test('scope=catalog still answers from the product table alone', () => {
  // The fridge basket picker depends on this branch and must keep seeing every row, duplicates
  // included — a basket has to point at one specific catalog record.
  const rows = tuc(search(ALH, { q: 'tuc', scope: 'catalog' }));
  assert.strictEqual(rows.length, 4);
});
