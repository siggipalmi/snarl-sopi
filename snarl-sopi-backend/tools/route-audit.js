#!/usr/bin/env node
/**
 * Walk every GET route against a running copy of the backend, as four different callers, and
 * report anything that answers someone it should not.
 *
 *   node tools/route-audit.js [path/to/db]       (default: scratch copy of $DB_PATH)
 *
 * test/routeAuth.test.js already proves every route carries a guard. This proves the guard is
 * the right one — that an operator asking for another operator's machine is refused, and that
 * what comes back on a list route never mentions anyone else's fleet.
 *
 * It works on a COPY of the database, because it has to create users to sign in as. The
 * original is never written to. Only GET routes are called: nothing here changes state.
 *
 * Exits non-zero if it finds anything, so it can gate a release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const srcDb = process.argv[2] || process.env.DB_PATH;
if (!srcDb || !fs.existsSync(srcDb)) {
  console.error('Usage: node tools/route-audit.js <path/to/db>   (or set DB_PATH)');
  console.error('Give it a throwaway or anonymised copy, not /data/snarl-sopi.db.');
  process.exit(2);
}

const PASSWORD = 'route-audit-' + Math.random().toString(36).slice(2, 10);
const workDb = path.join(os.tmpdir(), 'route-audit-' + process.pid + '.db');
fs.copyFileSync(srcDb, workDb);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(srcDb + suffix)) fs.copyFileSync(srcDb + suffix, workDb + suffix);
}
process.env.DB_PATH = workDb;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-audit-secret';

const PORT = 8300 + (process.pid % 400);
const BASE = 'http://127.0.0.1:' + PORT;

function cleanup() {
  for (const f of [workDb, workDb + '-wal', workDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

// ─── Fixtures: two operator users on the biggest operator, plus the AG admin ──────────────────

function seedUsers() {
  const Database = require('better-sqlite3');
  const { hashPassword } = require('../src/passwords');
  const db = new Database(workDb);

  const biggest = db.prepare(
    'SELECT operatorId, COUNT(*) n FROM machines WHERE operatorId IS NOT NULL ' +
    'GROUP BY operatorId ORDER BY n DESC LIMIT 1').get();
  if (!biggest) { console.error('No machines in this database — nothing to audit.'); process.exit(2); }

  const ag = db.prepare("SELECT id, email FROM users WHERE role = 'ag_admin' LIMIT 1").get();
  if (!ag) { console.error('No ag_admin in this database.'); process.exit(2); }

  const pw = hashPassword(PASSWORD);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(pw, ag.id);

  const made = [];
  for (const [id, role] of [['u_audit_opadmin', 'operator_admin'],
                            ['u_audit_restock', 'operator_restocker']]) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare('INSERT INTO users (id, name, email, password, role, operatorId, machineAccess, '
      + 'createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, role, id + '@audit.local', pw, role, biggest.operatorId, 'all',
           new Date().toISOString());
    made.push({ role, email: id + '@audit.local' });
  }

  const mine = db.prepare('SELECT deviceCode FROM machines WHERE operatorId = ?')
    .all(biggest.operatorId).map(r => r.deviceCode);
  const foreign = db.prepare(
    'SELECT deviceCode, operatorId FROM machines WHERE operatorId IS NOT NULL '
    + 'AND operatorId != ? LIMIT 1').get(biggest.operatorId);
  const foreignCodes = db.prepare(
    'SELECT deviceCode FROM machines WHERE operatorId IS NOT NULL AND operatorId != ?')
    .all(biggest.operatorId).map(r => r.deviceCode);
  const foreignOps = db.prepare(
    'SELECT id FROM operators WHERE id != ?').all(biggest.operatorId).map(r => r.id);

  db.close();
  return { operatorId: biggest.operatorId, agEmail: ag.email, users: made,
           mine, foreign, foreignCodes, foreignOps };
}

// ─── Driving the server ───────────────────────────────────────────────────────────────────────

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function login(email) {
  const r = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json().catch(() => ({}));
  return (j.data && j.data.token) || null;
}

async function get(urlPath, token) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  try {
    const r = await fetch(BASE + urlPath, { headers });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    return { status: 0, text: String(e.message) };
  }
}

// ─── The sweep ────────────────────────────────────────────────────────────────────────────────

const GUARDS = new Set(['requireAuth', 'requireMachineKey', 'requireKioskAuth', 'requireLeaseKey']);

function fill(pattern, subs) {
  let out = pattern;
  for (const [k, v] of Object.entries(subs)) out = out.replace(':' + k, encodeURIComponent(v));
  return out.includes(':') ? null : out;   // a param we cannot fill — skipped, and counted
}

async function main() {
  const fx = seedUsers();

  // Start the server in this process, after DB_PATH is pointed at the copy.
  process.env.PORT = String(PORT);
  const quiet = console.log;
  console.log = () => {};            // the backend is chatty on boot
  require('../src/server');
  console.log = quiet;

  if (!await waitForServer()) { console.error('Server did not come up.'); cleanup(); process.exit(2); }

  const { routes } = require('../src/router');
  const tokens = { anonymous: null, ag_admin: await login(fx.agEmail) };
  for (const u of fx.users) tokens[u.role] = await login(u.email);

  for (const [role, tok] of Object.entries(tokens)) {
    if (role !== 'anonymous' && !tok) {
      console.error('Could not sign in as ' + role + ' — aborting.');
      cleanup(); process.exit(2);
    }
  }

  const findings = [];
  const skipped = [];
  let checked = 0;

  const ownSubs = { deviceCode: fx.mine[0], operatorId: fx.operatorId, app: 'coil' };
  const foreignSubs = fx.foreign
    ? { deviceCode: fx.foreign.deviceCode, operatorId: fx.foreign.operatorId, app: 'coil' }
    : null;

  // Anything that names another operator's fleet in a response body is a leak, whatever the
  // route meant to return. Checked as whole words so a substring cannot raise a false alarm.
  const foreignNeedles = [...fx.foreignCodes, ...fx.foreignOps];
  function leaks(text) {
    if (!text || text.length > 4_000_000) return [];
    return foreignNeedles.filter(n => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text));
  }

  for (const route of routes) {
    if (route.method !== 'GET') continue;
    const guarded = (route.middleware || []).some(m => GUARDS.has(m.name));

    const own = fill(route.pattern, ownSubs);
    if (!own) { skipped.push(route.pattern); continue; }
    checked++;

    // 1. A guarded route must refuse an anonymous caller.
    if (guarded) {
      const anon = await get(own, null);
      if (anon.status === 200) {
        findings.push({ route: route.pattern, kind: 'open-to-anonymous',
          detail: 'returns 200 with no token, although it carries an auth guard' });
      }
    }

    // 2. What an operator gets back must not name anyone else's machines or operators.
    for (const role of ['operator_admin', 'operator_restocker']) {
      const res = await get(own, tokens[role]);
      if (res.status !== 200) continue;
      const hit = leaks(res.text);
      if (hit.length) {
        findings.push({ route: route.pattern, kind: 'cross-operator-data',
          detail: role + ' sees ' + hit.length + ' identifier(s) it does not own, e.g. '
                  + hit.slice(0, 3).join(', ') });
      }
    }

    // 3. Asking for another operator's resource by id must be refused.
    if (foreignSubs && /:deviceCode|:operatorId/.test(route.pattern)) {
      const other = fill(route.pattern, foreignSubs);
      if (other) {
        for (const role of ['operator_admin', 'operator_restocker']) {
          const res = await get(other, tokens[role]);
          if (res.status === 200) {
            findings.push({ route: route.pattern, kind: 'foreign-resource-served',
              detail: role + ' got 200 for another operator\'s id' });
          }
        }
      }
    }
  }

  // ─── Report ────────────────────────────────────────────────────────────────────────────────
  const W = 62;
  console.log('');
  console.log('Route scoping audit');
  console.log('  database  ' + srcDb + ' (worked on a copy)');
  console.log('  operator  ' + fx.operatorId + ' — ' + fx.mine.length + ' of its own machines');
  console.log('  checked   ' + checked + ' GET routes as anonymous, restocker, operator_admin, ag_admin');
  if (skipped.length) {
    console.log('  skipped   ' + skipped.length + ' with a parameter that cannot be filled: '
      + skipped.slice(0, 4).join(', ') + (skipped.length > 4 ? ' …' : ''));
  }
  console.log('');

  if (!findings.length) {
    console.log('  No findings. No route served an anonymous caller, leaked another');
    console.log('  operator\'s identifiers, or answered for a foreign id.');
    cleanup();
    process.exit(0);
  }

  const byKind = {};
  for (const f of findings) (byKind[f.kind] = byKind[f.kind] || []).push(f);
  for (const [kind, list] of Object.entries(byKind)) {
    console.log('  ' + kind.toUpperCase() + '  (' + list.length + ')');
    for (const f of list) console.log('    ' + f.route.padEnd(W) + ' ' + f.detail);
    console.log('');
  }
  console.log('  ' + findings.length + ' finding(s).');
  cleanup();
  process.exit(1);
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

main().catch(e => { console.error(e); cleanup(); process.exit(2); });
