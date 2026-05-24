/**
 * Snarl & Sopi frá AG Vending — Operator Backend
 * Route handlers implementing API Contract v0.1
 *
 * Kiosk-facing endpoints (contract section 2–3):
 *   POST /api/v1/machines/provision
 *   GET  /api/v1/machines/:deviceCode/config
 *
 * Operator dashboard endpoints:
 *   POST /api/v1/auth/login
 *   GET  /api/v1/machines
 *   GET  /api/v1/machines/:deviceCode
 *   PUT  /api/v1/machines/:deviceCode/profile
 *   PUT  /api/v1/machines/:deviceCode/featured
 *   PUT  /api/v1/machines/:deviceCode/ads
 *   PUT  /api/v1/machines/:deviceCode/settings
 *   POST /api/v1/machines/:deviceCode/revoke-key
 *   GET  /api/v1/alerts
 *   POST /api/v1/alerts/:id/resolve
 *   GET  /api/v1/orders
 *   GET  /api/v1/reports/summary
 *   GET  /api/v1/users
 *   POST /api/v1/users
 *   GET  /health
 *
 * Weimi proxy endpoints:
 *   GET  /api/v1/weimi/devices
 *   GET  /api/v1/weimi/device/:deviceCode
 *   GET  /api/v1/weimi/orders
 *   POST /api/v1/weimi/sync/:deviceCode
 */

const {
  machines, alerts, orders, users, authTokens, apiConfig,
  machineKeys, provisionMachine, validateMachineKey, revokeKey,
  buildConfigResponse, touchConfig,
} = require('./db');
const { createToken, requireAuth, requireAdmin } = require('./auth');
const { ok, created, notFound, badRequest, serverError, json,
        validateSettings, validateFeatured } = require('./helpers');
const weimi = require('./weimi');

// ─── Route table ──────────────────────────────────────────────────────────────

const routes = [
  { method:'GET',  pattern:'/health',                                        handler: handleHealth },
  { method:'GET',  pattern:'/whatismyip',                                    handler: handleWhatIsMyIp },
  { method:'GET',  pattern:'/api/v1/proxy/status',                           handler: handleProxyStatus, middleware:[requireAuth] },

  // Auth
  { method:'POST', pattern:'/api/v1/auth/login',                             handler: handleLogin },

  // ── Kiosk-facing (contract v0.1) ──────────────────────────────────────────
  { method:'POST', pattern:'/api/v1/machines/provision',                     handler: handleProvision },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/config',            handler: handleConfig,      middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/sales',             handler: handleSalesIngest, middleware:[requireMachineKey] },

  // ── Operator dashboard — machines ─────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/machines',                               handler: handleListMachines, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode',                   handler: handleGetMachine,   middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/profile',           handler: handleUpdateProfile,middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/featured',          handler: handleSetFeatured,  middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/ads',               handler: handleSetAds,       middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/settings',          handler: handleUpdateSettings,middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/revoke-key',        handler: handleRevokeKey,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/machines',                               handler: handleAddMachine,   middleware:[requireAuth] },

  // ── Operator dashboard — other ────────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/alerts',                                 handler: handleListAlerts,   middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/alerts/:id/resolve',                     handler: handleResolveAlert, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/orders',                                 handler: handleListOrders,   middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/orders/today',                           handler: handleMachineSalesToday, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/summary',                        handler: handleReportSummary,middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/users',                                  handler: handleListUsers,    middleware:[requireAuth, requireAdmin] },
  { method:'POST', pattern:'/api/v1/users',                                  handler: handleInviteUser,   middleware:[requireAuth, requireAdmin] },

  // ── Weimi proxy ───────────────────────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/weimi/devices',                          handler: handleWeimiDevices, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/weimi/device/:deviceCode',               handler: handleWeimiDevice,  middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/weimi/orders',                           handler: handleWeimiOrders,  middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/weimi/sync/:deviceCode',                 handler: handleWeimiSync,    middleware:[requireAuth] },
];

// ─── Router ───────────────────────────────────────────────────────────────────

function router(req, res) {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  for (const route of routes) {
    if (route.method !== req.method) continue;
    const params = matchPattern(route.pattern, pathname);
    if (params === null) continue;
    req.params = params;
    req.query  = Object.fromEntries(url.searchParams.entries());
    const chain = [...(route.middleware || []), route.handler];
    let i = 0;
    function next() {
      const fn = chain[i++];
      if (fn) { try { fn(req, res, next); } catch (err) { serverError(res, err); } }
    }
    next();
    return;
  }
  contractError(res, 404, 'not_found', `No route for ${req.method} ${pathname}`, `No route for ${req.method} ${pathname}`);
}

