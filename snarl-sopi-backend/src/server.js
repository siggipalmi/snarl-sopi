/**
 * Snúður & Sopi — Operator Backend API
 * Node.js HTTP server, zero external dependencies.
 *
 * Also serves the static operator dashboard HTML from /public/
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { router } = require('./router');
const email = require('./email');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// MIME types for static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Machine-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Static files for GET requests that aren't API routes
  if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/health' && !req.url.startsWith('/downloads')) {
    if (serveStatic(req, res)) return;
  }

  // Body parsing
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    req.rawBody = body;
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch {
      req.body = {};
      req._bodyParseError = true;
    }
    router(req, res);
  });
});

server.listen(PORT, () => {
  console.log(`\nSnarl & Sopi backend running on http://localhost:${PORT}`);
  console.log(`Static files served from ${PUBLIC_DIR}`);
  // Attach websocket proxy
  const proxy = require('./proxy');
  proxy.attachToServer(server);
  // Start periodic Nayax sync (every 60s) if configured
  startNayaxAutoSync();
  // Start periodic Weimi sync (status + products + orders) so inventory, sales,
  // and stock history (which powers last-visit detection) stay fresh automatically.
  startWeimiAutoSync();
  startDailyDigest();
  startConfigHealthSweep();
  // Mirror any charged fridge settlement that predates the orders-analytics link, so revenue,
  // heatmap and top-products include fridge sales that were only recorded as settlements.
  try {
    const storage = require('./storage');
    const n = storage.backfillFridgeOrders();
    if (n > 0) console.log(`[STORAGE] backfilled ${n} fridge sale(s) into orders`);
  } catch (e) { console.error('[STORAGE] fridge order backfill failed:', e && e.message); }
  console.log('Press Ctrl+C to stop.\n');
});

/**
 * Background loop: periodically pull status + products + orders for the whole
 * fleet from Weimi. This keeps the dashboard current without manual "sync all"
 * clicks, and accumulates stock-history snapshots so restocks (last-visit) are
 * detected automatically. Interval configurable via WEIMI_SYNC_INTERVAL_MS.
 */
// ── Daily machine digest ──────────────────────────────────────────────────────
// One email per opted-in machine, sent at the configured hour. Opt-in per machine, because a
// machine whose stock counts have never been established would otherwise report everything as
// empty every morning and train the operator to ignore the mail.
// Iceland is UTC year-round with no DST, so server time and local time coincide.
// ── Scheduled config health ───────────────────────────────────────────────────
// config_health is on-request only kiosk-side, and the condition it detects — closed lanes the
// kiosk couldn't decode, still taking money — can arise AFTER provisioning, from a config poll that
// lands oddly or a restart. On a machine with no OTA, asking on a schedule is the only way to catch
// that without a site visit. The command is read-only and touches no hardware.
function startConfigHealthSweep() {
  const EVERY_MS = 60 * 60 * 1000;                       // hourly
  const tick = () => {
    try {
      const storage = require('./storage');
      const { machines } = require('./db');
      for (const m of Object.values(machines)) {
        if (!m.isOnline) continue;                        // an offline machine just accrues a queue
        if (m.isKioskModel === false) continue;           // no app to answer
        // Only where it can tell us something: a machine with lanes closed is the case that matters.
        const closed = (m.settings && Array.isArray(m.settings.disabledAisles)) ? m.settings.disabledAisles : [];
        if (!closed.length) continue;
        // Don't stack: skip if a health check is already pending for this machine.
        const pending = (storage.listRecentCommands(m.deviceCode, 10) || [])
          .some(c => c.type === 'config_health' && c.status === 'pending');
        if (pending) continue;
        storage.enqueueCommand({
          id: 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
          deviceCode: m.deviceCode,
          type: 'config_health',
          params: JSON.stringify({}),
          issuedBy: 'scheduled',
          issuedAt: Date.now(),
        });
      }
    } catch (e) {
      console.error('[CONFIG-HEALTH] sweep failed:', e && e.message);
    }
  };
  setTimeout(tick, 5 * 60 * 1000);                        // first sweep 5 min after boot
  setInterval(tick, EVERY_MS).unref();
}

