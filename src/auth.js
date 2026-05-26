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
const { authTokens, users, machines, userCanAccessMachine, userCanAccessOperator,
        userCanInviteTo, userCanReassignWithin } = require('./db');

const SECRET = process.env.JWT_SECRET || 'snudur-sopi-dev-secret-change-in-prod';

// ─── Token creation / verification ────────────────────────────────────────────

function createToken(userId) {
  const payload = JSON.stringify({ userId, iat: Date.now(), exp: Date.now() + 8 * 3600 * 1000 });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  const token = `${b64}.${sig}`;
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
    return payload.userId;
  } catch {
    return null;
  }
}

// ─── Middleware ────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = verifyToken(token);
  if (!userId) return json(res, 401, { error: 'Unauthorized' });
  const user = users.find(u => u.id === userId);
  if (!user) return json(res, 401, { error: 'User not found' });
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
  createToken, verifyToken,
  requireAuth, requireAdmin, requireAgAdmin, requireOperatorAdmin,
  requireMachineAccess, requireOperatorAccess, requireKioskAuth,
  KIOSK_SECRET,
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}
