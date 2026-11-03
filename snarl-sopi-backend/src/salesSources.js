/**
 * Where one machine's sales come from, and which tables each source reaches (2026-11-03).
 *
 * A sale can arrive three ways and they land differently:
 *   kiosk  — our coil app's POST /sales: one `orders` row per line ("saleId#n"), NO order_items.
 *   weimi  — the Weimi order sync: one `orders` row per order AND one order_items row per line.
 *   fridge — a charged settlement: one `orders` row AND its order_items.
 * The VSK/profit report, the daily accounting export, the restock "sold since" and the silent-
 * machine check read order_items only; revenue, top products and Activity read `orders`.
 *
 * So two things are unknown until production answers them, and this reports both:
 *   - kiosk sales with no order_items line (missing from accounting), and
 *   - Weimi orders that look like the same purchase as a kiosk sale (counted twice in revenue):
 *     same total within MATCH_WINDOW_MS.
 * Pure: give it the rows, it returns the tally. Read-only by construction.
 */
const MATCH_WINDOW_MS = 3 * 60 * 1000;

function sourceOf(o, isFridgeOrder) {
  if (String(o.tradeNo).indexOf('#') >= 0) return 'kiosk';
  if (isFridgeOrder(o)) return 'fridge';
  return 'weimi';
}

function salesSources({ orders = [], items = [], isFridgeOrder = () => false, fromMs, toMs, days }) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const tally = () => ({ orders: 0, rows: 0, kr: 0 });
  const bySource = { kiosk: tally(), weimi: tally(), fridge: tally() };
  const byDay = {};
  const dayRow = d => byDay[d] || (byDay[d] = { day: d, kioskKr: 0, weimiKr: 0, fridgeKr: 0, orderItemsKr: 0 });

  // Kiosk lines → one purchase per saleId; others are one row per purchase already.
  const purchases = {};
  for (const o of orders) {
    if (o.status !== 1) continue;
    const src = sourceOf(o, isFridgeOrder);
    const base = String(o.tradeNo).split('#')[0];
    const key = src + ':' + base;
    const p = purchases[key] || (purchases[key] = { src, tradeNo: base, at: o.createTime, kr: 0, lines: 0 });
    p.kr += Number(o.amountKr) || 0; p.lines++;
    if (o.createTime < p.at) p.at = o.createTime;
    bySource[src].rows++; bySource[src].kr += Number(o.amountKr) || 0;
    dayRow(day(o.createTime))[src + 'Kr'] += Number(o.amountKr) || 0;
  }
  const list = Object.values(purchases);
  list.forEach(p => { bySource[p.src].orders++; });

  const itemTradeNos = new Set();
  let itemsKr = 0, itemsDelivered = 0;
  for (const it of items) {
    itemTradeNos.add(String(it.tradeNo));
    if (it.shipmentStatus === 1) { itemsDelivered++; itemsKr += (Number(it.payAmount) || 0) / 100; dayRow(day(it.createTime)).orderItemsKr += (Number(it.payAmount) || 0) / 100; }
  }

  const kiosk = list.filter(p => p.src === 'kiosk');
  const weimi = list.filter(p => p.src === 'weimi');
  // A kiosk sale reaches order_items only if something wrote lines under its own tradeNo.
  const kioskWithoutItems = kiosk.filter(p => !itemTradeNos.has(p.tradeNo) && !itemTradeNos.has(p.tradeNo + '#0'));

  // Pair each kiosk purchase with at most one Weimi order of the same total close in time.
  const used = new Set();
  const lookalikes = [];
  for (const k of kiosk) {
    const w = weimi.find(x => !used.has(x.tradeNo) && x.kr === k.kr && Math.abs(x.at - k.at) <= MATCH_WINDOW_MS);
    if (w) { used.add(w.tradeNo); lookalikes.push({ kioskSale: k.tradeNo, weimiOrder: w.tradeNo, kr: k.kr, secondsApart: Math.round((w.at - k.at) / 1000) }); }
  }

  const r = n => Math.round(n);
  return {
    window: { days, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    bySource: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, { ...v, kr: r(v.kr) }])),
    orderItems: { rows: items.length, delivered: itemsDelivered, deliveredKr: r(itemsKr) },
    kioskSalesWithoutOrderItems: { count: kioskWithoutItems.length, kr: r(kioskWithoutItems.reduce((s, p) => s + p.kr, 0)),
      sample: kioskWithoutItems.slice(-5).map(p => ({ saleId: p.tradeNo, at: new Date(p.at).toISOString(), kr: p.kr })) },
    weimiOrdersMatchingKioskSales: { count: lookalikes.length, kr: r(lookalikes.reduce((s, x) => s + x.kr, 0)),
      ofKioskSales: kiosk.length, ofWeimiOrders: weimi.length, sample: lookalikes.slice(-5) },
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, orderItemsKr: r(d.orderItemsKr) })),
    readMe: [
      'kioskSalesWithoutOrderItems > 0 → those sales are missing from the VSK/profit report and the accounting export.',
      'weimiOrdersMatchingKioskSales close to kioskSales → Weimi records our kiosk sales too, so revenue counts them twice.',
      'weimiOrdersMatchingKioskSales = 0 with kiosk sales present → Weimi does not see them; order_items has no copy at all.',
    ],
  };
}

module.exports = { salesSources, MATCH_WINDOW_MS };
