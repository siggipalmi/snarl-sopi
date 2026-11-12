'use strict';
/**
 * The planogram a Kiosk-catalog machine sells from (6.116.0).
 *
 * The layout blob (`layout:<deviceCode>` in meta) has always been the dashboard's picture of a
 * machine: layers of bays, each with a product, price, capacity and count. Until now Weimi wrote
 * it (every sync) and the kiosk never read it — the kiosk took its catalog from Weimi's cloud
 * directly. With `catalogSource = 'kiosk'` the roles flip: this blob is the catalog, the kiosk
 * receives it in its config, every edit is made here, and Weimi is read only on demand, as a
 * diff the operator applies by hand.
 *
 * Everything here works on the layout array; the storage object is passed in for meta reads and
 * writes and for the count ledger, so the pure parts can be tested on their own.
 */

const LAYERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MAX_POS = 8; // columnBaseZero: positions 00..08, nine lanes — the kiosk rejects anything wider

function readLayout(storage, deviceCode) {
  try { const raw = storage.getMeta('layout:' + deviceCode); const l = raw ? JSON.parse(raw) : null; return Array.isArray(l) ? l : null; }
  catch (e) { return null; }
}
function writeLayout(storage, deviceCode, layout) {
  storage.setMeta('layout:' + deviceCode, JSON.stringify(layout));
}
function allBays(layout) {
  const out = [];
  (layout || []).forEach(l => (l.bays || []).forEach(b => out.push({ layer: l.layer, bay: b })));
  return out;
}
function findBay(layout, aisleCode) {
  for (const l of (layout || [])) for (const b of (l.bays || [])) if (String(b.code) === String(aisleCode)) return { layer: l, bay: b };
  return null;
}
function totalStock(layout) {
  let t = 0; (layout || []).forEach(l => (l.bays || []).forEach(b => { t += Number(b.currStock) || 0; })); return t;
}
function sortLayout(layout) {
  layout.sort((x, y) => String(x.layer).localeCompare(String(y.layer)));
  layout.forEach(l => (l.bays || []).sort((a, b) => String(a.code).localeCompare(String(b.code))));
  return layout;
}

// "0-A03" → { cabinet: 0, layer: 'A', pos: 3 }
function parseCode(code) {
  const m = /^(\d+)-([A-Z])(\d+)$/.exec(String(code || ''));
  return m ? { cabinet: Number(m[1]), layer: m[2], pos: Number(m[3]) } : null;
}
function makeCode(layer, pos, cabinet = 0) {
  return `${cabinet}-${layer}${String(pos).padStart(2, '0')}`;
}
// The next free position on a layer, or null when the layer holds nine lanes already.
function nextFreeCode(layer, bays) {
  const used = new Set((bays || []).map(b => (parseCode(b.code) || {}).pos).filter(p => p != null));
  for (let p = 0; p <= MAX_POS; p++) if (!used.has(p)) return makeCode(layer, p);
  return null;
}

// What the kiosk, the machine list and the catalog views want to know about a product on this
// machine, from the layout alone — the shape weimi.aislesToProducts produced from Weimi's aisles.
function productsFromLayout(layout) {
  const by = {};
  allBays(layout).forEach(({ bay: b }) => {
    const gid = b.goodsId != null ? String(b.goodsId) : '';
    if (!gid) return;
    if (!by[gid]) by[gid] = { id: gid, slot: b.code, slots: [], name: String(b.name || '').trim().toLowerCase(), subtitle: null,
      priceIsk: Number(b.priceIsk) || 0, category: 'Other', imagePath: b.image || null, stock: 0, maxStock: 0,
      displayOrder: 999, featured: false, hidden: false, hideWhenEmpty: true };
    const p = by[gid];
    p.slots.push(b.code);
    p.stock += Number(b.currStock) || 0;
    p.maxStock += Number(b.maxStock) || 0;
    if (!p.imagePath && b.image) p.imagePath = b.image;
  });
  return Object.values(by).filter(p => p.name);
}

// The layout as the kiosk's config carries it. `types` is the layer → 'spiral'|'push' map the
// dashboard shows; `images` the goodsId → { url } map of hosted images, preferred over the bay's.
function configBlock(layout, types, images) {
  return (layout || []).map(l => ({
    layer: l.layer,
    type: (types && types[l.layer]) || 'spiral',
    bays: (l.bays || []).map(b => ({
      code: b.code,
      goodsId: b.goodsId != null && b.goodsId !== '' ? String(b.goodsId) : null,
      name: b.name || '',
      priceIsk: Number(b.priceIsk) || 0,
      image: (images && b.goodsId != null && images[String(b.goodsId)] && images[String(b.goodsId)].url) || b.image || null,
      maxStock: Number(b.maxStock) || 0,
      currStock: Number(b.currStock) || 0,
    })),
  }));
}

