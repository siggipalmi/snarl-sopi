/**
 * Every route carries an auth guard, or is listed here with a reason.
 *
 * This is the check that catches the next unguarded route. A route added to the table without
 * requireAuth (or one of the other guards) fails this test, and the author then either adds a
 * guard or adds a line below saying why the route is public. Both are fine; silence is not.
 *
 * It does not check that the guard is the RIGHT one — requireAuth where requireAgAdmin belongs
 * still passes. tools/route-audit.js exercises that against a running server.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

// Point storage at a throwaway file before requiring the router, which opens the DB on require.
process.env.DB_PATH = path.join(os.tmpdir(), 'route-auth-test-' + process.pid + '.db');

const { routes } = require('../src/router');

// A middleware that establishes who or what is calling.
const GUARDS = new Set([
  'requireAuth',        // a signed-in user (bearer token)
  'requireMachineKey',  // a provisioned machine (X-Machine-Key)
  'requireKioskAuth',   // the kiosk shared secret
  'requireLeaseKey',    // the skraning Worker (X-Lease-Key)
]);

// Routes that are reachable without any of the above, each with the reason it is safe.
// Keep the reason specific: "public" on its own is not a reason.
const PUBLIC = new Map([
  ['GET /health',
    'Status only. Secrets are reported as booleans, never values.'],
  ['GET /whatismyip',
    'Returns the callers own IP, which the caller already knows.'],
  ['POST /api/v1/demo-request',
    'The public marketing form on agvending.is.'],
  ['POST /api/v1/auth/login',
    'The sign-in itself. Rate-limited per IP and per email in the handler.'],
  ['POST /api/v1/auth/forgot-password',
    'Reaching this without being signed in is the whole point.'],
  ['GET /api/v1/password-reset/:token',
    'The token in the URL is the credential.'],
  ['POST /api/v1/password-reset/:token',
    'The token in the URL is the credential.'],
  ['GET /api/v1/invitations/:token',
    'The invitation token is the credential.'],
  ['POST /api/v1/invitations/:token/accept',
    'The invitation token is the credential.'],
  ['POST /api/v1/provisioning/pair',
    'Unauthenticated by design: the machine has no key yet, which is what pairing is for. '
    + 'Six-digit code, rate-limited by IP in the handler.'],
  ['GET /downloads',
    'Gated inside the handler by downloadsKeyOk() — an access key in the query string.'],
  ['POST /api/v1/machines/provision',
    'Gated inside the handler by the X-Provision-Secret header (PROVISION_SECRET).'],
  ['POST /api/v1/operators/provision',
    'Gated inside the handler by the X-Provision-Key header (PROVISION_KEY), which fails '
    + 'closed with 503 when the variable is unset.'],

  // Known gap, deliberately recorded rather than hidden. Serving this to anyone hands out the
  // kiosk binary. It carries no credentials — the apps bootstrap through a pairing code
  // (see coil-app PairingClient.kt) and no secret literal appears in their sources — so what
  // leaks is the app, not a way into the backend. Gating it behind requireMachineKey would
  // close it, but machines fetch their updates here, so that change has to be rolled out one
  // machine at a time rather than flipped.
  ['GET /api/v1/app-release/:app/apk',
    'KNOWN GAP: serves the kiosk APK unauthenticated. No credentials in the binary.'],
]);

function key(r) { return r.method + ' ' + r.pattern; }

function guardsOn(route) {
  return (route.middleware || []).map(m => m.name || (m.cap ? 'requireCap' : 'anon'));
}

test('every route either carries an auth guard or is a documented public route', () => {
  const undocumented = routes
    .filter(r => !guardsOn(r).some(n => GUARDS.has(n)))
    .filter(r => !PUBLIC.has(key(r)))
    .map(key);

  assert.deepStrictEqual(undocumented, [],
    'These routes have no auth guard and no entry in PUBLIC. Add a guard, or add a line to '
    + 'PUBLIC in this file saying why the route is safe to leave open:\n  '
    + undocumented.join('\n  '));
});

test('the PUBLIC list has no stale entries', () => {
  const live = new Set(routes.map(key));
  const stale = [...PUBLIC.keys()].filter(k => !live.has(k));
  assert.deepStrictEqual(stale, [],
    'These routes are listed as public but no longer exist. Remove them so the list keeps '
    + 'meaning something:\n  ' + stale.join('\n  '));
});

test('every public route states a reason', () => {
  const vague = [...PUBLIC.entries()]
    .filter(([, why]) => !why || why.trim().length < 20)
    .map(([k]) => k);
  assert.deepStrictEqual(vague, [], 'A reason has to say something: ' + vague.join(', '));
});

test('nothing reaches the AG-only surface without requireAuth in front of it', () => {
  // requireAgAdmin and requireOperatorAdmin both read req.user, which only requireAuth sets.
  // One of them without requireAuth ahead of it would throw rather than refuse.
  const ROLE_MW = new Set(['requireAgAdmin', 'requireOperatorAdmin', 'requireAdmin',
                           'requireMachineAccess', 'requireOperatorAccess', 'requireCap']);
  const bad = routes.filter(r => {
    const g = guardsOn(r);
    const roleAt = g.findIndex(n => ROLE_MW.has(n));
    if (roleAt === -1) return false;
    const authAt = g.indexOf('requireAuth');
    return authAt === -1 || authAt > roleAt;
  }).map(key);

  assert.deepStrictEqual(bad, [],
    'A role check needs requireAuth before it, or req.user is undefined:\n  ' + bad.join('\n  '));
});
