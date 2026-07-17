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
 * Sample the border and work out what the backdrop actually IS.
 *
 * Assuming "the background is pure white" is why knockout used to be hit-and-miss:
 * real packshots sit on cream, off-white, light grey, or JPEG-noisy backdrops, and a
 * fixed white threshold either seeds nothing (image comes back untouched) or has to be
 * loosened so far it eats pale products. So: measure the backdrop, then clear THAT.
 *
 * Returns { color:[r,g,b], uniformity, uniform } — uniformity is the fraction of border
 * pixels close to the median, so a photographic backdrop scores low and we can say so
 * instead of mangling the image.
 */
function analyzeBorder(data, width, height, channels, tolerance) {
  const px = (x, y) => { const i = (y * width + x) * channels; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
  const samples = [];
  const stepX = Math.max(1, Math.floor(width / 200));
  const stepY = Math.max(1, Math.floor(height / 200));
  for (let x = 0; x < width; x += stepX) { samples.push(px(x, 0)); samples.push(px(x, height - 1)); }
  for (let y = 0; y < height; y += stepY) { samples.push(px(0, y)); samples.push(px(width - 1, y)); }
  const opaque = samples.filter(s => s[3] > 16);
  if (!opaque.length) return { color: null, uniformity: 1, uniform: true, transparent: true };

  const med = (idx) => {
    const v = opaque.map(s => s[idx]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const color = [med(0), med(1), med(2)];
  const near = opaque.filter(s => dist(s, color) <= tolerance).length;
  const uniformity = near / opaque.length;
  return { color, uniformity, uniform: uniformity >= 0.7, transparent: false };
}

function dist(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Remove the backdrop by flood-filling inward from the edges, clearing pixels close to
 * the measured border colour. Only backdrop CONNECTED TO THE EDGE goes, so a white label
 * or a cap highlight enclosed by the product survives.
 *
 * Edge pixels get soft alpha (distance-proportional) so the cut-out doesn't come out
 * with a hard jaggy outline against the kiosk's tile colour.
 */
async function knockoutBackground(buf, opts = {}) {
  const sharp = sharpLib();
  const tolerance = Math.max(8, Math.min(Number(opts.tolerance) || 34, 90));
  const { data, info } = await sharp(buf, { failOn: 'none' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  const border = analyzeBorder(data, width, height, channels, tolerance);
  if (border.transparent) return { buffer: buf, clearedPixels: 0, totalPixels: width * height, uniform: true, alreadyTransparent: true, bgColor: null, uniformity: 1 };
  if (!border.uniform) {
    // Photographic / gradient / busy backdrop — no threshold can separate it safely.
    return { buffer: buf, clearedPixels: 0, totalPixels: width * height, uniform: false, bgColor: border.color, uniformity: border.uniformity };
  }

  const bg = border.color;
  const idx = (x, y) => (y * width + x) * channels;
  const isBg = (x, y) => {
    const i = idx(x, y);
    if (data[i + 3] <= 16) return false;                       // already transparent
    return dist([data[i], data[i + 1], data[i + 2]], bg) <= tolerance;
  };
  // Soft band: pixels a bit beyond tolerance get partial alpha rather than a hard edge.
  const softBand = tolerance * 1.6;

  const seen = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (seen[p]) return;
    seen[p] = 1;
    if (isBg(x, y)) stack.push(p);
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  let cleared = 0;
  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p - x) / width;
    data[idx(x, y) + 3] = 0;
    cleared++;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  // Feather: any still-opaque pixel touching a cleared one, and close-ish to the
  // backdrop colour, gets proportional alpha — kills the halo/jaggies.
  const touchesCleared = (x, y) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (data[idx(nx, ny) + 3] === 0) return true;
    }
    return false;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y);
      if (data[i + 3] === 0) continue;
      const d = dist([data[i], data[i + 1], data[i + 2]], bg);
      if (d < softBand && touchesCleared(x, y)) {
        const a = Math.max(0, Math.min(1, (d - tolerance) / (softBand - tolerance)));
        data[i + 3] = Math.round(data[i + 3] * a);
      }
    }
  }

  const out = await sharp(data, { raw: { width, height, channels } }).png().toBuffer();
  return { buffer: out, clearedPixels: cleared, totalPixels: width * height, uniform: true, bgColor: bg, uniformity: border.uniformity };
}

// Back-compat alias.
const knockoutWhiteBackground = (buf, threshold) => knockoutBackground(buf, { tolerance: threshold ? (255 - threshold) * 2.2 : undefined });

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
  let uniform = true;
  let bgColor = null;

  // 1) Auto-orient from EXIF before anything measures pixels.
  working = await sharp(working, { failOn: 'none' }).rotate().toBuffer();

  // 2) Optional knockout (before trim, so the freed border gets trimmed away).
  if (opts.knockoutWhite) {
    try {
      const ko = await knockoutBackground(working, { tolerance: opts.tolerance });
      const pct = ko.clearedPixels / ko.totalPixels;
      if (ko.alreadyTransparent) {
        note = 'already transparent — nothing to remove';
      } else if (!ko.uniform) {
        // Measured the border and it isn't a flat backdrop: a photo, a gradient, a scene.
        // Say so plainly instead of silently returning the image unchanged.
        note = 'background is not a flat colour (photo or gradient) — needs a replacement image';
        uniform = false;
      } else if (pct > 0.92) {
        note = 'knockout skipped — would have removed almost the whole image';
      } else if (pct < 0.02) {
        note = 'nothing removed — the product fills the frame, or it touches the edges';
      } else {
        working = ko.buffer;
        knockedOut = true;
        clearedPct = Math.round(pct * 1000) / 10;
        bgColor = ko.bgColor;
        // A pale product on a pale backdrop can't be told apart by any tolerance —
        // flag heavy clears so a human can eyeball them.
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

  return { buffer, contentType: 'image/webp', hasBackground, size, bytes: buffer.length, knockedOut, clearedPct, uniform, bgColor, note };
}

module.exports = { normalizeProductImage, detectHasBackground, knockoutBackground, knockoutWhiteBackground, analyzeBorder, MASTER };
