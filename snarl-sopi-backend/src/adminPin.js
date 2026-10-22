/**
 * Per-machine kiosk admin PIN (security review, 2026-10-22: "3) Yes").
 *
 * Every fridge used the same 123456 to reach the admin sheet (pairing, restart, leaving the app).
 * Now AG generates a PIN per machine. Only a PBKDF2 hash goes to the machine, inside its own config,
 * so the kiosk can check a PIN offline. The hash never goes to the dashboard: a 6-digit PIN is a
 * million guesses, which a leaked hash would not survive.
 *
 * Stored in schema_meta as adminpin:<deviceCode> = { algo, iter, salt, hash, setAt, setBy }.
 * The fridge app (0.69.0+) checks it with PBKDF2WithHmacSHA256 and the same parameters.
 */
const crypto = require('crypto');

const ITER = 50000, KEYLEN = 32;

function hashPin(pin, salt = crypto.randomBytes(16), iter = ITER) {
  const hash = crypto.pbkdf2Sync(String(pin), salt, iter, KEYLEN, 'sha256');
  return { algo: 'pbkdf2-sha256', iter, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function verifyPin(rec, pin) {
  if (!rec || rec.algo !== 'pbkdf2-sha256') return false;
  const want = Buffer.from(rec.hash, 'base64');
  const got = crypto.pbkdf2Sync(String(pin), Buffer.from(rec.salt, 'base64'), rec.iter, want.length, 'sha256');
  return crypto.timingSafeEqual(got, want);
}

// Six random digits, never the old shared code or an obvious one (111111, 123456, 654321…).
function newPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (/^(\d)\1{5}$/.test(pin)) continue;
    if ('0123456789012345'.includes(pin) || '9876543210987654'.includes(pin)) continue;
    return pin;
  }
}

module.exports = { hashPin, verifyPin, newPin };
