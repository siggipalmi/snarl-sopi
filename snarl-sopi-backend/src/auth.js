/**
 * Auth helpers + permission middleware.
 *
 * Roles:
 *   ag_admin         — AG Vending users, full access
 *   operator_admin   — manage own operator, invite staff, edit machines
 *   operator_manager — runs the operator's machines; no users, invoices or refunds
 *   operator_restocker — opens, restocks and moves products on assigned machines
 * What each may do is in roles.js; requireCap enforces it per route.
 */

const crypto = require('crypto');
const storage = require('./storage');
const roles = require('./roles');
const { authTokens, users, machines, operators, userCanAccessMachine, userCanAccessOperator,
        userCanInviteTo, userCanReassignWithin } = require('./db');

const SECRET = process.env.JWT_SECRET || 'snudur-sopi-dev-secret-change-in-prod';

// Whether a real secret was supplied. The fallback above is in a public repo, so it is worth
// nothing as a secret; a forged token is still refused today because verifyToken also requires
// the token to exist in SQLite, but that is one refactor away from being the only thing holding.
// Reported as a boolean by GET /health (auth.jwtSecret) so it can be confirmed from outside.
const JWT_SECRET_SET = !!process.env.JWT_SECRET;
if (!JWT_SECRET_SET) {
  console.warn('[AUTH] JWT_SECRET is not set — using the built-in development secret. ' +
    'Set JWT_SECRET on the backend: token signing is not secret without it.');
}

// Session length follows the role. An ag_admin can read every operator's data, so their session
// is capped short; operator sessions stay long, because making a restocker sign in again every
// week is friction that buys nothing.
const TTL_AG_ADMIN_MS = 7 * 24 * 3600 * 1000;  // 7 days
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;    // 30 days — operators

function ttlFor(role) { return role === 'ag_admin' ? TTL_AG_ADMIN_MS : TOKEN_TTL_MS; }

/** Boolean-only view of the auth config, for GET /health. Never returns the secret itself. */
function authConfig() {
  return {
    jwtSecret: JWT_SECRET_SET,
    adminSessionDays: Math.round(TTL_AG_ADMIN_MS / 86400000),
    operatorSessionDays: Math.round(TOKEN_TTL_MS / 86400000),
  };
}

