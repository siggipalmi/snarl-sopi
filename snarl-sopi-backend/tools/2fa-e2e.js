#!/usr/bin/env node
/**
 * The whole two-factor flow against a running backend, end to end.
 *
 *   node tools/2fa-e2e.js [path/to/db]
 *
 * test/totp.test.js proves the algorithm against the RFC. This proves the product: that
 * enrolment works, that a password alone stops being enough the moment 2fa is on, that a
 * trusted browser skips the code and a tampered one does not, that a recovery code works
 * exactly once, and that operators are left alone.
 *
 * Works on a COPY of the database. The original is never written to.
 *
 * A note on the replay guard, because it shapes this whole script: a code is spent once, and
 * the step it matched is recorded, so only one sign-in can succeed per 30-second window per
 * account. Sections that are about something else therefore clear the guard first (they own
 * the database) rather than waiting out a window. The replay section does not clear it — that
 * is the thing it is testing — and one section waits a real window to prove that the next code
 * a phone shows is accepted.
 *
 * Exits non-zero if any expectation fails, so it can gate a release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const srcDb = process.argv[2] || process.env.DB_PATH;
if (!srcDb || !fs.existsSync(srcDb)) {
  console.error('Usage: node tools/2fa-e2e.js <path/to/db>   (or set DB_PATH)');
  process.exit(2);
}

const PASSWORD = 'e2e-' + Math.random().toString(36).slice(2, 10);
const workDb = path.join(os.tmpdir(), '2fa-e2e-' + process.pid + '.db');
fs.copyFileSync(srcDb, workDb);
for (const sfx of ['-wal', '-shm']) {
  if (fs.existsSync(srcDb + sfx)) fs.copyFileSync(srcDb + sfx, workDb + sfx);
}
process.env.DB_PATH = workDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || '2fa-e2e-secret';

const PORT = 8700 + (process.pid % 300);
const BASE = 'http://127.0.0.1:' + PORT;

function cleanup() {
  for (const f of [workDb, workDb + '-wal', workDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}
process.on('exit', cleanup);

let passed = 0; const failures = [];
function check(label, condition, detail) {
  if (condition) { passed++; console.log('  ok    ' + label); }
  else { failures.push({ label, detail }); console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let sqlite;   // a second connection, for setting up and for clearing the replay guard

function seed() {
  // Requiring storage first runs the schema and migrations on the copy, so this works against a
  // database saved before the 2fa tables existed.
  require('../src/storage');
  const Database = require('better-sqlite3');
  const { hashPassword } = require('../src/passwords');
  sqlite = new Database(workDb);
  const pw = hashPassword(PASSWORD);

  const ag = sqlite.prepare("SELECT id, email FROM users WHERE role = 'ag_admin' LIMIT 1").get();
  if (!ag) { console.error('No ag_admin in this database.'); process.exit(2); }
  sqlite.prepare('UPDATE users SET password = ? WHERE id = ?').run(pw, ag.id);
  for (const t of ['user_totp', 'user_recovery_codes', 'trusted_devices']) {
    sqlite.prepare('DELETE FROM ' + t + ' WHERE userId = ?').run(ag.id);
  }

  const op = sqlite.prepare('SELECT operatorId FROM machines WHERE operatorId IS NOT NULL LIMIT 1').get();
  sqlite.prepare('DELETE FROM users WHERE id = ?').run('u_e2e_op');
  sqlite.prepare('INSERT INTO users (id, name, email, password, role, operatorId, machineAccess, '
    + 'createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('u_e2e_op', 'operator', 'u_e2e_op@e2e.local', pw, 'operator_admin',
         op.operatorId, 'all', new Date().toISOString());

  return { agId: ag.id, agEmail: ag.email, opId: 'u_e2e_op', opEmail: 'u_e2e_op@e2e.local' };
}

/** Forget which step was last spent, so the current code counts as fresh again. */
function clearReplayGuard(userId) {
  sqlite.prepare('UPDATE user_totp SET lastStep = -1 WHERE userId = ?').run(userId);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function post(p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function get(p, token) {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const login = (email, extra) => post('/api/v1/auth/login', { email, password: PASSWORD, ...extra });

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/health')).ok) return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const fx = seed();
  process.env.PORT = String(PORT);
  const say = console.log;
  console.log = () => {};
  require('../src/server');
  console.log = say;
  if (!await waitUp()) { console.error('Server did not come up.'); process.exit(2); }

  const totp = require('../src/totp');

  /** Sign in fully, as a browser that is not trusted. Clears the guard first, by design. */
  async function fullLogin(email, userId, extra = {}) {
    clearReplayGuard(userId);
    const a = await login(email);
    if (!a.body.data?.challenge) return a;
    const secret = sqlite.prepare('SELECT secret FROM user_totp WHERE userId = ?').get(userId).secret;
    return post('/api/v1/auth/login/totp',
      { challenge: a.body.data.challenge, code: totp.currentCode(secret), ...extra });
  }

  console.log('\nTwo-factor, end to end');
  console.log('  database  ' + srcDb + ' (worked on a copy)');
  console.log('  admin     ' + fx.agEmail + '\n');

  // ── Before enrolment ──────────────────────────────────────────────────────
  console.log('Before enrolment');
  let r = await login(fx.agEmail);
  check('password alone signs in', r.status === 200 && !!r.body.data?.token, 'got ' + r.status);
  const firstToken = r.body.data?.token;
  r = await get('/api/v1/auth/2fa', firstToken);
  check('2fa reports itself off', r.body.data?.enabled === false);

  // ── Enrolment ─────────────────────────────────────────────────────────────
  console.log('\nEnrolment');
  r = await post('/api/v1/auth/2fa/setup', {}, firstToken);
  const secret = r.body.data?.secret;
  check('setup returns a base32 secret', /^[A-Z2-7]{32}$/.test(secret || ''), secret);
  check('setup returns an otpauth URI', (r.body.data?.otpauthUri || '').startsWith('otpauth://totp/'));

  r = await get('/api/v1/auth/2fa', firstToken);
  check('an unconfirmed setup does not turn it on',
    r.body.data?.enabled === false && r.body.data?.pending === true);
  r = await login(fx.agEmail);
  check('sign-in still works while setup is unconfirmed', !!r.body.data?.token);

  r = await post('/api/v1/auth/2fa/confirm', { code: '000000' }, firstToken);
  check('confirm refuses a wrong code', r.status === 400 && r.body.error === 'bad_code');

  r = await post('/api/v1/auth/2fa/confirm', { code: totp.currentCode(secret) }, firstToken);
  const recoveryCodes = r.body.data?.recoveryCodes || [];
  check('confirm accepts a real code', r.status === 200 && r.body.data?.enabled === true);
  check('confirm returns 8 recovery codes', recoveryCodes.length === 8, 'got ' + recoveryCodes.length);

  // The code used to confirm is spent, like any other. Worth stating, because it is the one
  // moment a person might type the same code twice within half a minute.
  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp',
    { challenge: r.body.data?.challenge, code: totp.currentCode(secret) });
  check('the code that confirmed setup is already spent', r.status === 401,
    'got ' + r.status + ' — it should not be reusable');

  // ── The point of the exercise ─────────────────────────────────────────────
  console.log('\nWith 2fa on');
  r = await login(fx.agEmail);
  check('the password alone NO LONGER signs in',
    r.body.data?.needsTotp === true && !r.body.data?.token, JSON.stringify(r.body.data));
  const challenge = r.body.data?.challenge;
  check('a challenge is issued instead', typeof challenge === 'string' && challenge.length > 20);

  r = await post('/api/v1/auth/login/totp', { challenge, code: '000000' });
  check('a wrong code is refused', r.status === 401 && r.body.error === 'bad_code');
  r = await post('/api/v1/auth/login/totp', { challenge: 'made-up', code: totp.currentCode(secret) });
  check('a made-up challenge is refused', r.status === 401 && r.body.error === 'challenge_expired');

  clearReplayGuard(fx.agId);
  r = await post('/api/v1/auth/login/totp', { challenge, code: totp.currentCode(secret) });
  const agToken = r.body.data?.token;
  check('the right code completes the sign-in', r.status === 200 && !!agToken,
    'got ' + r.status + ' ' + JSON.stringify(r.body.error || ''));
  check('and reports it came from the app', r.body.data?.via === 'totp');
  check('no device token unless asked for', !r.body.data?.deviceToken);
  r = await post('/api/v1/auth/login/totp', { challenge, code: totp.currentCode(secret) });
  check('a spent challenge cannot be reused', r.status === 401);

  // ── Replay: no clearing here, that is the point ───────────────────────────
  console.log('\nReplay');
  clearReplayGuard(fx.agId);          // start from a known state, then do NOT clear again
  const reused = totp.currentCode(secret);
  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp', { challenge: r.body.data?.challenge, code: reused });
  const firstUse = r.status;
  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp', { challenge: r.body.data?.challenge, code: reused });
  check('a code works once and not twice in its own window',
    firstUse === 200 && r.status === 401, 'first ' + firstUse + ', second ' + r.status);

  // ── A real 30-second window, so "tomorrow's code works" is not taken on trust ──
  console.log('\nAfter a real 30-second window (waiting, no clock tricks)');
  const stepBefore = totp.stepFor();
  while (totp.stepFor() === stepBefore) await new Promise(r2 => setTimeout(r2, 1000));
  await new Promise(r2 => setTimeout(r2, 1500));   // settle inside the new window
  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp',
    { challenge: r.body.data?.challenge, code: totp.currentCode(secret) });
  check('the next code the app shows is accepted, with no guard cleared',
    r.status === 200 && !!r.body.data?.token, 'got ' + r.status);

  // ── Trusted device ────────────────────────────────────────────────────────
  console.log('\nTrusting this browser for 7 days');
  r = await fullLogin(fx.agEmail, fx.agId, { trustDevice: true });
  const deviceToken = r.body.data?.deviceToken;
  check('trustDevice returns a device token',
    typeof deviceToken === 'string' && deviceToken.includes('.'), JSON.stringify(r.body.error || ''));
  const until = r.body.data?.deviceTrustedUntil;
  const days = until ? Math.round((new Date(until) - Date.now()) / 86400000) : 0;
  check('trusted for 7 days', days === 7, days + ' days');

  r = await login(fx.agEmail, { deviceToken });
  check('a trusted browser skips the code',
    r.status === 200 && !!r.body.data?.token && !r.body.data?.needsTotp);
  r = await login(fx.agEmail, { deviceToken });
  check('and keeps skipping it, with no replay guard in the way', !!r.body.data?.token);

  r = await login(fx.agEmail, { deviceToken: (deviceToken || '').split('.')[0] + '.wrong-secret' });
  check('a tampered device token does NOT skip the code', r.body.data?.needsTotp === true);
  r = await login(fx.agEmail, { deviceToken: 'nonsense' });
  check('a nonsense device token does NOT skip the code', r.body.data?.needsTotp === true);

  // An operator, to check isolation between accounts.
  const opFirst = await login(fx.opEmail);
  check('an operator without 2fa signs in on the password alone', !!opFirst.body.data?.token);
  r = await post('/api/v1/auth/2fa/setup', {}, opFirst.body.data.token);
  const opSecret = r.body.data?.secret;
  await post('/api/v1/auth/2fa/confirm', { code: totp.currentCode(opSecret) }, opFirst.body.data.token);
  r = await fullLogin(fx.opEmail, fx.opId, { trustDevice: true });
  const opDeviceToken = r.body.data?.deviceToken;
  check('the operator can enrol too', !!opDeviceToken);
  r = await login(fx.agEmail, { deviceToken: opDeviceToken });
  check('one account\'s trusted device does not work for another',
    r.body.data?.needsTotp === true, JSON.stringify(r.body.data));
  r = await fullLogin(fx.agEmail, fx.agId);
  r = await post('/api/v1/auth/login/totp',
    { challenge: (await login(fx.opEmail)).body.data?.challenge, code: totp.currentCode(secret) });
  check('the admin\'s code does not sign in the operator', r.status === 401);

  // ── Recovery codes ────────────────────────────────────────────────────────
  console.log('\nRecovery codes');
  const code0 = recoveryCodes[0];
  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp', { challenge: r.body.data?.challenge, code: code0 });
  check('a recovery code signs in', r.status === 200 && !!r.body.data?.token);
  check('and reports it was a recovery code', r.body.data?.via === 'recovery');
  check('and says how many are left', r.body.data?.recoveryCodesLeft === 7,
    'got ' + r.body.data?.recoveryCodesLeft);

  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp', { challenge: r.body.data?.challenge, code: code0 });
  check('the same recovery code does NOT work twice', r.status === 401);

  r = await login(fx.agEmail);
  r = await post('/api/v1/auth/login/totp',
    { challenge: r.body.data?.challenge, code: recoveryCodes[1].toLowerCase().replace('-', ' ') });
  check('a recovery code works however it is typed', r.status === 200 && !!r.body.data?.token);

  r = await get('/api/v1/auth/2fa', agToken);
  check('the count of codes left is reported', r.body.data?.recoveryCodesLeft === 6,
    'got ' + r.body.data?.recoveryCodesLeft);

  // ── Sessions ──────────────────────────────────────────────────────────────
  console.log('\nSessions');
  r = await get('/api/v1/auth/sessions', agToken);
  const sessions = r.body.data?.sessions || [];
  check('sessions are listed', sessions.length > 1, sessions.length + ' session(s)');
  check('exactly one is marked current', sessions.filter(s => s.current).length === 1);
  check('no session row leaks a usable token',
    !JSON.stringify(sessions).includes(String(agToken).slice(0, 24)));
  check('trusted devices are listed with a label',
    (r.body.data?.trustedDevices || []).length > 0);

  r = await post('/api/v1/auth/sessions/revoke-others', {}, agToken);
  check('revoke-others reports what it ended', r.status === 200 && r.body.data?.signedOut > 0,
    'signedOut ' + r.body.data?.signedOut);
  r = await get('/api/v1/auth/sessions', agToken);
  check('only this session survives', (r.body.data?.sessions || []).length === 1,
    (r.body.data?.sessions || []).length + ' left');
  check('this session still works', r.status === 200);
  r = await get('/api/v1/machines', firstToken);
  check('an older session really was ended', r.status === 401, 'got ' + r.status);
  r = await login(fx.agEmail, { deviceToken });
  check('revoke-others also untrusted the browsers', r.body.data?.needsTotp === true);

  // ── Turning it off ────────────────────────────────────────────────────────
  console.log('\nTurning it off');
  r = await post('/api/v1/auth/2fa/disable', { password: 'not-the-password' }, agToken);
  check('disable refuses a wrong password', r.status === 401 && r.body.error === 'bad_password');
  r = await post('/api/v1/auth/2fa/disable', {}, agToken);
  check('disable refuses an empty password', r.status === 401);
  r = await post('/api/v1/auth/2fa/disable', { password: PASSWORD }, agToken);
  check('disable works with the password', r.status === 200 && r.body.data?.enabled === false);
  r = await login(fx.agEmail);
  check('and the password alone signs in again', !!r.body.data?.token && !r.body.data?.needsTotp);
  const left = sqlite.prepare('SELECT COUNT(*) n FROM user_recovery_codes WHERE userId = ?')
    .get(fx.agId).n;
  check('disabling cleared the recovery codes', left === 0, left + ' left behind');

  console.log('\n' + (failures.length ? failures.length + ' FAILED, ' : '') + passed + ' passed');
  if (failures.length) for (const f of failures) {
    console.log('  ' + f.label + (f.detail ? '  — ' + f.detail : ''));
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
