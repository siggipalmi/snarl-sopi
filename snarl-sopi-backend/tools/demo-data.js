#!/usr/bin/env node
/**
 * Fill an EMPTY database with invented demo data, for the public screenshots (the dashboard
 * images on agvending.is/kerfid).
 *
 *   DB_PATH=/tmp/demo.db node tools/demo-data.js
 *   DB_PATH=/tmp/demo.db PORT=3000 node src/server.js      # then sign in as below
 *
 * Why it exists: on an empty database src/db.js seeds the REAL fleet (machine names, codes,
 * operators), and lease_units seeds real customers. Neither may appear in a public picture.
 * Writing invented operators, machines and lease units first makes both seeds skip.
 *
 * Everything here is made up: names are generic places, device codes are in 621000xx / 821000xx
 * (the fleet uses 62160xxx / 82160xxx), prices and sales are illustrative. Orders cover the last
 * eight days up to now, so "today" is never empty whenever the script is run. Deterministic:
 * the same day gives the same numbers.
 *
 * Sign in: demo@agvending.is / demo-screenshots, an operator admin (Rekstrarstjóri) whose operator
 * owns every machine: the view a customer renting machines gets, without AG-only panels.
 * It refuses to touch a database that already has operators in it.
 */
const path = require('path');
if (!process.env.DB_PATH) { console.error('Set DB_PATH to a NEW file, e.g. DB_PATH=/tmp/demo.db'); process.exit(2); }
if (/^\/data\//.test(process.env.DB_PATH)) { console.error('Refusing: that looks like the production volume.'); process.exit(2); }

const storage = require(path.join(__dirname, '..', 'src', 'storage'));
const { hashPassword } = require(path.join(__dirname, '..', 'src', 'passwords'));

if (storage.listOperators && storage.listOperators().length) {
  console.error('Refusing: ' + process.env.DB_PATH + ' already has operators. Use a new, empty file.');
  process.exit(1);
}

// Small deterministic PRNG, seeded by the day, so a re-run the same day matches.
let seed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];

const NOW = Date.now(), DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

const OPERATORS = [
  { id: 'op_ag-vending', name: 'AG Vending', isAGVending: true },
  { id: 'op_demo', name: 'Rekstraraðili ehf.', isAGVending: false },
];

const COIL = 'VM-WM55DL', FRIDGE = 'GR-WM22Z680';
// [code, name, address, operator, model, online, fill %, days since last restock, sales weight]
const MACHINES = [
  ['62100066', 'Verslunarmiðstöð – 1. hæð', 'Smáratorg 29', 'op_demo', COIL, true, 27, 11, 1.4],
  ['62100192', 'Íþróttahús – gangur 3', 'Glerárgata 3', 'op_demo', COIL, true, 25, 11, 1.2],
  ['62100003', 'Hótel – lobbý', 'Hverfisgata 2', 'op_demo', COIL, false, 29, 9, 0.6],
  ['62100129', 'Bensínstöð – sjoppa 2', 'Fjarðargata 16', 'op_demo', COIL, true, 21, 9, 1.1],
  ['62100158', 'Verslunarmiðstöð – 1. hæð 2', 'Smáratorg 29', 'op_demo', COIL, true, 19, 7, 0.9],   // 7 d but 19% full: due
  ['62100108', 'Íþróttahús – gangur 2', 'Glerárgata 3', 'op_demo', COIL, false, 54, 6, 0.3],
  ['62100211', 'Sundlaug – anddyri', 'Laugavegur 105', 'op_demo', COIL, true, 72, 4, 1.0],
  ['62100230', 'Skóli – matsalur', 'Skólabraut 1', 'op_demo', COIL, true, 81, 3, 1.3],
  ['62100245', 'Skrifstofa – 4. hæð', 'Borgartún 30', 'op_demo', COIL, true, 88, 6, 0.7],
  ['62100073', 'Gistiheimili', 'Aðalstræti 9', 'op_demo', COIL, false, 40, 14, 0.2],
  ['82100011', 'Vinnustaður – kaffistofa 2', 'Fálkavellir 2', 'op_demo', FRIDGE, true, 63, 2, 1.0],
  ['82100012', 'Skóli – matsalur 2', 'Skólabraut 1', 'op_demo', FRIDGE, true, 47, 5, 0.9],
  ['82100014', 'Verkstæði', 'Smiðjuvegur 4', 'op_demo', FRIDGE, true, 58, 3, 0.8],
  ['82100015', 'Heilsugæsla – biðstofa', 'Álfabakki 14', 'op_demo', FRIDGE, true, 91, 1, 0.5],
];

