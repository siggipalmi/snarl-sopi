/**
 * The locker record routes (6.124.0), called as the router would call them. Invented data.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-routes-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');

const route = (method) => routes.find(r => r.method === method && r.pattern === '/api/v1/machines/:deviceCode/locker');

function machine(deviceCode, model) {
  return { deviceCode, deviceName: 'AG Test', location: 'Prufugata 1', operatorId: 'op-locker-test', model, isKioskModel: 0,
    isOnline: 1, isRunning: 1, kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1, settings: {},
    profile: { operatorName: 'Test', machineLabel: 'AG Test' }, featured: [], ads: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

storage.upsertOperator({ id: 'op-locker-test', name: 'Locker test', isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
for (const m of [machine('LKT1', 'LK-TEST'), machine('VMT1', 'VM-WM55DL')]) { storage.upsertMachine(m); machines[m.deviceCode] = m; }

function call(method, deviceCode, body, role) {
  let status = 0, text = '';
  const res = { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } };
  const req = { params: { deviceCode }, body, query: {}, headers: {}, user: { role: role || 'operator_admin', email: 'someone@example.test', operatorId: 'op-locker-test' } };
  route(method).handler(req, res);
  return { status, body: text ? JSON.parse(text) : null };
}

test('both routes exist and need a signed-in user with access to the machine', () => {
  for (const m of ['GET', 'PUT']) {
    assert.ok(route(m), m + ' route');
    assert.deepEqual(route(m).middleware.map(f => f.name), ['requireAuth', 'requireMachineAccess']);
  }
});

test('a new locker reads with the machine name and location and no boxes', () => {
  const r = call('GET', 'LKT1');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.info.name, 'AG Test');
  assert.equal(r.body.data.info.address, 'Prufugata 1');
  assert.deepEqual(r.body.data.boxes, []);
});

test('an operator changes the customer-facing details, and they are stored', () => {
  const r = call('PUT', 'LKT1', { info: { name: 'AG Test skápur', findNote: 'Í anddyrinu', accessNote: 'Dyrakóði 0000 utan opnunartíma' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.info.accessNote, 'Dyrakóði 0000 utan opnunartíma');
  assert.equal(r.body.data.updatedBy, 'someone@example.test');
  // Read back from the database, not from memory.
  assert.equal(storage.getMachine('LKT1').settings.locker.info.findNote, 'Í anddyrinu');
});

test('an operator cannot change the box list; AG can', () => {
  const boxes = [{ n: 1, size: 'middle' }, { n: 2, size: 'small' }, { n: 3, size: 'big' }];
  const refused = call('PUT', 'LKT1', { boxes });
  assert.equal(refused.status, 403);
  assert.deepEqual(call('GET', 'LKT1').body.data.boxes, [], 'nothing was stored by the refused call');

  const done = call('PUT', 'LKT1', { boxes }, 'ag_admin');
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.data.boxCounts, { small: 1, middle: 1, big: 1 });
  assert.equal(done.body.data.info.findNote, 'Í anddyrinu', 'the details set earlier are still there');
  assert.equal(storage.getMachine('LKT1').settings.locker.boxes.length, 3);
});

test('a bad record is refused whole and nothing changes', () => {
  const before = JSON.stringify(storage.getMachine('LKT1').settings.locker);
  assert.equal(call('PUT', 'LKT1', { info: { name: 'x'.repeat(61) } }).status, 400);
  assert.equal(call('PUT', 'LKT1', { info: { name: 'Fine' }, boxes: [{ n: 1, size: 'huge' }] }, 'ag_admin').status, 400);
  assert.equal(call('PUT', 'LKT1', {}).status, 400);
  assert.equal(JSON.stringify(storage.getMachine('LKT1').settings.locker), before);
});

test('a machine that is not a locker has no locker record, and an unknown machine is not found', () => {
  assert.equal(call('GET', 'VMT1').status, 400);
  assert.equal(call('PUT', 'VMT1', { info: { name: 'x' } }).status, 400);
  assert.equal(storage.getMachine('VMT1').settings.locker, undefined);
  assert.equal(call('GET', 'NOPE').status, 404);
});
