/**
 * Locker records (6.124.0): what a customer is told about a locker, and which boxes it has,
 * are data the operator enters. Invented data throughout.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lockers = require('../src/lockers');

const machine = (extra) => ({ deviceCode: 'LK-T1', deviceName: 'AG Test', location: 'Prufugata 1', model: 'LK-TEST', settings: {}, ...extra });

test('a locker with nothing entered falls back to the machine name and location', () => {
  const r = lockers.lockerRecord(machine());
  assert.equal(r.info.name, 'AG Test');
  assert.equal(r.info.address, 'Prufugata 1');
  assert.equal(r.info.accessNote, '');
  assert.deepEqual(r.boxes, []);
  assert.deepEqual(r.boxCounts, { small: 0, middle: 0, big: 0 });
  assert.match(r.mapUrl, /query=Prufugata%201$/);
});

test('info is trimmed to one line and only the fields sent come back', () => {
  const r = lockers.normalizeInfo({ name: '  AG   Test \n', accessNote: 'Dyrakóði 0000\tutan opnunartíma' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: 'AG Test', accessNote: 'Dyrakóði 0000 utan opnunartíma' });
});

test('info refuses what it cannot show', () => {
  assert.match(lockers.normalizeInfo({ name: 'x'.repeat(61) }).error, /name is too long/);
  assert.match(lockers.normalizeInfo({ accessNote: 'x'.repeat(241) }).error, /accessNote is too long/);
  assert.match(lockers.normalizeInfo({ helpPhone: 'call me' }).error, /helpPhone/);
  assert.match(lockers.normalizeInfo({ lat: 64.1 }).error, /lat and lng go together/);
  assert.match(lockers.normalizeInfo({ lat: 91, lng: 0 }).error, /lat must be/);
  assert.match(lockers.normalizeInfo({ doorCode: '1' }).error, /unknown info field: doorCode/);
  assert.match(lockers.normalizeInfo(null).error, /must be an object/);
  assert.equal(lockers.normalizeInfo({ helpPhone: '+354 555 0100' }).ok, true);
});

test('a map position wins over the address, and neither means no link', () => {
  assert.equal(lockers.mapUrl({ address: 'Prufugata 1', lat: 64.14, lng: -21.9 }), 'https://www.google.com/maps/search/?api=1&query=64.14,-21.9');
  assert.equal(lockers.mapUrl({ address: '' }), null);
});

test('boxes are checked, defaulted and sorted', () => {
  const r = lockers.normalizeBoxes([{ n: 3, size: 'small' }, { n: 1, size: 'middle' }, { n: 2, size: 'big', board: 2, lock: 1 }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [
    { n: 1, size: 'middle', board: 1, lock: 1 },
    { n: 2, size: 'big', board: 2, lock: 1 },
    { n: 3, size: 'small', board: 1, lock: 3 },
  ]);
  assert.deepEqual(lockers.boxCounts(r.value), { small: 1, middle: 1, big: 1 });
});

test('boxes refuse a list that would point at the wrong door', () => {
  assert.match(lockers.normalizeBoxes([{ n: 1, size: 'small' }, { n: 1, size: 'big' }]).error, /box 1 is listed twice/);
  assert.match(lockers.normalizeBoxes([{ n: 1, size: 'small' }, { n: 2, size: 'small', lock: 1 }]).error, /board 1 lock 1 already belongs/);
  assert.match(lockers.normalizeBoxes([{ n: 1, size: 'huge' }]).error, /size must be one of/);
  assert.match(lockers.normalizeBoxes([{ n: 0, size: 'small' }]).error, /n must be a whole number/);
  assert.match(lockers.normalizeBoxes([]).error, /must not be empty/);
  assert.match(lockers.normalizeBoxes('19').error, /must be a list/);
});

test('the 19-box layout of the first locker is accepted as it stands', () => {
  // Sizes as the unit's own table gives them: middle 1, 2, 12, 13; big 11, 19; the rest small.
  const size = (n) => ([1, 2, 12, 13].includes(n) ? 'middle' : [11, 19].includes(n) ? 'big' : 'small');
  const r = lockers.normalizeBoxes(Array.from({ length: 19 }, (_, i) => ({ n: i + 1, size: size(i + 1) })));
  assert.equal(r.ok, true);
  assert.deepEqual(lockers.boxCounts(r.value), { small: 13, middle: 4, big: 2 });
});

test('a change merges info, clears emptied fields, and replaces boxes whole', () => {
  const m = machine({ settings: { locker: { info: { name: 'Old', accessNote: 'Dyrakóði 0000', lat: 64, lng: -21 }, boxes: [{ n: 1, size: 'small', board: 1, lock: 1 }] } } });
  const next = lockers.applyChange(m, { info: { name: 'New', accessNote: '', lat: null, lng: null } }, 'op@example.test', '2026-11-25T12:00:00.000Z');
  assert.deepEqual(next.info, { name: 'New' });
  assert.equal(next.boxes.length, 1, 'boxes untouched when not sent');
  assert.equal(next.updatedBy, 'op@example.test');

  m.settings.locker = next;
  const boxes = lockers.normalizeBoxes([{ n: 1, size: 'big' }, { n: 2, size: 'small' }]).value;
  const after = lockers.applyChange(m, { boxes }, 'ag@example.test', '2026-11-25T13:00:00.000Z');
  assert.equal(after.boxes.length, 2);
  assert.deepEqual(after.info, { name: 'New' }, 'info untouched when not sent');
});

test('what a customer is shown leaves out the wiring and the editor', () => {
  const m = machine({ settings: { locker: { info: { findNote: 'Í anddyrinu', accessNote: 'Dyrakóði 0000', helpPhone: '555 0100' },
    boxes: [{ n: 1, size: 'small', board: 1, lock: 1 }], updatedBy: 'op@example.test' } } });
  const p = lockers.publicInfo(m);
  assert.deepEqual(Object.keys(p).sort(), ['accessNote', 'address', 'findNote', 'helpPhone', 'mapUrl', 'name']);
  assert.equal(p.findNote, 'Í anddyrinu');
  assert.ok(!JSON.stringify(p).includes('example.test'));
});
