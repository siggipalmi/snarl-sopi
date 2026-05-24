/**
 * Kiosk WebSocket Proxy
 *
 * Maintains persistent websocket connections to kiosk apps so the backend
 * can route Weimi API requests through them. Weimi blocks direct backend
 * requests with `host_not_allowed`, but the Android kiosk app gets through
 * fine — so we tunnel through it.
 *
 * Architecture:
 *   1. Kiosk connects to /proxy with X-Machine-Key authentication
 *   2. Backend stores the connection in a pool keyed by deviceCode
 *   3. When the backend needs Weimi data, it picks any connected kiosk,
 *      sends a JSON message, and awaits the response (with timeout)
 *   4. Kiosk forwards the request to Weimi via its OkHttp client, sends
 *      the response back over the same websocket
 *
 * Protocol (see api-contract-addendum-proxy.md for full spec):
 *   Backend → Kiosk:  { id, action, params }
 *   Kiosk → Backend:  { id, ok, data?, error? }
 *   Either direction: { type: "ping" } / { type: "pong" }
 */

const crypto = require('crypto');
const { validateMachineKey } = require('./db');

// ─── Connection pool ──────────────────────────────────────────────────────────
// deviceCode → { socket, connectedAt, lastSeenAt, requestCount }
const connections = new Map();

// Pending requests we're waiting for the kiosk to answer
// requestId → { resolve, reject, timeoutId, deviceCode, action }
const pending = new Map();

const REQUEST_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS   = 25_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a request to any connected kiosk and await its response.
 *
 * @param {string} action  - 'deviceProfile' | 'deviceInfo' | 'queryOrders'
 * @param {object} params  - action-specific parameters
 * @returns {Promise<object>} - the data from Weimi as returned by the kiosk
 * @throws if no kiosks are connected, request times out, or kiosk reports error
 */
async function proxyRequest(action, params = {}) {
  const kiosk = pickKiosk();
  if (!kiosk) {
    const err = new Error('No kiosk available to proxy request');
    err.code = 'NO_PROXY_AVAILABLE';
    throw err;
  }

  const id      = crypto.randomUUID();
  const message = JSON.stringify({ id, action, params });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      const err = new Error(`Proxy request to ${kiosk.deviceCode} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      err.code = 'PROXY_TIMEOUT';
      reject(err);
    }, REQUEST_TIMEOUT_MS);

    pending.set(id, {
      resolve, reject, timeoutId,
      deviceCode: kiosk.deviceCode, action,
    });

    try {
      kiosk.socket.send(message);
      kiosk.requestCount++;
      console.log(`[PROXY] → ${kiosk.deviceCode} ${action} (id=${id.slice(0,8)})`);
    } catch (err) {
      clearTimeout(timeoutId);
      pending.delete(id);
      reject(err);
    }
  });
}

/** Pick which connected kiosk to proxy through. Round-robin by request count. */
function pickKiosk() {
  if (connections.size === 0) return null;
  const sorted = [...connections.values()].sort((a, b) => a.requestCount - b.requestCount);
  return sorted[0];
}

/** Status summary for the operator dashboard / debug endpoint. */
function status() {
  const list = [...connections.values()].map(c => ({
    deviceCode:   c.deviceCode,
    connectedAt:  new Date(c.connectedAt).toISOString(),
    lastSeenAt:   new Date(c.lastSeenAt).toISOString(),
    requestCount: c.requestCount,
  }));
  return {
    connected:   connections.size,
    pending:     pending.size,
    connections: list,
  };
}

// ─── WebSocket server attachment ──────────────────────────────────────────────

/**
 * Attach websocket handlers to an existing HTTP server.
 * Uses the `ws` library if available, falls back to a clear error if not.
 */
function attachToServer(server) {
  let WebSocketServer;
  try {
    ({ WebSocketServer } = require('ws'));
  } catch {
    console.error('\n[PROXY] ⚠ ws library not installed — kiosk proxy disabled.');
    console.error('[PROXY]   Run: npm install ws');
    console.error('[PROXY]   Without this, the dashboard cannot fetch live Weimi data.\n');
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/proxy')) {
      socket.destroy();
      return;
    }

    // Extract auth from query string (browsers can't set custom headers on WS)
    // Format: /proxy?deviceCode=XXX&machineKey=mk_live_...
    const url        = new URL(req.url, 'http://localhost');
    const deviceCode = url.searchParams.get('deviceCode');
    const machineKey = url.searchParams.get('machineKey');

    if (!deviceCode || !machineKey) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\nmissing deviceCode or machineKey');
      socket.destroy();
      return;
    }

    if (!validateMachineKey(deviceCode, machineKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\ninvalid machine key');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, deviceCode);
    });
  });

  console.log('[PROXY] WebSocket server attached at /proxy');
}

function handleConnection(ws, deviceCode) {
  // Close existing connection from same kiosk if any (kiosk reconnected)
  const existing = connections.get(deviceCode);
  if (existing) {
    console.log(`[PROXY] ${deviceCode} reconnecting — closing old socket`);
    try { existing.socket.close(); } catch {}
  }

  const conn = {
    deviceCode,
    socket:       ws,
    connectedAt:  Date.now(),
    lastSeenAt:   Date.now(),
    requestCount: 0,
  };
  connections.set(deviceCode, conn);
  console.log(`[PROXY] ✓ ${deviceCode} connected (${connections.size} total)`);

  // Keepalive ping
  const pingTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) { clearInterval(pingTimer); return; }
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
  }, PING_INTERVAL_MS);

  ws.on('message', (data) => {
    conn.lastSeenAt = Date.now();
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { console.warn(`[PROXY] ${deviceCode} sent invalid JSON`); return; }

    if (msg.type === 'pong' || msg.type === 'ping') {
      if (msg.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
      }
      return;
    }

    // Response to one of our requests
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      clearTimeout(p.timeoutId);
      pending.delete(msg.id);
      console.log(`[PROXY] ← ${deviceCode} ${p.action} (id=${msg.id.slice(0,8)}) ${msg.ok ? 'ok' : 'err'}`);
      if (msg.ok) {
        p.resolve(msg.data);
      } else {
        const err = new Error(msg.error || 'Kiosk proxy reported error');
        err.code = 'PROXY_ERROR';
        p.reject(err);
      }
      return;
    }

    console.warn(`[PROXY] ${deviceCode} sent unknown message:`, msg);
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    if (connections.get(deviceCode)?.socket === ws) {
      connections.delete(deviceCode);
      console.log(`[PROXY] ✗ ${deviceCode} disconnected (${connections.size} remaining)`);
    }
  });

  ws.on('error', (err) => {
    console.warn(`[PROXY] ${deviceCode} socket error:`, err.message);
  });
}

module.exports = { proxyRequest, status, attachToServer };
