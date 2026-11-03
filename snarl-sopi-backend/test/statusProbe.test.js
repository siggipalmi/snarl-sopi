/**
 * GET /api/v1/debug/status-probe — answers the status it is asked for, nothing else.
 *
 * It exists to find out which error statuses Railway's edge passes through (502 is replaced by the
 * edge's own page). The properties that matter: it stays AG-only like every /debug route, it
 * answers exactly the code asked for with the marker in the body, and it refuses anything that is
 * not an error status.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'status-probe-test-' + process.pid + '.db');

const { routes } = require('../src/router');
const route = routes.find(r => r.method === 'GET' && r.pattern === '/api/v1/debug/status-probe');

function call(code) {
  const req = { query: code === undefined ? {} : { code: String(code) }, headers: {}, socket: {} };
  let status = 0, payload = null; const headers = {};
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    writeHead(s) { status = s; },
    end(buf) { payload = JSON.parse(String(buf)); },
  };
  route.handler(req, res);
  return { status, payload, headers };
}

test('the route exists and is AG-only', () => {
  assert.ok(route, 'GET /api/v1/debug/status-probe is in the route table');
  assert.deepStrictEqual((route.middleware || []).map(m => m.name), ['requireAuth', 'requireAgAdmin']);
});

test('it answers the status asked for, with the marker', () => {
  for (const code of [424, 502, 503, 504]) {
    const r = call(code);
    assert.strictEqual(r.status, code);
    assert.strictEqual(r.payload.marker, 'snarl-sopi-status-probe');
    assert.strictEqual(r.payload.sentStatus, code);
    assert.strictEqual(r.headers['x-status-probe'], String(code));
  }
});

test('anything but an error status is refused', () => {
  for (const code of [undefined, '', 'abc', 200, 302, 399, 600, 503.5]) {
    const r = call(code);
    assert.strictEqual(r.status, 400, 'code=' + code);
    assert.strictEqual(r.payload.ok, false);
  }
});