function productFields(storage, goodsId) {
  const p = storage.getProduct ? storage.getProduct(String(goodsId)) : null;
  if (!p) return null;
  return { name: p.name || '', image: p.imgUrl || '', salePriceIsk: p.salePriceIsk != null ? Number(p.salePriceIsk) : null };
}

/**
 * Change what a bay holds. patch: { goodsId?, priceIsk?, maxStock? }. A goodsId must be a product
 * we know; its name and image come from the product. Clearing a bay: goodsId ''. The count is
 * never touched here — a product change on a bay that still has units is the restocker's call.
 */
function editBay(storage, deviceCode, aisleCode, patch, actor) {
  const layout = readLayout(storage, deviceCode);
  if (!layout) return { ok: false, status: 404, error: 'no_layout', message: 'No planogram stored for ' + deviceCode };
  const hit = findBay(layout, aisleCode);
  if (!hit) return { ok: false, status: 404, error: 'no_such_bay', message: `Bay ${aisleCode} is not on this machine` };
  const b = hit.bay;
  const changed = [];
  const base = { deviceCode, aisleCode: b.code, actor };
  if (patch.goodsId !== undefined) {
    const gid = patch.goodsId == null ? '' : String(patch.goodsId);
    if (gid) {
      const pf = productFields(storage, gid);
      if (!pf) return { ok: false, status: 400, error: 'unknown_product', message: `Product ${gid} is not in the product list` };
      const before = b.name || b.goodsId || '—';
      b.goodsId = gid; b.name = pf.name; b.image = pf.image;
      if (patch.priceIsk === undefined && pf.salePriceIsk != null) b.priceIsk = Math.round(pf.salePriceIsk);
      storage.ledger({ ...base, goodsId: gid, productName: pf.name, before: Number(b.currStock) || 0, after: Number(b.currStock) || 0,
        cause: 'product_changed', ref: `${before} → ${pf.name}` });
      changed.push('goodsId');
    } else {
      const before = b.name || '—';
      storage.ledger({ ...base, goodsId: b.goodsId, productName: b.name, before: Number(b.currStock) || 0, after: 0,
        cause: 'product_changed', ref: `${before} → (empty)` });
      b.goodsId = ''; b.name = ''; b.image = ''; b.currStock = 0;
      changed.push('goodsId');
    }
  }
  if (patch.priceIsk !== undefined) {
    const isk = Math.round(Number(patch.priceIsk));
    if (!Number.isFinite(isk) || isk < 0) return { ok: false, status: 400, error: 'bad_price', message: 'priceIsk must be a number ≥ 0' };
    if (isk !== (Number(b.priceIsk) || 0)) {
      storage.ledger({ ...base, goodsId: b.goodsId, productName: b.name, before: Number(b.currStock) || 0, after: Number(b.currStock) || 0,
        cause: 'price_changed', ref: `${Number(b.priceIsk) || 0} → ${isk} kr` });
      b.priceIsk = isk; changed.push('priceIsk');
    }
  }
  if (patch.maxStock !== undefined) {
    const n = Math.round(Number(patch.maxStock));
    if (!Number.isFinite(n) || n < 0 || n > 99) return { ok: false, status: 400, error: 'bad_capacity', message: 'maxStock must be 0–99' };
    if (n !== (Number(b.maxStock) || 0)) {
      storage.ledger({ ...base, goodsId: b.goodsId, productName: b.name, before: Number(b.currStock) || 0, after: Number(b.currStock) || 0,
        cause: 'capacity_changed', ref: `${Number(b.maxStock) || 0} → ${n}` });
      b.maxStock = n; changed.push('maxStock');
    }
  }
  writeLayout(storage, deviceCode, layout);
  return { ok: true, bay: b, changed, totalCurrStock: totalStock(layout) };
}

