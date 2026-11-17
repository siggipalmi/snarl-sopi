/**
 * A weight read from the dashboard is the newest count of that basket (6.122.1).
 * 8626020618 A14, 2026-11-17: the editor read 479 g of 50 g bars while the tile said 0 from 05:21.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'scale-read-stock-test-' + process.pid + '.db');

const storage = require('../src/storage');

const OP = 'op_test', FRIDGE = 'GRTEST2';
storage.upsertOperator({ id: OP, name: 'Test operator' });
storage.upsertMachine({ deviceCode: FRIDGE, deviceName: 'Test fridge', operatorId: OP, model: 'GR-630' });
storage.upsertProduct({ goodsId: 'bar', name: 'Energy bar', salePriceIsk: 299, weightGrams: 50 });
storage.upsertProduct({ goodsId: 'water', name: 'Water', salePriceIsk: 349, weightGrams: 546 });
storage.upsertFridgeBasket({ deviceCode: FRIDGE, cabinet: 'A', basket: 14, productId: 'bar', enabled: true });
storage.upsertFridgeBasket({ deviceCode: FRIDGE, cabinet: 'A', basket: 1, productId: 'water', unitWeightG: 540, enabled: true });

// Required after the machine exists: the router loads machines into memory when it is required.
const { stockFromScaleResult } = require('../src/router');

const stock = () => Object.fromEntries(storage.basketStock(FRIDGE).map(s => [s.cabinet + s.basket, s]));

test('a single read sets that basket', () => {
  const n = stockFromScaleResult(FRIDGE, { type: 'scale_read', params: JSON.stringify({ cabinet: 'A', basket: 14 }) }, 'cabinet A basket 14: 479 g');
  assert.strictEqual(n, 1);
  assert.strictEqual(stock().A14.grams, 479);
  assert.strictEqual(stock().A14.units, 10);
});

test('read all trays sets every assigned basket, by tray address, with the basket override', () => {
  const n = stockFromScaleResult(FRIDGE, { type: 'read_all_trays', params: '{}' }, 'expecting 16 trays, got 16 — #0=3270g #1=12g #13=-4g');
  assert.strictEqual(n, 2);                       // tray 1 (A2) has no product
  assert.strictEqual(stock().A1.units, 6);        // 3270 / 540
  assert.strictEqual(stock().A14.units, 0);       // a negative reading is an empty basket
  assert.strictEqual(stock().A2, undefined);
});

test('an answer with no weight changes nothing', () => {
  assert.strictEqual(stockFromScaleResult(FRIDGE, { type: 'scale_read', params: '{"cabinet":"A","basket":14}' }, 'cabinet A basket 14: no reply from the scale'), 0);
  assert.strictEqual(stockFromScaleResult(FRIDGE, { type: 'scale_read', params: '{"cabinet":"A","basket":14}' }, null), 0);
});
