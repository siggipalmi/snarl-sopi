/**
 * Release lines (6.123.0). Until now every app key but 'fridge' read and wrote the coil line, so
 * a third kind of machine asking for "its" release would have been handed the coil APK. A parcel
 * locker gets a line of its own; the coil and fridge lines keep their stored keys.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'app-release-lines-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const storage = require('../src/storage');

test('each app line is stored under its own key', () => {
  storage.setAppRelease({ targetVersionCode: 170, versionName: 'coil' }, 'coil');
  storage.setAppRelease({ targetVersionCode: 90, versionName: 'fridge' }, 'fridge');

  assert.equal(storage.getAppRelease('locker'), null, 'a locker has no release until one is published for it');

  storage.setAppRelease({ targetVersionCode: 3, versionName: 'locker' }, 'locker');
  assert.equal(storage.getAppRelease('locker').versionName, 'locker');
  assert.equal(storage.getAppRelease('coil').versionName, 'coil', 'publishing a locker release leaves the coil line alone');
  assert.equal(storage.getAppRelease('fridge').versionName, 'fridge');
});

test('the coil and fridge lines keep the keys the fleet already stores them under', () => {
  assert.equal(storage.appReleaseMetaKey('coil'), 'app_release');
  assert.equal(storage.appReleaseMetaKey(undefined), 'app_release', 'no key still means the coil line, as before');
  assert.equal(storage.appReleaseMetaKey('fridge'), 'app_release_fridge');
  assert.equal(JSON.parse(storage.getMeta('app_release')).versionName, 'coil');
  assert.equal(JSON.parse(storage.getMeta('app_release_fridge')).versionName, 'fridge');
});