/** A new bay on a layer (created if missing), at the next free position or the given code. */
function addBay(storage, deviceCode, layerLetter, opts, actor) {
  const layer = String(layerLetter || '').toUpperCase();
  if (!LAYERS.includes(layer)) return { ok: false, status: 400, error: 'bad_layer', message: 'layer must be A–F' };
  const layout = readLayout(storage, deviceCode) || [];
  let l = layout.find(x => String(x.layer) === layer);
  if (!l) { l = { layer, bays: [] }; layout.push(l); }
  let code = opts && opts.code ? String(opts.code) : nextFreeCode(layer, l.bays);
  if (!code) return { ok: false, status: 400, error: 'layer_full', message: `Layer ${layer} already has nine lanes` };
  const pc = parseCode(code);
  if (!pc || pc.layer !== layer || pc.pos > MAX_POS) return { ok: false, status: 400, error: 'bad_code', message: `Bay code ${code} is not on layer ${layer}` };
  if (findBay(layout, code)) return { ok: false, status: 409, error: 'bay_exists', message: `Bay ${code} already exists` };
  const bay = { code, goodsId: '', name: '', image: '', priceIsk: 0, currStock: 0, maxStock: Math.max(0, Math.round(Number(opts && opts.maxStock) || 0)),
    isEnable: true, isBroken: false, shippingMode: null, needsCount: true };
  l.bays.push(bay);
  sortLayout(layout);
  writeLayout(storage, deviceCode, layout);
  storage.ledger({ deviceCode, aisleCode: code, goodsId: null, productName: null, before: null, after: 0, cause: 'slot_added', actor });
  let r = { ok: true, bay, totalCurrStock: totalStock(layout) };
  if (opts && opts.goodsId) {
    const e = editBay(storage, deviceCode, code, { goodsId: opts.goodsId, priceIsk: opts.priceIsk }, actor);
    if (!e.ok) return e;
    r = { ok: true, bay: e.bay, totalCurrStock: e.totalCurrStock };
  }
  return r;
}

function removeBay(storage, deviceCode, aisleCode, actor) {
  const layout = readLayout(storage, deviceCode);
  if (!layout) return { ok: false, status: 404, error: 'no_layout', message: 'No planogram stored for ' + deviceCode };
  const hit = findBay(layout, aisleCode);
  if (!hit) return { ok: false, status: 404, error: 'no_such_bay', message: `Bay ${aisleCode} is not on this machine` };
  hit.layer.bays = hit.layer.bays.filter(b => String(b.code) !== String(aisleCode));
  const kept = layout.filter(l => (l.bays || []).length > 0);
  writeLayout(storage, deviceCode, kept);
  storage.ledger({ deviceCode, aisleCode: hit.bay.code, goodsId: hit.bay.goodsId, productName: hit.bay.name,
    before: Number(hit.bay.currStock) || 0, after: null, cause: 'slot_removed', actor });
  return { ok: true, removed: hit.bay, totalCurrStock: totalStock(kept) };
}

// Weimi's device-info as a flat list of bays, in our bay shape, without counts (never ours).
function weimiBays(info, fixName) {
  const out = [];
  (info && info.cabinets || []).forEach(cab => (cab.layers || []).forEach(layer => (layer.aisles || []).forEach(a => {
    if (!a || !a.code) return;
    out.push({
      layer: layer.layer, code: a.code,
      goodsId: String(a.goodsId || a.id || ''),
      name: (fixName ? fixName(a.goodsName) : a.goodsName) || '',
      image: a.thumbnailUrl || a.imgUrl || a.imageUrl || '',
      priceIsk: Math.round((a.price || 0) / 100),
      maxStock: Number(a.maxStock) || 0,
      weimiStock: Number(a.currStock) || 0,
      shippingMode: a.shippingMode != null ? Number(a.shippingMode) : null,
    });
  })));
  return out;
}

/**
 * Our planogram against Weimi's, per bay code. Each row says what differs and what applying it
 * would do: 'take' Weimi's product/price/capacity (count kept), 'add' a bay Weimi has and we do
 * not (count 0, flagged), 'remove' a bay we have and Weimi does not. Counts are never compared:
 * Weimi's are stale for a Kiosk machine by design.
 */
function weimiDiff(layout, info, fixName) {
  const ours = {}; allBays(layout).forEach(({ layer, bay }) => { ours[bay.code] = { layer, ...bay }; });
  const theirs = {}; weimiBays(info, fixName).forEach(b => { theirs[b.code] = b; });
  const codes = Array.from(new Set([...Object.keys(ours), ...Object.keys(theirs)])).sort();
  return codes.map(code => {
    const o = ours[code], w = theirs[code];
    const row = { code, layer: (o && o.layer) || (w && w.layer) || (parseCode(code) || {}).layer || '',
      ours: o ? { goodsId: String(o.goodsId || ''), name: o.name || '', priceIsk: Number(o.priceIsk) || 0, maxStock: Number(o.maxStock) || 0, currStock: Number(o.currStock) || 0 } : null,
      weimi: w ? { goodsId: w.goodsId, name: w.name, priceIsk: w.priceIsk, maxStock: w.maxStock, weimiStock: w.weimiStock } : null,
      diffs: [], action: null };
    if (!o) { row.action = 'add'; return row; }
    if (!w) { row.action = 'remove'; return row; }
    if (String(o.goodsId || '') !== w.goodsId) row.diffs.push('product');
    if ((Number(o.priceIsk) || 0) !== w.priceIsk) row.diffs.push('price');
    if ((Number(o.maxStock) || 0) !== w.maxStock) row.diffs.push('capacity');
    row.action = row.diffs.length ? 'take' : null;
    return row;
  });
}

