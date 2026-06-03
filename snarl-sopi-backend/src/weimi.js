/**
 * Weimi API proxy.
 *
 * Handles all communication with the Weimi API server-side so that:
 *   1. The secret key never reaches the browser
 *   2. SHA-1 signing is done correctly (matching ApiSignGenerator.kt)
 *   3. CORS is not an issue
 *
 * Signing algorithm (from ApiSignGenerator.kt):
 *   SHA-1( "secretKey={k},nonce={n},timestamp={ms},appId={a},paramJson={j}" )
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// ─── Credentials (loaded from db / env at call time) ─────────────────────────

function getCredentials(apiConfig) {
  return {
    appId:     process.env.WEIMI_APP_ID     || apiConfig?.appId     || '8c98f0207729893439e089e3703b6b37',
    secretKey: process.env.WEIMI_SECRET_KEY || apiConfig?.secretKey || '1M1@#MLH4w#ko1k!/1D$',
    baseUrl:   apiConfig?.endpoint === 'prod'
      ? 'https://micron.weimi24.com/v8/third-center-web'
      : 'http://api.weimi24.com/v2022/third-center-web',
  };
}

// ─── Signing (mirrors ApiSignGenerator.kt exactly) ───────────────────────────

function canonicalJson(params) {
  // Sort keys alphabetically, exclude nulls — matches Jackson SORT_PROPERTIES_ALPHABETICALLY
  const sorted = Object.fromEntries(
    Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
  return JSON.stringify(sorted);
}

function buildSign(secretKey, nonce, timestamp, appId, paramJson) {
  const toSign = `secretKey=${secretKey},nonce=${nonce},timestamp=${timestamp},appId=${appId},paramJson=${paramJson}`;
  return crypto.createHash('sha1').update(toSign, 'utf8').digest('hex');
}

function buildHeaders(appId, secretKey, params) {
  const nonce     = crypto.randomUUID().replace(/-/g, '');
  const timestamp = Date.now();
  const paramJson = canonicalJson(params);
  const sign      = buildSign(secretKey, nonce, timestamp, appId, paramJson);
  return {
    'Client-Type': 'EXTERNAL',
    'APP_ID':      appId,
    'TIMESTAMP':   String(timestamp),
    'NONCE':       nonce,
    'SIGN':        sign,
    'Content-Type':'application/json',
    // OkHttp default User-Agent — Weimi uses this to identify Android clients
    'User-Agent':  'okhttp/4.12.0',
  };
}

// ─── HTTP request helper ──────────────────────────────────────────────────────

function weimiRequest(method, urlStr, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code !== 200) {
            reject(new Error(`Weimi API error ${json.code}: ${json.msg || data}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Weimi response parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Weimi request timed out')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Public API methods ───────────────────────────────────────────────────────
//
// Each Weimi endpoint has two callers:
//   1. Direct (e.g. deviceProfile)        — calls Weimi from this backend
//   2. Proxy variant (deviceProfileProxy) — routes through a connected kiosk
//
// The router always tries the proxy variant first since direct calls are
// blocked by Weimi's WAF (`host_not_allowed`) from non-Android clients.

const proxy = require('./proxy');

/**
 * GET /ext/device-profile via kiosk proxy.
 */
async function deviceProfileProxy(deviceCodes = []) {
  const data = await proxy.proxyRequest('deviceProfile', { deviceCodes });
  return data?.list || [];
}

/**
 * GET /ext/device-info via kiosk proxy.
 */
async function deviceInfoProxy(deviceCode) {
  const data = await proxy.proxyRequest('deviceInfo', { deviceCode });
  if (!data) throw new Error(`device-info returned no data for ${deviceCode}`);
  return data;
}

/**
 * POST /ext/query-order-list via kiosk proxy.
 */
async function queryOrdersProxy({ page = 1, size = 50, deviceCode, startDate, endDate } = {}) {
  const data = await proxy.proxyRequest('queryOrders', {
    current: page, size, deviceCode, startDate, endDate,
  });
  return data?.records || [];
}

/**
 * GET /ext/device-profile (direct from backend — blocked by Weimi WAF, kept for fallback).
 * Returns online/running status and stock total for one or more devices.
 */
