/**
 * Password hashing (Siggi, 2026-10-22, after the Railway breach: "Yes hash").
 *
 * scrypt from Node's own crypto, so no new dependency. Stored as
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 * so the cost can be raised later without breaking old hashes.
 *
 * Accounts created before this still hold their password as typed. verifyPassword accepts those,
 * and the sign-in handler replaces them with a hash on the user's next successful sign-in.
 */
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, KEYLEN = 64;   // ~50 ms on Railway; sign-in is rate-limited anyway

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(stored, plain) {
  if (typeof stored !== 'string' || typeof plain !== 'string' || !stored) return false;
  if (!isHashed(stored)) {
    // Not yet migrated. Compare in constant time over equal-length digests.
    const a = crypto.createHash('sha256').update(stored).digest();
    const b = crypto.createHash('sha256').update(plain).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let got;
  try {
    got = crypto.scryptSync(plain, Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch (e) { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { hashPassword, verifyPassword, isHashed };
