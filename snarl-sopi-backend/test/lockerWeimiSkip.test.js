/**
 * Parcel lockers are not Weimi machines (6.125.0): the sync never sends a locker's code to
 * Weimi, for status, products or orders. Invented data; Weimi is stubbed.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-weimi-skip-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const storage = require('../src/storage');
const weimi = require('../src/weimi');
const weimiSync = require('../src/weimiSync');

function machine(deviceCode, model, extra) {
  return { deviceCode, deviceName: deviceCode, location: '', operatorId: 'op-skip-test', model, isKioskModel: 0,
    isOnline: 0, isRunning: 0, kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1, settings: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra };
}

storage.upsertOperator({ id: 'op-skip-test', name: 'Skip test', isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
storage.upsertMachine(machine('LKSKIP1', 'LK-AGV19'));
// A coil machine on a kiosk catalog: its products are not fetched, but its status and orders are.
storage.upsertMachine(machine('VMSKIP1', 'VM-WM55DL', { catalogSource: 'kiosk' }));

test('a full sync asks Weimi about the coil machine and never names the locker', async () => {
  const asked = { profile: [], info: [], orders: [] };
  weimi.deviceProfile = async (cfg, codes) => { asked.profile.push(...codes); return []; };
  weimi.deviceInfo = async (cfg, code) => { asked.info.push(code); return {}; };
  weimi.queryOrders = async (cfg, q) => { asked.orders.push(q.deviceCode); return []; };

  const report = await weimiSync.syncAll({ orders: true, days: 1 });

  assert.ok(asked.profile.includes('VMSKIP1'), 'the coil machine is still asked about');
  assert.ok(asked.orders.includes('VMSKIP1'));
  for (const list of Object.values(asked)) assert.ok(!list.includes('LKSKIP1'), 'the locker code reached Weimi');

  const row = report.machines.find(r => r.deviceCode === 'LKSKIP1');
  assert.equal(row.skipped, 'locker');
  assert.equal(row.ok, true, 'a skipped locker is not a failed sync');
  assert.equal(report.machines.filter(r => r.productsError).length, 0);
});

test('syncing one locker on request does nothing and says so', async () => {
  let calls = 0;
  weimi.deviceInfo = async () => { calls++; return {}; };
  weimi.queryOrders = async () => { calls++; return []; };
  const r = await weimiSync.syncMachine('LKSKIP1', { orders: true });
  assert.deepEqual(r, { deviceCode: 'LKSKIP1', ok: true, skipped: 'locker' });
  assert.equal(calls, 0);
});
