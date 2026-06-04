/**
 * Fleet-wide Weimi sync.
 *
 * Now that the backend can reach Weimi production (micron.weimi24.com/v8)
 * directly, we pull real data for every machine without the kiosk proxy.
 *
 * Three sync operations:
 *   - syncStatusAll()            : one device-profile call for the whole fleet
 *   - syncDeviceProducts(code)   : device-info -> products / inventory / sold-out
 *   - syncOrders(code, days)     : query-order-list -> orders backfill (dedup)
 *
 * All direct calls go to the production domain. Status respects the proxy:
 * a machine is online if Weimi says so OR a kiosk is connected via the proxy.
 */

const weimi   = require('./weimi');
const storage = require('./storage');

// Force production unless explicitly overridden. The hardcoded creds in
// weimi.getCredentials are valid for prod (proven by the live diagnostic).
const WEIMI_CFG = { endpoint: process.env.WEIMI_ENV || 'prod' };

function proxyConnected(deviceCode) {
  try { return require('./proxy').isConnected(deviceCode); }
  catch { return false; }
}

/** device-info nests aisles under cabinets -> layers. Flatten to one array. */
function flattenAisles(info) {
  const out = [];
  (info.cabinets || []).forEach(cab => {
    (cab.layers || []).forEach(layer => {
      (layer.aisles || []).forEach(a => out.push(a));
    });
  });
  return out;
}

// ─── Status (whole fleet in one call) ─────────────────────────────────────────

async function syncStatusAll() {
  const machines = storage.listMachines();
  const codes = machines.map(m => m.deviceCode);
  if (!codes.length) return { updated: 0, fetched: 0 };

  const list = await weimi.deviceProfile(WEIMI_CFG, codes);
  const byCode = {};
  list.forEach(d => { if (d.deviceCode) byCode[d.deviceCode] = d; });

  let updated = 0;
  machines.forEach(m => {
    const d = byCode[m.deviceCode];
    const kioskAlive = proxyConnected(m.deviceCode) || storage.isKioskAlive(m.deviceCode);
    if (!d && !kioskAlive) return;
    const weimiOnline  = d ? (d.isOnline  === 1 || d.isOnline  === true) : false;
    const weimiRunning = d ? (d.isRunning === 1 || d.isRunning === true) : false;
    m.isOnline  = weimiOnline  || kioskAlive;
    m.isRunning = weimiRunning || kioskAlive;
    if (d && typeof d.totalCurrStock === 'number') m.totalCurrStock = d.totalCurrStock;
    m.updatedAt = new Date().toISOString();
    storage.upsertMachine(m);
    updated++;
  });
  storage.setMeta('weimisync:status:all', new Date().toISOString());
  return { updated, fetched: list.length };
}

// ─── Products + inventory for one machine ─────────────────────────────────────

