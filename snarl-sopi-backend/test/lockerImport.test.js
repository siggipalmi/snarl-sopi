/**
 * Taking over a locker with parcels in it (6.145.0): the previous system's export is read,
 * checked whole, and recorded with the codes the customers already hold. Invented data.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-import-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');
const parcels = require('../src/parcels');
const lockerImport = require('../src/lockerImport');

// Two boards as the 47-box locker has them: board 1 locks 1-22, board 2 locks 1-26 without 16.
const boxes = [];
for (let l = 1; l <= 22; l++) boxes.push({ n: boxes.length + 1, size: l === 1 || l === 14 ? 'big' : 'small', board: 1, lock: l });
for (let l = 1; l <= 26; l++) if (l !== 16) boxes.push({ n: boxes.length + 1, size: l === 1 || l === 14 ? 'big' : 'small', board: 2, lock: l });
function machine(deviceCode) {
  return { deviceCode, deviceName: 'Prufuskápur', location: '', operatorId: 'op-import', model: 'LK-AGV47', isKioskModel: 0, isOnline: 1, isRunning: 1,
    kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1, settings: { locker: { info: {}, boxes } },
    profile: {}, featured: [], ads: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
storage.upsertOperator({ id: 'op-import', name: 'Import test', isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
const M = machine('T0000001'), N = machine('T0000002');
for (const m of [M, N]) { storage.upsertMachine(m); machines[m.deviceCode] = m; }

const NOW = Date.parse('2026-11-27T11:00:00Z');
const HEAD = 'Parcel Number,Status,Device ID,Device Name,Box No.,Delivery Time,Sender,Receiver Phone,SMS status,Pickup code,Pick up time';
const line = (order, box, time, phone, code, device = 'T0000001') =>
  `"${order}","Stored & Not-collected","${device}","Lock02","${device}${box}1","${time}","S1","${phone}","SMS Not delivered","${code}",""`;
const file = (...lines) => '﻿' + [HEAD, ...lines, ',,,,,,,,,,,0.00,0.00,0.00,'].join('\r\n') + '\r\n';
const GOOD = file(
  line('70101', 'A01', '2026-11-27 09:15:02.100', '5550101', '100001'),
  line('Jona', 'A19', '2026-11-24 14:00:00.000', '5550102', '100002'),
  line('70103', 'B21', '2026-11-26 10:20:47.687', '5550103', '100003'),
  line('70104', 'B17', '2026-11-26 16:05:00.000', '5550104', '100004'));

test('the export is read: box names become board and lock, times are Iceland time, the empty last line is dropped', () => {
  assert.deepEqual(lockerImport.parseBox('A0109002B211'), { board: 2, lock: 21, label: 'B21' });
  assert.equal(lockerImport.parseBox('nothing'), null);
  const r = lockerImport.readMinnoExport(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[2].box, { board: 2, lock: 21 });
  assert.equal(r.rows[2].storedAt, Date.parse('2026-11-26T10:20:47Z'));
  assert.equal(lockerImport.readMinnoExport('a,b\r\n1,2').code, 'bad_file');
  assert.equal(lockerImport.readMinnoExport('').code, 'bad_file');
});

test('checking records nothing and the answer holds no phone number or code', () => {
  const r = lockerImport.importMinnoExport(M, GOOD, 'ag@example.test', { dryRun: true }, NOW);
  assert.deepEqual([r.ok, r.dryRun, r.total, r.problems, r.imported], [true, true, 4, 0, 0]);
  assert.deepEqual(r.rows.map(x => [x.box, x.boxN, x.orderNumber, x.problem]),
    [['A01', 1, '70101', null], ['A19', 19, 'Jona', null], ['B21', 42, '70103', null], ['B17', 38, '70104', null]]);
  assert.equal(/55501|10000\d/.test(JSON.stringify(r)), false);
  assert.equal(parcels.boxView(M).counts.occupied, 0);
});

test('one bad row stops the whole file, and says which and why', () => {
  parcels.registerOrder('op-import', { orderNumber: '70190', phone: '5550190' }, NOW);
  const s = parcels.startDeposit(N, { orderNumber: '70190', size: 'small' }, NOW);
  parcels.finishDeposit(N, s.parcelId, { outcome: 'stored' }, NOW);
  const bad = file(
    line('70201', 'A02', '2026-11-27 09:00:00', '5550201', '200001'),
    line('70202', 'B16', '2026-11-27 09:00:00', '5550202', '200002'),   // board 2 has no lock 16
    line('70203', 'A02', '2026-11-27 09:00:00', '5550203', '200003'),   // same box again
    line('70204', 'A03', '2026-11-27 09:00:00', '5550204', '20004'),    // five digits
    line('70205', 'A04', '2026-11-27 09:00:00', 'none', '200005'),
    line('70206', 'A05', '2026-11-27 09:00:00', '5550206', '200001'),   // code used above
    line('', 'A06', '2026-11-27 09:00:00', '5550207', '200007'),
    line('70190', 'A07', '2026-11-27 09:00:00', '5550190', '200008'),   // already in another locker
    line('70209', 'A08', 'yesterday', '5550209', '200009'));
  const r = lockerImport.importMinnoExport(M, bad, 'ag@example.test', { dryRun: false }, NOW);
  assert.deepEqual(r.rows.map(x => x.problem),
    [null, 'no_such_box', 'box_twice', 'bad_code', 'bad_phone', 'code_twice', 'no_order_number', 'order_in_a_locker', 'bad_time']);
  assert.deepEqual([r.problems, r.imported], [8, 0]);
  assert.equal(parcels.boxView(M).counts.occupied, 0, 'nothing was recorded, the good row included');
});

test('recording puts each parcel in its box with the code its customer holds, and sends nothing', () => {
  // The shop had already reported one of them: it must not stay expected.
  parcels.registerOrder('op-import', { orderNumber: '70103', phone: '5550103', firstName: 'Anna' }, NOW);
  const r = lockerImport.importMinnoExport(M, GOOD, 'ag@example.test', { dryRun: false }, NOW);
  assert.deepEqual([r.ok, r.imported, r.problems], [true, 4, 0]);
  const view = parcels.boxView(M);
  assert.equal(view.counts.occupied, 4);
  assert.deepEqual(view.boxes.filter(b => b.parcel).map(b => b.n), [1, 19, 38, 42]);
  const p = view.boxes.find(b => b.n === 42).parcel;
  assert.equal(p.orderNumber, '70103');
  assert.equal(p.storedAt, '2026-11-26T10:20:47.000Z');
  assert.equal(parcels.getParcel(M, p.id).events.some(e => e.type === 'imported'), true);
  assert.equal(parcels.getParcel(M, p.id).events.some(e => e.type.startsWith('sms_')), false, 'no message was attempted');

  // The customer's old code opens the box.
  const pick = parcels.startPickup(M, { code: '100003' }, NOW);
  assert.equal(pick.ok, true);
  assert.deepEqual([pick.box.board, pick.box.lock], [2, 21]);
  assert.equal(parcels.finishPickup(M, pick.parcelId, { opened: true }, NOW).state, 'collected');

  // Staff cannot put an imported order in a second time, also not one known only by a name.
  assert.equal(parcels.lookupForDeposit(M, '70101').code, 'order_used');
  assert.equal(parcels.lookupForDeposit(M, 'jona').code, 'order_used');
  // The offline list carries them, so a pickup works without a connection too.
  assert.equal(parcels.offlineList(M).parcels.length, 3);
});

test('a parcel that had waited two days is left to the old system\'s reminder; a younger one gets ours', () => {
  const due = parcels.parcelsNeedingReminder(48, NOW + 48 * 3600000);
  const stored = parcels.boxView(M).boxes.filter(b => b.parcel);
  const idOf = (n) => stored.find(b => b.n === n).parcel.id;
  assert.equal(due.includes(idOf(19)), false, 'stored on the 24th: already reminded before it came to us');
  assert.equal(due.includes(idOf(1)), true);
  assert.equal(due.includes(idOf(38)), true);
});

test('the same file a second time is refused: the boxes are in use', () => {
  const r = lockerImport.importMinnoExport(M, GOOD, 'ag@example.test', { dryRun: false }, NOW);
  assert.equal(r.imported, 0);
  assert.deepEqual([r.rows[0].problem, r.rows[1].problem, r.rows[3].problem], ['box_in_use', 'box_in_use', 'box_in_use']);
  assert.equal(r.rows[2].problem, 'order_used', 'the collected one is refused too');
});

test('a file from another locker is flagged, and only AG can import', () => {
  const other = file(line('70301', 'A10', '2026-11-27 09:00:00', '5550301', '300001', 'T0000009'));
  assert.deepEqual(lockerImport.importMinnoExport(M, other, 'ag@example.test', { dryRun: true }, NOW).otherDevices, ['T0000009']);
  const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/machines/:deviceCode/locker/import');
  assert.deepEqual(route.middleware.map(f => f.name), ['requireAuth', 'requireAgAdmin']);
});

test('the list of deposited orders says where each parcel is now', () => {
  const listed = parcels.listOrders('op-import', { status: 'deposited', limit: 500 });
  const gone = listed.find(o => o.orderNumber === '70103'), here = listed.find(o => o.orderNumber === '70101');
  assert.equal(gone.parcel.state, 'collected');
  assert.ok(gone.parcel.endedAt);
  assert.deepEqual([here.parcel.state, here.parcel.boxN], ['stored', 1]);
  assert.equal(parcels.listOrders('op-import', { status: 'expected' }).some(o => 'parcel' in o), false);
});
