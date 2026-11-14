/**
 * Where a product stands with Weimi, as a recorded fact.
 *
 * There are two catalogues — ours and Weimi's — and nothing recorded how a product stood between
 * them. Five creation paths each guessed, and so did every reader, including the guard I wrote on
 * 2026-11-13: it tested for the 'p-' prefix /products/quick mints and sailed straight past the
 * rows /products/import writes with a hex id when Weimi did not recognise a seed row. Those empty
 * a coil slot in exactly the same way.
 *
 * Step 1 of the rebuild records the fact instead. These tests pin the four states, that nothing
 * resets one by accident, and that the backfill is resumable and never invents an answer.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'weimi-status-test-' + process.pid + '.db');
const storage = require('../src/storage');

const P = (goodsId, over) => storage.upsertProduct(Object.assign(
  { goodsId, name: 'Product ' + goodsId, salePriceIsk: 299, vatRate: 11, measurement: 0,
    weimiId: null, goodsCode: null, customCode: null, barcode: null, imgUrl: null,
    weightGrams: null, costPriceIsk: null }, over));

test('a new row starts as unknown, never as a guess', () => {
  P('new1');
  assert.strictEqual(storage.getProduct('new1').weimiStatus, 'unknown');
  assert.strictEqual(storage.getProduct('new1').weimiCheckedAt, null);
});

test('the four states are the only ones that stick', () => {
  P('s1');
  for (const s of ['registered', 'local', 'failed', 'unknown']) {
    storage.setWeimiStatus('s1', s);
    assert.strictEqual(storage.getProduct('s1').weimiStatus, s);
  }
  storage.setWeimiStatus('s1', 'nonsense');
  assert.strictEqual(storage.getProduct('s1').weimiStatus, 'unknown', 'anything else means unknown');
});

test('setting a status records when it was asked', () => {
  P('s2');
  storage.setWeimiStatus('s2', 'registered', 1700000000000);
  assert.strictEqual(storage.getProduct('s2').weimiCheckedAt, 1700000000000);
});

test('an ordinary product update does not reset the status', () => {
  // The reason this is not a field on upsertProduct: that is called from a dozen places with no
  // opinion about Weimi, and a default would quietly undo an answer somebody established.
  P('s3');
  storage.setWeimiStatus('s3', 'registered');
  P('s3', { name: 'Renamed', salePriceIsk: 350 });
  assert.strictEqual(storage.getProduct('s3').weimiStatus, 'registered');
  assert.strictEqual(storage.getProduct('s3').name, 'Renamed', 'the update itself still applied');
});

test('the counts add up to the catalogue', () => {
  const before = storage.weimiStatusCounts();
  P('c1'); P('c2'); storage.setWeimiStatus('c1', 'local');
  const after = storage.weimiStatusCounts();
  assert.strictEqual(after.total, before.total + 2);
  assert.strictEqual(after.local, before.local + 1);
  assert.strictEqual(after.unknown, before.unknown + 1);
});

// ─── The backfill queue ───────────────────────────────────────────────────────

test('only unknown and failed rows are queued, unknown first', () => {
  for (const id of ['q1', 'q2', 'q3', 'q4']) P(id);
  storage.setWeimiStatus('q1', 'registered');
  storage.setWeimiStatus('q2', 'local');
  storage.setWeimiStatus('q3', 'failed');
  // q4 stays unknown
  const queued = storage.productsNeedingWeimiCheck(100).map(r => r.goodsId);
  assert.ok(!queued.includes('q1') && !queued.includes('q2'), 'settled rows are not re-asked');
  assert.ok(queued.includes('q3') && queued.includes('q4'));
  assert.ok(queued.indexOf('q4') < queued.indexOf('q3'), 'never-asked before previously-failed');
});

test('the queue is bounded, so one call cannot run for minutes', () => {
  assert.ok(storage.productsNeedingWeimiCheck(2).length <= 2);
  assert.ok(storage.productsNeedingWeimiCheck(10000).length <= 200, 'hard ceiling');
  assert.ok(storage.productsNeedingWeimiCheck(0).length >= 1, 'a nonsense limit still does work');
});

test('answering a row takes it out of the queue, so the backfill makes progress', () => {
  const first = storage.productsNeedingWeimiCheck(1)[0];
  storage.setWeimiStatus(first.goodsId, 'local');
  const next = storage.productsNeedingWeimiCheck(1)[0];
  assert.notStrictEqual(next && next.goodsId, first.goodsId);
});