async function syncDeviceProducts(deviceCode) {
  const m = storage.getMachine(deviceCode);
  if (!m) throw new Error(`machine ${deviceCode} not in DB`);

  const info   = await weimi.deviceInfo(WEIMI_CFG, deviceCode);
  const aisles = flattenAisles(info);
  const products = weimi.aislesToProducts(aisles);

  // Detect a restock (manual visit): authoritative total stock went UP vs the
  // previous sync. Sales only decrease, so a net increase means product was added.
  const prevTotal = (m.products || []).reduce((s, p) => s + (p.stock || 0), 0);
  const newTotal  = products.reduce((s, p) => s + (p.stock || 0), 0);
  if (m.products && m.products.length && newTotal > prevTotal) {
    storage.setMeta(`lastvisit:${deviceCode}`, Date.now());
  }

  m.products       = products;
  m.totalCurrStock = newTotal;
  m.maxStock       = products.reduce((s, p) => s + (p.maxStock || 0), 0);
  if (info.deviceName && !m.deviceName) m.deviceName = info.deviceName;
  m.updatedAt = new Date().toISOString();
  storage.upsertMachine(m);

  // Feed sold-out detection: one snapshot per product (summed across its slots)
  products.forEach(p => {
    storage.recordStockSnapshot({
      deviceCode,
      goodsId:     String(p.id),
      productName: p.name,
      stock:       p.stock || 0,
      source:      'weimi_sync',
    });
  });

  storage.setMeta(`weimisync:products:${deviceCode}`, new Date().toISOString());

  // Capture the per-layer / per-bay layout (for the bay layout + config view).
  // Grouped by layer letter, preserving each bay's product/stock/state.
  const layerMap = {};
  (info.cabinets || []).forEach(cab => (cab.layers || []).forEach(layer => {
    const key = layer.layer;
    if (!layerMap[key]) layerMap[key] = { layer: key, bays: [] };
    (layer.aisles || []).forEach(a => {
      layerMap[key].bays.push({
        code:      a.code,
        goodsId:   String(a.goodsId || a.id || ''),
        name:      weimi.fixMojibake(a.goodsName) || '',
        image:     a.thumbnailUrl || a.imgUrl || a.imageUrl || '',
        priceIsk:  Math.round((a.price || 0) / 100),
        currStock: a.currStock || 0,
        maxStock:  a.maxStock || 0,
        isEnable:  a.isEnable !== false,
        isBroken:  !!a.isBroken,
      });
    });
  }));
  const layout = Object.values(layerMap).sort((x, y) => String(x.layer).localeCompare(String(y.layer)));
  storage.setMeta(`layout:${deviceCode}`, JSON.stringify(layout));

  return { products: products.length, totalCurrStock: m.totalCurrStock, maxStock: m.maxStock, layers: layout.length };
}

// ─── Orders backfill for one machine ──────────────────────────────────────────

async function syncOrders(deviceCode, days = 7) {
  const list   = await weimi.queryOrders(WEIMI_CFG, { deviceCode });
  const cutoff = Date.now() - days * 86400000;

  let imported = 0, duplicates = 0, skipped = 0, outOfRange = 0;
  (list || []).forEach(o => {
    const tradeNo = o.tradeNo || o.orderId;
    if (!tradeNo) { skipped++; return; }

    const details = o.detailVOList || [];
    const first   = details[0] || {};

    // Order time: prefer the per-item shipmentTime, else order-level fields.
    // Iceland runs on UTC year-round, so parse "yyyy-MM-dd HH:mm:ss" as UTC.
    const timeStr = first.shipmentTime || o.tradeStartTime || o.payEndTime || null;
    let ts = timeStr ? Date.parse(String(timeStr).replace(' ', 'T') + 'Z') : Date.now();
    if (isNaN(ts)) ts = Date.now();
    if (ts < cutoff) { outOfRange++; return; }

    if (storage.getOrder(tradeNo)) { duplicates++; return; }

    const totalAmount = typeof o.totalAmount === 'number' ? o.totalAmount : 0;
    const delivered   = details.some(d => d.shipmentStatus === 1);

    storage.insertOrder({
      tradeNo,
      deviceCode,
      goodsId:     first.goodsId || null,
      productName: weimi.fixMojibake(first.goodsName) || (details.length ? `${details.length} items` : ''),
      totalAmount,
      amountKr:    Math.round(totalAmount / 100),
      status:      delivered ? 1 : 0,
      statusLabel: delivered ? 'success' : 'not_delivered',
      createTime:  ts,
    });
    imported++;
  });

  storage.setMeta(`weimisync:orders:${deviceCode}`, new Date().toISOString());
  return { imported, duplicates, skipped, outOfRange, fetched: (list || []).length };
}

// ─── Per-machine + fleet orchestration ────────────────────────────────────────

