/**
 * One product catalogue, for every screen and every account.
 *
 * Through November 2026 the dashboard had three answers to "what is a product": /products (the
 * catalogue), /products/catalog (placements, scoped to your machines) and /products/search (a
 * merge of both). Every product bug reported came from a screen asking what EXISTS and being
 * handed what is PLACED — a product vanishing from one operator's catalog page, the slot picker
 * offering her nothing at all, a card reading "0 kr", and a search reporting stock off other
 * operators' planograms.
 *
 * There is now one endpoint. The product fields are identical for every caller, because the
 * catalogue is AG's master list and not an operator's. `placement` is computed per caller and
 * only ever describes. These tests pin both halves of that, and the one field that is NOT
 * catalogue-wide: cost price.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'product-catalogue-test-' + process.pid + '.db');
const storage = require('../src/storage');

storage.upsertOperator({ id: 'ag',  name: 'AG Vending' });
storage.upsertOperator({ id: 'alh', name: 'Alhlida lausnir' });
storage.upsertMachine({ deviceCode: 'AG1',  deviceName: 'Grotta haegri',   operatorId: 'ag'  });
storage.upsertMachine({ deviceCode: 'AG2',  deviceName: 'Grotta vinstri',  operatorId: 'ag'  });
storage.upsertMachine({ deviceCode: 'ALH1', deviceName: 'Alhlida machine', operatorId: 'alh' });

const bay = (goodsId, name, priceIsk, stock) => ({ goodsId, name, priceIsk, currStock: stock, code: goodsId });
// Both TUC products are in AG's two machines. One of them is carried under its goodsCode, which
// is the case that used to need identifier-matching in the browser.
storage.setMeta('layout:AG1', JSON.stringify([{ bays: [
  bay('ORIG-CODE', 'TUC Mini Original 100gr', 310, 4),
  bay('SYRD-PLACED', 'TUC Mini Syrdur Rjomi 100g', 310, 4),
]}]));
storage.setMeta('layout:AG2', JSON.stringify([{ bays: [
  bay('ORIG-CODE', 'TUC Mini Original 100gr', 310, 2),
  bay('LOOSE', 'Loaded but never catalogued', 250, 3),
]}]));
storage.setMeta('layout:ALH1', JSON.stringify([{ bays: [bay('OTHER', 'Something else', 199, 5)] }]));

const P = (o) => storage.upsertProduct(Object.assign(
  { weimiId: null, goodsCode: null, customCode: null, salePriceIsk: 299, vatRate: 11,
    measurement: 0, barcode: null, imgUrl: null, weightGrams: null, costPriceIsk: null }, o));
// The four rows from the live catalogue, including the duplicate pair.
P({ goodsId: 'ORIG-PLACED', goodsCode: 'ORIG-CODE', name: 'TUC Mini Original 100gr',
    salePriceIsk: null, costPriceIsk: 450, weightGrams: 100, imgUrl: 'o.png' });
P({ goodsId: 'ORIG-DUP',    name: 'TUC Mini Original 100gr',    costPriceIsk: 350, weightGrams: 100 });
P({ goodsId: 'SYRD-PLACED', name: 'TUC Mini Syrdur Rjomi 100g', costPriceIsk: 450, weightGrams: 100, imgUrl: 's.png' });
P({ goodsId: 'SYRD-SEED',   name: 'TUC Mini Syrdur Rjomi 100g', costPriceIsk: 122, vatRate: null });

const { handleListProducts, handleUnmappedProducts } = require('../src/router');

// machineAccess is 'all' or a list of device codes; the users table defaults it to 'all', so
// that is the shape a signed-in operator admin actually has.
const AG  = { id: 'u1', email: 'ag@t.is',  role: 'ag_admin',       operatorId: 'ag',  machineAccess: 'all' };
const ALH = { id: 'u2', email: 'alh@t.is', role: 'operator_admin', operatorId: 'alh', machineAccess: 'all' };

function call(handler, user, query) {
  const cap = { status: 200, body: null };
  const res = { writeHead(c) { cap.status = c; }, setHeader() {},
                end(b) { try { cap.body = JSON.parse(b); } catch { cap.body = b; } } };
  handler({ query: query || {}, user, params: {} }, res);
  return cap;
}
const products = (user, query) => (call(handleListProducts, user, query).body?.data?.products) || [];
const byId = (rows, id) => rows.find(r => r.goodsId === id);
const tuc = rows => rows.filter(r => /tuc/i.test(r.name || ''));

// ─── The catalogue is the same for everyone ───────────────────────────────────

test('both accounts are sent exactly the same products', () => {
  const a = products(AG).map(p => p.goodsId).sort();
  const b = products(ALH).map(p => p.goodsId).sort();
  assert.deepStrictEqual(b, a, 'the catalogue is AG\'s master list, not an operator\'s');
  assert.strictEqual(a.length, 4);
});

test('an operator sees a product she has never stocked', () => {
  // The reported case: TUC Mini Sýrður Rjómi, in none of her machines.
  assert.strictEqual(tuc(products(ALH)).length, 4);
});

test('name, VSK and weight read identically for both', () => {
  for (const id of ['ORIG-PLACED', 'SYRD-PLACED', 'SYRD-SEED']) {
    const a = byId(products(AG), id), b = byId(products(ALH), id);
    assert.strictEqual(b.name, a.name, id);
    assert.strictEqual(b.vatRate, a.vatRate, id);
    assert.strictEqual(b.weightGrams, a.weightGrams, id);
    assert.strictEqual(b.salePriceIsk, a.salePriceIsk, id);
  }
});

test('one row never swallows another that shares an identifier', () => {
  // 6.118.0 fixed this in the browser; the merge it fixed no longer exists at all.
  const rows = products(ALH).map(p => p.goodsId).sort();
  assert.deepStrictEqual(rows, ['ORIG-DUP', 'ORIG-PLACED', 'SYRD-PLACED', 'SYRD-SEED']);
});

test('duplicate rows keep their own figures', () => {
  // They are shown as the two separate records they are. Collapsing them in the API would hide
  // a data problem and make "which one did I just pick" unanswerable in a picker.
  assert.strictEqual(byId(products(AG), 'SYRD-PLACED').costPriceIsk, 450);
  assert.strictEqual(byId(products(AG), 'SYRD-SEED').costPriceIsk, 122);
});

// ─── Placement describes, never filters ───────────────────────────────────────

test('placement is counted over the caller\'s own machines', () => {
  assert.strictEqual(byId(products(AG),  'ORIG-PLACED').placement.machineCount, 2);
  assert.strictEqual(byId(products(ALH), 'ORIG-PLACED').placement.machineCount, 0);
});

test('a product is matched to its slot on any of its identifiers', () => {
  // The layout carries ORIG-CODE; the catalogue row is ORIG-PLACED with that as its goodsCode.
  const p = byId(products(AG), 'ORIG-PLACED');
  assert.strictEqual(p.placement.slotCount, 2);
  assert.strictEqual(p.placement.priceIsk, 310, 'what the machines actually charge');
});

test('an operator is never shown stock from another operator\'s machines', () => {
  for (const p of products(ALH)) {
    assert.strictEqual(p.placement.stock, 0, p.name);
    assert.deepStrictEqual(p.placement.machines, []);
  }
});

test('the catalogue price and the machine price are separate fields', () => {
  // A product with no catalogue price read "0 kr" to an operator, because the only price on
  // screen came from a planogram she could not see. Null here, and never conflated.
  const agRow = byId(products(AG), 'ORIG-PLACED');
  assert.strictEqual(agRow.salePriceIsk, null, 'this row genuinely has no catalogue price');
  assert.strictEqual(agRow.placement.priceIsk, 310);
  const alhRow = byId(products(ALH), 'ORIG-PLACED');
  assert.strictEqual(alhRow.salePriceIsk, null);
  assert.strictEqual(alhRow.placement.priceIsk, null, 'she has it in no machine');
});

// ─── Searching and narrowing ──────────────────────────────────────────────────

test('q matches name, barcode and customCode, for both accounts alike', () => {
  assert.strictEqual(tuc(products(ALH, { q: 'tuc' })).length, 4);
  assert.strictEqual(tuc(products(AG,  { q: 'syrdur' })).length, 2);
  storage.upsertProduct({ goodsId: 'BC1', name: 'Kex', barcode: '5701234567890',
                          customCode: 'KEX-9', salePriceIsk: 100, vatRate: 11 });
  assert.ok(byId(products(ALH, { q: '570123' }), 'BC1'), 'barcode');
  assert.ok(byId(products(ALH, { q: 'kex-9' }), 'BC1'), 'customCode');
});

test('inMachine narrows to one machine\'s products', () => {
  const rows = products(AG, { inMachine: 'AG2' });
  assert.deepStrictEqual(rows.map(r => r.goodsId), ['ORIG-PLACED'],
    'AG2 also holds an uncatalogued entry, which is not a catalogue product');
});

test('inMachine refuses a machine the caller cannot reach', () => {
  const r = call(handleListProducts, ALH, { inMachine: 'AG1' });
  assert.strictEqual(r.status, 403);
});

// ─── Cost price is not catalogue-wide ─────────────────────────────────────────

test('an operator is not sent cost prices at all', () => {
  // Siggi, 2026-11-13: "operators should not see each other's cost price." One shared column
  // keyed on goodsId means any cost an operator reads is somebody else's.
  for (const p of products(ALH)) {
    assert.ok(!('costPriceIsk' in p), p.name + ' must not carry a cost');
    assert.ok(!('costPriceNetIsk' in p), p.name);
  }
  assert.strictEqual(call(handleListProducts, ALH, {}).body.data.costVisible, false);
});

test('AG still sees cost', () => {
  assert.strictEqual(byId(products(AG), 'SYRD-PLACED').costPriceIsk, 450);
  assert.strictEqual(call(handleListProducts, AG, {}).body.data.costVisible, true);
});

test('viewing as an operator hides cost too', () => {
  // requireAuth rewrites req.user to the operator for X-View-As-Operator, so the AG admin sees
  // exactly what that operator sees — including the withholding.
  const viewing = { ...AG, role: 'operator_admin', operatorId: 'alh', viewingAs: true, realRole: 'ag_admin' };
  assert.ok(!('costPriceIsk' in products(viewing)[0]));
});

// ─── Unmapped planogram entries ───────────────────────────────────────────────

test('unmapped lists what is loaded in machines but missing from the catalogue', () => {
  // AG reaches every machine, so both uncatalogued entries are AG's to deal with.
  const rows = call(handleUnmappedProducts, AG, {}).body.data.products;
  assert.deepStrictEqual(rows.map(r => r.goodsId), ['LOOSE', 'OTHER']);
  assert.strictEqual(rows[0].machineCount, 1);
});

test('a planogram entry matched by goodsCode is not reported as unmapped', () => {
  const rows = call(handleUnmappedProducts, AG, {}).body.data.products;
  assert.ok(!rows.some(r => r.goodsId === 'ORIG-CODE'),
    'it is the catalogue row ORIG-PLACED, carried under its goodsCode');
});

test('an operator only sees unmapped entries from her own machines', () => {
  const rows = call(handleUnmappedProducts, ALH, {}).body.data.products;
  assert.deepStrictEqual(rows.map(r => r.goodsId), ['OTHER']);
});

test('AG can scope unmapped to one operator, and cannot be asked for a foreign one', () => {
  const rows = call(handleUnmappedProducts, AG, { operatorId: 'alh' }).body.data.products;
  assert.deepStrictEqual(rows.map(r => r.goodsId), ['OTHER']);
  assert.strictEqual(call(handleUnmappedProducts, ALH, { operatorId: 'ag' }).status, 403);
});
