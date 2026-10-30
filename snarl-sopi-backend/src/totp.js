/**
 * TOTP (RFC 6238) and recovery codes, on node's crypto alone.
 *
 * No dependency: the whole algorithm is an HMAC over a time counter, and a package here would be
 * one more thing to keep patched for the sake of forty lines. Verified in test/totp.test.js
 * against the test vectors printed in RFC 6238 Appendix B, so "it seems to work with my phone"
 * is not what this rests on.
 *
 * Authenticator apps (Google Authenticator, 1Password, Authy) expect:
 *   - a base32 secret, RFC 4648, no padding
 *   - SHA-1, a 30-second step and 6 digits — the defaults, which they do not all let you change
 */

const crypto = require('crypto');

const DIGITS = 6;
const STEP_S = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ─── base32, RFC 4648 ─────────────────────────────────────────────────────────

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  // Accept what a person might type: lowercase, spaces, and the padding we never emit.
  const clean = String(str).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('not base32: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── The code itself ──────────────────────────────────────────────────────────

/** The counter value for a moment in time. Exposed so replay can be pinned to a step. */
function stepFor(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_S);
}

/**
 * The code for one counter value. `digits` is 6 everywhere in the product; the parameter exists
 * because RFC 6238's published vectors are 8 digits, and a test that cannot reproduce them
 * verifies nothing.
 */
function codeForStep(secretB32, step, digits = DIGITS) {
  const key = base32Decode(secretB32);
  const counter = Buffer.alloc(8);
  // Big-endian 64-bit. writeBigUInt64BE keeps this exact past 2038 and avoids the
  // sign trouble of shifting a 32-bit number.
  counter.writeBigUInt64BE(BigInt(step));

  const mac = crypto.createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks the offset.
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16)
            | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The code a phone is showing right now. */
function currentCode(secretB32, nowMs = Date.now()) {
  return codeForStep(secretB32, stepFor(nowMs));
}

/**
 * Check a typed code.
 *
 * Returns the step it matched, or null. The step matters: the caller stores the last step a
 * user spent and refuses anything at or below it, so a code read over someone's shoulder
 * cannot be used again inside its own 30 seconds.
 *
 * `window` of 1 accepts the neighbouring steps, which covers a phone clock off by a few
 * seconds and the person who starts typing as the code rolls over. It widens the guessing
 * surface from one code to three — 3 in a million per try, against a limit of ten tries.
 */
function verify(secretB32, token, { window = 1, nowMs = Date.now(), afterStep = -1 } = {}) {
  const typed = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;

  const now = stepFor(nowMs);
  for (let drift = -window; drift <= window; drift++) {
    const step = now + drift;
    if (step <= afterStep) continue;              // already spent
    const expected = codeForStep(secretB32, step);
    // Both sides are 6 ASCII digits, so lengths always match here.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return step;
  }
  return null;
}

// ─── Enrolment ────────────────────────────────────────────────────────────────

/** A fresh secret. 20 bytes is what RFC 4226 §4 requires as a minimum and what apps expect. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Grouped into fours, for someone typing it in by hand off the screen. */
function formatSecret(secretB32) {
  return String(secretB32).replace(/(.{4})/g, '$1 ').trim();
}

/**
 * The otpauth:// URI behind the QR code. The label carries the issuer twice, once in the path
 * and once as a parameter, which is what the apps actually read.
 */
function otpauthUri(secretB32, account, issuer = 'AG Vending') {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  const q = new URLSearchParams({
    secret: secretB32, issuer, algorithm: 'SHA1',
    digits: String(DIGITS), period: String(STEP_S),
  });
  return 'otpauth://totp/' + label + '?' + q.toString();
}

// ─── Recovery codes ───────────────────────────────────────────────────────────

/**
 * Codes for the day the phone is lost. Shown once, stored only as hashes.
 *
 * Crockford-ish alphabet: no I, O, 0 or 1, because these get read off paper and typed back by
 * someone who is already having a bad day.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (const byte of crypto.randomBytes(8)) s += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    codes.push(s.slice(0, 4) + '-' + s.slice(4, 8));
  }
  return codes;
}

function normaliseRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Hash for storage. A recovery code has ~40 bits of entropy from a 32-character alphabet, so
 * unlike a password it does not need a slow KDF to resist guessing — but it is still a
 * credential at rest, so it is never stored in the clear.
 */
function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(normaliseRecoveryCode(code)).digest('hex');
}

function recoveryCodeMatches(code, storedHash) {
  const got = Buffer.from(hashRecoveryCode(code));
  const want = Buffer.from(String(storedHash || ''));
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

module.exports = {
  DIGITS, STEP_S,
  base32Encode, base32Decode,
  stepFor, codeForStep, currentCode, verify,
  generateSecret, formatSecret, otpauthUri,
  generateRecoveryCodes, normaliseRecoveryCode, hashRecoveryCode, recoveryCodeMatches,
};
