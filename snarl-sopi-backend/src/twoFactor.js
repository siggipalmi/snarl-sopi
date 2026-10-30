/**
 * The sign-in half of two-factor: the step between password and session, and the browser that
 * gets to skip it for a week.
 *
 * src/totp.js is the algorithm. This is the policy around it — challenges, replay, recovery
 * codes, trusted devices — kept out of router.js because it is the part worth reading on its own.
 *
 * Shape of a sign-in with 2FA on:
 *   POST /auth/login            → { needsTotp: true, challenge }   (no session yet)
 *   POST /auth/login/totp       → { token, user, deviceToken? }
 *
 * A challenge proves only that the password was right a moment ago. It lives in memory and dies
 * after five minutes or on a restart, which costs the person one retyped password and means a
 * half-finished sign-in is never durable state.
 */

const crypto = require('crypto');
const storage = require('./storage');
const totp = require('./totp');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TRUST_TTL_MS = 7 * 24 * 3600 * 1000;   // the same week an ag_admin session lasts
const RECOVERY_CODE_COUNT = 8;

// ─── Challenges ───────────────────────────────────────────────────────────────

const _challenges = new Map();   // id → { userId, expiresAt }

function sweepChallenges(now = Date.now()) {
  for (const [id, c] of _challenges) if (c.expiresAt < now) _challenges.delete(id);
}