function startDailyDigest() {
  const CHECK_MS = 5 * 60 * 1000;
  let lastSentDay = {};                      // deviceCode -> YYYY-MM-DD, so an hour-long window sends once
  const tick = async () => {
    try {
      const storage = require('./storage');
      const { machines, operators } = require('./db');
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const hour = now.getUTCHours();
      for (const m of Object.values(machines)) {
        const n = (m.settings && m.settings.notifications) || {};
        if (!n.enabled) continue;                                  // opt-in
        const sendHour = Number.isFinite(Number(n.sendHour)) ? Number(n.sendHour) : 7;
        if (hour !== sendHour) continue;
        if (lastSentDay[m.deviceCode] === today) continue;
        lastSentDay[m.deviceCode] = today;

        const lowStock = storage.lowStockForMachine(m.deviceCode, n.thresholds || {}, n.lowStockDefault);
        const alerts = (storage.listAlerts() || []).filter(a => !a.resolved && a.deviceCode === m.deviceCode);
        // Nothing wrong and nothing to restock → send nothing. A daily "all fine" email is noise,
        // and noise is how an alert stops being read.
        if (!lowStock.length && !alerts.length) continue;

        const op = operators[m.operatorId];
        const toEmail = (op && op.contactEmail && op.contactEmail.trim()) ? op.contactEmail.trim() : null;
        if (!toEmail) continue;                                    // resolveOperatorEmail already alerts on this

        let tempC = null, tempOver = false;
        try {
          const t = storage.latestTelemetry(m.deviceCode);
          if (t && t.tempC != null) {
            tempC = t.tempC;
            const maxC = (m.settings && m.settings.tempMaxC != null) ? Number(m.settings.tempMaxC) : 8;
            tempOver = tempC > maxC;
          }
        } catch (e) { /* temperature is a bonus */ }

        await email.sendMachineDigest({
          to: toEmail,
          operatorName: (op && op.name) || 'AG Vending',
          machineName: m.deviceName || m.deviceCode,
          deviceCode: m.deviceCode,
          status: {
            online: !!m.isOnline,
            lastSeenText: m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleString('is-IS', { timeZone: 'Atlantic/Reykjavik' }) : null,
            tempC, tempOver,
            appVersion: m.kioskVersion || null,
            todayIsk: (() => { const d = new Date(); d.setUTCHours(0,0,0,0); return storage.revenueSince(m.deviceCode, d.getTime()); })(),
          },
          lowStock, alerts,
          dashboardUrl: (process.env.APP_URL || 'https://admin.agvending.is') + '/?page=machines&code=' + m.deviceCode,
        }).catch(err => console.error(`[DIGEST] ${m.deviceCode} send failed:`, err && err.message));
        console.log(`[DIGEST] sent for ${m.deviceCode}: ${lowStock.length} stock item(s), ${alerts.length} alert(s)`);
      }
      // Forget yesterday's marks so the map can't grow without bound.
      for (const k of Object.keys(lastSentDay)) if (lastSentDay[k] !== today) delete lastSentDay[k];
    } catch (e) {
      console.error('[DIGEST] tick failed:', e && e.message);
    }
  };
  setTimeout(tick, 60_000);                 // first check a minute after boot
  setInterval(tick, CHECK_MS).unref();
}

function startWeimiAutoSync() {
  const weimiSync = require('./weimiSync');
  const INTERVAL_MS = Number(process.env.WEIMI_SYNC_INTERVAL_MS) || 30 * 60_000; // default 30 min
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const report = await weimiSync.syncAll({ orders: true });
      const s = report?.summary || {};
      console.log(`[WEIMI] auto-sync: ${s.productsOk || 0}/${s.total || 0} products, ${s.ordersImported || 0} orders`);
    } catch (e) {
      console.error('[WEIMI] auto-sync failed:', e.message);
    } finally {
      inFlight = false;
    }
  };
  setTimeout(tick, 15_000);                 // first run ~15s after boot
  setInterval(tick, INTERVAL_MS).unref();
  console.log(`[WEIMI] Auto-sync enabled (${Math.round(INTERVAL_MS / 60000)}min interval)`);
}

/**
 * Background loop: every 60s, fetch fresh status from Nayax for every linked machine.
 * Skips silently if Nayax isn't configured or auth fails — surfaces in logs only.
 */
function startNayaxAutoSync() {
  const nayax   = require('./nayax');
  const storage = require('./storage');
  if (!nayax.isConfigured()) {
    console.log('[NAYAX] Auto-sync disabled (NAYAX_TOKEN not set)');
    return;
  }
  const INTERVAL_MS = 60_000;
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const linked = storage.listMachines().filter(m => m.nayaxMachineId);
      if (!linked.length) return;
      let ok = 0, fail = 0;
      for (const m of linked) {
        try {
          const data = await nayax.getMachineById(m.nayaxMachineId);
          // Lift the apply logic from the router so we don't import it
          const statusStr  = data.Status || data.MachineStatus || data.OperationalStatus || null;
          const isOnlineBool = typeof data.IsOnline === 'boolean' ? data.IsOnline : (typeof data.Online === 'boolean' ? data.Online : null);
          let online = isOnlineBool;
          if (online === null && typeof statusStr === 'string') {
            const s = statusStr.toLowerCase();
            if (s.includes('online') || s.includes('active') || s.includes('ok'))     online = true;
            else if (s.includes('offline') || s.includes('disconnected') || s.includes('down')) online = false;
          }
          if (online !== null) { m.isOnline = online; m.isRunning = online; }
          m.nayaxLastSyncAt = new Date().toISOString();
          m.nayaxData = {
            rawStatus:    statusStr || null,
            nayaxName:    data.MachineName || data.Name || null,
            lastActivity: data.LastActivity || data.LastSeen || data.LastReportDate || null,
            fetchedAt:    m.nayaxLastSyncAt,
            full:         data,
          };
          storage.upsertMachine(m);
          ok++;
        } catch (e) {
          fail++;
          if (e.code === 'NAYAX_AUTH') {
            console.error('[NAYAX] auto-sync auth failed, pausing until restart');
            return; // bail entirely — keeps polling but won't try until restart
          }
        }
      }
      if (ok > 0 || fail > 0) console.log(`[NAYAX] auto-sync: ${ok} ok, ${fail} fail`);
    } finally {
      inFlight = false;
    }
  };
  // Wait 5s after startup so we don't fire alongside boot, then poll forever
  setTimeout(tick, 5_000);
  setInterval(tick, INTERVAL_MS).unref();
  console.log('[NAYAX] Auto-sync enabled (60s interval)');
}
