/**
 * The enrolment QR actually scans.
 *
 * A QR code that looks right and does not decode is a support call on the one day you are trying
 * to lock the place down, and nothing about an SVG full of black squares tells you by eye which
 * one you have. So the code is generated with `qrcode`, rasterised with sharp, and decoded with
 * jsQR — a separate implementation by different authors, so a bug would have to exist in both to
 * get past this.
 */

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const jsQR = require('jsqr').default || require('jsqr');

const totp = require('../src/totp');

/** Render an SVG QR to pixels and read it back. */
async function decode(svg, size = 500) {
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(size, size, { kernel: 'nearest' })   // nearest keeps the module edges hard
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const result = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return result && result.data;
}

test('the enrolment QR decodes to the otpauth URI it was made from', async () => {
  // Built the same way beginSetup builds it, without needing a database.
  const QRCode = require('qrcode');
  const secret = totp.generateSecret();
  const uri = totp.otpauthUri(secret, 'siggip@agvending.is');
  const svg = await QRCode.toString(uri, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#FFFFFF' },
  });

  const decoded = await decode(svg);
  assert.strictEqual(decoded, uri, 'the QR must decode to exactly the URI');

  // And the decoded URI must still carry a working secret, not merely the right characters.
  const u = new URL(decoded);
  const scanned = u.searchParams.get('secret');
  assert.strictEqual(scanned, secret);
  const code = totp.currentCode(scanned);
  assert.strictEqual(totp.verify(secret, code), totp.stepFor(),
    'a code from the scanned secret must verify against the stored one');
});

test('it still decodes at the size the dashboard shows it', async () => {
  const QRCode = require('qrcode');
  const uri = totp.otpauthUri(totp.generateSecret(), 'siggip@agvending.is');
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  // 132 px is the box in the mockup; 264 is the same at 2x.
  for (const size of [132, 264]) {
    assert.strictEqual(await decode(svg, size), uri, 'should decode at ' + size + 'px');
  }
});

test('a long account name still produces a scannable code', async () => {
  const QRCode = require('qrcode');
  const uri = totp.otpauthUri(totp.generateSecret(),
    'a.fairly.long.operator.address@a-long-domain-name.example.is');
  const svg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  assert.strictEqual(await decode(svg, 600), uri);
});
