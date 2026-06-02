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
  if (req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/health') {
    if (serveStatic(req, res)) return;
  }

  // Body parsing
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch {
      req.body = {};
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
  console.log('Press Ctrl+C to stop.\n');
});

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
