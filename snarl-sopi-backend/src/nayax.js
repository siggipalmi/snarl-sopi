/**
 * Nayax Lynx API client.
 *
 * Bearer token auth — no signing, no IP whitelisting required. The token
 * is generated in Nayax Core under Account Settings → Security & Login → User Tokens.
 *
 * Configured via env:
 *   NAYAX_TOKEN  — required; the bearer token
 *   NAYAX_ENV    — 'prod' (default) or 'qa'
 *
 * Endpoints used (Lynx v1):
 *   GET /operational/v1/machines                            — list all machines (filterable)
 *   GET /operational/v1/machines/{MachineID}                — one machine by Nayax ID
 *   GET /operational/v1/devices/{DeviceSerialNumber}/machine — lookup by reader serial
 *   GET /operational/v1/machines/{MachineID}/lastsales      — last sales for a machine
 *
 * All methods return promises. Network/auth errors throw with a descriptive .code:
 *   NAYAX_NOT_CONFIGURED — no NAYAX_TOKEN set
 *   NAYAX_AUTH           — 401 from Nayax (bad/expired token)
 *   NAYAX_RATE_LIMITED   — 429
 *   NAYAX_API_ERROR      — anything else non-2xx
 *   NAYAX_NETWORK        — fetch threw before getting a response
 */

const TOKEN = process.env.NAYAX_TOKEN || '';
const ENV   = (process.env.NAYAX_ENV || 'prod').toLowerCase();

const BASE = ENV === 'qa'
  ? 'https://qa-lynx.nayax.com'
  : 'https://lynx.nayax.com';

function isConfigured() { return Boolean(TOKEN); }

function err(code, message, status, body) {
  const e = new Error(message);
  e.code = code;
  if (status !== undefined) e.status = status;
  if (body !== undefined)   e.body = body;
  return e;
}

async function request(path, { method = 'GET', query, signal } = {}) {
  if (!TOKEN) throw err('NAYAX_NOT_CONFIGURED', 'NAYAX_TOKEN env variable not set');

  let url = BASE + path;
  if (query && typeof query === 'object') {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
      .join('&');
    if (qs) url += '?' + qs;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Accept':        'application/json',
      },
      signal: signal || AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw err('NAYAX_NETWORK', 'Network error calling Nayax: ' + e.message);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (response.status === 401) throw err('NAYAX_AUTH',         'Nayax rejected the token (401)', 401, body);
  if (response.status === 429) throw err('NAYAX_RATE_LIMITED', 'Nayax rate-limited the request (429)', 429, body);
  if (!response.ok)            throw err('NAYAX_API_ERROR',    `Nayax returned HTTP ${response.status}`, response.status, body);

  return body;
}

// ─── Methods ──────────────────────────────────────────────────────────────────

async function listMachines({ limit = 100, offset = 0, operatorIdentifier, machineName } = {}) {
  return request('/operational/v1/machines', {
    query: { ResultsLimit: limit, ResultsOffset: offset, OperatorIdentifier: operatorIdentifier, MachineName: machineName },
  });
}

async function getMachineById(machineId) {
  if (!machineId) throw err('NAYAX_API_ERROR', 'machineId required');
  return request('/operational/v1/machines/' + encodeURIComponent(machineId));
}

async function getMachineByDeviceSerial(deviceSerial) {
  if (!deviceSerial) throw err('NAYAX_API_ERROR', 'deviceSerial required');
  return request('/operational/v1/devices/' + encodeURIComponent(deviceSerial) + '/machine');
}

async function getLastSales(machineId, { limit = 50 } = {}) {
  if (!machineId) throw err('NAYAX_API_ERROR', 'machineId required');
  return request('/operational/v1/machines/' + encodeURIComponent(machineId) + '/lastsales', {
    query: { ResultsLimit: limit },
  });
}

/**
 * Connection check — calls listMachines with limit 1 to verify the token works.
 */
async function ping() {
  const body = await listMachines({ limit: 1 });
  return {
    ok:       true,
    env:      ENV,
    base:     BASE,
    sampleMachineCount: Array.isArray(body) ? body.length : (body?.Results?.length ?? 0),
  };
}

module.exports = {
  isConfigured, ping,
  listMachines, getMachineById, getMachineByDeviceSerial, getLastSales,
};
