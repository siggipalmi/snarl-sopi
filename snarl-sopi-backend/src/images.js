/**
 * Product image normalization.
 *
 * Every product image the fleet shows goes through here, so tiles are consistent
 * regardless of what the source looked like. Rules (agreed with the kiosk chat):
 *
 *  - Square canvas, PAD never CROP (cropping cuts off caps/tops of bottles).
 *  - Master size 800x800 — covers 3-col (~270px), 4-col (~190px) and 2x2 hero tiles
 *    on the 1080x1920 screen from a single asset.
 *  - Alpha preserved. Transparent source stays transparent (kiosk floats it on the
 *    pastel category tile); baked-in background is padded with white and flagged so
 *    the kiosk frames it on a white inner card.
 *  - `imageHasBackground` is auto-detected and returned, so the kiosk's two-mode tile
 *    logic renders the right mode without anyone hand-tagging images.
 *  - WebP output (smaller, alpha-capable).
 *  - Optional, OPT-IN white-background knockout. Deliberately not the default: it eats
 *    white parts of products (labels, foam, packaging) and there is no safe automatic
 *    way to tell "white background" from "white product".
 */

const MASTER = 800;
const WEBP_QUALITY = 88;

// A pixel counts as "background white" when every channel is at/above this.
const WHITE_THRESHOLD = 242;
// Fraction of border pixels that must be transparent to call the source transparent.
const TRANSPARENT_BORDER_RATIO = 0.5;

function sharpLib() { return require('sharp'); }

/**
 * Does this image carry a baked-in background, or is it cut out (transparent)?
 * We only inspect the BORDER: a product shot with a transparent background has
 * transparent edges, whatever is happening in the middle.
 */
async function detectHasBackground(buf) {
  const sharp = sharpLib();
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  if (!meta.hasAlpha) return true; // no alpha channel at all → definitely baked-in

  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (!width || !height) return true;

  let border = 0, transparent = 0;
  const at = (x, y) => data[(y * width + x) * channels + (channels - 1)]; // alpha byte
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) { border++; if (at(x, y) < 16) transparent++; }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) { border++; if (at(x, y) < 16) transparent++; }
  }
  if (!border) return true;
  return (transparent / border) < TRANSPARENT_BORDER_RATIO;
}

/**
 * Opt-in: make near-white pixels transparent.
 * Flood-fills inward from the edges so enclosed white areas (a label, a bottle cap
 * highlight) survive — only white CONNECTED TO THE BORDER is treated as background.
 */
async function knockoutWhiteBackground(buf, threshold = WHITE_THRESHOLD) {
  const sharp = sharpLib();
  const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const idx = (x, y) => (y * width + x) * channels;
  const isWhite = (x, y) => {
    const i = idx(x, y);
    return data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold && data[i + 3] > 16;
  };

  const seen = new Uint8Array(width * height);
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (seen[p]) return;
    seen[p] = 1;
    if (isWhite(x, y)) queue.push(p);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  let cleared = 0;
  while (queue.length) {
    const p = queue.pop();
    const x = p % width, y = (p - x) / width;
    data[idx(x, y) + 3] = 0; // punch alpha
    cleared++;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  const out = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  return { buffer: out, clearedPixels: cleared, totalPixels: width * height };
}

/**
 * Normalize one product image.
 *
 * @param {Buffer} input               source bytes (any format sharp reads)
 * @param {object} [opts]
 * @param {boolean} [opts.knockoutWhite=false]  opt-in white-background removal
 * @param {number}  [opts.size=800]             master square size
 * @returns {Promise<{buffer:Buffer, contentType:string, hasBackground:boolean,
 *                    size:number, bytes:number, knockedOut:boolean, note:string|null}>}
 */
async function normalizeProductImage(input, opts = {}) {
  const sharp = sharpLib();
  const size = Math.max(64, Math.min(Number(opts.size) || MASTER, 2048));
  if (!input || !input.length) throw new Error('empty image');

  let working = input;
  let knockedOut = false;
  let note = null;
  let clearedPct = null;

  // 1) Auto-orient from EXIF before anything measures pixels.
  working = await sharp(working, { failOn: 'none' }).rotate().toBuffer();

  // 2) Optional knockout (before trim, so the freed border gets trimmed away).
  if (opts.knockoutWhite) {
    try {
      const ko = await knockoutWhiteBackground(working, opts.threshold);
      const pct = ko.clearedPixels / ko.totalPixels;
      // Guard: if it ate almost everything, the "background" wasn't background.
      if (pct > 0.92) {
        note = 'knockout skipped — would have removed almost the whole image';
      } else {
        working = ko.buffer;
        knockedOut = true;
        clearedPct = Math.round(pct * 1000) / 10;
        // A white product on a white background can't be distinguished from its
        // backdrop by any threshold — flag heavy clears so a human can eyeball them.
        if (pct > 0.82) note = 'cleared ' + clearedPct + '% — check the product is intact';
      }
    } catch (e) { note = 'knockout failed (' + e.message + ') — kept original background'; }
  }

  // 3) Detect background mode AFTER knockout (knockout changes the answer).
  const hasBackground = await detectHasBackground(working);

  // 4) Trim uniform border, then pad to an exact square. Never crop.
  //    Pad colour matches the mode: white card for baked-in, transparent for cut-out.
  const pad = hasBackground ? { r: 255, g: 255, b: 255, alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 };
  let pipeline = sharp(working, { failOn: 'none' }).ensureAlpha();
  try {
    // trim() throws on an image that is entirely one colour — tolerate that.
    pipeline = sharp(await pipeline.trim({ threshold: 12 }).toBuffer(), { failOn: 'none' }).ensureAlpha();
  } catch (e) { pipeline = sharp(working, { failOn: 'none' }).ensureAlpha(); }

  const buffer = await pipeline
    .resize(size, size, { fit: 'contain', background: pad, withoutEnlargement: false })
    .webp({ quality: WEBP_QUALITY, alphaQuality: 100 })
    .toBuffer();

  return { buffer, contentType: 'image/webp', hasBackground, size, bytes: buffer.length, knockedOut, clearedPct, note };
}

module.exports = { normalizeProductImage, detectHasBackground, knockoutWhiteBackground, MASTER };
