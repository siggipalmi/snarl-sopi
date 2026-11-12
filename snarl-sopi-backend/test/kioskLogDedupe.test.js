/**
 * The log relay posts a tail, so consecutive posts overlap; the overlap used to be stored twice
 * (Grótta vinstri, 2026-11-11). A repeat of a recently stored line is skipped.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = path.join(os.tmpdir(), 'kiosk-log-dedupe-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);
const storage = require('../src/storage');

test('an overlapping relay post stores only its new lines', () => {
  const a = ['11-11 02:18:46.246 I/VM( 1338): drop sensor applied: off', '11-11 02:38:58.060 I/VM( 1338): drop sensor applied: off'];
  const b = [a[1], '11-11 02:59:10.808 I/VM( 1338): drop sensor applied: off'];
  assert.strictEqual(storage.appendKioskLogs('D1', 1, '0.80.25', a), 2);
  assert.strictEqual(storage.appendKioskLogs('D1', 2, '0.80.25', b), 1);
  assert.strictEqual(storage.appendKioskLogs('D1', 3, '0.80.25', b), 0);
  assert.deepStrictEqual(storage.listKioskLogs('D1', 10).map(r => r.line), [a[0], a[1], b[1]]);
  // another machine's identical line is its own
  assert.strictEqual(storage.appendKioskLogs('D2', 4, null, [a[0]]), 1);
});
