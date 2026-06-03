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
    const proxyUp = proxyConnected(m.deviceCode);
    if (!d && !proxyUp) return;
    const weimiOnline  = d ? (d.isOnline  === 1 || d.isOnline  === true) : false;
    const weimiRunning = d ? (d.isRunning === 1 || d.isRunning === true) : false;
    m.isOnline  = weimiOnline  || proxyUp;
    m.isRunning = weimiRunning || proxyUp;
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

  m.products       = products;
  m.totalCurrStock = products.reduce((s, p) => s + (p.stock || 0), 0);
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
  return { products: products.length, totalCurrStock: m.totalCurrStock, maxStock: m.maxStock };
}

// ─── Orders backfill for one machine ──────────────────────────────────────────

async function syncOrders(deviceCode, days = 7) {
  const end   = new Date();
  const start = new Date(Date.now() - days * 86400000);
  const fmt   = d => d.toISOString().slice(0, 10);

  const records = await weimi.queryOrders(WEIMI_CFG, {
    deviceCode, startDate: fmt(start), endDate: fmt(end), page: 1, size: 200,
  });

  let imported = 0, duplicates = 0, skipped = 0;
  (records || []).forEach(o => {
    const tradeNo = o.tradeNo || o.tradeNoOut || o.orderId;
    if (!tradeNo) { skipped++; return; }
    if (storage.getOrder(tradeNo)) { duplicates++; return; }

    const first = (o.detailVOList && o.detailVOList[0]) || {};
    const totalAmount = typeof o.totalAmount === 'number' ? o.totalAmount : 0;
    // createTime field name varies; try the common candidates, fall back to now
    const createTime = o.payEndTime || o.createTime || o.payTime || o.tradeTime || Date.now();

    storage.insertOrder({
      tradeNo,
      deviceCode,
      goodsId:     first.goodsId || null,
      productName: first.goodsName || (o.detailVOList ? `${o.detailVOList.length} items` : ''),
      totalAmount,
      amountKr:    Math.round(totalAmount / 100),
      status:      1, // query-order-list returns paid orders; mark success
      statusLabel: 'success',
      createTime:  Number(createTime),
    });
    imported++;
  });

  storage.setMeta(`weimisync:orders:${deviceCode}`, new Date().toISOString());
  return { imported, duplicates, skipped, fetched: (records || []).length };
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

function lastSync(deviceCode) {
  return {
    products: deviceCode ? storage.getMeta(`weimisync:products:${deviceCode}`) : storage.getMeta('weimisync:all'),
    orders:   deviceCode ? storage.getMeta(`weimisync:orders:${deviceCode}`) : null,
    statusAll: storage.getMeta('weimisync:status:all'),
    all:       storage.getMeta('weimisync:all'),
  };
}

module.exports = { syncStatusAll, syncDeviceProducts, syncOrders, syncMachine, syncAll, lastSync };