function issueChallenge(userId) {
  sweepChallenges();
  const id = crypto.randomBytes(32).toString('base64url');
  _challenges.set(id, { userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return id;
}

/** The user this challenge stands for, or null if it is unknown or stale. */
function readChallenge(id) {
  if (!id) return null;
  const c = _challenges.get(String(id));
  if (!c) return null;
  if (c.expiresAt < Date.now()) { _challenges.delete(String(id)); return null; }
  return c.userId;
}

function consumeChallenge(id) { _challenges.delete(String(id)); }

// ─── Status ───────────────────────────────────────────────────────────────────

/** True once the user has set 2FA up AND proved they can read a code from it. */
function isEnabled(userId) {
  const row = storage.getTotp(userId);
  return !!(row && row.confirmedAt);
}

function status(userId) {
  const row = storage.getTotp(userId);
  const codes = storage.listRecoveryCodes(userId);
  return {
    enabled: !!(row && row.confirmedAt),
    pending: !!(row && !row.confirmedAt),
    enabledAt: row && row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
    recoveryCodesLeft: codes.filter(c => !c.usedAt).length,
    recoveryCodesTotal: codes.length,
    trustedDevices: storage.listTrustedDevices(userId).filter(d => d.expiresAt > Date.now()).length,
  };
}

// ─── Enrolment ────────────────────────────────────────────────────────────────

/**
 * Begin setup. Replaces any unconfirmed attempt, so a half-scanned QR can simply be redone.
 * Nothing about signing in changes until confirm() succeeds.
 */
function beginSetup(user) {
  const secret = totp.generateSecret();
  storage.startTotpSetup(user.id, secret);
  return {
    secret,
    secretFormatted: totp.formatSecret(secret),
    otpauthUri: totp.otpauthUri(secret, user.email),
  };
}

/**
 * Finish setup by proving a code can be read off the app. Returns the recovery codes, which is
 * the only time they exist in the clear.
 */
function confirmSetup(userId, code) {
  const row = storage.getTotp(userId);
  if (!row) return { ok: false, error: 'no_setup_in_progress' };
  if (row.confirmedAt) return { ok: false, error: 'already_enabled' };

  const step = totp.verify(row.secret, code);
  if (step === null) return { ok: false, error: 'bad_code' };

  storage.confirmTotp(userId, step);
  const codes = totp.generateRecoveryCodes(RECOVERY_CODE_COUNT);
  storage.replaceRecoveryCodes(userId, codes.map(totp.hashRecoveryCode));
  return { ok: true, recoveryCodes: codes };
}

/** Fresh recovery codes, invalidating the old set. Needs a current code to prove it is them. */
function regenerateRecoveryCodes(userId, code) {
  const check = checkCode(userId, code, { allowRecovery: false });
  if (!check.ok) return check;
  const codes = totp.generateRecoveryCodes(RECOVERY_CODE_COUNT);
  storage.replaceRecoveryCodes(userId, codes.map(totp.hashRecoveryCode));
  return { ok: true, recoveryCodes: codes };
}

/** Turn it off. Also drops the recovery codes and every trusted device. */
function disable(userId) {
  storage.disableTotp(userId);
}

// ─── Checking a code ──────────────────────────────────────────────────────────

/**
 * Check a code from the app, or a recovery code if allowed.
 *
 * A code is good for one use: the step it matched is recorded, and anything at or below that
 * step is refused afterwards, so someone who reads a code over a shoulder cannot spend it
 * again within its own 30 seconds.
 */
function checkCode(userId, code, { allowRecovery = true } = {}) {
  const row = storage.getTotp(userId);
  if (!row || !row.confirmedAt) return { ok: false, error: 'not_enabled' };

  const step = totp.verify(row.secret, code, { afterStep: row.lastStep });
  if (step !== null) {
    storage.setTotpStep(userId, step);
    return { ok: true, via: 'totp' };
  }

  if (allowRecovery) {
    const normalised = totp.normaliseRecoveryCode(code);
    if (normalised.length >= 6) {
      for (const stored of storage.listRecoveryCodes(userId)) {
        if (stored.usedAt) continue;
        if (!totp.recoveryCodeMatches(normalised, stored.codeHash)) continue;
        // spendRecoveryCode is the atomic bit: it only reports success for the call that
        // actually flipped usedAt, so the same code presented twice at once spends once.
        if (!storage.spendRecoveryCode(stored.id)) break;
        const left = storage.listRecoveryCodes(userId).filter(c => !c.usedAt).length;
        return { ok: true, via: 'recovery', recoveryCodesLeft: left };
      }
    }
  }

  return { ok: false, error: 'bad_code' };
}

// ─── Trusted devices ──────────────────────────────────────────────────────────
//
// The token handed to the browser is "<id>.<secret>". Only sha256(secret) is stored, so a copy
// of the table does not let anyone skip the code — the same reason the machine keys are hashed.

function hashDeviceSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function trustDevice(userId, label) {
  const id = crypto.randomBytes(12).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  storage.insertTrustedDevice({
    id, userId, tokenHash: hashDeviceSecret(secret),
    label: (label || '').slice(0, 120) || null,
    expiresAt: Date.now() + TRUST_TTL_MS,
  });
  return { deviceToken: id + '.' + secret, expiresAt: Date.now() + TRUST_TTL_MS };
}

/** Does this browser get to skip the code? Touches the row when it does. */
function deviceIsTrusted(userId, deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string') return false;
  const dot = deviceToken.indexOf('.');
  if (dot < 1) return false;
  const id = deviceToken.slice(0, dot), secret = deviceToken.slice(dot + 1);

  const row = storage.getTrustedDevice(id);
  if (!row || row.userId !== userId) return false;
  if (row.expiresAt < Date.now()) return false;

  const got = Buffer.from(hashDeviceSecret(secret));
  const want = Buffer.from(String(row.tokenHash));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;

  storage.touchTrustedDevice(id);
  return true;
}

function listTrustedDevices(userId) {
  const now = Date.now();
  return storage.listTrustedDevices(userId)
    .filter(d => d.expiresAt > now)
    .map(d => ({
      id: d.id, label: d.label || 'Óþekkt tæki',
      createdAt: new Date(d.createdAt).toISOString(),
      lastUsedAt: d.lastUsedAt ? new Date(d.lastUsedAt).toISOString() : null,
      expiresAt: new Date(d.expiresAt).toISOString(),
    }));
}

function forgetDevice(userId, id) { return storage.deleteTrustedDevice(id, userId); }
function forgetAllDevices(userId) { storage.deleteUserTrustedDevices(userId); }

// Expired rows are harmless (every read checks expiresAt) but there is no reason to keep them.
setInterval(() => {
  try { storage.cleanupExpiredTrustedDevices(); sweepChallenges(); }
  catch (e) { console.warn('[2FA] cleanup failed:', e.message); }
}, 6 * 3600 * 1000).unref();

module.exports = {
  CHALLENGE_TTL_MS, TRUST_TTL_MS, RECOVERY_CODE_COUNT,
  issueChallenge, readChallenge, consumeChallenge,
  isEnabled, status,
  beginSetup, confirmSetup, regenerateRecoveryCodes, disable,
  checkCode,
  trustDevice, deviceIsTrusted, listTrustedDevices, forgetDevice, forgetAllDevices,
};