async function syncMachine(deviceCode, { orders = true, days = 7 } = {}) {
  const result = { deviceCode, ok: true };
  try {
    result.products = await syncDeviceProducts(deviceCode);
  } catch (e) {
    result.ok = false;
    result.productsError = e.message;
  }
  if (orders) {
    try {
      result.orders = await syncOrders(deviceCode, days);
    } catch (e) {
      result.ordersError = e.message;
    }
  }
  return result;
}

async function syncAll({ orders = true, days = 7 } = {}) {
  const report = { startedAt: new Date().toISOString(), machines: [] };

  // 1. Fleet status in a single call
  try {
    report.status = await syncStatusAll();
  } catch (e) {
    report.statusError = e.message;
  }

  // 2. Per-machine products (+ optional orders)
  const machines = storage.listMachines();
  for (const m of machines) {
    const r = await syncMachine(m.deviceCode, { orders, days });
    report.machines.push(r);
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    total:        report.machines.length,
    productsOk:   report.machines.filter(r => r.products).length,
    productsFail: report.machines.filter(r => r.productsError).length,
    ordersImported: report.machines.reduce((s, r) => s + (r.orders?.imported || 0), 0),
  };
  storage.setMeta('weimisync:all', report.finishedAt);
  return report;
}

/**
 * Enumerate the whole fleet from Weimi (device-profile with no codes returns
 * all devices) and upsert into our machine list. Existing machines keep their
 * operator assignment and only have name/status refreshed; new machines are
 * added as 'Unassigned' for the operator to claim.
 */
async function populateFromWeimi() {
  const list = await weimi.deviceProfile(WEIMI_CFG, []); // empty = all devices

  // New machines need a valid operatorId (NOT NULL + FK). Park them under a
  // dedicated "Unassigned" operator the AG admin can reassign from later.
  const UNASSIGNED = 'op_unassigned';
  if (!storage.getOperator(UNASSIGNED)) {
    storage.upsertOperator({ id: UNASSIGNED, name: 'Unassigned', isAGVending: false });
  }

  let added = 0, updated = 0;
  const addedList = [];
  list.forEach(d => {
    if (!d.deviceCode) return;
    const existing = storage.getMachine(d.deviceCode);
    const proxyUp = proxyConnected(d.deviceCode);
    const online  = (d.isOnline === 1) || proxyUp;
    if (existing) {
      if (d.deviceName) existing.deviceName = existing.deviceName || d.deviceName;
      existing.isOnline = online;
      existing.isRunning = (d.isRunning === 1) || proxyUp;
      if (typeof d.totalCurrStock === 'number') existing.totalCurrStock = d.totalCurrStock;
      existing.updatedAt = new Date().toISOString();
      storage.upsertMachine(existing);
      updated++;
    } else {
      storage.upsertMachine({
        deviceCode:     d.deviceCode,
        deviceName:     d.deviceName || d.deviceCode,
        operatorId:     UNASSIGNED,
        profile:        { operatorName: 'Unassigned' },
        isOnline:       online,
        isRunning:      (d.isRunning === 1) || proxyUp,
        totalCurrStock: d.totalCurrStock || 0,
        maxStock:       0,
        products:       [],
        createdAt:      new Date().toISOString(),
        updatedAt:      new Date().toISOString(),
      });
      added++;
      addedList.push({ deviceCode: d.deviceCode, deviceName: d.deviceName || d.deviceCode });
    }
  });
  storage.setMeta('weimisync:populate', new Date().toISOString());
  return { fetched: list.length, added, updated, addedList };
}

function lastSync(deviceCode) {
  return {
    products: deviceCode ? storage.getMeta(`weimisync:products:${deviceCode}`) : storage.getMeta('weimisync:all'),
    orders:   deviceCode ? storage.getMeta(`weimisync:orders:${deviceCode}`) : null,
    statusAll: storage.getMeta('weimisync:status:all'),
    all:       storage.getMeta('weimisync:all'),
  };
}

module.exports = { syncStatusAll, syncDeviceProducts, syncOrders, syncMachine, syncAll, populateFromWeimi, lastSync };