function matchPattern(pattern, pathname) {
  const patParts = pattern.split('/');
  const urlParts = pathname.split('/');
  if (patParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
    } else if (patParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

// ─── Contract error shape (section 5) ────────────────────────────────────────

function contractError(res, status, code, messageIs, messageEn) {
  json(res, status, { error: { code, message: messageIs, messageEn } });
}

// ─── Machine key middleware ───────────────────────────────────────────────────

function requireMachineKey(req, res, next) {
  const key        = req.headers['x-machine-key'];
  const deviceCode = req.params.deviceCode;
  if (!key) return contractError(res, 401, 'missing_key', 'Vantar X-Machine-Key haus.', 'Missing X-Machine-Key header.');
  if (!validateMachineKey(deviceCode, key)) {
    return contractError(res, 401, 'invalid_key', 'Lykill er ógildur eða útrunninn.', 'Machine key is invalid, expired, or revoked.');
  }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  ok(res, { status: 'ok', version: '2.0.0', contract: 'v0.1', uptime: process.uptime() });
}

/**
 * GET /whatismyip
 * Calls an external service to determine the public IP this server uses
 * for outbound requests. Useful for getting the IP that needs to be
 * whitelisted by Weimi.
 */
function handleWhatIsMyIp(req, res) {
  const https = require('https');
  https.get('https://api.ipify.org?format=json', r => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        ok(res, {
          publicIp: parsed.ip,
          note: 'This is the outgoing IP Weimi sees when this backend calls their API. Give this IP to Weimi support for whitelisting.',
        });
      } catch {
        json(res, 502, { ok: false, error: 'Could not parse ipify response', raw: data });
      }
    });
  }).on('error', err => {
    json(res, 502, { ok: false, error: 'Could not reach ipify', detail: err.message });
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

function handleLogin(req, res) {
  const { email, password } = req.body || {};
  if (!email || !password) return badRequest(res, 'email and password required');
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return json(res, 401, { ok: false, error: 'Invalid credentials' });
  const token = createToken(user.id);
  user.lastActiveAt = new Date().toISOString();
  ok(res, { token, user: publicUser(user) });
}

// ─── Provisioning (contract section 2.2) ─────────────────────────────────────

function handleProvision(req, res) {
  const { deviceCode } = req.body || {};
  if (!deviceCode) return contractError(res, 400, 'missing_device_code', 'Vantar deviceCode.', 'deviceCode is required.');

  const result = provisionMachine(deviceCode);

  if (result.error === 'device_not_found') {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${deviceCode} er ekki skráð í kerfinu.`,
      `Device code ${deviceCode} is not registered.`);
  }
  if (result.error === 'already_provisioned') {
    return contractError(res, 409, 'already_provisioned',
      `Tæki ${deviceCode} hefur þegar verið úthlutað lykli. Afturkallið núverandi lykil á stjórnborðinu.`,
      `Device ${deviceCode} already has an active key. Revoke it from the dashboard before re-provisioning.`);
  }

  console.log(`[PROVISION] ${deviceCode} → key issued`);
  ok(res, { machineKey: result.machineKey, deviceCode: result.deviceCode });
}

// ─── Config endpoint (contract section 3) ────────────────────────────────────

/**
 * POST /api/v1/machines/:deviceCode/sales
 *
 * Receives sales events from the kiosk app after a successful dispense.
 * The kiosk POSTs one record per completed sale (or a batch if it was offline).
 *
 * Body shape:
 *   {
 *     tradeNo:     string,   // unique transaction id from Weimi or local
 *     goodsId:     string,   // product id
 *     productName: string,   // for display in operator dashboard
 *     amountKr:    number,   // amount charged in ISK
 *     timestamp:   number,   // UTC epoch ms when the sale completed
 *     status:      number    // 1 = success, 2 = failed, 3 = refunded
 *   }
 *
 * Or an array of the above for batch upload (offline queue flush).
 */
function handleSalesIngest(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${deviceCode} er ekki skráð.`,
      `Device ${deviceCode} is not registered.`);
  }

  const records = Array.isArray(req.body) ? req.body : [req.body];
  const errors  = [];
  const accepted = [];
  const duplicates = [];

  records.forEach((r, i) => {
    if (!r.tradeNo)                                   { errors.push(`[${i}] tradeNo required`);     return; }
    if (typeof r.amountKr !== 'number')               { errors.push(`[${i}] amountKr must be number`); return; }
    if (typeof r.timestamp !== 'number')              { errors.push(`[${i}] timestamp must be epoch ms`); return; }
    if (![1, 2, 3].includes(r.status))                { errors.push(`[${i}] status must be 1|2|3`); return; }

    // Reject duplicates by tradeNo (idempotent — kiosk can safely retry)
    if (orders.find(o => o.tradeNo === r.tradeNo)) {
      duplicates.push(r.tradeNo);
      return;
    }

    orders.push({
      tradeNo:    r.tradeNo,
      deviceCode,
      goodsId:    r.goodsId    || null,
      productName:r.productName || '',
      totalAmount:Math.round(r.amountKr * 100), // store in hundredths matching Weimi
      amountKr:   r.amountKr,
      status:     r.status,
      statusLabel:{1:'success',2:'failed',3:'refunded'}[r.status],
      createTime: r.timestamp,
    });
    accepted.push(r.tradeNo);
  });

  if (errors.length) return badRequest(res, 'Validation failed', errors);

  console.log(`[SALES] ${deviceCode} accepted ${accepted.length}, duplicates ${duplicates.length}`);
  ok(res, { accepted: accepted.length, duplicates: duplicates.length, total: records.length });
}

function handleConfig(req, res) {
  const machine = machines[req.params.deviceCode];
  if (!machine) {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${req.params.deviceCode} er ekki skráð í kerfinu.`,
      `Device ${req.params.deviceCode} is not registered.`);
  }

  // 304 Not Modified support (contract section 3.2, configVersion)
  const clientVersion = req.headers['if-none-match'];
  if (clientVersion && clientVersion === machine.configVersion) {
    res.writeHead(304); res.end(); return;
  }

  ok(res, buildConfigResponse(machine));
}

// ─── Operator: machines ───────────────────────────────────────────────────────

function handleListMachines(req, res) {
  const list = Object.values(machines).map(m => ({
    ...machineSummary(m),
    keyStatus: machineKeys[m.deviceCode]
      ? (machineKeys[m.deviceCode].revokedAt ? 'revoked' : 'active')
      : 'not_provisioned',
  }));
  ok(res, list, { total: list.length });
}

function handleGetMachine(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  ok(res, {
    ...machineDetail(m),
    keyStatus: machineKeys[m.deviceCode]
      ? (machineKeys[m.deviceCode].revokedAt ? 'revoked' : 'active')
      : 'not_provisioned',
    configPreview: buildConfigResponse(m),
  });
}

function handleAddMachine(req, res) {
  const { deviceCode, deviceName, location, operatorName } = req.body || {};
  if (!deviceCode || !deviceName) return badRequest(res, 'deviceCode and deviceName required');
  if (machines[deviceCode]) return badRequest(res, 'Device code already exists');
  machines[deviceCode] = {
    deviceCode, deviceName, location: location || '', isOnline: false, isRunning: false,
    kioskVersion: null, totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: operatorName || 'AG Vending', supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: deviceName },
    featured: [], ads: [],
    configVersion: new Date().toISOString(),
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: true, heatedGlassDefaultOn: true, hasLedStrips: true, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  created(res, machineSummary(machines[deviceCode]));
}

// ── PUT /machines/:deviceCode/profile ─────────────────────────────────────────
// Updates the contract `profile` fields. Bumps configVersion.
function handleUpdateProfile(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  const allowed = ['operatorName', 'supportEmail', 'supportPhone', 'machineLabel'];
  allowed.forEach(k => { if (req.body[k] !== undefined) m.profile[k] = req.body[k]; });
  touchConfig(m);
  ok(res, { profile: m.profile, configVersion: m.configVersion });
}

// ── PUT /machines/:deviceCode/featured ────────────────────────────────────────
// Replaces featured array. Bumps configVersion.
function handleSetFeatured(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  if (!Array.isArray(req.body)) return badRequest(res, 'Body must be an array');
  if (req.body.length > 8) return badRequest(res, 'Maximum 8 featured products');
  const errors = [];
  req.body.forEach((item, i) => {
    if (!item.goodsId?.trim()) errors.push(`[${i}] goodsId required`);
    if (!item.tag?.trim())     errors.push(`[${i}] tag required`);
    if (typeof item.order !== 'number') errors.push(`[${i}] order must be a number`);
  });
  if (errors.length) return badRequest(res, 'Validation failed', errors);
  m.featured = req.body.map(item => ({
    goodsId: item.goodsId.trim(),
    tag:     item.tag.trim(),
    order:   item.order,
  }));
  touchConfig(m);
  ok(res, { featured: m.featured, configVersion: m.configVersion });
}

// ── PUT /machines/:deviceCode/ads ─────────────────────────────────────────────
// Replaces ads array. Bumps configVersion.
function handleSetAds(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  if (!Array.isArray(req.body)) return badRequest(res, 'Body must be an array');
  const errors = [];
  req.body.forEach((ad, i) => {
    if (!['video','image'].includes(ad.type)) errors.push(`[${i}] type must be "video" or "image"`);
    if (!ad.url?.startsWith('https://'))      errors.push(`[${i}] url must be an HTTPS URL`);
    if (ad.type === 'image' && typeof ad.durationSec !== 'number') errors.push(`[${i}] durationSec required for images`);
    if (ad.overlayText && ad.overlayText.length > 80) errors.push(`[${i}] overlayText must be ≤80 chars`);
  });
  if (errors.length) return badRequest(res, 'Validation failed', errors);
  m.ads = req.body.map(ad => ({
    type:        ad.type,
    url:         ad.url,
    durationSec: ad.durationSec ?? null,
    overlayText: ad.overlayText ?? null,
  }));
  touchConfig(m);
  ok(res, { ads: m.ads, configVersion: m.configVersion });
}

// ── PUT /machines/:deviceCode/settings ────────────────────────────────────────
// Updates hardware/display settings (operator dashboard only, not sent to kiosk).
function handleUpdateSettings(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  const { valid, errors } = validateSettings(req.body);
  if (!valid) return badRequest(res, 'Validation failed', errors);
  const allowed = ['showAdRegion','showLeftHero','showRightHero','showIdleScreen','idleTimeoutSeconds','defaultLanguage','availableLanguages','hasHeatedGlass','heatedGlassDefaultOn','hasLedStrips','ledBrightness','motorSerialPort','controlBoardAddress'];
  allowed.forEach(k => { if (req.body[k] !== undefined) m.settings[k] = req.body[k]; });
  m.updatedAt = new Date().toISOString();
  ok(res, { settings: m.settings });
}

// ── POST /machines/:deviceCode/revoke-key ─────────────────────────────────────
function handleRevokeKey(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  revokeKey(req.params.deviceCode);
  ok(res, { deviceCode: req.params.deviceCode, revokedAt: machineKeys[req.params.deviceCode]?.revokedAt });
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

function handleListAlerts(req, res) {
  const { type, deviceCode, resolved } = req.query;
  let result = [...alerts];
  if (type)       result = result.filter(a => a.type === type);
  if (deviceCode) result = result.filter(a => a.deviceCode === deviceCode);
  if (resolved !== undefined) result = result.filter(a => a.resolved === (resolved === 'true'));
  ok(res, result, { total: result.length });
}

function handleResolveAlert(req, res) {
  const alert = alerts.find(a => a.id === req.params.id);
  if (!alert) return notFound(res, `Alert ${req.params.id} not found`);
  alert.resolved   = true;
  alert.resolvedAt = new Date().toISOString();
  ok(res, alert);
}

// ─── Orders ───────────────────────────────────────────────────────────────────

function handleListOrders(req, res) {
  const { deviceCode, page = '1', size = '50', today } = req.query;
  let result = [...orders];
  if (deviceCode) result = result.filter(o => o.deviceCode === deviceCode);

  // today=1 filters from 00:00 UTC
  if (today === '1') {
    const d = new Date();
    const todayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    result = result.filter(o => o.createTime >= todayUTC);
  }

  result.sort((a, b) => b.createTime - a.createTime);
  const pageNum  = Math.max(1, parseInt(page));
  const pageSize = Math.min(100, Math.max(1, parseInt(size)));
  const total    = result.length;
  const slice    = result.slice((pageNum - 1) * pageSize, pageNum * pageSize);

  // Add todayUTC to metadata so frontend can trust the server's clock
  const d = new Date();
  const todayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  ok(res, slice.map(o => ({ ...o, machineName: machines[o.deviceCode]?.deviceName || o.deviceCode })),
    { total, page: pageNum, size: pageSize, pages: Math.ceil(total / pageSize), todayUTC });
}

// ─── Per-machine today sales summary ──────────────────────────────────────────

function handleMachineSalesToday(req, res) {
  const d = new Date();
  const todayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const todayOrders = orders.filter(o => o.status === 1 && o.createTime >= todayUTC);

  const byMachine = {};
  Object.keys(machines).forEach(code => { byMachine[code] = { orders: 0, revenueKr: 0 }; });
  todayOrders.forEach(o => {
    if (!byMachine[o.deviceCode]) byMachine[o.deviceCode] = { orders: 0, revenueKr: 0 };
    byMachine[o.deviceCode].orders++;
    byMachine[o.deviceCode].revenueKr += o.amountKr;
  });

  ok(res, {
    todayUTC,
    todayDate: new Date(todayUTC).toISOString().slice(0, 10),
    totalOrders: todayOrders.length,
    totalRevenueKr: todayOrders.reduce((s, o) => s + o.amountKr, 0),
    byMachine,
  });
}

// ─── Reports ──────────────────────────────────────────────────────────────────

function handleReportSummary(req, res) {
  const success = orders.filter(o => o.status === 1);
  const total   = success.reduce((s, o) => s + o.totalAmount, 0);
  ok(res, {
    totalOrders:    orders.length,
    successOrders:  success.length,
    totalRevenueKr: Math.round(total / 100),
    avgOrderValueKr:success.length ? Math.round(total / success.length / 100) : 0,
    refundRate:     orders.length  ? Math.round(orders.filter(o=>o.status===3).length / orders.length * 1000) / 10 : 0,
    byMachine: Object.values(machines).map(m => {
      const mo = orders.filter(o => o.deviceCode === m.deviceCode && o.status === 1);
      return { deviceCode: m.deviceCode, machineName: m.deviceName, orders: mo.length, revenueKr: Math.round(mo.reduce((s,o)=>s+o.totalAmount,0)/100) };
    }),
  });
}

// ─── Users ────────────────────────────────────────────────────────────────────

function handleListUsers(req, res) { ok(res, users.map(publicUser), { total: users.length }); }

function handleInviteUser(req, res) {
  const { name, email, role } = req.body || {};
  if (!name || !email || !role) return badRequest(res, 'name, email, and role required');
  if (!['super_admin','operator','technician'].includes(role)) return badRequest(res, 'invalid role');
  if (users.find(u => u.email === email)) return badRequest(res, 'Email already exists');
  const newUser = { id: `u${users.length+1}`, name, email, password: 'demo', role, machineAccess: 'all', lastActiveAt: null };
  users.push(newUser);
  created(res, publicUser(newUser));
}

// ─── Weimi proxy handlers ─────────────────────────────────────────────────────

async function handleWeimiDevices(req, res) {
  try {
    const codes    = Object.keys(machines).filter(c => !machines[c].unsupported && machines[c].isKioskModel !== false);
    const profiles = await weimi.deviceProfileProxy(codes);
    profiles.forEach(p => {
      if (machines[p.deviceCode]) {
        machines[p.deviceCode].isOnline      = p.isOnline  === true || p.isOnline  === 1;
        machines[p.deviceCode].isRunning     = p.isRunning === true || p.isRunning === 1;
        machines[p.deviceCode].totalCurrStock= p.totalCurrStock || 0;
        if (p.deviceName) machines[p.deviceCode].deviceName = p.deviceName;
      }
    });
    ok(res, profiles, { synced: profiles.length, via: 'kiosk-proxy' });
  } catch (err) {
    console.error('[Weimi] deviceProfile:', err.message);
    const status = err.code === 'NO_PROXY_AVAILABLE' ? 503 : 502;
    json(res, status, { ok: false, error: 'Weimi proxy error', detail: err.message, code: err.code });
  }
}

async function handleWeimiDevice(req, res) {
  const { deviceCode } = req.params;
  try {
    const info      = await weimi.deviceInfoProxy(deviceCode);
    const allAisles = info.cabinets?.flatMap(c => c.layers?.flatMap(l => l.aisles || []) || []) || [];
    const products  = weimi.aislesToProducts(allAisles);
    if (machines[deviceCode]) {
      machines[deviceCode].products        = products;
      machines[deviceCode].totalCurrStock  = products.reduce((s,p)=>s+p.stock,0);
      machines[deviceCode].maxStock        = products.reduce((s,p)=>s+(p.maxStock||0),0);
      machines[deviceCode].updatedAt       = new Date().toISOString();
    }
    ok(res, { deviceCode, productCount: products.length, products, via: 'kiosk-proxy' });
  } catch (err) {
    console.error('[Weimi] deviceInfo:', err.message);
    const status = err.code === 'NO_PROXY_AVAILABLE' ? 503 : 502;
    json(res, status, { ok: false, error: 'Weimi proxy error', detail: err.message, code: err.code });
  }
}

async function handleWeimiOrders(req, res) {
  const { deviceCode, page, size, startDate, endDate } = req.query;
  try {
    const records = await weimi.queryOrdersProxy({ page: parseInt(page)||1, size: parseInt(size)||50, deviceCode, startDate, endDate });
    ok(res, records.map(o => ({ ...o, statusLabel: {1:'success',2:'failed',3:'refunded'}[o.status]||'unknown', amountKr: Math.round((o.totalAmount||0)/100), machineName: machines[o.deviceCode]?.deviceName || o.deviceCode })), { via: 'kiosk-proxy' });
  } catch (err) {
    console.error('[Weimi] queryOrders:', err.message);
    const status = err.code === 'NO_PROXY_AVAILABLE' ? 503 : 502;
    json(res, status, { ok: false, error: 'Weimi proxy error', detail: err.message, code: err.code });
  }
}

async function handleWeimiSync(req, res) {
  const { deviceCode } = req.params;
  try {
    const [profiles, info] = await Promise.all([
      weimi.deviceProfileProxy([deviceCode]),
      weimi.deviceInfoProxy(deviceCode),
    ]);
    const profile   = profiles[0] || {};
    const allAisles = info.cabinets?.flatMap(c => c.layers?.flatMap(l => l.aisles||[]) || []) || [];
    const products  = weimi.aislesToProducts(allAisles);
    if (!machines[deviceCode]) {
      machines[deviceCode] = { deviceCode, deviceName: profile.deviceName||deviceCode, location:'', isOnline:false, isRunning:false, kioskVersion:null, totalCurrStock:0, maxStock:0, profile:{ operatorName:'AG Vending', supportEmail:'hallo@snarlogsopi.is', supportPhone:null, machineLabel:profile.deviceName||deviceCode }, featured:[], ads:[], configVersion:new Date().toISOString(), settings:{ showAdRegion:true,showLeftHero:true,showRightHero:true,showIdleScreen:false,idleTimeoutSeconds:60,defaultLanguage:'Icelandic',availableLanguages:['Icelandic','English'],hasHeatedGlass:true,heatedGlassDefaultOn:true,hasLedStrips:true,ledBrightness:8,motorSerialPort:'/dev/ttyS3',controlBoardAddress:0 }, products:[], productOverrides:{}, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
    }
    const m = machines[deviceCode];
    m.isOnline       = profile.online || profile.isOnline || false;
    m.isRunning      = profile.running|| profile.isRunning|| false;
    m.deviceName     = profile.deviceName || profile.displayName || m.deviceName;
    m.products       = products;
    m.totalCurrStock = products.reduce((s,p)=>s+p.stock,0);
    m.maxStock       = products.reduce((s,p)=>s+(p.maxStock||0),0);
    m.updatedAt      = new Date().toISOString();
    ok(res, { deviceCode, deviceName: m.deviceName, isOnline: m.isOnline, productCount: products.length, totalStock: m.totalCurrStock, syncedAt: m.updatedAt, via: 'kiosk-proxy' });
  } catch (err) {
    console.error('[Weimi] sync:', err.message);
    const status = err.code === 'NO_PROXY_AVAILABLE' ? 503 : 502;
    json(res, status, { ok: false, error: 'Weimi proxy error', detail: err.message, code: err.code });
  }
}

function handleProxyStatus(req, res) {
  const proxy = require('./proxy');
  ok(res, proxy.status());
}

// ─── View models ──────────────────────────────────────────────────────────────

function machineSummary(m) {
  return {
    deviceCode: m.deviceCode, deviceName: m.deviceName, location: m.location,
    isOnline: m.isOnline, isRunning: m.isRunning, kioskVersion: m.kioskVersion,
    totalCurrStock: m.totalCurrStock, maxStock: m.maxStock,
    stockPercent: m.maxStock > 0 ? Math.round(m.totalCurrStock / m.maxStock * 100) : 0,
    unsupported: m.unsupported || false,
    operatorName: m.profile.operatorName,
    configVersion: m.configVersion,
    updatedAt: m.updatedAt,
  };
}

function machineDetail(m) {
  return { ...machineSummary(m), profile: m.profile, featured: m.featured, ads: m.ads, settings: m.settings, productOverrides: m.productOverrides, createdAt: m.createdAt };
}

function publicUser(u) {
  const { password, ...safe } = u; return safe;
}

module.exports = { router };