/** Constant-time string compare, so a signature check cannot be probed byte by byte. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─── Token creation / verification ────────────────────────────────────────────

function createToken(userId) {
  const issuedAt = Date.now();
  // The role is looked up here rather than passed in, so that no call site can hand an
  // AG Vending admin a 30-day session by forgetting an argument.
  const role = (users.find(u => u.id === userId) || {}).role;
  const expiresAt = issuedAt + ttlFor(role);
  const payload = JSON.stringify({ userId, iat: issuedAt, exp: expiresAt });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  const token = `${b64}.${sig}`;

  // Persist so the token survives Railway restarts
  try {
    storage.insertAuthToken(token, userId, expiresAt);
  } catch (e) {
    // Shouldn't happen — token is unique — but log just in case
    console.warn('[AUTH] Failed to persist token:', e.message);
  }
  // Also keep in the in-memory map for fast path (avoids one SQLite hit per request)
  authTokens.set(token, userId);
  return token;
}

function verifyToken(token) {
  if (!token) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp < Date.now()) return null;

    // Cryptographic signature checks out and payload says it's unexpired —
    // but the token might have been revoked or come from before the server was restarted
    // (in-memory map was wiped). Fall back to checking SQLite.
    if (!authTokens.has(token)) {
      const stored = storage.getAuthToken(token);
      if (!stored) return null; // unknown or expired/revoked
      // Re-cache in memory
      authTokens.set(token, stored.userId);
    }

    return payload.userId;
  } catch {
    return null;
  }
}

function revokeToken(token) {
  authTokens.delete(token);
  storage.deleteAuthToken(token);
}

function revokeAllForUser(userId) {
  // Clear from memory
  for (const [tok, uid] of authTokens.entries()) {
    if (uid === userId) authTokens.delete(tok);
  }
  storage.deleteUserTokens(userId);
}

// Periodic cleanup of expired tokens (every 6 hours)
setInterval(() => {
  try {
    storage.cleanupExpiredAuthTokens();
    // Also purge expired entries from the in-memory map
    const now = Date.now();
    for (const [tok] of authTokens.entries()) {
      const [b64] = tok.split('.');
      try {
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
        if (payload.exp < now) authTokens.delete(tok);
      } catch {
        authTokens.delete(tok);
      }
    }
  } catch (e) { console.warn('[AUTH] cleanup failed:', e.message); }
}, 6 * 3600 * 1000).unref();

// ─── Middleware ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = verifyToken(token);
  if (!userId) return json(res, 401, { error: 'Unauthorized' });
  const user = users.find(u => u.id === userId);
  if (!user) return json(res, 401, { error: 'User not found' });
  // Billing lever: a suspended operator's users are locked out everywhere
  // (AG Vending admins are never affected).
  if (user.role !== 'ag_admin' && user.operatorId) {
    const op = operators[user.operatorId];
    if (op && op.suspended) {
      return json(res, 403, { error: 'account_suspended', message: 'This account is suspended. Please contact AG Vending.' });
    }
  }
  // "View as operator" (AG only): the dashboard sends X-View-As-Operator and gets exactly what that
  // operator's admin would see — read-only. Anything but a read is refused here, before any route
  // runs, so no handler has to know about it.
  const viewAs = req.headers['x-view-as-operator'];
  if (viewAs && user.role === 'ag_admin') {
    const op = operators[viewAs];
    if (!op) return json(res, 400, { ok: false, error: 'unknown_operator' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 403, { ok: false, error: { code: 'view_only', message: 'Skoðunarhamur — ekki hægt að breyta.', messageEn: 'Viewing as an operator is read-only.' } });
    }
    req.user = { ...user, role: 'operator_admin', operatorId: op.id || viewAs, operatorName: op.name, viewingAs: true, realRole: user.role };
    return next();
  }
  // operator_viewer was never enforced as read-only; it now means restocker (roles.js).
  req.user = user.role === 'operator_viewer' ? { ...user, role: roles.normalizeRole(user.role) } : user;
  next();
}

/** Refuse unless the signed-in user's role allows [cap] (roles.js). The reason names the role. */
function requireCap(cap) {
  const mw = (req, res, next) => {
    if (roles.can(req.user, cap)) return next();
    const r = roles.roleInfo(req.user && req.user.role);
    return json(res, 403, { ok: false, code: 'role_forbidden', cap,
      error: `Your role (${r ? r.label : 'unknown'}) can't ${roles.CAP_TEXT[cap] || cap}.` });
  };
  mw.cap = cap;
  return mw;
}

/** Require AG Vending admin role. */
function requireAgAdmin(req, res, next) {
  if (req.user?.role !== 'ag_admin') {
    return json(res, 403, { error: 'Forbidden — AG Vending admin access required' });
  }
  next();
}

/** Require operator_admin OR ag_admin (for inviting users / editing operator). */
function requireOperatorAdmin(req, res, next) {
  const role = req.user?.role;
  if (role !== 'ag_admin' && role !== 'operator_admin') {
    return json(res, 403, { error: 'Forbidden — admin access required' });
  }
  next();
}

/** Require access to the machine identified by req.params.deviceCode. */
function requireMachineAccess(req, res, next) {
  if (!userCanAccessMachine(req.user, req.params.deviceCode)) {
    return json(res, 403, { error: 'Forbidden — you do not have access to this machine' });
  }
  next();
}

/** Require access to the operator identified by req.params.operatorId. */
function requireOperatorAccess(req, res, next) {
  if (!userCanAccessOperator(req.user, req.params.operatorId)) {
    return json(res, 403, { error: 'Forbidden — you do not have access to this operator' });
  }
  next();
}

/** Legacy — still used in some routes. */
function requireAdmin(req, res, next) { return requireAgAdmin(req, res, next); }

const KIOSK_SECRET = process.env.KIOSK_SECRET || 'kiosk-dev-secret';

function requireKioskAuth(req, res, next) {
  const secret = req.headers['x-kiosk-secret'];
  if (secret !== KIOSK_SECRET) return json(res, 401, { error: 'Unauthorized' });
  next();
}

module.exports = {
  createToken, verifyToken, revokeToken, revokeAllForUser, authConfig,
  requireAuth, requireAdmin, requireAgAdmin, requireOperatorAdmin,
  requireMachineAccess, requireOperatorAccess, requireKioskAuth, requireCap,
  KIOSK_SECRET,
};

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
