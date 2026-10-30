/**
 * TOTP against the vectors published in RFC 6238 Appendix B.
 *
 * These are the numbers in the standard, so matching them means the implementation agrees with
 * every authenticator app rather than merely agreeing with itself. The published table is
 * 8 digits; the product uses 6, which is the same value truncated, and both are checked.
 */

const test = require('node:test');
const assert = require('node:assert');
const totp = require('../src/totp');

// RFC 6238 uses the ASCII secret "12345678901234567890" for the SHA-1 vectors.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

// time (seconds since epoch) → the 8-digit code in the RFC's SHA-1 column
const VECTORS = [
  [59,          '94287082'],
  [1111111109,  '07081804'],
  [1111111111,  '14050471'],
  [1234567890,  '89005924'],
  [2000000000,  '69279037'],
  [20000000000, '65353130'],
];

test('base32 round-trips, and decodes what a person might type', () => {
  const buf = Buffer.from('12345678901234567890', 'ascii');
  assert.deepStrictEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  // The RFC's secret, as the standard prints its base32 form.
  assert.strictEqual(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  // Lowercase, spaces and padding all have to survive, because people retype these by hand.
  const key = 'JBSWY3DPEHPK3PXP';
  assert.deepStrictEqual(totp.base32Decode('jbsw y3dp ehpk 3pxp'), totp.base32Decode(key));
  assert.deepStrictEqual(totp.base32Decode(key + '='), totp.base32Decode(key));
  assert.throws(() => totp.base32Decode('not-base32!'), /not base32/);
});

test('RFC 6238 Appendix B vectors, 8 digits', () => {
  for (const [seconds, expected] of VECTORS) {
    const step = totp.stepFor(seconds * 1000);
    assert.strictEqual(totp.codeForStep(RFC_SECRET, step, 8), expected,
      'at t=' + seconds + ' the RFC says ' + expected);
  }
});

test('the product\'s 6 digits are the same vectors truncated', () => {
  for (const [seconds, expected] of VECTORS) {
    assert.strictEqual(totp.currentCode(RFC_SECRET, seconds * 1000), expected.slice(-6));
  }
});

test('the counter is big-endian 64-bit, so it still works past 2038', () => {
  // t=20000000000 is the year 2603 and is the RFC's own check that the counter is 64-bit.
  // A 32-bit shift would have overflowed and produced a different code.
  assert.strictEqual(totp.currentCode(RFC_SECRET, 20000000000 * 1000), '353130');
});

test('verify accepts the current code and returns the step it matched', () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  const step = totp.stepFor(now);
  assert.strictEqual(totp.verify(secret, totp.currentCode(secret, now), { nowMs: now }), step);
});

test('verify tolerates one step of clock drift either way, and no more', () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  const step = totp.stepFor(now);

  for (const drift of [-1, 0, 1]) {
    const code = totp.codeForStep(secret, step + drift);
    assert.strictEqual(totp.verify(secret, code, { nowMs: now }), step + drift,
      drift + ' step(s) away should be accepted');
  }
  for (const drift of [-2, 2, 10]) {
    const code = totp.codeForStep(secret, step + drift);
    assert.strictEqual(totp.verify(secret, code, { nowMs: now }), null,
      drift + ' step(s) away should be refused');
  }
});

test('a spent code cannot be used again inside its own window', () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  const code = totp.currentCode(secret, now);
  const step = totp.verify(secret, code, { nowMs: now });
  assert.strictEqual(typeof step, 'number');
  // Second presentation, same 30 seconds, with the step recorded as spent.
  assert.strictEqual(totp.verify(secret, code, { nowMs: now, afterStep: step }), null);
  // The next step's code is still fine.
  const next = totp.codeForStep(secret, step + 1);
  assert.strictEqual(totp.verify(secret, next, { nowMs: now + 30000, afterStep: step }), step + 1);
});