// [goodsId, name, sale price kr (VSK incl.), cost kr, VSK %, coil?, fridge?]
const PRODUCTS = [
  ['demo-01', 'Vatn 500 ml', 250, 95, 11, 1, 1],
  ['demo-02', 'Gos 500 ml', 350, 140, 11, 1, 1],
  ['demo-03', 'Orkudrykkur', 450, 210, 11, 1, 1],
  ['demo-04', 'Kaffi á flösku', 490, 230, 11, 0, 1],
  ['demo-05', 'Súkkulaði', 300, 120, 11, 1, 0],
  ['demo-06', 'Próteinstykki', 450, 200, 11, 1, 1],
  ['demo-07', 'Snakk', 390, 150, 11, 1, 0],
  ['demo-08', 'Hnetublanda', 420, 190, 11, 1, 0],
  ['demo-09', 'Samloka – kjúklingur', 990, 520, 11, 0, 1],
  ['demo-10', 'Samloka – skinka og ostur', 890, 450, 11, 0, 1],
  ['demo-11', 'Skyr', 450, 210, 11, 0, 1],
  ['demo-12', 'Ávaxtasafi', 350, 150, 11, 1, 1],
  ['demo-13', 'Tyggjó', 250, 90, 11, 1, 0],
  ['demo-14', 'Salat', 1290, 690, 11, 0, 1],
];

// ── operators, users, lease unit ────────────────────────────────────────────
OPERATORS.forEach(o => storage.upsertOperator({ ...o, createdAt: iso(NOW - 200 * DAY) }));
storage.insertUser({
  id: 'u_demo', name: 'Rekstrarstjóri', email: 'demo@agvending.is', password: hashPassword('demo-screenshots'),
  role: 'operator_admin', operatorId: 'op_demo', machineAccess: 'all', lastActiveAt: iso(NOW), createdAt: iso(NOW - 200 * DAY),
});
// One invented lease unit, so db.js does not seed the real lease customers.
storage.insertLeaseUnit({ machineId: '62100999', nayaxId: '0000000000000000', type: 'Tvöfaldur', status: 'available', assignedTo: '', kennitala: '' });

// ── products ────────────────────────────────────────────────────────────────
PRODUCTS.forEach(([goodsId, name, price, cost, vat]) =>
  storage.upsertProduct({ goodsId, name, salePriceIsk: price, costPriceIsk: cost, vatRate: vat }));

// ── machines, stock, last visit ─────────────────────────────────────────────
for (const [code, name, address, op, model, online, fill, restockDays] of MACHINES) {
  const fridge = model === FRIDGE;
  const assortment = PRODUCTS.filter(p => (fridge ? p[6] : p[5]));
  const perSlot = fridge ? 8 : 10;
  const maxStock = assortment.length * perSlot;
  storage.upsertMachine({
    deviceCode: code, deviceName: name, location: address, operatorId: op, model,
    isKioskModel: !fridge, isOnline: online, isRunning: online, kioskVersion: fridge ? '0.70.8' : '0.80.13',
    totalCurrStock: Math.round(maxStock * fill / 100), maxStock,
    profile: { operatorName: OPERATORS.find(o => o.id === op).name }, settings: {},
    products: assortment.map(([goodsId, n, price], i) => ({ goodsId, name: n, price, aisle: i + 1 })),
    stockSource: 'kiosk', createdAt: iso(NOW - 180 * DAY), updatedAt: iso(NOW),
  });
  for (const [goodsId, n] of assortment) {
    const stock = Math.max(0, Math.round(perSlot * fill / 100 + (rnd() * 4 - 2)));
    storage.recordStockSnapshot({ deviceCode: code, goodsId, productName: n, stock, source: 'kiosk' });
  }
  storage.setMeta('lastvisit:' + code, NOW - restockDays * DAY - Math.floor(rnd() * 6) * 3600000);
  // A healthy coil machine holds its own key (config_health → keySource=stored). Without this the
  // machine list shows the key-migration banner, which a customer would never see on a set-up fleet.
  if (!fridge) storage.setMeta('confighealth:' + code, JSON.stringify({ keySource: 'stored', at: NOW }));
}