async function deviceProfile(apiConfig, deviceCodes = []) {
  const { appId, secretKey, baseUrl } = getCredentials(apiConfig);
  const params = { deviceCodes: deviceCodes.join(',') };
  const headers = buildHeaders(appId, secretKey, params);
  const url = new URL(`${baseUrl}/ext/device-profile`);
  deviceCodes.forEach(c => url.searchParams.append('deviceCodes', c));
  // Weimi uses GET with query params for this endpoint
  const fullUrl = `${baseUrl}/ext/device-profile?deviceCodes=${deviceCodes.join(',')}`;
  const json = await weimiRequest('GET', fullUrl, headers, null);
  return json?.data?.list || [];
}

/**
 * GET /ext/device-info
 * Returns full cabinet/layer/aisle layout with stock and product info.
 */
async function deviceInfo(apiConfig, deviceCode) {
  const { appId, secretKey, baseUrl } = getCredentials(apiConfig);
  const params = { deviceCodes: deviceCode };
  const headers = buildHeaders(appId, secretKey, params);
  const fullUrl = `${baseUrl}/ext/device-info?deviceCodes=${deviceCode}`;
  const json = await weimiRequest('GET', fullUrl, headers, null);
  const dataArr = json?.data;
  if (!Array.isArray(dataArr) || dataArr.length === 0) {
    throw new Error(`device-info returned no data for ${deviceCode}`);
  }
  return dataArr[0];
}

/**
 * POST /ext/query-order-list
 * Returns paginated order list, optionally filtered by deviceCode and date range.
 */
async function queryOrders(apiConfig, { page = 1, size = 50, deviceCode, startDate, endDate } = {}) {
  const { appId, secretKey, baseUrl } = getCredentials(apiConfig);
  const params = { current: page, size };
  if (deviceCode) params.deviceCode = deviceCode;
  if (startDate)  params.startDate  = startDate;
  if (endDate)    params.endDate    = endDate;
  const headers = buildHeaders(appId, secretKey, params);
  const body    = canonicalJson(params);
  const json = await weimiRequest('POST', `${baseUrl}/ext/query-order-list`, headers, body);
  return json?.data?.records || [];
}

/**
 * Convert a flat list of Weimi aisles into deduplicated products.
 * Mirrors ProductMapping.kt toProducts() logic exactly.
 */
function aislesToProducts(aisles) {
  const categoryMap = {
    'orkudrykk': 'Drinks', 'drykk': 'Drinks',
    'kaffi': 'Coffee',
    'orkustang': 'Snacks', 'stang': 'Snacks',
    'sælg': 'Sweet', 'sætt': 'Sweet',
    'holl': 'Healthy',
  };

  function inferCategory(name, typeNames) {
    const types = typeNames.join(' ').toLowerCase();
    for (const [key, cat] of Object.entries(categoryMap)) {
      if (types.includes(key)) return cat;
    }
    const n = name.toLowerCase();
    if (['kaffi','espress','latte','cappuc'].some(k => n.includes(k))) return 'Coffee';
    if (['skyr','hydra','prótein','protein','oat king','barebells'].some(k => n.includes(k))) return 'Healthy';
    if (['powerade','fylkis','kók','cola','drykk','vatn'].some(k => n.includes(k))) return 'Drinks';
    if (['súkkul','sukkul','chocolate','choc','sætt','candy','nammi'].some(k => n.includes(k))) return 'Sweet';
    if (['corny','bar ','biscuit','chips','snakk','pagen','giff'].some(k => n.includes(k))) return 'Snacks';
    return 'Other';
  }

  const valid = aisles.filter(a => a.goodsName?.trim() && !a.isBroken && a.isEnable);
  const grouped = {};
  valid.forEach(a => {
    const key = a.goodsId || a.id;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(a);
  });

  return Object.entries(grouped).map(([productId, group]) => {
    const first = group[0];
    const name  = first.goodsName?.trim().toLowerCase();
    if (!name) return null;
    const slots      = group.map(a => a.code).filter(Boolean);
    const totalStock = group.reduce((s, a) => s + (a.currStock || 0), 0);
    const maxStock   = group.reduce((s, a) => s + (a.maxStock  || 0), 0);
    const typeNames  = (first.goodsTypeList || []).map(t => t.name);
    return {
      id:           productId,
      slot:         slots[0] || '',
      slots,
      name,
      subtitle:     null,
      priceIsk:     Math.round((first.price || 0) / 100),
      category:     inferCategory(name, typeNames),
      imagePath:    first.thumbnailUrl || first.imgUrl || null,
      stock:        totalStock,
      maxStock,
      displayOrder: 999,
      featured:     false,
      hidden:       false,
      hideWhenEmpty:true,
    };
  }).filter(Boolean);
}

