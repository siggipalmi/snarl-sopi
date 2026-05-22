/**
 * Auth helpers.
 * Uses simple signed tokens (HMAC-SHA256) since we can't npm install jsonwebtoken.
 * In production: replace with proper JWT library + bcrypt password hashing.
 */

const crypto = require('crypto');
const { authTokens, users } = require('./db');

const SECRET = process.env.JWT_SECRET || 'snudur-sopi-dev-secret-change-in-prod';

// ─── Token creation / verification ───────────────────────────────────────────

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

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Require a valid Authorization: Bearer <token> header.
 * Attaches req.user on success.
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = verifyToken(token);
  if (!userId) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  const user = users.find(u => u.id === userId);
  if (!user) return json(res, 401, { error: 'User not found' });
  req.user = user;
  next();
}

/**
 * Require super_admin role.
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'super_admin') {
    return json(res, 403, { error: 'Forbidden' });
  }
  next();
}

/**
 * Kiosk-to-backend auth: simple shared secret in X-Kiosk-Secret header.
 * The kiosk app will include this when calling /api/v1/kiosk/* endpoints.
 * In production: per-device signed tokens.
 */
const KIOSK_SECRET = process.env.KIOSK_SECRET || 'kiosk-dev-secret';

function requireKioskAuth(req, res, next) {
  const secret = req.headers['x-kiosk-secret'];
  if (secret !== KIOSK_SECRET) {
    return json(res, 401, { error: 'Unauthorized' });
  }
  next();
}

module.exports = { createToken, verifyToken, requireAuth, requireAdmin, requireKioskAuth };

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}
