/**
 * The locker app's release line (6.147.0): publish, canary, halt and "load latest build", with
 * the builds read from a private repository. GitHub is stubbed; machines are invented.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-ota-test-'));
process.env.DB_PATH = path.join(TMP, 'test.db');
process.env.APK_DIR = path.join(TMP, 'apks');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);
process.env.LOCKER_RELEASES_REPO = 'example-owner/locker-app';
process.env.RELEASES_REPO = 'example-owner/kiosk-apps';
delete process.env.GITHUB_TOKEN;
delete process.env.LOCKER_RELEASES_TOKEN;

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');

function machine(deviceCode, model) {
  return { deviceCode, deviceName: deviceCode, location: '', operatorId: 'op-ota', model, isKioskModel: 0, isOnline: 1, isRunning: 1,
    kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1, settings: model.startsWith('LK-') ? { locker: { info: {}, boxes: [{ n: 1, size: 'small', board: 1, lock: 1 }] } } : {},
    profile: {}, featured: [], ads: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
storage.upsertOperator({ id: 'op-ota', name: 'OTA test', isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
for (const m of [machine('LKO-1', 'LK-AGV19'), machine('LKO-2', 'LK-AGV47'), machine('VMO-1', 'VM-WM55DL')]) { storage.upsertMachine(m); machines[m.deviceCode] = m; }

async function call(method, pattern, { params = {}, body, query = {}, headers = {} } = {}) {
  const route = routes.find(r => r.method === method && r.pattern === pattern);
  assert.ok(route, method + ' ' + pattern);
  let status = 0, text = '', piped = false;
  const done = new Promise(resolve => {
    const res = { writeHead(s) { status = s; }, setHeader() {}, end(b) { text = b ? b.toString() : ''; resolve(); },
      on() { return res; }, once() { return res; }, emit() { return true; }, write() { piped = true; return true; } };
    Promise.resolve(route.handler({ params, body, query, headers, user: { role: 'ag_admin', email: 'ag@example.test' } }, res)).catch(e => { text = JSON.stringify({ thrown: e.message }); resolve(); });
    if (pattern.endsWith('/apk')) setTimeout(resolve, 150);
  });
  await done;
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (e) {}
  return { status, body: parsed, piped, guards: route.middleware ? route.middleware.map(f => f.name) : [] };
}

const APK = Buffer.alloc(4096, 7);
const ASSET = 'https://api.github.com/repos/example-owner/locker-app/releases/assets/4242';
let seen = [];
const realFetch = global.fetch;
function stubGitHub({ list = 200 } = {}) {
  seen = [];
  global.fetch = async (url, opts = {}) => {
    const h = opts.headers || {};
    seen.push({ url: String(url), auth: h.Authorization || null, accept: h.Accept || null });
    const res = (status, bodyObj, buf) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
      json: async () => bodyObj, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
    if (String(url).endsWith('/repos/example-owner/locker-app/releases?per_page=50')) {
      if (list !== 200) return res(list, { message: 'Not Found' }, Buffer.alloc(0));
      return res(200, [
        { tag_name: 'locker-v0.4.13', body: 'versionCode: 23\n', assets: [{ name: 'locker-0.4.13.apk', url: ASSET.replace('4242', '4100'), browser_download_url: 'https://github.com/example-owner/locker-app/releases/download/locker-v0.4.13/locker-0.4.13.apk' }] },
        { tag_name: 'locker-v0.4.14', body: 'What changed\nversionCode: 24\n', html_url: 'https://github.com/example-owner/locker-app/releases/tag/locker-v0.4.14',
          assets: [{ name: 'locker-0.4.14.apk', url: ASSET, browser_download_url: 'https://github.com/example-owner/locker-app/releases/download/locker-v0.4.14/locker-0.4.14.apk' }] },
        { tag_name: 'coil-v9.9.9', body: 'versionCode: 999\n', assets: [{ name: 'coil-9.9.9.apk', url: 'x', browser_download_url: 'x' }] },
      ], Buffer.alloc(0));
    }
    if (String(url) === ASSET) return h.Authorization ? res(200, null, APK) : res(404, null, Buffer.alloc(0));
    return res(404, null, Buffer.alloc(0));
  };
}
test.after(() => { global.fetch = realFetch; fs.rmSync(TMP, { recursive: true, force: true }); });

test('a locker asks for its update and is told there is none, not that its model is unknown', async () => {
  const r = await call('GET', '/api/v1/machines/:deviceCode/app-update', { params: { deviceCode: 'LKO-1' }, headers: { 'x-app-version-code': '22', 'x-app-version-name': '0.4.12' } });
  assert.deepEqual([r.status, r.body.rolloutEnabled, r.body.reason], [200, false, 'no_release']);
  assert.equal(storage.getAppVersion('LKO-1').vc, 22, 'its version is recorded for the fleet table');
});

test('without a token the private repository cannot be read, and the answer says what to set', async () => {
  stubGitHub({ list: 404 });
  const r = await call('GET', '/api/v1/app-release/latest-build', { query: { app: 'locker' } });
  assert.equal(r.status, 424);
  assert.match(r.body.error, /private/);
  assert.match(r.body.error, /LOCKER_RELEASES_TOKEN/);
});

test('with a token the newest locker build is found, and only locker builds', async () => {
  process.env.LOCKER_RELEASES_TOKEN = 'test-token-not-real';
  stubGitHub();
  const r = await call('GET', '/api/v1/app-release/latest-build', { query: { app: 'locker' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.data.app, r.body.data.versionCode, r.body.data.versionName, r.body.data.apkUrl], ['locker', 24, '0.4.14', ASSET]);
  assert.equal(seen[0].auth, 'Bearer test-token-not-real');
  assert.equal(JSON.stringify(r.body).includes('test-token-not-real'), false, 'the token never reaches the dashboard');
});

test('publishing fetches the private asset with the token and serves it from our own address', async () => {
  stubGitHub();
  const refused = await call('PUT', '/api/v1/app-release', { body: { app: 'lockers', targetVersionCode: 24, apkUrl: ASSET, cohort: ['LKO-1'] } });
  assert.equal(refused.status, 400, 'a mistyped line is refused, never read as coil');
  const wrong = await call('PUT', '/api/v1/app-release', { body: { app: 'coil', targetVersionCode: 24, apkUrl: 'https://example.test/dl/locker-0.4.14.apk', cohort: ['VMO-1'] } });
  assert.match(wrong.body.error, /filename says locker/);

  const r = await call('PUT', '/api/v1/app-release', { body: { app: 'locker', targetVersionCode: 24, versionName: '0.4.14', apkUrl: ASSET, cohort: ['LKO-1'], requiresStoredKey: true } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = seen.find(x => x.url === ASSET);
  assert.deepEqual([got.auth, got.accept], ['Bearer test-token-not-real', 'application/octet-stream']);
  assert.equal(r.body.data.release.apkUrl, '/api/v1/app-release/locker/apk');
  assert.equal(r.body.data.release.requiresStoredKey, false, 'the stored-key guard does not apply to a locker');
  assert.equal(fs.readFileSync(path.join(process.env.APK_DIR, 'locker.apk')).length, APK.length);
  assert.equal(storage.getAppRelease('coil'), null, 'the coil line is untouched');

  // The token is sent to that one address shape only.
  stubGitHub();
  await call('PUT', '/api/v1/app-release', { body: { app: 'locker', targetVersionCode: 25, apkUrl: 'https://api.github.com/repos/someone-else/other/releases/assets/1', cohort: ['LKO-1'] } });
  assert.equal(seen[0].auth, null);
});

test('the canary locker is offered the build, the other locker and the coil machine are not', async () => {
  const offer = (code) => call('GET', '/api/v1/machines/:deviceCode/app-update', { params: { deviceCode: code }, headers: { host: 'backend.example.test', 'x-app-version-code': '22' } });
  const a = (await offer('LKO-1')).body;
  assert.deepEqual([a.rolloutEnabled, a.targetVersionCode, a.versionName, a.apkUrl], [true, 24, '0.4.14', 'https://backend.example.test/api/v1/app-release/locker/apk']);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([(await offer('LKO-2')).body.rolloutEnabled, (await offer('LKO-2')).body.reason], [false, 'not_in_cohort']);
  assert.equal((await offer('VMO-1')).body.reason, 'no_release', 'a coil machine never sees the locker build');
});

test('halt, resume and widening work on the locker line; an unknown line is refused', async () => {
  assert.equal((await call('POST', '/api/v1/app-release/rollout', { body: { app: 'locker', on: false } })).body.data.release.rolloutEnabled, false);
  const halted = (await call('GET', '/api/v1/machines/:deviceCode/app-update', { params: { deviceCode: 'LKO-1' }, headers: {} })).body;
  assert.deepEqual([halted.rolloutEnabled, halted.reason], [false, 'halted']);
  await call('POST', '/api/v1/app-release/rollout', { body: { app: 'locker', on: true } });
  assert.equal((await call('POST', '/api/v1/app-release/cohort', { body: { app: 'locker', cohort: 'all' } })).body.data.release.cohort, 'all');
  assert.equal((await call('GET', '/api/v1/machines/:deviceCode/app-update', { params: { deviceCode: 'LKO-2' }, headers: {} })).body.rolloutEnabled, true);
  assert.equal((await call('POST', '/api/v1/app-release/rollout', { body: { app: 'toaster', on: false } })).status, 400);
  assert.equal((await call('POST', '/api/v1/app-release/cohort', { body: { app: 'toaster', cohort: 'all' } })).status, 400);
  assert.equal((await call('GET', '/api/v1/app-release/:app/apk', { params: { app: 'toaster' } })).status, 404, 'an unknown line is no longer served the coil APK');
});

test('who may do what: publishing is AG only, the manifest needs the machine key', () => {
  const guards = (m, p) => routes.find(r => r.method === m && r.pattern === p).middleware.map(f => f.name);
  assert.deepEqual(guards('PUT', '/api/v1/app-release'), ['requireAuth', 'requireAgAdmin']);
  assert.deepEqual(guards('GET', '/api/v1/app-release/latest-build'), ['requireAuth', 'requireAgAdmin']);
  assert.deepEqual(guards('GET', '/api/v1/machines/:deviceCode/app-update'), ['requireMachineKey']);
});
