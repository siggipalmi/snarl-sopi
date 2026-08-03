/**
 * Auth helpers + permission middleware.
 *
 * Roles:
 *   ag_admin         — AG Vending users, full access
 *   operator_admin   — manage own operator, invite staff, edit machines
 *   operator_manager — edit assigned machines, view sales
 *   operator_viewer  — read-only
 */

const crypto = require('crypto');
const storage = require('./storage');
const { authTokens, users, machines, operators, userCanAccessMachine, userCanAccessOperator,
        userCanInviteTo, userCanReassignWithin } = require('./db');

const SECRET = process.env.JWT_SECRET || 'snudur-sopi-dev-secret-change-in-prod';

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// ─── Token creation / verification ────────────────────────────────────────────

function createToken(userId) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + TOKEN_TTL_MS;
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
  if (expected !== sig) return null;
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
  req.user = user;
  next();
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
  createToken, verifyToken, revokeToken, revokeAllForUser,
  requireAuth, requireAdmin, requireAgAdmin, requireOperatorAdmin,
  requireMachineAccess, requireOperatorAccess, requireKioskAuth,
  KIOSK_SECRET,
};

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