// ── orders: the last eight days up to now ───────────────────────────────────
// A day's shape: little before 8, a lunch peak, an afternoon peak. Weekends a bit quieter.
const HOUR_WEIGHT = [0,0,0,0,0,0,0,1,2,3,3,4,6,5,3,3,4,5,4,3,2,1,1,0];
// The dashboard compares today SO FAR with all of yesterday. Scale today so that, whatever the hour
// of the run, it is running about a quarter ahead: a demo should not read "-29% vs yesterday".
const nowH = new Date(NOW).getUTCHours();
const elapsed = HOUR_WEIGHT.slice(0, nowH + 1).reduce((a, b) => a + b, 0) / HOUR_WEIGHT.reduce((a, b) => a + b, 0);
const TODAY_BOOST = 1.25 / Math.max(elapsed, 0.15);
let orders = 0, n = 0;
for (let d = 7; d >= 0; d--) {
  const day0 = new Date(NOW - d * DAY); day0.setUTCHours(0, 0, 0, 0);
  const quiet = dt => [0, 6].includes(new Date(dt).getUTCDay()) ? 0.7 : 1;
  // Today is scaled against yesterday's level (TODAY_BOOST), so a Monday after a quiet Sunday
  // does not read +100%.
  const weekend = d === 0 ? quiet(day0.getTime() - DAY) : quiet(day0.getTime());
  for (const [code, , , , model, online, , , weight] of MACHINES) {
    if (!online && d < 3) continue;                       // offline machines stopped selling
    const fridge = model === FRIDGE;
    const assortment = PRODUCTS.filter(p => (fridge ? p[6] : p[5]));
    const today = d === 0;
    const count = Math.round((fridge ? 7 : 9) * weight * weekend * (today ? TODAY_BOOST * elapsed : 0.8 + rnd() * 0.4));
    for (let i = 0; i < count; i++) {
      let h; do { h = Math.floor(rnd() * 24); } while ((today && h > nowH) || rnd() * 6 > HOUR_WEIGHT[h]);
      const t = Math.min(day0.getTime() + h * 3600000 + Math.floor(rnd() * 3600000), NOW - Math.floor(rnd() * 600000));
      const lines = fridge && rnd() < 0.3 ? 2 : 1;
      const items = Array.from({ length: lines }, () => pick(assortment));
      const kr = items.reduce((s, p) => s + p[2], 0);
      const r = rnd(), status = r < 0.95 ? 1 : r < 0.98 ? 2 : 3;
      const tradeNo = 'fr-' + t + String(++n).padStart(4, '0');   // the shape of a real order id
      storage.insertOrder({
        tradeNo, deviceCode: code, goodsId: items[0][0], productName: items.map(p => p[1]).join(', '),
        totalAmount: kr * 100, amountKr: kr, status,
        statusLabel: { 1: 'success', 2: 'failed', 3: 'refunded' }[status], createTime: t,
      });
      items.forEach((p, li) => storage.upsertOrderItem({
        tradeNo, lineIndex: li, deviceCode: code, goodsId: p[0], productName: p[1],
        payAmount: p[2] * 100, shipmentStatus: status === 1, createTime: t,
      }));
      orders++;
    }
  }
}

// ── alerts ──────────────────────────────────────────────────────────────────
for (const [code, name] of MACHINES.filter(m => !m[5])) {
  const since = NOW - (code === '62100073' ? 318 : code === '62100108' ? 92 : 6) * DAY;
  storage.insertAlert({
    id: 'demo-offline-' + code, type: 'offline', severity: code === '62100073' ? 'warning' : 'critical',
    title: 'Machine offline — ' + name, detail: code + ' · offline since ' + iso(since).slice(0, 10),
    deviceCode: code, resolved: false, createdAt: iso(since),
  });
}

console.log(`Demo data written to ${process.env.DB_PATH}: ${OPERATORS.length} operators, ${MACHINES.length} machines, `
  + `${PRODUCTS.length} products, ${orders} orders. Sign in as demo@agvending.is / demo-screenshots.`);
