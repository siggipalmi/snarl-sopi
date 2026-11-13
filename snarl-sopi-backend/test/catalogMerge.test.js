/**
 * The catalog screen is two lists stitched together, and one of them is scoped by role.
 *
 *   GET /api/v1/products          — the product database. Not scoped: every signed-in user
 *                                   receives every row.
 *   GET /api/v1/products/catalog  — products read out of machine planograms, scoped to the
 *                                   machines that user can reach.
 *
 * renderCatalog() merges them. It used to register every identifier of a database row that had
 * found no planogram slot (goodsId, goodsCode, weimiId, customCode) into the lookup map, so a
 * later row whose goodsId happened to equal any one of them was folded into the first card
 * instead of getting its own. Those are different KINDS of identifier — a match across two of
 * them means nothing.
 *
 * The damage was role-dependent, which is why it went unseen. For AG admin the first row
 * normally matched a real planogram slot and so never reached that branch; for an operator who
 * cannot see that machine it did, and the second product vanished from their catalog — and took
 * the surviving card's cost price with it. Reported 2026-11-11: AG could see
 * "TUC Mini Sýrður Rjómi 100g", the operator Alhliða lausnir could not.
 *
 * These tests run the REAL merge, lifted out of public/index.html, so the fix cannot be undone
 * by an edit to the page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// ─── Lift the merge out of the page ───────────────────────────────────────────

function loadMerge() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const fnAt = html.indexOf('async function renderCatalog()');
  assert.notStrictEqual(fnAt, -1, 'renderCatalog() is gone from index.html — this test needs it');
  // The same two lines open the merge in renderReconcile(), so search from renderCatalog on.
  const start = html.indexOf('    const placed = (placedRes', fnAt);
  const assignAt = html.indexOf('    _catalogMerged = Object.values(byId)', start);
  assert.ok(start !== -1 && assignAt > start, 'could not find the merge block in renderCatalog()');
  const end = html.indexOf('\n', assignAt);
  const body = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('placedRes', 'ourRes',
    'let _catalogMerged;\n' + body + '\nreturn _catalogMerged;');
}

const merge = loadMerge();

const res = (products) => ({ ok: true, data: { products } });
const cards = (placed, ours) => merge(res(placed), res(ours));
const named = (list, name) => list.find(c => c.name === name);

// A product sitting in a machine's planogram, as /products/catalog reports it.
const slot = (goodsId, name, over) => Object.assign(
  { goodsId, name, image: '', priceIsk: 299, machineCount: 1, slotCount: 1,
    machines: [{ deviceCode: 'MA1', deviceName: 'A machine' }] }, over);

// A row of the product database, as /products reports it.
const row = (o) => Object.assign(
  { goodsId: null, goodsCode: null, weimiId: null, customCode: null, name: '',
    salePriceIsk: 299, vatRate: 11, costPriceIsk: null, weightGrams: null,
    barcode: null, imgUrl: null, imageNormalizedAt: null }, o);

// The reported case. Two database rows: the first carries a customCode that happens to equal
// the second's goodsId. Both operators are sent both rows; only the planogram differs.
const SNACK = row({ goodsId: 'X1', goodsCode: 'XC1', customCode: 'Y1',
                    name: 'Some other snack', costPriceIsk: 122 });
const TUC   = row({ goodsId: 'Y1', name: 'TUC Mini Sýrður Rjómi 100g',
                    costPriceIsk: 450, weightGrams: 100 });
const AG_SEES   = [slot('XC1', 'Some other snack')];  // the machine belongs to another operator
const OP_SEES   = [];                                 // …so this operator's planogram is empty

test('an operator sees every product the AG admin sees', () => {
  const ag = cards(AG_SEES, [SNACK, TUC]).map(c => c.name).sort();
  const op = cards(OP_SEES, [SNACK, TUC]).map(c => c.name).sort();
  assert.deepStrictEqual(op, ag,
    'the database list is identical for both roles, so the same products must appear');
  assert.deepStrictEqual(ag, ['Some other snack', 'TUC Mini Sýrður Rjómi 100g']);
});

test('a product is not swallowed by an unrelated row that shares an identifier', () => {
  // Before the fix this returned one card and TUC Mini was simply not on the operator's screen.
  const op = cards(OP_SEES, [SNACK, TUC]);
  assert.strictEqual(op.length, 2);
  assert.ok(named(op, 'TUC Mini Sýrður Rjómi 100g'), 'TUC Mini must have its own card');
});

test('the surviving card keeps its own cost price', () => {
  // The other half of the same bug: the swallowed row overwrote the card it landed on, so the
  // operator was shown 450 kr — TUC Mini's cost — against a different product.
  const op = cards(OP_SEES, [SNACK, TUC]);
  assert.strictEqual(named(op, 'Some other snack').costPriceIsk, 122);
  assert.strictEqual(named(op, 'TUC Mini Sýrður Rjómi 100g').costPriceIsk, 450);
});

test('order does not decide who disappears', () => {
  for (const ours of [[SNACK, TUC], [TUC, SNACK]]) {
    assert.strictEqual(cards(OP_SEES, ours).length, 2);
  }
});

// ─── What the merge must still do ─────────────────────────────────────────────

test('a database row still lands on its planogram slot, matched on any identifier', () => {
  // This is what placedByAnyId is for and it must keep working: the machine layout can carry
  // the goodsCode, the weimiId or the customCode rather than our goodsId.
  for (const key of ['goodsCode', 'weimiId', 'customCode']) {
    const r = row({ goodsId: 'DB1', name: 'Pepsi Max 330', costPriceIsk: 88, [key]: 'LAYOUT9' });
    const out = cards([slot('LAYOUT9', 'Pepsi Max 330')], [r]);
    assert.strictEqual(out.length, 1, 'matched on ' + key + ' — one card, not two');
    assert.strictEqual(out[0].machineCount, 1, 'and it keeps the placement');
    assert.strictEqual(out[0].costPriceIsk, 88, 'and gains the database attributes');
  }
});

test('two database rows may still share one planogram slot', () => {
  // Genuine duplicates that both point at the same placed product still collapse onto it —
  // that path is untouched. Only row-onto-row merging is gone.
  const a = row({ goodsId: 'D1', goodsCode: 'SLOT', name: 'Prince Polo', costPriceIsk: 70 });
  const b = row({ goodsId: 'D2', customCode: 'SLOT', name: 'Prince Polo', costPriceIsk: 71 });
  const out = cards([slot('SLOT', 'Prince Polo')], [a, b]);
  assert.strictEqual(out.length, 1);
});

test('a product in the database but in no machine is shown as not placed', () => {
  const out = cards([], [row({ goodsId: 'Z1', name: 'In the database only', costPriceIsk: 10 })]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].machineCount, 0);
  assert.strictEqual(out[0].hasAttrs, true);
});

test('a planogram product with no database row still appears, flagged as unmapped', () => {
  const out = cards([slot('L1', 'Loaded but unmapped')], []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].hasAttrs, false, 'drives the "no VSK / cost set" note on the card');
});

test('a newer normalized image still wins over a stale duplicate', () => {
  // The guard that exists because duplicates land on one card via the slot. Still needed.
  const stale = row({ goodsId: 'S1', goodsCode: 'SLOT', name: 'Kex',
                      imgUrl: 'stale.png', imageNormalizedAt: 1000 });
  const fresh = row({ goodsId: 'S2', customCode: 'SLOT', name: 'Kex',
                      imgUrl: 'fresh.png', imageNormalizedAt: 2000 });
  assert.strictEqual(cards([slot('SLOT', 'Kex')], [fresh, stale])[0].image, 'fresh.png');
  assert.strictEqual(cards([slot('SLOT', 'Kex')], [stale, fresh])[0].image, 'fresh.png');
});
