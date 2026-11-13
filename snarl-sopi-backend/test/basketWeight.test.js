/**
 * A unit weight should be typed once, not once per machine and once per operator.
 *
 * Every fridge basket already resolves its weight as `unitWeightG ?? product.weightGrams`, so the
 * inheritance was there all along. What was missing is the other direction: when the catalog held
 * no weight, whoever assigned the product typed one, it was stored on THAT BASKET alone, and the
 * product row stayed null. The next machine asked again, and another operator never saw that the
 * question had already been answered. Siggi, 2026-11-13: "It doesn't make sense you need to type
 * in the weight for a product that either has it from Weimi or some other operator has typed in."
 *
 * The promotion only ever fills a null. That is the whole safety argument, and the tests below
 * exist to keep it true: a weight is what a gravity fridge charges on, so overwriting one would
 * change what a machine takes off a customer's card.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'basket-weight-test-' + process.pid + '.db');

const storage = require('../src/storage');

const OP = 'op_test', FRIDGE = 'GRTEST1';
storage.upsertOperator({ id: OP, name: 'Test operator' });
storage.upsertMachine({ deviceCode: FRIDGE, deviceName: 'Test fridge', operatorId: OP, model: 'GR-630' });

// Required after the machine exists: the router loads machines into memory when it is required.
const { handleSetFridgeBaskets, weimiWeightGrams } = require('../src/router');

const AG = { id: 'u1', email: 'ag@test.is', role: 'ag_admin', operatorId: OP };

let seq = 0;
function product(over) {
  const goodsId = 'P' + (++seq);
  storage.upsertProduct(Object.assign(
    { goodsId, name: 'Product ' + goodsId, salePriceIsk: 299, vatRate: 11,
      costPriceIsk: 100, weightGrams: null, measurement: 0, barcode: null, imgUrl: null }, over, { goodsId }));
  return goodsId;
}

// Drive the handler the way the HTTP layer does, and hand back what it answered.
function saveBaskets(baskets, user) {
  let out = null;
  const res = {
    writeHead() {}, end() {},
    setHeader() {},
  };
  // json()/ok() in router.js both go through res — capture via a minimal stand-in.
  const capture = { statusCode: 0, body: null };
  res.writeHead = (code) => { capture.statusCode = code; };
  res.end = (body) => { try { capture.body = JSON.parse(body); } catch { capture.body = body; } };
  handleSetFridgeBaskets({ params: { deviceCode: FRIDGE }, body: { baskets }, user: user || AG }, res);
  out = capture;
  return out;
}

const basket = (productId, over) => Object.assign(
  { cabinet: 'A', basket: 1, productId, priceIsk: 299, enabled: true }, over);

// ─── The promotion ────────────────────────────────────────────────────────────

test('a weight typed for a product the catalog has none for is promoted to the product', () => {
  const gid = product();
  assert.strictEqual(storage.getProduct(gid).weightGrams, null, 'starts with no weight');

  const r = saveBaskets([basket(gid, { unitWeightG: 100 })]);
  assert.strictEqual(r.body.ok !== false, true, JSON.stringify(r.body));
  assert.strictEqual(storage.getProduct(gid).weightGrams, 100,
    'the next machine, and every other operator, inherits it from here');
  assert.deepStrictEqual(r.body.data.promoted.map(p => p.goodsId), [gid], 'and it is reported');
});

test('a weight already in the catalog is never overwritten', () => {
  // The safety property. A gravity fridge charges on this number.
  const gid = product({ weightGrams: 125 });
  saveBaskets([basket(gid, { unitWeightG: 100, basket: 2 })]);
  assert.strictEqual(storage.getProduct(gid).weightGrams, 125);
});

test('the basket keeps its own override', () => {
  // Promoting must not quietly retune this basket: it still weighs what it was told to.
  const gid = product();
  saveBaskets([basket(gid, { unitWeightG: 90, basket: 3 })]);
  const row = storage.listFridgeBaskets(FRIDGE).find(b => b.cabinet === 'A' && Number(b.basket) === 3);
  assert.strictEqual(Number(row.unitWeightG), 90);
  assert.strictEqual(storage.getProduct(gid).weightGrams, 90);
});

test('inheriting a weight promotes nothing', () => {
  const gid = product({ weightGrams: 55 });
  const r = saveBaskets([basket(gid, { basket: 4 })]);   // no unitWeightG — inherits
  assert.deepStrictEqual(r.body.data.promoted, []);
  assert.strictEqual(storage.getProduct(gid).weightGrams, 55);
});

test('a basket with no weight anywhere is still refused, and promotes nothing', () => {
  const gid = product();
  const r = saveBaskets([basket(gid, { basket: 5 })]);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.rejected[0].reason, 'no_unit_weight');
  assert.deepStrictEqual(r.body.promoted, []);
  assert.strictEqual(storage.getProduct(gid).weightGrams, null);
});

test('an implausible weight is accepted for the basket but not promoted', () => {
  // 25 kg in one basket is somebody's typo or a gram/milligram mix-up. It must not become the
  // number every other machine then charges on.
  const gid = product();
  saveBaskets([basket(gid, { unitWeightG: 25000, basket: 6 })]);
  assert.strictEqual(storage.getProduct(gid).weightGrams, null);
});

test('two baskets of the same product promote once', () => {
  const gid = product();
  const r = saveBaskets([
    basket(gid, { unitWeightG: 80, basket: 7 }),
    basket(gid, { unitWeightG: 80, basket: 8 }),
  ]);
  assert.strictEqual(r.body.data.promoted.length, 1);
  assert.strictEqual(storage.getProduct(gid).weightGrams, 80);
});

test('a rejected basket never promotes its weight', () => {
  // basket 99 does not exist on this model, so nothing about that row should reach the catalog.
  const gid = product();
  const r = saveBaskets([basket(gid, { unitWeightG: 70, basket: 99 })]);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(storage.getProduct(gid).weightGrams, null);
});

// ─── Reading a weight out of a Weimi goods record ─────────────────────────────

test('a believable gram value is taken, whichever field carries it', () => {
  for (const key of ['goodsWeight', 'weight', 'weightGram', 'weightGrams', 'netWeight', 'unitWeight']) {
    assert.strictEqual(weimiWeightGrams({ [key]: 100 }), 100, key);
    assert.strictEqual(weimiWeightGrams({ [key]: '100' }), 100, key + ' as a string');
  }
});

test('a record with no weight gives null rather than a guess', () => {
  for (const w of [null, undefined, {}, { goodsName: 'Kex' }, { goodsWeight: null }, { goodsWeight: '' }]) {
    assert.strictEqual(weimiWeightGrams(w), null);
  }
});

test('a kilogram figure is refused rather than rounded into grams', () => {
  // The field name tells us nothing about the unit. A whole number or it is not grams: 0.1 kg
  // rounds to 0 and reads as absent anyway, but 0.6 would round to a 1 g unit weight, and a
  // gravity fridge with a 1 g unit weight charges for air.
  assert.strictEqual(weimiWeightGrams({ goodsWeight: 0.1 }), null);
  assert.strictEqual(weimiWeightGrams({ goodsWeight: 0.6 }), null);
});

test('junk and out-of-range values are refused', () => {
  for (const v of ['abc', NaN, Infinity, -5, 0, 20001, 1e9]) {
    assert.strictEqual(weimiWeightGrams({ goodsWeight: v }), null, String(v));
  }
  assert.strictEqual(weimiWeightGrams({ goodsWeight: 20000 }), 20000, 'the ceiling itself is fine');
});

test('the first believable field wins and a junk one does not block it', () => {
  assert.strictEqual(weimiWeightGrams({ goodsWeight: 'n/a', weight: 150 }), 150);
});
