const test = require('node:test');
const assert = require('node:assert');
const { paidShare } = require('../src/fridgeSale');

const sum = rows => rows.reduce((s, l) => s + l.lineIsk, 0);

test('the paid amount is spread over the lines by value and sums exactly', () => {
  const lines = [{ lineIsk: 2050, quantity: 4 }, { lineIsk: 6400, quantity: 1 }, { lineIsk: 900, quantity: 1 }];
  const out = paidShare(lines, 8000, 9350);
  assert.strictEqual(sum(out), 8000);
  assert.deepStrictEqual(out.map(l => l.lineIsk), [1754, 5476, 770]);
  assert.deepStrictEqual(out.map(l => l.quantity), [4, 1, 1], 'units are left as they were');
  assert.strictEqual(lines[0].lineIsk, 2050, 'inputs are not changed');
});

test('paid in full leaves the lines alone', () => {
  const lines = [{ lineIsk: 900 }, { lineIsk: 450 }];
  assert.deepStrictEqual(paidShare(lines, 1350, 1350).map(l => l.lineIsk), [900, 450]);
});

test('awkward ratios still sum to the paid amount', () => {
  const lines = [{ lineIsk: 333 }, { lineIsk: 333 }, { lineIsk: 334 }];
  for (const paid of [1, 2, 499, 500, 998, 999]) assert.strictEqual(sum(paidShare(lines, paid, 1000)), paid);
});

test('nothing paid books nothing', () => {
  assert.strictEqual(sum(paidShare([{ lineIsk: 900 }, { lineIsk: 450 }], 0, 1350)), 0);
});

test('lines with no value: all of it on the first line', () => {
  assert.deepStrictEqual(paidShare([{ lineIsk: null }, { lineIsk: null }], 800, 1350).map(l => l.lineIsk), [800, 0]);
});
