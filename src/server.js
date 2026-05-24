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
  console.log('Press Ctrl+C to stop.\n');
});