/**
 * Apply chosen rows of a diff. changes: [{ code, action: 'take'|'add'|'remove' }]. Re-reads Weimi's
 * info passed in (the caller fetched it moments ago) so 'take' and 'add' carry Weimi's current
 * values. Every applied row is a ledger entry; the kiosk picks the layout up at its next poll.
 */
function applyWeimiDiff(storage, deviceCode, info, changes, actor, fixName) {
  const layout = readLayout(storage, deviceCode) || [];
  const theirs = {}; weimiBays(info, fixName).forEach(b => { theirs[b.code] = b; });
  const applied = [], skipped = [];
  for (const ch of (changes || [])) {
    const code = ch && ch.code ? String(ch.code) : '';
    const w = theirs[code];
    const hit = findBay(layout, code);
    if (ch.action === 'take' && hit && w) {
      const b = hit.bay;
      const before = `${b.name || '—'} · ${Number(b.priceIsk) || 0} kr · ${Number(b.maxStock) || 0}`;
      b.goodsId = w.goodsId; b.name = w.name; b.image = w.image || b.image; b.priceIsk = w.priceIsk; b.maxStock = w.maxStock;
      if (w.shippingMode != null) b.shippingMode = w.shippingMode;
      storage.ledger({ deviceCode, aisleCode: code, goodsId: w.goodsId, productName: w.name, before: Number(b.currStock) || 0, after: Number(b.currStock) || 0,
        cause: 'import_take', ref: `${before} → ${w.name || '—'} · ${w.priceIsk} kr · ${w.maxStock}`, actor });
      applied.push(code);
    } else if (ch.action === 'add' && !hit && w) {
      let l = layout.find(x => String(x.layer) === String(w.layer));
      if (!l) { l = { layer: String(w.layer), bays: [] }; layout.push(l); }
      l.bays.push({ code, goodsId: w.goodsId, name: w.name, image: w.image, priceIsk: w.priceIsk, currStock: 0, maxStock: w.maxStock,
        isEnable: true, isBroken: false, shippingMode: w.shippingMode, needsCount: true });
      storage.ledger({ deviceCode, aisleCode: code, goodsId: w.goodsId, productName: w.name, before: null, after: 0,
        cause: 'import_add', ref: `weimi ${w.weimiStock}`, actor });
      applied.push(code);
    } else if (ch.action === 'remove' && hit && !w) {
      hit.layer.bays = hit.layer.bays.filter(b => String(b.code) !== code);
      storage.ledger({ deviceCode, aisleCode: code, goodsId: hit.bay.goodsId, productName: hit.bay.name, before: Number(hit.bay.currStock) || 0, after: null,
        cause: 'import_remove', actor });
      applied.push(code);
    } else {
      skipped.push(code);
    }
  }
  const kept = sortLayout(layout.filter(l => (l.bays || []).length > 0));
  writeLayout(storage, deviceCode, kept);
  return { ok: true, applied, skipped, totalCurrStock: totalStock(kept) };
}

// Layer → 'spiral' | 'push': Weimi's shippingMode majority per layer, overridden by the hand-set map.
function layerTypes(layout, saved) {
  const cfg = {};
  (layout || []).forEach(l => {
    const modes = (l.bays || []).map(b => b.shippingMode).filter(m => m != null);
    const push = modes.filter(m => Number(m) === 2).length;
    cfg[l.layer] = (modes.length && push * 2 > modes.length) ? 'push' : 'spiral';
  });
  return { ...cfg, ...(saved || {}) };
}

module.exports = { LAYERS, MAX_POS, readLayout, writeLayout, findBay, totalStock, parseCode, makeCode, nextFreeCode,
  productsFromLayout, configBlock, editBay, addBay, removeBay, weimiBays, weimiDiff, applyWeimiDiff, layerTypes };
