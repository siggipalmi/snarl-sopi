'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { modelInfo, appLineFor, isUnknownModel, isLockerModel, KNOWN } = require('../src/machineModels');

test('the catalogued models map to their app line', () => {
  assert.equal(appLineFor('GR-WM22Z680'), 'fridge');
  assert.equal(appLineFor('GR-WM22Z1260'), 'fridge');
  assert.equal(appLineFor('VM-WM55DL'), 'coil');
  for (const m of Object.keys(KNOWN)) assert.equal(modelInfo(m).catalogued, true, m);
});

test('an uncatalogued model of a known family still gets its line', () => {
  // A new fridge must not stop updating because nobody added it to the table.
  assert.equal(appLineFor('GR-WM30Z9999'), 'fridge');
  assert.equal(appLineFor('VM-SOMETHINGNEW'), 'coil');
  assert.equal(modelInfo('GR-WM30Z9999').catalogued, false);
  assert.equal(modelInfo('GR-WM30Z9999').known, true);
});

test('a model we cannot identify gets NO app line', () => {
  for (const m of ['', null, undefined, '   ', 'WM55DL', 'fridge', 'XX-1', '0']) {
    assert.equal(appLineFor(m), null, JSON.stringify(m));
    assert.equal(isUnknownModel(m), true, JSON.stringify(m));
    assert.equal(modelInfo(m).kind, 'unknown', JSON.stringify(m));
  }
});

test('"not a fridge" and "unknown" are different answers', () => {
  // The old rule was !model.startsWith('GR-') => coil, which answered "coil"
  // for a machine with no model at all. That is the bug this module exists for.
  assert.equal(appLineFor('VM-WM55DL'), 'coil');
  assert.notEqual(appLineFor(''), 'coil');
});

test('the prefix test ignores case and surrounding space', () => {
  assert.equal(appLineFor('  gr-wm22z680  '), 'fridge');
  assert.equal(appLineFor('vm-wm55dl'), 'coil');
});

test('a parcel locker is its own kind with its own app line', () => {
  // No locker model is catalogued yet; the LK- family alone decides.
  for (const m of ['LK-UPUS24', 'lk-anything', '  LK-1  ']) {
    assert.equal(appLineFor(m), 'locker', m);
    assert.equal(modelInfo(m).kind, 'locker', m);
    assert.equal(isLockerModel(m), true, m);
    assert.equal(isUnknownModel(m), false, m);
  }
  // And nothing in service becomes a locker.
  for (const m of [...Object.keys(KNOWN), '', null, 'XX-1', 'LOCKER', 'VM-LK-1']) {
    assert.equal(isLockerModel(m), false, JSON.stringify(m));
  }
});

test('an unknown model still gets a label to show in the fleet list', () => {
  assert.equal(modelInfo('').labelEn, '(not set)');
  assert.equal(modelInfo('XX-9').labelEn, 'XX-9');
});
