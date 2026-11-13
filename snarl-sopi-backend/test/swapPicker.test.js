/**
 * The slot picker's row shape, lifted from public/index.html so a page edit cannot undo it.
 *
 * The rule that matters here is the price. A product that has never been in a machine can have
 * no catalog price — on the live catalogue TUC Mini Sýrður Rjómi showed "0 kr" to an operator for
 * exactly that reason, because the price it displays comes from the planogram she cannot see.
 * The old picker did `value = p.priceIsk || 0`, so once the picker started offering unplaced
 * products, choosing one would have prefilled a slot at 0 kr and the confirm would have read as
 * routine. swapRow() returns null rather than 0, and the box is left empty and focused.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadSwapRow() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('function swapRow(p) {');
  assert.notStrictEqual(at, -1, 'swapRow() is gone from index.html — this test needs it');
  const end = html.indexOf('\n}', at) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(html.slice(at, end) + '\nreturn swapRow;')();
}
const swapRow = loadSwapRow();

test('a product with no price gives null, never zero', () => {
  // Null keeps the price box empty; 0 would be a slot that dispenses for nothing.
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex' }).priceIsk, null);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', priceIsk: 0 }).priceIsk, null);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', salePriceIsk: 0 }).priceIsk, null);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', salePriceIsk: null }).priceIsk, null);
});

test('a real price comes through from either source', () => {
  // The placement list calls it priceIsk, the server search calls it salePriceIsk.
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', priceIsk: 299 }).priceIsk, 299);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', salePriceIsk: 310 }).priceIsk, 310);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'Kex', priceIsk: 299, salePriceIsk: 1 }).priceIsk, 299,
    'the placement price wins — it is what the machine charges today');
});

test('the image comes through from either source', () => {
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'K', image: 'a.png' }).image, 'a.png');
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'K', imgUrl: 'b.png' }).image, 'b.png');
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'K' }).image, '');
});

test('a product in no machine reports zero, which is what splits the two groups', () => {
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'K' }).machineCount, 0);
  assert.strictEqual(swapRow({ goodsId: 'A', name: 'K', machineCount: 2 }).machineCount, 2);
});

test('a nameless row still renders as something', () => {
  assert.strictEqual(swapRow({ goodsId: '77' }).name, '#77');
  assert.strictEqual(swapRow({ goodsId: 77 }).goodsId, '77', 'ids are compared as strings');
});