module.exports = {
  deviceProfile, deviceInfo, queryOrders,
  deviceProfileProxy, deviceInfoProxy, queryOrdersProxy,
  aislesToProducts, getCredentials,
  rawDiagnostic, rawOrdersDiagnostic,
};

/** Low-level raw request that resolves with the full outcome, never throws. */
function _rawCall(method, url, headers, bodyStr) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return resolve({ error: e.message, url }); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const reqObj = lib.request({
      hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search, method, headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({
          httpStatus: res.statusCode,
          weimiCode: json?.code ?? null,
          weimiMsg: json?.msg ?? null,
          listLen: Array.isArray(json?.list) ? json.list.length
                 : Array.isArray(json?.data?.records) ? json.data.records.length
                 : Array.isArray(json?.data) ? json.data.length : null,
          bodyPreview: data.slice(0, 600),
        });
      });
    });
    reqObj.on('error', e => resolve({ error: e.message, code: e.code, url }));
    reqObj.setTimeout(15000, () => { reqObj.destroy(); resolve({ error: 'timeout', url }); });
    if (bodyStr) reqObj.write(bodyStr);
    reqObj.end();
  });
}

/**
 * Tries several shapes of the order-list call so we can see which (if any)
 * actually returns orders for a device. Forces production.
 */
async function rawOrdersDiagnostic({ deviceCode = '62160043' } = {}) {
  const { appId, secretKey, baseUrl } = getCredentials({ endpoint: 'prod' });
  const today = new Date();
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const d = x => x.toISOString().slice(0, 10);

  const variants = [
    { name: 'GET ?deviceCode',            method: 'GET',  params: { deviceCode },
      path: `/ext/query-order-list?deviceCode=${deviceCode}` },
    { name: 'GET ?deviceCode&tradeNo=',   method: 'GET',  params: { deviceCode, tradeNo: '' },
      path: `/ext/query-order-list?deviceCode=${deviceCode}&tradeNo=` },
    { name: 'POST current/size/device',   method: 'POST', params: { current: 1, size: 20, deviceCode } },
    { name: 'POST device+dates',          method: 'POST', params: { current: 1, size: 20, deviceCode, startDate: d(weekAgo), endDate: d(today) } },
  ];

  const out = [];
  for (const v of variants) {
    const headers = buildHeaders(appId, secretKey, v.params);
    let url, body = null;
    if (v.method === 'GET') {
      url = `${baseUrl}${v.path}`;
    } else {
      url = `${baseUrl}/ext/query-order-list`;
      body = canonicalJson(v.params);
    }
    const res = await _rawCall(v.method, url, headers, body);
    out.push({ variant: v.name, method: v.method, url, ...res });
  }
  return { deviceCode, baseUrl, variants: out };
}

/**
 * Diagnostic helper: makes one signed GET to /ext/device-profile and returns
 * the FULL raw outcome (HTTP status, body, the exact URL and headers used)
 * WITHOUT throwing on a non-200 Weimi code. Used to figure out whether the
 * connectivity block is domain, IP, or auth related.
 *
 * env: 'prod' -> https://micron.weimi24.com/v8/...   (foreign production)
 *      'test' -> http://api.weimi24.com/v2022/...     (test)
 */
function rawDiagnostic({ env = 'prod', deviceCode = '62160485' } = {}) {
  const apiConfig = { endpoint: env === 'test' ? 'test' : 'prod' };
  const { appId, secretKey, baseUrl } = getCredentials(apiConfig);
  const params  = { deviceCodes: deviceCode };
  const headers = buildHeaders(appId, secretKey, params);
  const url     = `${baseUrl}/ext/device-profile?deviceCodes=${deviceCode}`;

  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { return resolve({ ok: false, stage: 'url', error: e.message, url, baseUrl }); }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const started = Date.now();
    const reqObj = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          stage: 'response',
          env, baseUrl, url,
          httpStatus: res.statusCode,
          weimiCode: json?.code ?? null,
          weimiMsg:  json?.msg ?? null,
          bodyPreview: data.slice(0, 500),
          ms: Date.now() - started,
        });
      });
    });
    reqObj.on('error', (e) => resolve({ ok: false, stage: 'network', error: e.message, code: e.code, env, baseUrl, url }));
    reqObj.setTimeout(15000, () => { reqObj.destroy(); resolve({ ok: false, stage: 'timeout', error: 'timed out after 15s', env, baseUrl, url }); });
    reqObj.end();
  });
}