test('verify refuses anything that is not six digits', () => {
  const secret = totp.generateSecret();
  for (const bad of ['', null, undefined, '12345', '1234567', 'abcdef', '12 34 56 ', '０１２３４５']) {
    assert.strictEqual(totp.verify(secret, bad), null, JSON.stringify(bad) + ' should be refused');
  }
  // A code with ordinary spaces in it is a person typing, and should work.
  const now = Date.now();
  const code = totp.currentCode(secret, now);
  assert.strictEqual(typeof totp.verify(secret, code.slice(0, 3) + ' ' + code.slice(3),
    { nowMs: now }), 'number');
});

test('a wrong code is refused', () => {
  const secret = totp.generateSecret();
  const now = Date.now();
  const right = totp.currentCode(secret, now);
  // Walk to a value that is definitely not in the accepted window.
  let wrong = String((Number(right) + 1) % 1000000).padStart(6, '0');
  while (totp.verify(secret, wrong, { nowMs: now }) !== null) {
    wrong = String((Number(wrong) + 1) % 1000000).padStart(6, '0');
  }
  assert.strictEqual(totp.verify(secret, wrong, { nowMs: now }), null);
});

test('a code from one secret does not work against another', () => {
  const a = totp.generateSecret(), b = totp.generateSecret();
  const now = Date.now();
  assert.strictEqual(totp.verify(b, totp.currentCode(a, now), { nowMs: now }), null);
});

test('secrets are 160-bit and distinct', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const s = totp.generateSecret();
    assert.strictEqual(totp.base32Decode(s).length, 20, '20 bytes, per RFC 4226 §4');
    seen.add(s);
  }
  assert.strictEqual(seen.size, 50, 'no repeats');
});

test('the otpauth URI carries what an authenticator app reads', () => {
  const secret = totp.generateSecret();
  const uri = totp.otpauthUri(secret, 'siggip@agvending.is');
  const u = new URL(uri);
  assert.strictEqual(u.protocol, 'otpauth:');
  assert.strictEqual(u.host, 'totp');
  assert.strictEqual(decodeURIComponent(u.pathname), '/AG Vending:siggip@agvending.is');
  assert.strictEqual(u.searchParams.get('secret'), secret);
  assert.strictEqual(u.searchParams.get('issuer'), 'AG Vending');
  assert.strictEqual(u.searchParams.get('digits'), '6');
  assert.strictEqual(u.searchParams.get('period'), '30');
  assert.strictEqual(u.searchParams.get('algorithm'), 'SHA1');
});

test('the displayed secret is grouped but decodes the same', () => {
  const secret = totp.generateSecret();
  const shown = totp.formatSecret(secret);
  assert.match(shown, /^([2-7A-Z]{4} )+[2-7A-Z]{1,4}$/);
  assert.deepStrictEqual(totp.base32Decode(shown), totp.base32Decode(secret));
});

// ─── Recovery codes ───────────────────────────────────────────────────────────

test('recovery codes avoid the characters people misread', () => {
  const codes = totp.generateRecoveryCodes(40);
  assert.strictEqual(codes.length, 40);
  assert.strictEqual(new Set(codes).size, 40, 'no repeats');
  for (const c of codes) {
    assert.match(c, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/, c);
    assert.ok(!/[IO01]/.test(c), c + ' contains a character that gets misread');
  }
});

test('a recovery code matches its hash however it is typed back', () => {
  const [code] = totp.generateRecoveryCodes(1);
  const stored = totp.hashRecoveryCode(code);
  for (const variant of [code, code.toLowerCase(), code.replace('-', ''),
                         ' ' + code + ' ', code.replace('-', ' ')]) {
    assert.ok(totp.recoveryCodeMatches(variant, stored), JSON.stringify(variant));
  }
});

test('a different recovery code does not match, and the hash is not the code', () => {
  const [a, b] = totp.generateRecoveryCodes(2);
  const stored = totp.hashRecoveryCode(a);
  assert.ok(!totp.recoveryCodeMatches(b, stored));
  assert.ok(!totp.recoveryCodeMatches('', stored));
  assert.ok(!stored.includes(totp.normaliseRecoveryCode(a)), 'stored hash must not contain the code');
  assert.strictEqual(stored.length, 64, 'sha256 hex');
});
