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
  operators, machines, alerts, orders, users, authTokens, apiConfig,
  storage,
  provisionMachine, validateMachineKey, revokeKey,
  buildConfigResponse, touchConfig,
  userCanAccessMachine, userCanAccessOperator, machinesForUser, operatorsForUser,
  userCanInviteTo, userCanReassignWithin,
  invitations, createInvitation, getInvitation, consumeInvitation,
} = require('./db');
const { createToken, requireAuth, requireAdmin, requireAgAdmin,
        requireOperatorAdmin, requireMachineAccess, requireOperatorAccess,
        revokeToken } = require('./auth');
const email = require('./email');
const crypto = require('crypto');
const { ok, created, notFound, badRequest, serverError, json,
        validateSettings, validateFeatured } = require('./helpers');
const weimi = require('./weimi');

// ─── Route table ──────────────────────────────────────────────────────────────

const routes = [
  { method:'GET',  pattern:'/health',                                        handler: handleHealth },
  { method:'GET',  pattern:'/whatismyip',                                    handler: handleWhatIsMyIp },
  { method:'GET',  pattern:'/api/v1/proxy/status',                           handler: handleProxyStatus, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/debug/outbound-ip',                       handler: handleOutboundIp },
  { method:'GET',  pattern:'/api/v1/debug/weimi-test',                        handler: handleWeimiTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-orders',                      handler: handleWeimiOrdersTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-device',                      handler: handleWeimiDeviceDigest },
  { method:'GET',  pattern:'/api/v1/debug/shipment-status',                   handler: (req,res)=>ok(res,{ breakdown: require('./storage').shipmentStatusBreakdown(), note:'shipmentStatus 1 = delivered; anything else = not dispensed' }) },
  { method:'GET',  pattern:'/api/v1/debug/kiosk-config',                      handler: (req,res)=>{ const c=req.query?.deviceCode; const m=c&&machines[c]; if(!m) return json(res,404,{ok:false,error:'machine not found — pass ?deviceCode='}); return ok(res, buildConfigResponse(m)); } },
  { method:'GET',  pattern:'/api/v1/debug/telemetry',                         handler: (req,res)=>{ const c=req.query?.deviceCode; if(!c) return ok(res,{ all: lastTelemetry }); return ok(res, lastTelemetry[c] || { note:'no telemetry received yet for '+c }); } },
  { method:'GET',  pattern:'/api/v1/debug/weimi-write-test',                  handler: handleWeimiWriteTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-fleet',                       handler: handleWeimiFleetDigest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-goods-library',               handler: handleWeimiGoodsLibrary },
  { method:'GET',  pattern:'/api/v1/debug/r2-test',                           handler: handleR2Test },
  { method:'GET',  pattern:'/api/v1/debug/weimi-query-goods',                 handler: handleWeimiQueryGoods },
  { method:'GET',  pattern:'/api/v1/debug/save-goods-test',                   handler: handleSaveGoodsTest },
  { method:'GET',  pattern:'/api/v1/debug/order-times',                       handler: handleOrderTimes },

  // Weimi fleet sync (direct, production)
  { method:'GET',  pattern:'/api/v1/weimi/last-sync',                         handler: handleWeimiLastSync, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/weimi/sync-all',                          handler: handleWeimiSyncAll, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/weimi/populate',                          handler: handleWeimiPopulate, middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/layout',             handler: handleMachineLayout, middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/bay-config',         handler: handleSetBayConfig, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/slots/stock',        handler: handleSlotStock, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/slots/price',        handler: handleSlotPrice, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/products/price',                          handler: handleProductPrice, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/products/catalog',                        handler: handleProductCatalog, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/products/enrich',                         handler: handleProductEnrich, middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/products/import-seed',                    handler: handleImportSeed,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/products/import',                         handler: handleImportProducts, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/products',                               handler: handleCreateProduct, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/products',                               handler: handleListProducts,  middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/products/:goodsId',                      handler: handleUpdateProduct, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/slots/product',      handler: handleSlotProduct, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/weimi/sync',         handler: handleWeimiSyncOne, middleware:[requireAuth, requireMachineAccess] },

  // Nayax integration
  { method:'GET',  pattern:'/api/v1/nayax/status',                           handler: handleNayaxStatus,    middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/nayax/machines',                         handler: handleNayaxList,      middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/nayax/link',        handler: handleNayaxLink,      middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/nayax/sync',        handler: handleNayaxSyncOne,   middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/nayax/sync-all',                         handler: handleNayaxSyncAll,   middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/nayax/sales',       handler: handleNayaxSalesOne,  middleware:[requireAuth, requireMachineAccess] },

  // Auth
  { method:'POST', pattern:'/api/v1/auth/login',                             handler: handleLogin },
  { method:'POST', pattern:'/api/v1/auth/logout',                            handler: handleLogout, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/auth/change-password',                   handler: handleChangePassword, middleware:[requireAuth] },

  // Invitations
  { method:'GET',  pattern:'/api/v1/invitations/:token',                     handler: handleGetInvitation },
  { method:'POST', pattern:'/api/v1/invitations/:token/accept',              handler: handleAcceptInvitation },

  // ── Kiosk-facing (contract v0.1) ──────────────────────────────────────────
  { method:'POST', pattern:'/api/v1/machines/provision',                     handler: handleProvision },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/config',            handler: handleConfig,      middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/sales',             handler: handleSalesIngest, middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/complaints',        handler: handleComplaintIngest, middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/telemetry',         handler: handleTelemetryIngest, middleware:[requireMachineKey] },

  // Operator complaint management (dashboard-facing)
  { method:'GET',  pattern:'/api/v1/complaints',                             handler: handleListComplaints, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/complaints/:complaintId',                handler: handleGetComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/reply',          handler: handleReplyComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/refund',         handler: handleRefundComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/status',         handler: handleSetComplaintStatus, middleware:[requireAuth] },

  // ── Operator dashboard — machines ─────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/machines',                               handler: handleListMachines, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode',                   handler: handleGetMachine,   middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode',                   handler: handleUpdateMachine,middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/profile',           handler: handleUpdateProfile,middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/operator',          handler: handleAssignOperator, middleware:[requireAuth, requireAgAdmin] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/featured',          handler: handleSetFeatured,  middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/featured/batch',                         handler: handleBatchFeatured, middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/ads',               handler: handleSetAds,       middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/settings',          handler: handleUpdateSettings,middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/revoke-key',        handler: handleRevokeKey,    middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines',                               handler: handleAddMachine,   middleware:[requireAuth, requireOperatorAdmin] },

  // ── Operators (multi-tenant management) ───────────────────────────────────
  { method:'GET',  pattern:'/api/v1/operators',                              handler: handleListOperators, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId',                  handler: handleGetOperator,   middleware:[requireAuth, requireOperatorAccess] },
  { method:'PUT',  pattern:'/api/v1/operators/:operatorId',                  handler: handleUpdateOperator,middleware:[requireAuth, requireOperatorAccess, requireOperatorAdmin] },
  { method:'POST', pattern:'/api/v1/operators',                              handler: handleCreateOperator,middleware:[requireAuth, requireAgAdmin] },
  { method:'DELETE',pattern:'/api/v1/operators/:operatorId',                 handler: handleDeleteOperator,middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId/users',            handler: handleOperatorUsers, middleware:[requireAuth, requireOperatorAccess] },
  { method:'POST', pattern:'/api/v1/operators/:operatorId/users',            handler: handleInviteToOperator, middleware:[requireAuth, requireOperatorAccess, requireOperatorAdmin] },

  // ── Operator dashboard — other ────────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/alerts',                                 handler: handleListAlerts,   middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/alerts/:id/resolve',                     handler: handleResolveAlert, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/orders',                                 handler: handleListOrders,   middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/orders/today',                           handler: handleMachineSalesToday, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/summary',                        handler: handleReportSummary,middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/revenue-series',                 handler: handleRevenueSeries, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/machine-comparison',             handler: handleMachineComparison, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/top-products',                   handler: handleTopProducts, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/profit',                         handler: handleProfitReport, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/dispense-issues',                handler: handleDispenseIssues, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/reports/hourly',                         handler: handleHourlyHeatmap, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/sold-out',                               handler: handleSoldOut, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/detail',            handler: handleMachineDetail, middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/users',                                  handler: handleListUsers,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/users',                                  handler: handleInviteUser,   middleware:[requireAuth, requireOperatorAdmin] },
  { method:'PUT',  pattern:'/api/v1/users/:userId',                          handler: handleUpdateUser,   middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/invitations',                            handler: handleListInvitations, middleware:[requireAuth, requireOperatorAdmin] },
  { method:'DELETE', pattern:'/api/v1/invitations/:token',                   handler: handleRevokeInvitation, middleware:[requireAuth, requireOperatorAdmin] },
  { method:'POST', pattern:'/api/v1/invitations/:token/resend',              handler: handleResendInvitation, middleware:[requireAuth, requireOperatorAdmin] },

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
  // Any authenticated kiosk call doubles as a presence heartbeat.
  try { require('./db').markKioskSeen(deviceCode); } catch (e) { /* non-fatal */ }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  let version = '0.0.0';
  try { version = require('../package.json').version; } catch (e) {}
  ok(res, { status: 'ok', version, contract: 'v0.1', uptime: process.uptime() });
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
  storage.updateLastActive(user.id);
  ok(res, { token, user: publicUser(user) });
}

function handleLogout(req, res) {
  // Pull the token out of the auth header — requireAuth has already validated it
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) revokeToken(token);
  ok(res, { message: 'Logged out' });
}

// ─── Provisioning (contract section 2.2) ─────────────────────────────────────

function handleProvision(req, res) {
  // Provisioning gate: deviceCodes are not secret, so a shared provisioning
  // secret prevents anyone from minting a working machineKey. The kiosk sends
  // it as the X-Provision-Secret header. If PROVISION_SECRET is unset (dev),
  // provisioning is open but logs a loud warning.
  const expected = process.env.PROVISION_SECRET;
  if (expected) {
    const provided = req.headers['x-provision-secret'];
    if (!provided || provided !== expected) {
      console.warn('[PROVISION] rejected: bad or missing provisioning secret');
      return contractError(res, 401, 'invalid_provision_secret',
        'Ógilt provisioning-leyndarmál.', 'Invalid or missing provisioning secret.');
    }
  } else {
    console.warn('[PROVISION] PROVISION_SECRET not set — provisioning is OPEN. Set it in the environment to secure this endpoint.');
  }

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

    // For successful sales, decrement stock and detect sold-out transitions
    if (r.status === 1 && r.goodsId) {
      storage.applySaleToStock({
        deviceCode,
        goodsId:     String(r.goodsId),
        productName: r.productName || '',
      });
    }
  });

  if (errors.length) return badRequest(res, 'Validation failed', errors);

  console.log(`[SALES] ${deviceCode} accepted ${accepted.length}, duplicates ${duplicates.length}`);
  ok(res, { accepted: accepted.length, duplicates: duplicates.length, total: records.length });
}

// ─── Complaints (kiosk-facing ingest) ─────────────────────────────────────────

/**
 * POST /api/v1/machines/:deviceCode/complaints
 * Kiosk reports a customer complaint about items that didn't vend.
 * See api-contract-addendum-complaints.md for full spec.
 */
async function handleComplaintIngest(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${deviceCode} er ekki skráð.`,
      `Device ${deviceCode} is not registered.`);
  }

  const c = req.body || {};
  const errors = [];
  if (!c.tradeNo)                          errors.push('tradeNo required');
  if (!Array.isArray(c.items) || c.items.length === 0) errors.push('items must be a non-empty array');
  if (!c.customerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.customerEmail)) errors.push('customerEmail invalid');
  if (typeof c.timestampMs !== 'number')   errors.push('timestampMs must be a number (epoch ms)');
  if (c.note && c.note.length > 500)       errors.push('note must be <= 500 chars');
  if (Array.isArray(c.items)) {
    c.items.forEach((it, i) => {
      if (!it.goodsId)                            errors.push(`items[${i}] goodsId required`);
      if (!it.name)                               errors.push(`items[${i}] name required`);
      if (typeof it.priceIsk !== 'number')        errors.push(`items[${i}] priceIsk must be number`);
    });
  }
  if (errors.length) return badRequest(res, 'Validation failed', errors);

  // Idempotency — if a complaint exists for this tradeNo, return 409 with the existing id
  const existing = storage.getComplaintByTradeNo(c.tradeNo);
  if (existing) {
    return json(res, 409, { ok: false, error: 'A complaint for this tradeNo already exists', complaintId: existing.id });
  }

  const id        = 'cmp_' + crypto.randomBytes(12).toString('hex');
  const totalIsk  = c.items.reduce((s, i) => s + (i.priceIsk || 0), 0);
  const createdAt = new Date().toISOString();
  const complaint = {
    id, tradeNo: c.tradeNo, deviceCode,
    operatorId:      m.operatorId,
    customerEmail:   c.customerEmail.trim().toLowerCase(),
    note:            c.note?.trim() || null,
    items:           c.items.map(i => ({ goodsId: String(i.goodsId), name: i.name, priceIsk: i.priceIsk })),
    totalIsk,
    status:          'open',
    kioskAppVersion: c.kioskAppVersion || null,
    kioskOsLocale:   c.kioskOsLocale   || null,
    timestampMs:     c.timestampMs,
    createdAt,
  };
  storage.insertComplaint(complaint);

  console.log(`[COMPLAINT] ${deviceCode} new id=${id} from ${complaint.customerEmail} for ${totalIsk} kr`);

  // Fire pattern alerts (3+ complaints same machine in 24h)
  checkComplaintPatterns(m, deviceCode);

  // Notify the operator by email (best effort, doesn't block the response)
  notifyOperatorOfComplaint(complaint, m).catch(err =>
    console.error('[COMPLAINT] operator notification failed:', err.message)
  );

  created(res, { complaintId: id });
}

/** Detect 3+ complaints for the same machine in the past 24h, emit Alert. */
function checkComplaintPatterns(machine, deviceCode) {
  const since24h = Date.now() - 24 * 3600 * 1000;
  const count    = storage.countComplaintsForMachineSince(deviceCode, since24h);
  if (count >= 3) {
    const alertId = 'alert_pattern_' + deviceCode + '_' + Math.floor(Date.now() / (12 * 3600 * 1000));
    if (!storage.getAlert(alertId)) {
      storage.insertAlert({
        id:         alertId,
        type:       'complaint_cluster',
        severity:   'warning',
        title:      `${count} kvartanir á 24 klst — ${machine.deviceName}`,
        detail:     `${deviceCode} · likely a stuck spiral or sensor issue. Investigate the machine.`,
        deviceCode,
        resolved:   false,
        createdAt:  new Date().toISOString(),
      });
      console.log(`[ALERT] Created complaint cluster alert for ${deviceCode}`);
    }
  }
}

async function notifyOperatorOfComplaint(complaint, machine) {
  // Find an operator admin to notify; fallback to AG Vending if none
  const op = storage.getOperator(machine.operatorId);
  if (!op) return;

  // Pick the operator's contactEmail if set, otherwise the first operator_admin user, otherwise AG admins
  let toEmail = op.contactEmail && op.contactEmail.trim() ? op.contactEmail.trim() : null;
  if (!toEmail) {
    const opUsers = storage.listUsersByOperator(op.id);
    const admin   = opUsers.find(u => u.role === 'operator_admin');
    toEmail = admin?.email || null;
  }
  if (!toEmail) {
    // Last resort — notify AG Vending
    const agUsers = storage.listUsersByOperator('op_ag-vending');
    toEmail = agUsers[0]?.email || null;
  }
  if (!toEmail) {
    console.warn('[COMPLAINT] No operator email found for ' + op.id + ' — skipping notification');
    return;
  }

  const dashboardUrl = (process.env.APP_URL || 'https://snarl-sopi-production.up.railway.app') + '/?page=complaints&id=' + complaint.id;

  return email.sendComplaintToOperator({
    to:           toEmail,
    operatorName: op.name,
    machineName:  machine.deviceName,
    deviceCode:   machine.deviceCode,
    complaint,
    dashboardUrl,
  });
}

// ─── Complaints (operator-facing dashboard) ──────────────────────────────────

function handleListComplaints(req, res) {
  const { status, deviceCode } = req.query || {};
  let list = req.user.role === 'ag_admin'
    ? storage.listComplaints()
    : storage.listComplaintsByOperator(req.user.operatorId);
  if (status)     list = list.filter(c => c.status === status);
  if (deviceCode) list = list.filter(c => c.deviceCode === deviceCode);
  // Enrich with machine + operator names for the dashboard
  const enriched = list.map(c => ({
    ...c,
    machineName:  machines[c.deviceCode]?.deviceName || c.deviceCode,
    operatorName: operators[c.operatorId]?.name || c.operatorId,
  }));
  ok(res, enriched, { total: enriched.length });
}

function handleGetComplaint(req, res) {
  const c = storage.getComplaint(req.params.complaintId);
  if (!c) return notFound(res, 'Complaint not found');
  if (req.user.role !== 'ag_admin' && c.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }
  ok(res, {
    ...c,
    machineName:  machines[c.deviceCode]?.deviceName || c.deviceCode,
    operatorName: operators[c.operatorId]?.name || c.operatorId,
  });
}

async function handleReplyComplaint(req, res) {
  const c = storage.getComplaint(req.params.complaintId);
  if (!c) return notFound(res, 'Complaint not found');
  if (req.user.role !== 'ag_admin' && c.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }
  const { replyText, refundedAmount } = req.body || {};
  if (!replyText || !replyText.trim()) return badRequest(res, 'replyText required');
  if (replyText.length > 2000)         return badRequest(res, 'replyText must be <= 2000 chars');

  const op      = operators[c.operatorId];
  const machine = machines[c.deviceCode];

  try {
    await email.sendComplaintReplyToCustomer({
      to:             c.customerEmail,
      operatorName:   op?.name || 'Snarl & Sopi',
      machineName:    machine?.deviceName || c.deviceCode,
      replyText:      replyText.trim(),
      refundedAmount: typeof refundedAmount === 'number' ? refundedAmount : null,
    });
  } catch (err) {
    console.error('[COMPLAINT] reply email failed:', err.message);
    return json(res, 502, { ok: false, error: 'Failed to send reply email', detail: err.message });
  }

  storage.markComplaintReplied(c.id, replyText.trim(), req.user.name);
  if (c.status === 'open') storage.markComplaintStatus(c.id, 'replied');

  ok(res, storage.getComplaint(c.id));
}

function handleRefundComplaint(req, res) {
  const c = storage.getComplaint(req.params.complaintId);
  if (!c) return notFound(res, 'Complaint not found');
  if (req.user.role !== 'ag_admin' && c.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }
  const { amount } = req.body || {};
  const refundAmount = typeof amount === 'number' ? amount : c.totalIsk;
  if (refundAmount <= 0) return badRequest(res, 'amount must be > 0');
  if (refundAmount > c.totalIsk) return badRequest(res, `amount cannot exceed totalIsk (${c.totalIsk})`);

  storage.markComplaintRefunded(c.id, refundAmount, req.user.name);
  console.log(`[COMPLAINT] ${c.id} marked refunded ${refundAmount} kr by ${req.user.name}`);
  ok(res, storage.getComplaint(c.id));
}

function handleSetComplaintStatus(req, res) {
  const c = storage.getComplaint(req.params.complaintId);
  if (!c) return notFound(res, 'Complaint not found');
  if (req.user.role !== 'ag_admin' && c.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }
  const { status } = req.body || {};
  const valid = ['open', 'replied', 'refunded', 'resolved', 'dismissed'];
  if (!valid.includes(status)) return badRequest(res, `status must be one of: ${valid.join(', ')}`);
  storage.markComplaintStatus(c.id, status);
  ok(res, storage.getComplaint(c.id));
}

// ── Telemetry (kiosk energy board → backend) ─────────────────────────────────
// In-memory ONLY for now. The energy-board scaling is unverified on hardware
// (kiosk v0.39.4 probe), so per the contract we do NOT persist or alert yet —
// this just gives the probe a live target and lets us read back real values to
// confirm scaling before building persistence/alerting.
const lastTelemetry = {};

function handleTelemetryIngest(req, res) {
  const deviceCode = req.params.deviceCode;
  const b = req.body || {};
  const reading = {
    deviceCode,
    readAt:  typeof b.readAt === 'string' ? b.readAt : null,
    climate: b.climate || null,
    power:   b.power || null,
    faults:  Array.isArray(b.faults) ? b.faults.slice(0, 20) : [],
    receivedAt: new Date().toISOString(),
  };
  lastTelemetry[deviceCode] = reading;
  const c = reading.climate, p = reading.power;
  console.log(`[TELEMETRY] ${deviceCode} temp=${c?.cabinetTempC ?? '–'}C hum=${c?.humidity ?? '–'} evap=${c?.evaporatorRaw ?? '–'} V=${p?.voltageV ?? '–'} A=${p?.currentA ?? '–'} E=${p?.energy ?? '–'} faults=${reading.faults.length}`);
  ok(res, { received: true });
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
  const list = machinesForUser(req.user).map(m => ({
    ...machineSummary(m),
    keyStatus: (() => { const k = storage.getMachineKey(m.deviceCode); return k ? (k.revokedAt ? 'revoked' : 'active') : 'not_provisioned'; })(),
  }));
  ok(res, list, { total: list.length });
}

function handleGetMachine(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  ok(res, {
    ...machineDetail(m),
    keyStatus: (() => { const k = storage.getMachineKey(m.deviceCode); return k ? (k.revokedAt ? 'revoked' : 'active') : 'not_provisioned'; })(),
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
function handleUpdateMachine(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  if (req.body.deviceName !== undefined && String(req.body.deviceName).trim()) {
    m.deviceName = String(req.body.deviceName).trim();
  }
  if (req.body.location !== undefined) m.location = String(req.body.location);
  if (req.body.operatorName !== undefined) {
    m.profile = m.profile || {};
    m.profile.operatorName = String(req.body.operatorName);
    if (m.settings) m.settings.operatorName = String(req.body.operatorName);
  }
  touchConfig(m);  // persists via storage.upsertMachine
  ok(res, machineSummary(m));
}

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

// Is a product (by product code = goodsId) stocked in a machine's layout?
// Returns true / false, or null if the layout is unknown (then we don't block).
function machineStocksGoods(code, goodsId) {
  try {
    const raw = require('./storage').getMeta(`layout:${code}`);
    if (!raw) return null;
    const layout = JSON.parse(raw);
    if (!Array.isArray(layout)) return null;
    let found = false;
    layout.forEach(layer => (layer.bays || []).forEach(b => {
      if (b && String(b.goodsId) === String(goodsId)) found = true;
    }));
    return found;
  } catch { return null; }
}

// ── POST /api/v1/featured/batch ───────────────────────────────────────────────
// Apply one hero product (by product code) + tag to many machines at once.
// mode 'append' (default) de-dupes (updates the tag if already featured, else
// appends, capped at 8); mode 'replace' sets it as the sole featured item.
// Only touches machines the user can access AND that actually stock the product.
function handleBatchFeatured(req, res) {
  const { goodsId, tag, deviceCodes, mode } = req.body || {};
  const gid = goodsId != null ? String(goodsId).trim() : '';
  const tg  = tag != null ? String(tag).trim() : '';
  if (!gid) return badRequest(res, 'goodsId required');
  if (!tg)  return badRequest(res, 'tag required');
  if (!Array.isArray(deviceCodes) || !deviceCodes.length) return badRequest(res, 'deviceCodes required');
  const replace = mode === 'replace';
  const applied = [], skipped = [];
  for (const code of deviceCodes) {
    const m = machines[code];
    if (!m) { skipped.push({ deviceCode: code, reason: 'not_found' }); continue; }
    if (!userCanAccessMachine(req.user, code)) { skipped.push({ deviceCode: code, reason: 'forbidden' }); continue; }
    if (machineStocksGoods(code, gid) === false) { skipped.push({ deviceCode: code, reason: 'not_stocked' }); continue; }
    let featured = Array.isArray(m.featured) ? m.featured.slice() : [];
    if (replace) {
      featured = [{ goodsId: gid, tag: tg, order: 0 }];
    } else {
      const existing = featured.find(f => String(f.goodsId) === gid);
      if (existing) { existing.tag = tg; }                       // de-dupe: refresh tag, keep slot
      else if (featured.length >= 8) { skipped.push({ deviceCode: code, reason: 'full' }); continue; }
      else { featured.push({ goodsId: gid, tag: tg, order: featured.length }); }
      featured = featured.map((f, i) => ({ goodsId: f.goodsId, tag: f.tag, order: i }));
    }
    m.featured = featured;
    touchConfig(m);
    applied.push({ deviceCode: code, deviceName: m.deviceName });
  }
  ok(res, { appliedCount: applied.length, skippedCount: skipped.length, applied, skipped });
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
  storage.upsertMachine(m);
  ok(res, { settings: m.settings });
}

// ── POST /machines/:deviceCode/revoke-key ─────────────────────────────────────
function handleRevokeKey(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  revokeKey(req.params.deviceCode);
  ok(res, { deviceCode: req.params.deviceCode, revokedAt: storage.getMachineKey(req.params.deviceCode)?.revokedAt });
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
  const alert = storage.getAlert(req.params.id);
  if (!alert) return notFound(res, `Alert ${req.params.id} not found`);
  storage.resolveAlert(req.params.id);
  ok(res, { ...alert, resolved: true, resolvedAt: new Date().toISOString() });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

function handleListOrders(req, res) {
  const { deviceCode, page = '1', size = '50', today } = req.query;

  // Restrict to machines the user can access
  const allowed = new Set(machinesForUser(req.user).map(m => m.deviceCode));
  let result = orders.filter(o => allowed.has(o.deviceCode));

  if (deviceCode) {
    if (!allowed.has(deviceCode)) return json(res, 403, { error: 'Forbidden' });
    result = result.filter(o => o.deviceCode === deviceCode);
  }

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

  const d = new Date();
  const todayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  ok(res, slice.map(o => ({ ...o, machineName: machines[o.deviceCode]?.deviceName || o.deviceCode })),
    { total, page: pageNum, size: pageSize, pages: Math.ceil(total / pageSize), todayUTC });
}

// ─── Per-machine today sales summary — scoped ────────────────────────────────

function handleMachineSalesToday(req, res) {
  const d = new Date();
  const todayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const tomorrowUTC = todayUTC + 86400000;

  const allowed    = machinesForUser(req.user).map(m => m.deviceCode);
  const allowedSet = new Set(allowed);
  const todayOrders = storage.listOrdersToday(todayUTC, tomorrowUTC).filter(o => allowedSet.has(o.deviceCode));

  const byMachine = {};
  allowed.forEach(code => { byMachine[code] = { orders: 0, revenueKr: 0 }; });
  todayOrders.forEach(o => {
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
  const allowed = new Set(machinesForUser(req.user).map(m => m.deviceCode));
  const scopedOrders = orders.filter(o => allowed.has(o.deviceCode));
  const success = scopedOrders.filter(o => o.status === 1);
  const total   = success.reduce((s, o) => s + o.totalAmount, 0);
  ok(res, {
    totalOrders:    scopedOrders.length,
    successOrders:  success.length,
    totalRevenueKr: Math.round(total / 100),
    avgOrderValueKr:success.length ? Math.round(total / success.length / 100) : 0,
    refundRate:     scopedOrders.length  ? Math.round(scopedOrders.filter(o=>o.status===3).length / scopedOrders.length * 1000) / 10 : 0,
    byMachine: machinesForUser(req.user).map(m => {
      const mo = scopedOrders.filter(o => o.deviceCode === m.deviceCode && o.status === 1);
      return { deviceCode: m.deviceCode, machineName: m.deviceName, orders: mo.length, revenueKr: Math.round(mo.reduce((s,o)=>s+o.totalAmount,0)/100) };
    }),
  });
}

// ─── Analytics: revenue trends, comparisons, top products, heatmap ───────────

/**
 * Day boundaries: Iceland is UTC year-round (no DST). UTC midnight = Iceland midnight.
 * Helpers expect millisecond epochs.
 */
function startOfDayUTC(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function getDaysParam(query, defaultDays = 7) {
  const raw = parseInt(query?.days, 10);
  if (!isFinite(raw) || raw < 1) return defaultDays;
  if (raw > 365) return 365;
  return raw;
}

// Resolve a report window from the query: a custom from/to (YYYY-MM-DD, inclusive,
// UTC days) takes priority; otherwise a rolling `days` window ending today.
// Returns { fromMs, toMs (exclusive), days|null }.
function resolveReportWindow(query, defaultDays = 7) {
  const dre = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(query?.from || '').trim();
  const to   = String(query?.to   || '').trim();
  if (dre.test(from) && dre.test(to)) {
    const f = Date.parse(from + 'T00:00:00Z');
    const t = Date.parse(to + 'T00:00:00Z');
    if (!isNaN(f) && !isNaN(t) && t >= f) {
      return { fromMs: f, toMs: t + 86400000, days: null };
    }
  }
  const days = getDaysParam(query, defaultDays);
  const todayUTC = startOfDayUTC(Date.now());
  return { fromMs: todayUTC - (days - 1) * 86400000, toMs: todayUTC + 86400000, days };
}

function getAccessibleDeviceCodes(user, requestedDeviceCode, operatorId) {
  let allowed = machinesForUser(user);
  if (operatorId) allowed = allowed.filter(m => m.operatorId === operatorId);
  const codes = allowed.map(m => m.deviceCode);
  if (requestedDeviceCode) {
    if (!codes.includes(requestedDeviceCode)) return null; // access denied
    return [requestedDeviceCode];
  }
  return codes;
}

/**
 * Build a goodsId → product image map from the synced layout meta of the given
 * devices. Lets list/report responses carry product thumbnails without an extra
 * Weimi round-trip (the 30-min sync already stored them).
 */
function goodsImageMap(codes) {
  const storage = require('./storage');
  const map = {};
  for (const code of (codes || [])) {
    let layout;
    try { const raw = storage.getMeta(`layout:${code}`); layout = raw ? JSON.parse(raw) : null; }
    catch { layout = null; }
    if (!Array.isArray(layout)) continue;
    layout.forEach(layer => (layer.bays || []).forEach(b => {
      const gid = (b && b.goodsId != null) ? String(b.goodsId) : '';
      if (gid && b.image && !map[gid]) map[gid] = b.image;
    }));
  }
  return map;
}

/**
 * GET /api/v1/reports/revenue-series?days=7&deviceCode=...
 * Returns daily revenue + order-count buckets for the chart on the dashboard.
 */
function handleRevenueSeries(req, res) {
  const days = getDaysParam(req.query, 7);
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode, req.query?.operatorId);
  if (codes === null) return json(res, 403, { error: 'Forbidden' });

  const todayUTC = startOfDayUTC(Date.now());
  const fromMs = todayUTC - (days - 1) * 86400000;
  const toMs = todayUTC + 86400000;

  // Pre-fill all days so the chart shows zeros for empty days
  const buckets = {};
  for (let i = 0; i < days; i++) {
    const dayStart = fromMs + i * 86400000;
    buckets[dayStart] = { dayUTC: dayStart, dayISO: new Date(dayStart).toISOString().slice(0, 10), orders: 0, revenueKr: 0 };
  }

  const orders = codes.length ? storage.listOrdersInRange(codes, fromMs, toMs) : [];
  orders.forEach(o => {
    const dayStart = startOfDayUTC(o.createTime);
    if (buckets[dayStart]) {
      buckets[dayStart].orders++;
      buckets[dayStart].revenueKr += o.amountKr;
    }
  });

  const series = Object.values(buckets).sort((a, b) => a.dayUTC - b.dayUTC);
  ok(res, {
    days,
    fromUTC: fromMs,
    toUTC: toMs,
    deviceCode: req.query?.deviceCode || null,
    series,
    total: {
      orders: series.reduce((s, b) => s + b.orders, 0),
      revenueKr: series.reduce((s, b) => s + b.revenueKr, 0),
    },
  });
}

/**
 * GET /api/v1/reports/machine-comparison?days=7
 * Returns per-machine revenue totals for a given period — for the dashboard's
 * machine-by-machine bar chart.
 */
function handleMachineComparison(req, res) {
  const days = getDaysParam(req.query, 7);
  const opId = req.query?.operatorId;
  const accessible = machinesForUser(req.user).filter(m => !opId || m.operatorId === opId);
  const codes = accessible.map(m => m.deviceCode);
  if (!codes.length) return ok(res, { days, machines: [] });

  const todayUTC = startOfDayUTC(Date.now());
  const fromMs = todayUTC - (days - 1) * 86400000;
  const toMs = todayUTC + 86400000;
  const orders = storage.listOrdersInRange(codes, fromMs, toMs);

  const byCode = {};
  accessible.forEach(m => {
    byCode[m.deviceCode] = {
      deviceCode: m.deviceCode,
      deviceName: m.deviceName,
      operatorName: operators[m.operatorId]?.name || null,
      orders: 0,
      revenueKr: 0,
      isOnline: m.isOnline,
    };
  });
  orders.forEach(o => {
    if (byCode[o.deviceCode]) {
      byCode[o.deviceCode].orders++;
      byCode[o.deviceCode].revenueKr += o.amountKr;
    }
  });

  const machines = Object.values(byCode).sort((a, b) => b.revenueKr - a.revenueKr);
  ok(res, { days, machines });
}

/**
 * GET /api/v1/reports/top-products?days=30&deviceCode=...&limit=20
 * Aggregates sales by goodsId+productName.
 */
function handleTopProducts(req, res) {
  const days = getDaysParam(req.query, 30);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 20));
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode);
  if (codes === null) return json(res, 403, { error: 'Forbidden' });
  if (!codes.length) return ok(res, { days, top: [], slow: [] });

  const todayUTC = startOfDayUTC(Date.now());
  const fromMs = todayUTC - (days - 1) * 86400000;
  const toMs = todayUTC + 86400000;
  const orders = storage.listOrdersInRange(codes, fromMs, toMs);

  const byProduct = {};
  orders.forEach(o => {
    const key = o.goodsId || ('_unknown_' + o.productName);
    if (!byProduct[key]) {
      byProduct[key] = {
        goodsId: o.goodsId || null,
        productName: o.productName || '(unknown)',
        units: 0,
        revenueKr: 0,
        machineCount: new Set(),
      };
    }
    byProduct[key].units++;
    byProduct[key].revenueKr += o.amountKr;
    byProduct[key].machineCount.add(o.deviceCode);
  });

  const list = Object.values(byProduct).map(p => ({
    goodsId: p.goodsId,
    productName: p.productName,
    units: p.units,
    revenueKr: p.revenueKr,
    machineCount: p.machineCount.size,
  }));

  const imgMap = goodsImageMap(codes);
  list.forEach(p => { p.image = (p.goodsId && imgMap[String(p.goodsId)]) || ''; });

  const top = list.slice().sort((a, b) => b.revenueKr - a.revenueKr).slice(0, limit);
  const slow = list.slice().sort((a, b) => a.units - b.units).slice(0, limit);

  ok(res, { days, top, slow, totalProducts: list.length });
}

function emptyProfit(days, fromMs, toMs) {
  return {
    days, fromUTC: fromMs, toUTC: toMs,
    match: { items: 0, matched: 0, unmatched: 0 },
    totals: { grossKr: 0, netKr: 0, vskKr: 0, units: 0, orders: 0 },
    vsk: { '11': { grossKr: 0, netKr: 0, vskKr: 0, units: 0 }, '24': { grossKr: 0, netKr: 0, vskKr: 0, units: 0 } },
    profit: { itemsWithCost: 0, itemsTotal: 0, grossKrCovered: 0, netKrCovered: 0, netCostKr: 0, profitKr: 0, marginPct: null },
    byProduct: [], byMachine: [],
  };
}

/**
 * GET /api/v1/reports/profit?days=N[&operatorId=...]
 * The VSK + profit report. Works off order line items (each gravity-fridge
 * purchase is often several items), joins each line to our stored VSK rate and
 * cost, and back-calculates net sales, VSK and profit. Icelandic prices are
 * VSK-inclusive, so net = gross / (1 + rate), VSK = gross − net; cost is treated
 * gross the same way. Profit figures cover only items that have a cost set.
 */
function handleProfitReport(req, res) {
  const opId = req.query?.operatorId;
  const accessible = machinesForUser(req.user).filter(m => !opId || m.operatorId === opId);
  const codes = accessible.map(m => m.deviceCode);
  const nameByCode = {}; accessible.forEach(m => { nameByCode[m.deviceCode] = m.deviceName; });

  const win = resolveReportWindow(req.query, 7);
  const fromMs = win.fromMs, toMs = win.toMs, days = win.days;
  if (!codes.length) return ok(res, emptyProfit(days, fromMs, toMs));

  const rows = storage.reportItems(fromMs, toMs, codes);
  const netOf = (grossC, rate) => Math.round(grossC / (1 + rate / 100));
  const kr = (c) => Math.round(c / 100);

  const tot = { grossC: 0, netC: 0, vskC: 0, units: 0 };
  const bucket = { 11: { grossC: 0, netC: 0, vskC: 0, units: 0 }, 24: { grossC: 0, netC: 0, vskC: 0, units: 0 } };
  const ck = { grossC: 0, netC: 0, netCostC: 0, profitC: 0, items: 0 };
  const orders = new Set();
  let matched = 0, unmatched = 0;
  const byProduct = {}, byMachine = {};

  rows.forEach(it => {
    const grossC = it.payAmount || 0;
    const hasAttrs = it.vatRate != null;
    const rate = (it.vatRate === 24) ? 24 : 11;       // default 11 when unknown
    const netC = netOf(grossC, rate);
    const vskC = grossC - netC;
    hasAttrs ? matched++ : unmatched++;
    orders.add(it.tradeNo);

    tot.grossC += grossC; tot.netC += netC; tot.vskC += vskC; tot.units++;
    const bk = bucket[rate]; bk.grossC += grossC; bk.netC += netC; bk.vskC += vskC; bk.units++;

    const hasCost = it.costPriceIsk != null;
    let profitC = null;
    if (hasCost) {
      const netCostC = netOf(it.costPriceIsk * 100, rate);
      profitC = netC - netCostC;
      ck.grossC += grossC; ck.netC += netC; ck.netCostC += netCostC; ck.profitC += profitC; ck.items++;
    }

    const gk = it.goodsId || ('_u_' + (it.name || ''));
    const p = byProduct[gk] || (byProduct[gk] = { goodsId: it.goodsId || null, name: it.name || '(unknown)', vatRate: hasAttrs ? rate : null, units: 0, grossC: 0, netC: 0, vskC: 0, profitC: 0, anyCost: false });
    p.units++; p.grossC += grossC; p.netC += netC; p.vskC += vskC;
    if (hasCost) { p.profitC += profitC; p.anyCost = true; }

    const mc = byMachine[it.deviceCode] || (byMachine[it.deviceCode] = { deviceCode: it.deviceCode, deviceName: nameByCode[it.deviceCode] || it.deviceCode, units: 0, grossC: 0, profitC: 0, anyCost: false });
    mc.units++; mc.grossC += grossC;
    if (hasCost) { mc.profitC += profitC; mc.anyCost = true; }
  });

  ok(res, {
    days, fromUTC: fromMs, toUTC: toMs,
    match: { items: rows.length, matched, unmatched },
    totals: { grossKr: kr(tot.grossC), netKr: kr(tot.netC), vskKr: kr(tot.vskC), units: tot.units, orders: orders.size },
    vsk: {
      '11': { grossKr: kr(bucket[11].grossC), netKr: kr(bucket[11].netC), vskKr: kr(bucket[11].vskC), units: bucket[11].units },
      '24': { grossKr: kr(bucket[24].grossC), netKr: kr(bucket[24].netC), vskKr: kr(bucket[24].vskC), units: bucket[24].units },
    },
    profit: {
      itemsWithCost: ck.items, itemsTotal: rows.length,
      grossKrCovered: kr(ck.grossC), netKrCovered: kr(ck.netC),
      netCostKr: kr(ck.netCostC), profitKr: kr(ck.profitC),
      marginPct: ck.netC > 0 ? Math.round(ck.profitC / ck.netC * 1000) / 10 : null,
    },
    byProduct: Object.values(byProduct).map(p => ({
      goodsId: p.goodsId, name: p.name, vatRate: p.vatRate, units: p.units,
      grossKr: kr(p.grossC), netKr: kr(p.netC), vskKr: kr(p.vskC),
      profitKr: p.anyCost ? kr(p.profitC) : null, hasCost: p.anyCost,
    })).sort((a, b) => b.grossKr - a.grossKr),
    byMachine: Object.values(byMachine).map(m => ({
      deviceCode: m.deviceCode, deviceName: m.deviceName, units: m.units,
      grossKr: kr(m.grossC), profitKr: m.anyCost ? kr(m.profitC) : null,
    })).sort((a, b) => b.grossKr - a.grossKr),
  });
}

/**
 * GET /api/v1/reports/dispense-issues?days|from|to&operatorId
 * Lines the customer paid for but the machine did not dispense
 * (shipmentStatus != 1) — i.e. likely owed a refund. Scoped to the user.
 */
function handleDispenseIssues(req, res) {
  const opId = req.query?.operatorId;
  const accessible = machinesForUser(req.user).filter(m => !opId || m.operatorId === opId);
  const codes = accessible.map(m => m.deviceCode);
  const nameByCode = {}; accessible.forEach(m => { nameByCode[m.deviceCode] = m.deviceName; });

  const win = resolveReportWindow(req.query, 30);
  const empty = { days: win.days, fromMs: win.fromMs, toMs: win.toMs, count: 0, totalKr: 0, byMachine: [], items: [] };
  if (!codes.length) return ok(res, empty);

  const kr = c => Math.round((c || 0) / 100);
  const rows = storage.dispenseIssues(win.fromMs, win.toMs, codes);
  const byMachine = {};
  const items = rows.map(r => {
    const machineName = nameByCode[r.deviceCode] || r.deviceCode;
    byMachine[r.deviceCode] = byMachine[r.deviceCode] || { deviceCode: r.deviceCode, machineName, count: 0, amountKr: 0 };
    byMachine[r.deviceCode].count++;
    byMachine[r.deviceCode].amountKr += kr(r.payAmount);
    return {
      tradeNo: r.tradeNo, deviceCode: r.deviceCode, machineName,
      product: r.name || '—', amountKr: kr(r.payAmount),
      shipmentStatus: r.shipmentStatus, time: r.createTime,
    };
  });

  ok(res, {
    days: win.days, fromMs: win.fromMs, toMs: win.toMs,
    count: items.length,
    totalKr: items.reduce((s, i) => s + i.amountKr, 0),
    byMachine: Object.values(byMachine).sort((a, b) => b.count - a.count),
    items: items.slice(0, 200),
  });
}

/**
 * GET /api/v1/reports/hourly?days=30&deviceCode=...
 * Returns a 7x24 grid of order counts and revenue — for the hourly heatmap.
 */
function handleHourlyHeatmap(req, res) {
  const days = getDaysParam(req.query, 30);
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode);
  if (codes === null) return json(res, 403, { error: 'Forbidden' });
  if (!codes.length) return ok(res, { days, grid: [] });

  const todayUTC = startOfDayUTC(Date.now());
  const fromMs = todayUTC - (days - 1) * 86400000;
  const toMs = todayUTC + 86400000;
  const orders = storage.listOrdersInRange(codes, fromMs, toMs);

  // grid[dayOfWeek][hour] — 7 days (0=Sun..6=Sat in UTC), 24 hours
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ orders: 0, revenueKr: 0 }))
  );

  orders.forEach(o => {
    const d = new Date(o.createTime);
    const dow = d.getUTCDay();
    const hr = d.getUTCHours();
    grid[dow][hr].orders++;
    grid[dow][hr].revenueKr += o.amountKr;
  });

  // Find peak so the dashboard can normalise colour
  let peakOrders = 0;
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++)
    if (grid[d][h].orders > peakOrders) peakOrders = grid[d][h].orders;

  ok(res, { days, peakOrders, grid });
}

/**
 * GET /api/v1/sold-out?scope=fleet|machine&deviceCode=...&days=30
 * Returns currently-empty slots + recent sold-out events.
 */
function handleSoldOut(req, res) {
  const days = getDaysParam(req.query, 30);
  const scope = req.query?.scope === 'machine' ? 'machine' : 'fleet';
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode, req.query?.operatorId);
  if (codes === null) return json(res, 403, { error: 'Forbidden' });

  const sinceMs = Date.now() - days * 86400000;
  const emptyNow = storage.listEmptySlotsForDevices(codes);
  const recent = storage.listSoldOutEventsScoped(codes, sinceMs, 200);

  // Enrich with machine names
  const enrich = row => ({
    ...row,
    machineName: machines[row.deviceCode]?.deviceName || row.deviceCode,
    operatorName: machines[row.deviceCode]
      ? operators[machines[row.deviceCode].operatorId]?.name || null
      : null,
  });

  ok(res, {
    scope,
    days,
    deviceCode: req.query?.deviceCode || null,
    currentlyEmpty: emptyNow.map(enrich),
    recentEvents: recent.map(enrich),
    counts: { currentlyEmpty: emptyNow.length, recentEvents: recent.length },
  });
}

/**
 * GET /api/v1/machines/:deviceCode/detail
 * Single-machine bundle for the detail page — machine + recent activity summary.
 */
function handleMachineDetail(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, 'Machine not found');
  ok(res, {
    machine: m,
    operatorName: operators[m.operatorId]?.name || null,
    keyStatus: (() => {
      const k = storage.getMachineKey(m.deviceCode);
      return k ? (k.revokedAt ? 'revoked' : 'active') : 'not_provisioned';
    })(),
    slotStock: storage.listSlotStockForDevice(m.deviceCode),
    emptySlots: storage.listEmptySlotsForDevice(m.deviceCode),
  });
}

// ─── Users ────────────────────────────────────────────────────────────────────

function handleListUsers(req, res) {
  // AG admin sees everyone; others only see their own operator's staff
  let list;
  if (req.user.role === 'ag_admin') {
    list = users;
  } else {
    list = users.filter(u => u.operatorId === req.user.operatorId);
  }
  ok(res, list.map(publicUser), { total: list.length });
}

/**
 * PUT /api/v1/users/:userId — AG-admin edit of a user's name, role, and operator.
 * Used to move users between operators and change permissions.
 */
function handleUpdateUser(req, res) {
  const target = storage.getUser(req.params.userId);
  if (!target) return notFound(res, 'User not found');

  const validRoles = ['ag_admin', 'operator_admin', 'operator_manager', 'operator_viewer'];
  const newRole = req.body.role != null ? String(req.body.role) : target.role;
  if (!validRoles.includes(newRole)) return badRequest(res, `role must be one of ${validRoles.join(', ')}`);

  let newOpId = req.body.operatorId != null ? String(req.body.operatorId) : target.operatorId;
  // AG admins always live on the AG Vending house operator.
  if (newRole === 'ag_admin') {
    const house = Object.values(operators).find(o => o.isAGVending);
    if (house) newOpId = house.id;
  }
  if (!operators[newOpId]) return badRequest(res, 'operator not found');

  // Safety: never strip the last AG admin, and don't let an admin lock themselves out.
  if (target.role === 'ag_admin' && newRole !== 'ag_admin') {
    const agAdmins = users.filter(u => u.role === 'ag_admin');
    if (agAdmins.length <= 1) return badRequest(res, 'Cannot remove the last AG Vending admin');
    if (target.id === req.user.id) return badRequest(res, 'You cannot remove your own AG admin access');
  }

  const newName = (req.body.name != null && String(req.body.name).trim())
    ? String(req.body.name).trim() : target.name;

  storage.updateUser({
    id: target.id, name: newName, role: newRole, operatorId: newOpId,
    machineAccess: target.machineAccess || 'all',
  });
  console.log(`[USER] ${req.user.name} updated ${target.email} → role=${newRole}, operator=${operators[newOpId].name}`);
  ok(res, publicUser(storage.getUser(target.id)));
}

async function handleInviteUser(req, res) {
  const { name, email: inviteeEmail, role, operatorId, machineAccess } = req.body || {};
  if (!name || !inviteeEmail || !role) return badRequest(res, 'name, email, and role required');

  const targetOpId = operatorId || req.user.operatorId;
  if (!operators[targetOpId]) return badRequest(res, 'operator not found');

  if (!userCanInviteTo(req.user, targetOpId)) {
    return json(res, 403, { error: 'Forbidden — you cannot invite users to this operator' });
  }

  const validRoles = ['ag_admin', 'operator_admin', 'operator_manager', 'operator_viewer'];
  if (!validRoles.includes(role)) return badRequest(res, `role must be one of ${validRoles.join(', ')}`);

  if (role === 'ag_admin' && req.user.role !== 'ag_admin') {
    return json(res, 403, { error: 'Only AG Vending admins can create AG admins' });
  }

  if (users.find(u => u.email === inviteeEmail)) return badRequest(res, 'Email already exists');

  // Check for a pending (unconsumed, unexpired) invitation
  for (const inv of invitations.values()) {
    if (inv.email === inviteeEmail && !inv.consumedAt && inv.expiresAt > Date.now()) {
      return badRequest(res, 'An invitation is already pending for this email. It expires '
        + new Date(inv.expiresAt).toISOString().slice(0, 10));
    }
  }

  // Create invitation
  const invite = createInvitation({
    email: inviteeEmail, name, role, operatorId: targetOpId,
    inviterId: req.user.id,
    machineAccess: machineAccess || 'all',
  });

  // Send the invitation email with the signup link. Real delivery happens only
  // if SendGrid is configured (SENDGRID_API_KEY); otherwise it is logged. We
  // report whether it actually sent so the UI can fall back to sharing the link.
  let emailed = false;
  try {
    const r = await email.sendInvitation({
      to:           inviteeEmail,
      name,
      inviterName:  req.user.name,
      operatorName: operators[targetOpId].name,
      role,
      inviteToken:  invite.token,
    });
    emailed = !!(r && r.mocked === false);
  } catch (err) {
    console.error('[INVITE] Failed to send email:', err.message);
    // Don't fail the request — the admin can share the link manually.
  }

  created(res, {
    email: invite.email,
    name:  invite.name,
    role:  invite.role,
    operatorId: invite.operatorId,
    operatorName: operators[invite.operatorId].name,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    emailed,
    token: invite.token,
  });
}

/**
 * GET /api/v1/invitations/:token
 * Public — used by the dashboard's invite-accept screen to verify a token
 * before showing the password-setting form.
 */
function handleGetInvitation(req, res) {
  const invite = getInvitation(req.params.token);
  if (!invite) {
    return json(res, 404, { error: 'Invitation not found, already used, or expired' });
  }
  // Don't leak the inviterId; only return what the user needs to see
  ok(res, {
    email:        invite.email,
    name:         invite.name,
    role:         invite.role,
    operatorName: operators[invite.operatorId]?.name || null,
    expiresAt:    new Date(invite.expiresAt).toISOString(),
  });
}

/**
 * POST /api/v1/invitations/:token/accept
 * Public — completes the invitation flow by creating a real user with the
 * password the invitee chose. Returns a login token.
 */
function handleAcceptInvitation(req, res) {
  const invite = getInvitation(req.params.token);
  if (!invite) return json(res, 404, { error: 'Invitation not found, already used, or expired' });

  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return badRequest(res, 'Password must be at least 8 characters');
  }

  // Double-check no race with manual user creation
  if (users.find(u => u.email === invite.email)) {
    return badRequest(res, 'A user with this email already exists');
  }

  const newUser = {
    id:          `u${users.length + 1}`,
    name:        invite.name,
    email:       invite.email,
    password,    // TODO: hash with bcrypt in production
    role:        invite.role,
    operatorId:  invite.operatorId,
    machineAccess: invite.machineAccess || 'all',
    lastActiveAt:  new Date().toISOString(),
    createdAt:     new Date().toISOString(),
  };
  users.push(newUser);

  consumeInvitation(invite.token);

  const token = createToken(newUser.id);
  console.log(`[INVITE] ${invite.email} accepted invitation for ${operators[invite.operatorId]?.name}`);
  ok(res, { token, user: publicUser(newUser) });
}

/**
 * POST /api/v1/auth/change-password
 * For logged-in users to change their own password.
 */
function handleChangePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return badRequest(res, 'currentPassword and newPassword required');
  if (newPassword.length < 8) return badRequest(res, 'New password must be at least 8 characters');
  if (req.user.password !== currentPassword) return json(res, 401, { error: 'Current password is incorrect' });

  storage.updateUserPassword(req.user.id, newPassword);
  ok(res, { message: 'Password changed' });
}

/**
 * GET /api/v1/invitations
 * Lists pending invitations the user is allowed to see.
 *   - AG admin sees all pending invitations
 *   - Operator admin sees invitations to their own operator
 */
function handleListInvitations(req, res) {
  const now = Date.now();
  const list = [];
  for (const inv of invitations.values()) {
    if (inv.consumedAt) continue;      // skip accepted invitations
    if (inv.expiresAt < now) continue; // skip expired
    if (req.user.role !== 'ag_admin' && inv.operatorId !== req.user.operatorId) continue;
    const inviter = users.find(u => u.id === inv.inviterId);
    list.push({
      token:        inv.token,
      email:        inv.email,
      name:         inv.name,
      role:         inv.role,
      operatorId:   inv.operatorId,
      operatorName: operators[inv.operatorId]?.name || null,
      invitedBy:    inviter?.name || 'unknown',
      createdAt:    new Date(inv.createdAt).toISOString(),
      expiresAt:    new Date(inv.expiresAt).toISOString(),
    });
  }
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  ok(res, list, { total: list.length });
}

/**
 * DELETE /api/v1/invitations/:token
 * Revoke a pending invitation. The invitee can no longer use the link.
 */
function handleRevokeInvitation(req, res) {
  const inv = invitations.get(req.params.token);
  if (!inv) return notFound(res, 'Invitation not found');
  if (inv.consumedAt) return badRequest(res, 'Invitation has already been accepted');

  // Permission: AG admin can revoke any; operator admin can revoke own operator's
  if (req.user.role !== 'ag_admin' && inv.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }

  invitations.delete(req.params.token);
  console.log(`[INVITE] ${req.user.name} revoked invitation for ${inv.email}`);
  ok(res, { revoked: true, email: inv.email });
}

/**
 * POST /api/v1/invitations/:token/resend — re-send the signup email for a
 * pending invitation. Reports whether email actually went out.
 */
async function handleResendInvitation(req, res) {
  const inv = invitations.get(req.params.token);
  if (!inv) return notFound(res, 'Invitation not found');
  if (inv.consumedAt) return badRequest(res, 'Invitation has already been accepted');
  if (inv.expiresAt <= Date.now()) return badRequest(res, 'Invitation has expired — create a new one');
  if (req.user.role !== 'ag_admin' && inv.operatorId !== req.user.operatorId) {
    return json(res, 403, { error: 'Forbidden' });
  }
  let emailed = false;
  try {
    const r = await email.sendInvitation({
      to: inv.email, name: inv.name, inviterName: req.user.name,
      operatorName: operators[inv.operatorId]?.name || '', role: inv.role, inviteToken: inv.token,
    });
    emailed = !!(r && r.mocked === false);
  } catch (e) { console.error('[INVITE] resend failed:', e.message); }
  ok(res, { emailed, email: inv.email, token: inv.token });
}

// ─── Operator handlers ────────────────────────────────────────────────────────

function handleListOperators(req, res) {
  const list = operatorsForUser(req.user).map(o => ({
    ...o,
    machineCount: Object.values(machines).filter(m => m.operatorId === o.id).length,
    userCount:    users.filter(u => u.operatorId === o.id).length,
  }));
  ok(res, list, { total: list.length });
}

function handleGetOperator(req, res) {
  const op = operators[req.params.operatorId];
  if (!op) return notFound(res, 'Operator not found');
  const opMachines = Object.values(machines).filter(m => m.operatorId === op.id);
  const opUsers    = users.filter(u => u.operatorId === op.id).map(publicUser);
  ok(res, { ...op, machines: opMachines.map(machineSummary), users: opUsers });
}

// Upload a base64 image to R2 and return its public URL (used for operator logos).
async function uploadBase64Image(b64, typeHint, keyBase) {
  const r2 = require('./r2');
  if (!r2.isConfigured()) throw new Error('image hosting not configured');
  let data = String(b64); let contentType = typeHint || 'image/png';
  const m = data.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { contentType = m[1]; data = m[2]; }
  const buf = Buffer.from(data, 'base64');
  if (!buf || !buf.length) throw new Error('empty image');
  if (buf.length > 8 * 1024 * 1024) throw new Error('image too large (max 8MB)');
  const ext = /png/.test(contentType) ? 'png' : /webp/.test(contentType) ? 'webp'
            : /svg/.test(contentType) ? 'svg' : /gif/.test(contentType) ? 'gif' : 'jpg';
  return r2.putObject(`${keyBase}-${Date.now()}.${ext}`, buf, contentType);
}

async function handleUpdateOperator(req, res) {
  const op = operators[req.params.operatorId];
  if (!op) return notFound(res, 'Operator not found');
  const allowed = ['name', 'contactEmail', 'contactPhone', 'address'];
  allowed.forEach(k => { if (req.body[k] !== undefined) op[k] = req.body[k]; });
  if (req.body.logoBase64) {
    try { op.logoUrl = await uploadBase64Image(req.body.logoBase64, req.body.logoType, `operators/${op.id}`); }
    catch (e) { return json(res, 502, { error: 'logo upload failed: ' + e.message }); }
  }
  storage.upsertOperator(op);
  ok(res, op);
}

async function handleCreateOperator(req, res) {
  const { name, address, contactEmail, contactPhone } = req.body || {};
  if (!name) return badRequest(res, 'name required');
  const slug = name.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `op_${slug || Date.now()}`;
  if (operators[id]) return badRequest(res, 'Operator with this name already exists');
  let logoUrl = '';
  if (req.body.logoBase64) {
    try { logoUrl = await uploadBase64Image(req.body.logoBase64, req.body.logoType, `operators/${id}`); }
    catch (e) { return json(res, 502, { error: 'logo upload failed: ' + e.message }); }
  }
  operators[id] = {
    id, name, isAGVending: false,
    contactEmail: contactEmail || '', contactPhone: contactPhone || '',
    address: address || '', logoUrl,
    createdAt: new Date().toISOString(),
  };
  storage.upsertOperator(operators[id]);
  created(res, operators[id]);
}

function handleDeleteOperator(req, res) {
  const op = operators[req.params.operatorId];
  if (!op) return notFound(res, 'Operator not found');
  if (op.isAGVending) return badRequest(res, 'The AG Vending house operator cannot be deleted');
  const mCount = Object.values(machines).filter(m => m.operatorId === op.id).length;
  const uCount = users.filter(u => u.operatorId === op.id).length;
  if (mCount || uCount) {
    return badRequest(res, `Reassign this operator's ${mCount} machine(s) and ${uCount} user(s) before deleting it.`);
  }
  delete operators[op.id];
  storage.deleteOperator(op.id);
  console.log(`[OPERATOR] ${req.user.name} deleted operator ${op.name} (${op.id})`);
  ok(res, { deleted: true, id: op.id });
}

function handleOperatorUsers(req, res) {
  const opId = req.params.operatorId;
  const list = users.filter(u => u.operatorId === opId).map(publicUser);
  ok(res, list, { total: list.length });
}

function handleInviteToOperator(req, res) {
  // Reuse the main invite handler logic by injecting operatorId from URL
  req.body = { ...req.body, operatorId: req.params.operatorId };
  return handleInviteUser(req, res);
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

/**
 * GET /api/v1/debug/outbound-ip
 * Returns the outbound IP this Railway container uses for HTTPS requests.
 * Useful for asking partners (Weimi, Nayax, etc.) to whitelist our IP.
 *
 * We call a few public "what's my IP" services in parallel and return all
 * answers so we can spot any disagreement (some services see different
 * IPs depending on the network path). Cached for 60s to avoid noise.
 */
let _outboundIpCache = null;
async function handleOutboundIp(req, res) {
  if (_outboundIpCache && Date.now() - _outboundIpCache.fetchedAt < 60_000) {
    return ok(res, _outboundIpCache);
  }
  const sources = [
    { name: 'ipify',    url: 'https://api.ipify.org?format=json',     parse: d => d.ip },
    { name: 'icanhaz',  url: 'https://ipv4.icanhazip.com',            parse: d => String(d).trim() },
    { name: 'ifconfig', url: 'https://ifconfig.me/ip',                parse: d => String(d).trim() },
  ];
  const results = await Promise.all(sources.map(async (s) => {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      return { source: s.name, ok: r.ok, status: r.status, ip: s.parse(body) };
    } catch (e) {
      return { source: s.name, ok: false, error: e.message };
    }
  }));
  // Pick the most-agreed-on IP for the headline
  const ips = results.filter(r => r.ok && r.ip).map(r => r.ip);
  const counts = {};
  ips.forEach(ip => { counts[ip] = (counts[ip] || 0) + 1; });
  const headline = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  _outboundIpCache = {
    ip: headline,
    agreed: ips.length > 0 && new Set(ips).size === 1,
    sources: results,
    fetchedAt: Date.now(),
    note: 'Railway shared egress IPs may change. For permanent whitelisting, request a static outbound IP (Railway paid add-on).',
  };
  ok(res, _outboundIpCache);
}

/**
 * GET /api/v1/debug/weimi-test?env=prod&deviceCode=62160485
 * Fires one signed request directly at the Weimi production (or test) domain
 * and returns exactly what came back — to determine whether the block is
 * domain / IP / auth related.
 */
async function handleWeimiTest(req, res) {
  const weimi = require('./weimi');
  const env = req.query?.env === 'test' ? 'test' : 'prod';
  const deviceCode = req.query?.deviceCode || '62160485';
  try {
    const result = await weimi.rawDiagnostic({ env, deviceCode });
    ok(res, result);
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

// ─── Weimi fleet sync handlers ───────────────────────────────────────────────

async function handleWeimiOrdersTest(req, res) {
  const weimi = require('./weimi');
  const deviceCode = req.query?.deviceCode || '62160043';
  try {
    const result = await weimi.rawOrdersDiagnostic({ deviceCode });
    ok(res, result);
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

/**
 * GET /api/v1/debug/weimi-goods-library?size=50&barcode=...
 * Probes POST /ext/org/vision/goods/page to learn whether Weimi returns this
 * operator's full product library for our (gravity) account. listLen = number of
 * product records returned; bodyPreview shows the shape. This decides whether the
 * catalog can offer products that aren't currently placed in any machine.
 */
async function handleWeimiGoodsLibrary(req, res) {
  const weimi = require('./weimi');
  const size = Math.min(200, Math.max(1, parseInt(req.query?.size, 10) || 50));
  const barcode = req.query?.barcode || undefined;
  try {
    const result = await weimi.visionGoodsPageRaw({ endpoint: 'prod' }, { current: 1, size, barcode });
    ok(res, result);
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

/**
 * GET /api/v1/debug/r2-test
 * Uploads a small SVG to the R2 bucket and returns its public URL. Opening that
 * URL in a browser proves the whole chain: credentials, upload, public serving.
 */
/**
 * GET /api/v1/debug/weimi-query-goods?goodsCode=...&goodsId=...&goodsCustomCode=...
 * Confirms the sanctioned product API (/ext/query/goods) responds for our App ID
 * and shows the response shape. Pass a code from the product-database export.
 */
async function handleWeimiQueryGoods(req, res) {
  const weimi = require('./weimi');
  const { goodsId, goodsCode, goodsCustomCode } = req.query || {};
  try {
    const result = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { goodsId, goodsCode, goodsCustomCode });
    ok(res, result);
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

/**
 * GET /api/v1/debug/save-goods-test?confirm=create
 * Proves the full create chain: upload an image to R2, then create a clearly
 * labeled, deletable test product in Weimi using that R2 link. Guarded by
 * ?confirm=create so it never fires accidentally (it writes to the live catalog).
 */
async function handleSaveGoodsTest(req, res) {
  const r2 = require('./r2');
  const weimi = require('./weimi');
  if ((req.query?.confirm || '') !== 'create') {
    return ok(res, {
      ok: false, willCreate: true,
      message: 'This creates a real (but clearly labeled and deletable) test product in your Weimi catalog. Re-run with ?confirm=create to proceed, then delete "__API TEST — safe to delete" in the portal.',
    });
  }
  if (!r2.isConfigured()) return ok(res, { ok: false, stage: 'r2', message: 'R2 not configured.' });

  // 1) Upload a test image to R2.
  const key = `r2-test/product-${Date.now()}.svg`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
    '<rect width="300" height="300" fill="#FAF7F2"/>' +
    '<text x="150" y="150" text-anchor="middle" font-family="Georgia,serif" font-size="20" font-style="italic" fill="#8B6B3E">API test</text>' +
    '<text x="150" y="180" text-anchor="middle" font-family="monospace" font-size="12" fill="#1A1A1A">safe to delete</text></svg>';
  let imgUrl;
  try { imgUrl = await r2.putObject(key, Buffer.from(svg, 'utf8'), 'image/svg+xml'); }
  catch (e) { return ok(res, { ok: false, stage: 'r2_upload', error: e.message }); }

  // 2) Create the test product in Weimi using the R2 image link.
  const fields = {
    goodsName: '__API TEST — safe to delete',
    goodsCustomCode: 'apitest-' + Date.now(),
    retailPrice: 100,
    imgUrl, thumbnailUrl: imgUrl,
    measurement: 0,
  };
  try {
    const result = await weimi.saveGoodsRaw({ endpoint: 'prod' }, fields);
    if (result && result.weimiMsg) result.weimiMsgReadable = weimi.fixMojibake(result.weimiMsg);
    ok(res, { ok: result?.weimiCode === 200, imgUrl, sent: fields, weimi: result, note: 'weimiCode 200 = created; delete "__API TEST" in the portal afterward.' });
  } catch (e) {
    ok(res, { ok: false, stage: 'save_goods', imgUrl, error: e.message });
  }
}

async function handleR2Test(req, res) {
  const r2 = require('./r2');
  if (!r2.isConfigured()) {
    const c = r2.r2Config();
    return ok(res, {
      ok: false, configured: false,
      message: 'R2 env vars missing or incomplete.',
      present: {
        R2_ENDPOINT: !!c.endpoint, R2_BUCKET: !!c.bucket, R2_PUBLIC_URL: !!c.publicUrl,
        R2_ACCESS_KEY_ID: !!c.accessKeyId, R2_SECRET_ACCESS_KEY: !!c.secretAccessKey,
      },
    });
  }
  const key = `r2-test/hello-${Date.now()}.svg`;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="140">' +
    '<rect width="360" height="140" fill="#FAF7F2"/>' +
    '<text x="180" y="62" text-anchor="middle" font-family="Georgia,serif" font-size="26" font-style="italic" fill="#8B6B3E">Snarl &amp; Sopi</text>' +
    '<text x="180" y="95" text-anchor="middle" font-family="monospace" font-size="14" fill="#1A1A1A">R2 upload OK</text></svg>';
  try {
    const url = await r2.putObject(key, Buffer.from(svg, 'utf8'), 'image/svg+xml');
    ok(res, { ok: true, configured: true, key, publicUrl: url, hint: 'Open publicUrl in a browser — if you see the image, R2 works end to end.' });
  } catch (e) {
    json(res, 200, { ok: false, configured: true, error: e.name || 'error', message: e.message });
  }
}

/**
 * GET /api/v1/debug/weimi-fleet?orders=true
 * Maps the entire fleet in one shot: device-profile status for everyone, then
 * device-info presence/shape per machine, and (optionally) order counts.
 */
async function handleWeimiFleetDigest(req, res) {
  const weimi   = require('./weimi');
  const storage = require('./storage');
  const cfg = { endpoint: 'prod' };
  const withOrders = req.query?.orders === 'true';

  const machines = storage.listMachines();
  const codes = machines.map(m => m.deviceCode);

  let profileByCode = {};
  try {
    const list = await weimi.deviceProfile(cfg, codes);
    list.forEach(d => { if (d.deviceCode) profileByCode[d.deviceCode] = d; });
  } catch (e) { /* reported per-row */ }

  const rows = [];
  for (const m of machines) {
    const row = { deviceCode: m.deviceCode, name: m.deviceName };
    const prof = profileByCode[m.deviceCode];
    row.profileOnline = prof ? (prof.isOnline === 1) : null;
    row.profileStock  = prof ? prof.totalCurrStock : null;

    try {
      const info = await weimi.deviceInfo(cfg, m.deviceCode);
      const aisles = [];
      (info.cabinets || []).forEach(c => (c.layers || []).forEach(l => (l.aisles || []).forEach(a => aisles.push(a))));
      const modes = {}, meas = {};
      aisles.forEach(a => { modes[a.shippingMode] = (modes[a.shippingMode]||0)+1; meas[a.measurement] = (meas[a.measurement]||0)+1; });
      row.deviceInfo = true;
      row.aisles = aisles.length;
      row.enabled = aisles.filter(a => a.isEnable).length;
      row.broken = aisles.filter(a => a.isBroken).length;
      row.stock = aisles.reduce((s,a)=>s+(a.currStock||0),0);
      row.maxStock = aisles.reduce((s,a)=>s+(a.maxStock||0),0);
      row.modes = modes;
      row.meas = meas;
    } catch (e) {
      row.deviceInfo = false;
      row.deviceInfoErr = e.message.includes('no data') ? 'empty' : e.message.slice(0, 40);
    }

    if (withOrders) {
      try {
        const list = await weimi.queryOrders(cfg, { deviceCode: m.deviceCode });
        const times = list.map(o => o.detailVOList?.[0]?.shipmentTime || o.tradeStartTime).filter(Boolean).sort();
        row.orderCount = list.length;
        row.orderEarliest = times[0] || null;
        row.orderLatest = times[times.length - 1] || null;
      } catch (e) { row.orderCount = null; }
    }

    rows.push(row);
  }

  const withData = rows.filter(r => r.deviceInfo);
  const empty    = rows.filter(r => !r.deviceInfo);
  ok(res, {
    total: rows.length,
    withDeviceInfo: withData.length,
    emptyDeviceInfo: empty.length,
    emptyList: empty.map(r => r.deviceCode),
    rows,
  });
}

/**
 * GET /api/v1/debug/weimi-device?deviceCode=X
 * Rich digest of one machine straight from Weimi: channel/aisle layout (why
 * stock may read 0%), per-bay dispensing config (shippingMode / measurement),
 * and order history depth. Used to design machine-type + bay modelling.
 */
async function handleWeimiDeviceDigest(req, res) {
  const weimi = require('./weimi');
  const cfg = { endpoint: 'prod' };
  const deviceCode = req.query?.deviceCode;
  if (!deviceCode) return json(res, 400, { ok: false, error: 'deviceCode required' });
  const out = { deviceCode };

  try {
    const info = await weimi.deviceInfo(cfg, deviceCode);
    const aisles = [];
    (info.cabinets || []).forEach(c => (c.layers || []).forEach(l => (l.aisles || []).forEach(a => aisles.push(a))));
    const byMode = {}, byMeas = {};
    aisles.forEach(a => {
      byMode[a.shippingMode] = (byMode[a.shippingMode] || 0) + 1;
      byMeas[a.measurement]  = (byMeas[a.measurement]  || 0) + 1;
    });
    // Per-layer breakdown: shows whether any field (shippingMode / ctrlBoard /
    // measurement) separates spiral layers from direct-push layers.
    const layers = [];
    (info.cabinets || []).forEach(c => (c.layers || []).forEach(l => {
      const as = l.aisles || [];
      const dist = key => { const m = {}; as.forEach(a => { m[a[key]] = (m[a[key]] || 0) + 1; }); return m; };
      layers.push({
        layer: l.layer,
        bays: as.length,
        shippingMode: dist('shippingMode'),
        ctrlBoard: dist('ctrlBoard'),
        measurement: dist('measurement'),
        sampleCodes: as.slice(0, 2).map(a => a.code),
      });
    }));
    out.deviceInfo = {
      deviceName:   info.deviceName,
      cabinetTotal: info.cabinetTotal, layerTotal: info.layerTotal, aisleTotal: info.aisleTotal,
      aisleCount:   aisles.length,
      withGoods:    aisles.filter(a => a.goodsName && a.goodsName.trim()).length,
      enabled:      aisles.filter(a => a.isEnable).length,
      broken:       aisles.filter(a => a.isBroken).length,
      sumCurrStock: aisles.reduce((s, a) => s + (a.currStock || 0), 0),
      sumMaxStock:  aisles.reduce((s, a) => s + (a.maxStock || 0), 0),
      shippingModes: byMode,   // distribution of dispensing modes across bays
      measurements:  byMeas,   // 0 = by piece, 1 = by weight
      layers,                  // per-layer field distributions
      sampleAisles: aisles.slice(0, 8).map(a => ({
        code: a.code, name: weimi.fixMojibake(a.goodsName), price: a.price,
        currStock: a.currStock, maxStock: a.maxStock,
        shippingMode: a.shippingMode, measurement: a.measurement,
        ctrlBoard: a.ctrlBoard, ctrlCmd: a.ctrlCmd,
        isEnable: a.isEnable, isBroken: a.isBroken,
      })),
    };
  } catch (e) { out.deviceInfoError = e.message; }

  try {
    const list = await weimi.queryOrders(cfg, { deviceCode });
    const times = list.map(o => (o.detailVOList?.[0]?.shipmentTime) || o.tradeStartTime).filter(Boolean).sort();
    out.orders = {
      count: list.length,
      earliest: times[0] || null,
      latest: times[times.length - 1] || null,
      totalRevenueKr: Math.round(list.reduce((s, o) => s + (o.totalAmount || 0), 0) / 100),
      sample: list.slice(0, 3).map(o => ({
        tradeNo: o.tradeNo, totalAmount: o.totalAmount,
        items: (o.detailVOList || []).map(d => weimi.fixMojibake(d.goodsName)),
        time: o.detailVOList?.[0]?.shipmentTime,
      })),
    };
  } catch (e) { out.ordersError = e.message; }

  ok(res, out);
}

function handleWeimiLastSync(req, res) {
  const weimiSync = require('./weimiSync');
  ok(res, weimiSync.lastSync(req.query?.deviceCode || null));
}

async function handleWeimiSyncAll(req, res) {
  const weimiSync = require('./weimiSync');
  const orders = req.query?.orders !== 'false';
  const days   = Math.min(90, Math.max(1, parseInt(req.query?.days, 10) || 7));
  try {
    const report = await weimiSync.syncAll({ orders, days });
    ok(res, report);
  } catch (e) {
    console.error('[WEIMI] sync-all failed:', e.message);
    json(res, 502, { ok: false, error: e.message });
  }
}

async function handleWeimiSyncOne(req, res) {
  const weimiSync = require('./weimiSync');
  const orders = req.query?.orders !== 'false';
  const days   = Math.min(90, Math.max(1, parseInt(req.query?.days, 10) || 7));
  try {
    // refresh this machine's status too (cheap, single device)
    const result = await weimiSync.syncMachine(req.params.deviceCode, { orders, days });
    ok(res, result);
  } catch (e) {
    console.error('[WEIMI] sync one failed:', e.message);
    json(res, 502, { ok: false, error: e.message });
  }
}

// ─── Bay layout + dispensing-type configuration ──────────────────────────────

// Named exceptions (spiral layer count differs from the standard 4).
// Everything else defaults to: top 4 layers spiral, the rest direct-push.
const BAY_SPIRAL_EXCEPTIONS = {
  '62160043': 3,  // Valur I       — A,B,C spiral / D,E,F push
  '62160042': 2,  // Gamli Gerpla  — A,B spiral / rest push
  '62160488': 99, // Evanger       — all spiral
};

function defaultBayConfig(deviceCode, layout) {
  const spiralCount = BAY_SPIRAL_EXCEPTIONS[deviceCode] ?? 4;
  const cfg = {};
  (layout || []).forEach((l, idx) => {
    cfg[l.layer] = idx < spiralCount ? 'spiral' : 'push';
  });
  return cfg;
}

function handleMachineLayout(req, res) {
  const storage = require('./storage');
  const code = req.params.deviceCode;
  const layoutRaw = storage.getMeta(`layout:${code}`);
  const layout = layoutRaw ? JSON.parse(layoutRaw) : [];
  const savedRaw = storage.getMeta(`baycfg:${code}`);
  const saved = savedRaw ? JSON.parse(savedRaw) : null;
  const defaults = defaultBayConfig(code, layout);
  const bayConfig = { ...defaults, ...(saved || {}) };
  ok(res, {
    deviceCode: code,
    configured: layout.length > 0,
    layout,
    bayConfig,
    lastSync: storage.getMeta(`weimisync:products:${code}`) || null,
  });
}

function handleSetBayConfig(req, res) {
  const storage = require('./storage');
  const code = req.params.deviceCode;
  const body = req.body || {};
  const layerTypes = body.layerTypes || body.bayConfig;
  if (!layerTypes || typeof layerTypes !== 'object') {
    return json(res, 400, { ok: false, error: 'layerTypes object required' });
  }
  const clean = {};
  for (const [layer, type] of Object.entries(layerTypes)) {
    if (type === 'spiral' || type === 'push') clean[layer] = type;
  }
  storage.setMeta(`baycfg:${code}`, JSON.stringify(clean));
  ok(res, { deviceCode: code, bayConfig: clean });
}

/**
 * Interpret a Weimi write outcome from weimi._rawCall.
 * Returns { ok, status, operationStatus?, error?, message? }.
 *   code 200 + operationStatus 0/1/2 → success
 *   code 4003                         → machine offline (409)
 *   anything else / network error     → upstream failure (502)
 */
function interpretWeimiWrite(result) {
  if (!result || result.error) {
    return { ok: false, status: 502, error: 'weimi_unreachable', message: result?.error || 'no response' };
  }
  if (result.weimiCode === 200) {
    let operationStatus = null;
    try { operationStatus = JSON.parse(result.bodyPreview)?.data?.operationStatus ?? null; } catch {}
    return { ok: true, status: 200, operationStatus };
  }
  if (result.weimiCode === 4003) {
    return { ok: false, status: 409, error: 'machine_offline', message: 'The machine is offline — Weimi can only apply changes while it is online.' };
  }
  return { ok: false, status: 502, error: 'weimi_error', code: result.weimiCode, message: result.weimiMsg || 'write rejected' };
}

/**
 * POST /api/v1/machines/:deviceCode/slots/stock
 * Restock: set current stock for one or more aisles (per-aisle, safe — only the
 * aisles passed are changed). body: { aisles: [{ aisleCode, currStock }] }.
 */
async function handleSlotStock(req, res) {
  const weimi = require('./weimi');
  const code = req.params.deviceCode;
  const body = req.body || {};
  const input = Array.isArray(body.aisles) ? body.aisles : null;
  if (!input || !input.length) return json(res, 400, { ok: false, error: 'aisles array required' });

  const clean = [];
  for (const a of input) {
    if (!a || !a.aisleCode) continue;
    const n = Number(a.currStock);
    if (!Number.isFinite(n) || n < 0) continue;
    clean.push({ aisleCode: String(a.aisleCode), currStock: Math.round(n) });
  }
  if (!clean.length) return json(res, 400, { ok: false, error: 'no valid aisle/stock pairs' });

  let result;
  try {
    result = await weimi.updateAisleStock({ endpoint: 'prod' }, code, clean);
  } catch (e) {
    return json(res, 502, { ok: false, error: 'weimi_unreachable', message: e.message });
  }
  const verdict = interpretWeimiWrite(result);
  if (!verdict.ok) {
    return json(res, verdict.status, { ok: false, error: verdict.error, message: verdict.message, code: verdict.code });
  }

  // Refresh our local copy so the dashboard reflects the new stock immediately.
  try { await require('./weimiSync').syncMachine(code, { orders: false }); } catch (e) { /* non-fatal */ }

  ok(res, { deviceCode: code, updated: clean.length, operationStatus: verdict.operationStatus });
}

/**
 * POST /api/v1/machines/:deviceCode/slots/price
 * Change prices via Weimi's dedicated per-aisle product/price endpoint
 * (/ext/aisle/goods/update). Weimi keeps one price per product across a machine,
 * so changes are grouped by the product currently in each slot.
 * body: { changes: [{ aisleCode, priceIsk }] }.
 */
async function handleSlotPrice(req, res) {
  const weimi = require('./weimi');
  const code = req.params.deviceCode;
  const body = req.body || {};
  const changes = Array.isArray(body.changes) ? body.changes : null;
  if (!changes || !changes.length) return json(res, 400, { ok: false, error: 'changes array required' });

  // aisleCode → new price in CENTS
  const priceMap = {};
  for (const ch of changes) {
    if (!ch || !ch.aisleCode) continue;
    const isk = Number(ch.priceIsk);
    if (!Number.isFinite(isk) || isk < 0) continue;
    priceMap[String(ch.aisleCode)] = Math.round(isk) * 100;
  }
  const wanted = Object.keys(priceMap);
  if (!wanted.length) return json(res, 400, { ok: false, error: 'no valid price changes' });

  // Need each slot's current product id → read fresh device-info.
  let info;
  try { info = await weimi.deviceInfo({ endpoint: 'prod' }, code); }
  catch (e) { return json(res, 502, { ok: false, error: 'weimi_unreachable', message: e.message }); }
  const byCode = {};
  (info.cabinets || []).forEach(cab => (cab.layers || []).forEach(l => (l.aisles || []).forEach(a => { if (a.code) byCode[a.code] = a; })));

  // Group by product (Weimi prices per product, not per slot). Last price wins
  // if the same product is given different prices.
  const byGoods = {};   // goodsId → { price, aisleCodes: [] }
  let emptySlot = null;
  for (const aisleCode of wanted) {
    const a = byCode[aisleCode];
    if (!a || !(a.goodsId || a.id)) { emptySlot = aisleCode; continue; }
    const gid = String(a.goodsId || a.id);
    if (!byGoods[gid]) byGoods[gid] = { price: priceMap[aisleCode], aisleCodes: [] };
    byGoods[gid].price = priceMap[aisleCode];
    byGoods[gid].aisleCodes.push(aisleCode);
  }
  const goodsIds = Object.keys(byGoods);
  if (!goodsIds.length) {
    return json(res, 400, { ok: false, error: 'empty_slot', message: emptySlot ? ('Slot has no product to price.') : 'none of those slots were found on this machine' });
  }

  let applied = 0, firstErr = null;
  for (const gid of goodsIds) {
    const g = byGoods[gid];
    let r;
    try { r = await weimi.updateAisleGoods({ endpoint: 'prod' }, code, g.aisleCodes, gid, g.price); }
    catch (e) { if (!firstErr) firstErr = { status: 502, error: 'weimi_unreachable', message: e.message }; continue; }
    const v = interpretWeimiWrite(r);
    if (v.ok) applied += g.aisleCodes.length;
    else if (!firstErr) firstErr = v;
  }

  if (applied === 0) {
    const e = firstErr || { status: 502, error: 'weimi_error', message: 'price update rejected' };
    return json(res, e.status || 502, { ok: false, error: e.error, message: e.message, code: e.code });
  }

  try { await require('./weimiSync').syncMachine(code, { orders: false }); } catch (e) { /* non-fatal */ }
  ok(res, { deviceCode: code, updated: applied, products: goodsIds.length });
}

/**
 * POST /api/v1/products/price
 * Apply a product's price across several machines at once. For each machine the
 * user picked (and can access), find the slots currently holding that product
 * and update them. Machines that don't carry the product are reported, not failed.
 * body: { goodsId, priceIsk, deviceCodes: [] }.
 */
async function handleProductPrice(req, res) {
  const weimi = require('./weimi');
  const body = req.body || {};
  const goodsId = body.goodsId != null ? String(body.goodsId) : '';
  const isk = Number(body.priceIsk);
  const deviceCodes = Array.isArray(body.deviceCodes) ? body.deviceCodes.map(String) : [];
  if (!goodsId) return json(res, 400, { ok: false, error: 'goodsId required' });
  if (!Number.isFinite(isk) || isk < 0) return json(res, 400, { ok: false, error: 'valid priceIsk required' });
  if (!deviceCodes.length) return json(res, 400, { ok: false, error: 'deviceCodes required' });
  const priceCents = Math.round(isk) * 100;

  // Only machines this user can access.
  const allowed = new Set(getAccessibleDeviceCodes(req.user) || []);
  const targets = deviceCodes.filter(c => allowed.has(c));
  if (!targets.length) return json(res, 403, { ok: false, error: 'no accessible machines in request' });

  const results = [];
  for (const code of targets) {
    let info;
    try { info = await weimi.deviceInfo({ endpoint: 'prod' }, code); }
    catch (e) { results.push({ deviceCode: code, ok: false, error: 'weimi_unreachable', message: e.message }); continue; }

    const aisleCodes = [];
    (info.cabinets || []).forEach(cab => (cab.layers || []).forEach(l => (l.aisles || []).forEach(a => {
      if (a.code && String(a.goodsId || a.id) === goodsId) aisleCodes.push(a.code);
    })));
    if (!aisleCodes.length) { results.push({ deviceCode: code, ok: false, error: 'not_stocked', message: 'Product not in this machine' }); continue; }

    let r;
    try { r = await weimi.updateAisleGoods({ endpoint: 'prod' }, code, aisleCodes, goodsId, priceCents); }
    catch (e) { results.push({ deviceCode: code, ok: false, error: 'weimi_unreachable', message: e.message }); continue; }
    const v = interpretWeimiWrite(r);
    if (v.ok) {
      results.push({ deviceCode: code, ok: true, slots: aisleCodes.length });
      try { await require('./weimiSync').syncMachine(code, { orders: false }); } catch (e) { /* non-fatal */ }
    } else {
      results.push({ deviceCode: code, ok: false, error: v.error, message: v.message });
    }
  }

  const okCount = results.filter(x => x.ok).length;
  ok(res, { goodsId, priceIsk: Math.round(isk), applied: okCount, total: targets.length, results });
}

/**
 * GET /api/v1/products/catalog[?operatorId=...]
 * The operator's de-facto product catalog: every distinct product currently
 * stocked across the machines this user can access, aggregated from the synced
 * layout meta. Used as the product picker for slot swaps (Weimi exposes no
 * gravity-machine "list my products" endpoint — only visual-cabinet ones).
 * Returns { products: [{ goodsId, name, image, priceIsk, machineCount, slotCount }] }.
 */
/**
 * POST /api/v1/products
 * Create a product in Weimi (sanctioned /ext/save/goods) with an R2-hosted image.
 * body: { goodsName, priceIsk, imageBase64 (data URL or raw), imageType?,
 *         measurement? (0 item / 1 weight), goodsCustomCode?, barcode? }.
 * Returns { ok, goodsId, customCode, imgUrl }.
 */
/**
 * PUT /api/v1/products/:goodsId
 * Edit a product: name / image / barcode / measurement in Weimi (via save/goods
 * modify), plus our own VSK / cost / weight in the local DB. Price is NOT changed
 * here — per-slot pricing goes through the price module.
 */
async function handleUpdateProduct(req, res) {
  const r2 = require('./r2');
  const weimi = require('./weimi');
  const goodsId = req.params.goodsId;
  const b = req.body || {};
  if (!goodsId) return json(res, 400, { ok: false, error: 'goodsId required' });

  // Current record from Weimi (authoritative for the required fields).
  // The id we hold can be one of three things: products we *created* are keyed by
  // Weimi's internal goodsId, while products already *placed* in machines come from
  // the layout keyed by their product code (goodsCode). Try each identifier in turn.
  let current = null;
  for (const keyName of ['goodsId', 'goodsCode', 'goodsCustomCode']) {
    try {
      const q = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { [keyName]: goodsId });
      const d = JSON.parse(q.bodyPreview)?.data || null;
      if (d && d.goodsId) { current = d; break; }
    } catch { /* try next identifier */ }
  }
  if (!current || !current.goodsId) return json(res, 404, { ok: false, error: 'product not found in Weimi' });

  // Optional new image.
  let imgUrl = current.imgUrl;
  let thumbnailUrl = current.thumbnailUrl || current.imgUrl;
  if (b.imageBase64) {
    if (!r2.isConfigured()) return json(res, 500, { ok: false, error: 'image hosting not configured' });
    let buf, contentType = b.imageType || 'image/png';
    try {
      let data = String(b.imageBase64);
      const m = data.match(/^data:([^;]+);base64,(.*)$/s);
      if (m) { contentType = m[1]; data = m[2]; }
      buf = Buffer.from(data, 'base64');
    } catch (e) { return json(res, 400, { ok: false, error: 'bad image data' }); }
    if (!buf || !buf.length) return json(res, 400, { ok: false, error: 'empty image' });
    if (buf.length > 8 * 1024 * 1024) return json(res, 413, { ok: false, error: 'image too large (max 8MB)' });
    const ext = /png/.test(contentType) ? 'png' : /webp/.test(contentType) ? 'webp'
              : /svg/.test(contentType) ? 'svg' : /gif/.test(contentType) ? 'gif' : 'jpg';
    const key = `products/${current.goodsCustomCode || goodsId}-${Date.now()}.${ext}`;
    try { imgUrl = await r2.putObject(key, buf, contentType); thumbnailUrl = imgUrl; }
    catch (e) { return json(res, 502, { ok: false, stage: 'image_upload', error: e.message }); }
  }

  const goodsName   = (b.goodsName != null && String(b.goodsName).trim()) ? String(b.goodsName).trim().slice(0, 200) : current.goodsName;
  const measurement = (b.measurement != null) ? (Number(b.measurement) === 1 ? 1 : 0) : (current.measurement || 0);
  const barcode     = (b.barcode != null) ? String(b.barcode).slice(0, 32) : (current.barcode || '');

  // Modify in Weimi (name / image / barcode / measurement); keep price as-is.
  // save/goods modify requires the internal goodsId, which is current.goodsId —
  // not necessarily the id we were called with (that may be a product code).
  const fields = {
    goodsId: current.goodsId, goodsName,
    goodsCustomCode: current.goodsCustomCode,
    retailPrice: current.retailPrice,
    imgUrl, thumbnailUrl, measurement,
  };
  if (barcode) fields.barcode = barcode;

  let result;
  try { result = await weimi.saveGoodsRaw({ endpoint: 'prod' }, fields); }
  catch (e) { return json(res, 502, { ok: false, stage: 'save_goods', error: e.message }); }
  if (result.weimiCode !== 200) {
    return json(res, 502, { ok: false, stage: 'save_goods', error: weimi.fixMojibake(result.weimiMsg || 'update failed') });
  }

  // Our own attributes (keep existing if a field wasn't supplied).
  const existing = storage.getProduct(goodsId) || {};
  const numField = (v, keep) => (v === undefined) ? keep : (v == null || v === '' ? null : Math.max(0, Math.round(Number(v))));
  const vatRate = (b.vatRate != null) ? (Number(b.vatRate) === 24 ? 24 : 11) : (existing.vatRate != null ? existing.vatRate : 11);
  const costPriceIsk = numField(b.costPriceIsk, existing.costPriceIsk != null ? existing.costPriceIsk : null);
  const weightGrams  = numField(b.weightGrams,  existing.weightGrams  != null ? existing.weightGrams  : null);
  try {
    storage.upsertProduct({
      goodsId, weimiId: current.goodsId, goodsCode: current.goodsCode || null,
      customCode: current.goodsCustomCode, name: goodsName,
      salePriceIsk: Math.round((current.retailPrice || 0) / 100), vatRate, costPriceIsk, weightGrams,
      measurement, barcode: barcode || null, imgUrl,
    });
  } catch (e) { console.error('[products] upsert failed:', e.message); }

  ok(res, { ok: true, goodsId, goodsName, imgUrl, vatRate, costPriceIsk, weightGrams, measurement, barcode: barcode || null });
}

/**
 * GET /api/v1/products — list the products we've stored locally (with our own
 * weight / VSK / cost attributes). Source for the catalog and the VSK report.
 */
function handleListProducts(req, res) {
  const products = storage.listProducts().map(p => ({
    goodsId: p.goodsId, weimiId: p.weimiId || null, goodsCode: p.goodsCode || null,
    customCode: p.customCode, name: p.name,
    salePriceIsk: p.salePriceIsk, vatRate: p.vatRate, costPriceIsk: p.costPriceIsk,
    weightGrams: p.weightGrams, measurement: p.measurement, barcode: p.barcode,
    imgUrl: p.imgUrl, updatedAt: p.updatedAt,
  }));
  ok(res, { products });
}

/**
 * GET /api/v1/products/import-seed — the bundled list of products to import
 * (product code + name + the VSK / cost / weight we derived from the Weimi
 * export). The dashboard fetches this, then feeds it back in batches to
 * /products/import. Kept server-side so the catalog ships with the data.
 */
function handleImportSeed(req, res) {
  let seed = [];
  try { seed = require('./data/import-seed.json'); } catch { seed = []; }
  ok(res, { count: Array.isArray(seed) ? seed.length : 0, rows: seed });
}

/**
 * POST /api/v1/products/import  body: { rows: [{ code, name?, vatRate?,
 * costPriceIsk?, weightGrams?, priceIsk?, customCode?, measurement? }] }
 * For each row we look the product up in Weimi by its code (so we capture the
 * live name, image, price and the internal id), then store it keyed by that
 * code with our VSK / cost / weight. If Weimi can't find it we still save the
 * row's attributes so nothing is lost. Idempotent — safe to re-run.
 */
async function handleImportProducts(req, res) {
  const weimi = require('./weimi');
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return json(res, 400, { ok: false, error: 'rows[] required' });
  if (rows.length > 60) return json(res, 400, { ok: false, error: 'max 60 rows per batch' });

  async function importOne(row) {
    const code = String(row.code || '').trim();
    if (!code) return { code: '', status: 'error', error: 'no code' };
    const vatRate = (Number(row.vatRate) === 24) ? 24 : 11;
    const cost    = (row.costPriceIsk != null && row.costPriceIsk !== '') ? Math.max(0, Math.round(Number(row.costPriceIsk))) : null;
    const weight  = (row.weightGrams  != null && row.weightGrams  !== '') ? Math.max(0, Math.round(Number(row.weightGrams)))  : null;

    // Find the live product: try product code, then custom code.
    let found = null;
    for (const keyName of ['goodsCode', 'goodsCustomCode']) {
      const val = keyName === 'goodsCode' ? code : (row.customCode || code);
      try {
        const q = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { [keyName]: val });
        const d = JSON.parse(q.bodyPreview)?.data || null;
        if (d && d.goodsId) { found = d; break; }
      } catch { /* try next */ }
    }

    if (found) {
      try {
        storage.upsertProduct({
          goodsId: code,                                   // catalog/order key = product code
          weimiId: found.goodsId,                          // Weimi internal record id
          goodsCode: found.goodsCode || code,
          customCode: found.goodsCustomCode || row.customCode || null,
          name: weimi.fixMojibake(found.goodsName) || row.name || null,
          salePriceIsk: found.retailPrice != null ? Math.round(found.retailPrice / 100)
                        : (row.priceIsk != null ? Math.round(row.priceIsk) : null),
          vatRate, costPriceIsk: cost, weightGrams: weight,
          measurement: found.measurement != null ? found.measurement : (row.measurement || 0),
          barcode: found.barcode || null,
          imgUrl: found.imgUrl || null,
        });
        return { code, status: 'ok', name: weimi.fixMojibake(found.goodsName) || row.name || '' };
      } catch (e) { return { code, status: 'error', error: e.message }; }
    }

    // Not found in Weimi — keep the attributes anyway (no live image / id yet).
    try {
      storage.upsertProduct({
        goodsId: code, weimiId: null, goodsCode: code,
        customCode: row.customCode || null, name: row.name || null,
        salePriceIsk: row.priceIsk != null ? Math.round(row.priceIsk) : null,
        vatRate, costPriceIsk: cost, weightGrams: weight,
        measurement: row.measurement || 0, barcode: null, imgUrl: null,
      });
    } catch (e) { return { code, status: 'error', error: e.message }; }
    return { code, status: 'notfound', name: row.name || '' };
  }

  // Process the batch with light concurrency so we don't hammer Weimi.
  const results = [];
  const POOL = 6;
  for (let i = 0; i < rows.length; i += POOL) {
    const slice = rows.slice(i, i + POOL);
    const r = await Promise.all(slice.map(importOne));
    results.push(...r);
  }
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  ok(res, { counts, results });
}

async function handleCreateProduct(req, res) {
  const r2 = require('./r2');
  const weimi = require('./weimi');
  const b = req.body || {};
  const goodsName = (b.goodsName || '').trim();
  const isk = Number(b.priceIsk);
  if (!goodsName) return json(res, 400, { ok: false, error: 'name required' });
  if (!Number.isFinite(isk) || isk < 0) return json(res, 400, { ok: false, error: 'valid priceIsk required' });
  if (!b.imageBase64) return json(res, 400, { ok: false, error: 'image required' });
  if (!r2.isConfigured()) return json(res, 500, { ok: false, error: 'image hosting (R2) not configured' });

  // Our own attributes (stored locally — Weimi's catalog can't hold them).
  const vatRate = (Number(b.vatRate) === 24) ? 24 : 11;            // VSK 11 or 24 (default 11, food)
  const numOrNull = v => (v != null && v !== '' && Number.isFinite(Number(v))) ? Math.max(0, Math.round(Number(v))) : null;
  const costPriceIsk = numOrNull(b.costPriceIsk);                  // gross cost (kr), optional
  const weightGrams  = numOrNull(b.weightGrams);                   // unit weight (g), optional
  const measurement  = Number(b.measurement) === 1 ? 1 : 0;

  // Decode the image (accepts a data URL or a bare base64 string).
  let buf, contentType = b.imageType || 'image/png';
  try {
    let data = String(b.imageBase64);
    const m = data.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) { contentType = m[1]; data = m[2]; }
    buf = Buffer.from(data, 'base64');
  } catch (e) { return json(res, 400, { ok: false, error: 'bad image data' }); }
  if (!buf || !buf.length) return json(res, 400, { ok: false, error: 'empty image' });
  if (buf.length > 8 * 1024 * 1024) return json(res, 413, { ok: false, error: 'image too large (max 8MB)' });

  const ext = /png/.test(contentType) ? 'png' : /webp/.test(contentType) ? 'webp'
            : /svg/.test(contentType) ? 'svg' : /gif/.test(contentType) ? 'gif' : 'jpg';
  const customCode = (b.goodsCustomCode || ('p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8))).slice(0, 32);
  const key = `products/${customCode}.${ext}`;

  let imgUrl;
  try { imgUrl = await r2.putObject(key, buf, contentType); }
  catch (e) { return json(res, 502, { ok: false, stage: 'image_upload', error: e.message }); }

  const fields = {
    goodsName: goodsName.slice(0, 200),
    goodsCustomCode: customCode,
    retailPrice: Math.round(isk) * 100,
    imgUrl, thumbnailUrl: imgUrl,
    measurement,
  };
  if (b.barcode) fields.barcode = String(b.barcode).slice(0, 32);

  let result;
  try { result = await weimi.saveGoodsRaw({ endpoint: 'prod' }, fields); }
  catch (e) { return json(res, 502, { ok: false, stage: 'save_goods', error: e.message, imgUrl }); }

  let goodsId = null;
  try { goodsId = JSON.parse(result.bodyPreview)?.data?.goodsId || null; } catch {}
  if (result.weimiCode !== 200 || !goodsId) {
    return json(res, 502, { ok: false, stage: 'save_goods', error: weimi.fixMojibake(result.weimiMsg || 'create failed'), imgUrl });
  }

  // Resolve the product code (goodsCode) — that's the id machines and orders use,
  // so we key on it (with the internal id kept as a backup match key). This keeps
  // a created product as a single catalog card once it's placed in a machine.
  let goodsCode = null;
  try {
    const q = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { goodsId });
    goodsCode = JSON.parse(q.bodyPreview)?.data?.goodsCode || null;
  } catch { /* fall back to internal id */ }
  const catalogKey = goodsCode || goodsId;

  // Store our own attributes (weight / VSK / cost).
  try {
    storage.upsertProduct({
      goodsId: catalogKey, weimiId: goodsId, goodsCode: goodsCode || null,
      customCode, name: fields.goodsName,
      salePriceIsk: Math.round(isk), vatRate, costPriceIsk, weightGrams,
      measurement, barcode: fields.barcode || null, imgUrl,
    });
  } catch (e) { console.error('[products] upsert failed:', e.message); }

  ok(res, { ok: true, goodsId, goodsCode, customCode, imgUrl, goodsName: fields.goodsName,
            salePriceIsk: Math.round(isk), vatRate, costPriceIsk, weightGrams, measurement,
            barcode: fields.barcode || null });
}

/**
 * GET /api/v1/debug/order-times?deviceCode=62160043
 * Pulls recent orders straight from Weimi and shows the raw time strings next to
 * how we parse them (as UTC). If parsedAsUTC_ISO is shifted from the true sale
 * time, Weimi reports order times in a non-UTC zone and the parse needs correcting
 * — the suspected cause of "today" including yesterday.
 */
async function handleOrderTimes(req, res) {
  const weimi = require('./weimi');
  const deviceCode = req.query?.deviceCode || '62160043'; // Valur I (online) by default
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  try {
    const list = await weimi.queryOrders({ endpoint: 'prod' }, { deviceCode });
    const sample = (list || []).slice(0, 12).map(o => {
      const first = (o.detailVOList || [])[0] || {};
      const raw = first.shipmentTime || o.tradeStartTime || o.payEndTime || null;
      const parsedUTC = raw ? weimi.parseWeimiTime(raw) : null;
      return {
        tradeNo: o.tradeNo || o.orderId,
        rawTimeString: raw,
        tradeStartTime: o.tradeStartTime || null,
        payEndTime: o.payEndTime || null,
        shipmentTime: first.shipmentTime || null,
        parsedUTC_ISO: parsedUTC ? new Date(parsedUTC).toISOString() : null,
        bucket: parsedUTC == null ? '?' : (parsedUTC >= todayUTC ? 'today'
              : (parsedUTC >= todayUTC - 86400000 ? 'yesterday' : 'older')),
      };
    });
    ok(res, {
      deviceCode,
      serverNowUTC_ISO: now.toISOString(),
      todayBoundaryUTC_ISO: new Date(todayUTC).toISOString(),
      note: 'Times now parsed as China time (UTC+8). parsedUTC_ISO should sit at or before serverNowUTC_ISO for recent sales.',
      orderCount: (list || []).length,
      sample,
    });
  } catch (e) {
    json(res, 200, { ok: false, error: e.message });
  }
}

function handleProductCatalog(req, res) {
  const storage = require('./storage');
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode, req.query?.operatorId);
  if (codes === null) return json(res, 403, { error: 'Forbidden' });

  const byGoods = {};   // goodsId → aggregate
  for (const code of (codes || [])) {
    let layout;
    try { const raw = storage.getMeta(`layout:${code}`); layout = raw ? JSON.parse(raw) : null; }
    catch { layout = null; }
    if (!Array.isArray(layout)) continue;
    layout.forEach(layer => (layer.bays || []).forEach(b => {
      const gid = (b && b.goodsId != null) ? String(b.goodsId) : '';
      if (!gid) return;
      if (!byGoods[gid]) byGoods[gid] = { goodsId: gid, name: b.name || '', image: b.image || '', priceCounts: {}, machines: new Set(), slotCount: 0 };
      const g = byGoods[gid];
      if (!g.name && b.name) g.name = b.name;
      if (!g.image && b.image) g.image = b.image;
      const isk = Number(b.priceIsk);
      if (Number.isFinite(isk) && isk > 0) g.priceCounts[isk] = (g.priceCounts[isk] || 0) + 1;
      g.machines.add(code);
      g.slotCount += 1;
    }));
  }

  const products = Object.values(byGoods).map(g => {
    let priceIsk = 0, best = -1;   // representative price = most common across slots
    for (const [p, n] of Object.entries(g.priceCounts)) { if (n > best) { best = n; priceIsk = Number(p); } }
    const machineList = [...g.machines].map(code => ({ deviceCode: code, deviceName: (machines[code] && machines[code].deviceName) || code }));
    return { goodsId: g.goodsId, name: g.name || ('#' + g.goodsId), image: g.image || '', priceIsk, machineCount: g.machines.size, slotCount: g.slotCount, machines: machineList };
  }).sort((a, b) => a.name.localeCompare(b.name));

  ok(res, { products });
}

/**
 * POST /api/v1/products/enrich   (AG admin)
 * Create product-database rows for products that are loaded on machines but
 * missing from the database — closing the migration gap. Uses the shelf data
 * the caller passes (name/image/price from the layout) and, best-effort, pulls
 * authoritative details (name, image, barcode, codes) from Weimi's single-product
 * API. VSK and cost are left blank for the operator/AG to fill via import or edit.
 * body: { products: [{ goodsId, name, image, priceIsk }] }
 */
async function handleProductEnrich(req, res) {
  const weimi = require('./weimi');
  const storage = require('./storage');
  const list = Array.isArray(req.body?.products) ? req.body.products : [];
  if (!list.length) return badRequest(res, 'products required');
  const enriched = [], skipped = [];
  for (const item of list) {
    const gid = item && item.goodsId != null ? String(item.goodsId) : '';
    if (!gid) { skipped.push({ goodsId: gid, reason: 'no goodsId' }); continue; }
    if (storage.getProduct(gid)) { skipped.push({ goodsId: gid, reason: 'already_in_db' }); continue; }
    // Best-effort: pull authoritative details from Weimi (the id we hold is the
    // product code, so try goodsCode first, then the other identifiers).
    let w = null;
    for (const keyName of ['goodsCode', 'goodsId', 'goodsCustomCode']) {
      try {
        const q = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { [keyName]: gid });
        const d = JSON.parse(q.bodyPreview)?.data || null;
        if (d && d.goodsId) { w = d; break; }
      } catch { /* try next identifier */ }
    }
    const layoutName = (item.name || '').trim();
    const layoutImg  = (item.image || '').trim();
    const priceIsk   = Number(item.priceIsk) || 0;
    storage.upsertProduct({
      goodsId:      gid,
      weimiId:      w ? w.goodsId : null,
      goodsCode:    w ? (w.goodsCode || gid) : gid,
      customCode:   w ? (w.goodsCustomCode || null) : null,
      name:         (w && w.goodsName) || layoutName || ('#' + gid),
      salePriceIsk: priceIsk || null,
      vatRate:      null,   // VSK set later via import / edit
      costPriceIsk: null,   // cost set later via import / edit
      weightGrams:  null,
      measurement:  (w && w.measurement != null) ? w.measurement : 0,
      barcode:      w ? (w.barcode || null) : null,
      imgUrl:       (w && w.imgUrl) || layoutImg || null,
    });
    enriched.push({ goodsId: gid, name: (w && w.goodsName) || layoutName, fromWeimi: !!w });
  }
  ok(res, { enrichedCount: enriched.length, skippedCount: skipped.length, enriched, skipped });
}

/**
 * POST /api/v1/machines/:deviceCode/slots/product
 * Swap the product in a single slot. Assigns the new product + price via the
 * proven per-aisle goods/update endpoint, then sets the loaded stock count.
 * Requires the machine to be online (Weimi rejects writes to offline machines).
 * body: { aisleCode, goodsId, priceIsk, currStock? }.
 */
async function handleSlotProduct(req, res) {
  const weimi = require('./weimi');
  const code = req.params.deviceCode;
  const body = req.body || {};
  const aisleCode = body.aisleCode != null ? String(body.aisleCode) : '';
  const goodsId = body.goodsId != null ? String(body.goodsId) : '';
  const isk = Number(body.priceIsk);
  if (!aisleCode) return json(res, 400, { ok: false, error: 'aisleCode required' });
  if (!goodsId) return json(res, 400, { ok: false, error: 'goodsId required' });
  if (!Number.isFinite(isk) || isk < 0) return json(res, 400, { ok: false, error: 'valid priceIsk required' });
  const priceCents = Math.round(isk) * 100;

  // 1) Assign the new product + price to this one slot.
  let r;
  try { r = await weimi.updateAisleGoods({ endpoint: 'prod' }, code, [aisleCode], goodsId, priceCents); }
  catch (e) { return json(res, 502, { ok: false, error: 'weimi_unreachable', message: e.message }); }
  const v = interpretWeimiWrite(r);
  if (!v.ok) return json(res, v.status, { ok: false, error: v.error, message: v.message, code: v.code });

  // 2) Set the loaded stock count for the swapped slot (best-effort; the swap
  //    itself already succeeded).
  let stockSet = null;
  const n = Number(body.currStock);
  if (Number.isFinite(n) && n >= 0) {
    try {
      const sr = await weimi.updateAisleStock({ endpoint: 'prod' }, code, [{ aisleCode, currStock: Math.round(n) }]);
      if (interpretWeimiWrite(sr).ok) stockSet = Math.round(n);
    } catch (e) { /* non-fatal */ }
  }

  try { await require('./weimiSync').syncMachine(code, { orders: false }); } catch (e) { /* non-fatal */ }
  ok(res, { deviceCode: code, aisleCode, goodsId, priceIsk: Math.round(isk), stockSet });
}

async function handleWeimiPopulate(req, res) {
  const weimiSync = require('./weimiSync');
  try {
    const result = await weimiSync.populateFromWeimi();
    ok(res, result);
  } catch (e) {
    console.error('[WEIMI] populate failed:', e.message);
    json(res, 502, { ok: false, error: e.message });
  }
}

/**
 * GET /api/v1/debug/weimi-write-test?deviceCode=X[&full=true]
 * Verifies whether Weimi accepts WRITE calls for this machine type, using
 * NO-OP writes (resubmits the slot's CURRENT values, so nothing changes).
 *   - Always: per-aisle stock no-op (/ext/aisle/stock/update)
 *   - full=true: whole-machine goods/info no-op (price+stock+product) too
 * operationStatus 0/1/2 = accepted; 3 or an error = not supported for this model.
 */
async function handleWeimiWriteTest(req, res) {
  const weimi = require('./weimi');
  const code = req.query?.deviceCode;
  const full = req.query?.full === 'true';
  if (!code) return json(res, 400, { ok: false, error: 'deviceCode required' });
  const CFG = { endpoint: 'prod' };
  try {
    const info = await weimi.deviceInfo(CFG, code);
    const aisles = [];
    (info.cabinets || []).forEach(cab => (cab.layers || []).forEach(l => (l.aisles || []).forEach(a => aisles.push(a))));
    const valid = aisles.filter(a => a.code && (a.goodsId || a.id));
    if (!valid.length) return json(res, 200, { ok: false, error: 'no configured aisles found for this device', aisleCount: aisles.length });

    const target = valid.find(a => a.isEnable && !a.isBroken) || valid[0];
    const out = {
      deviceCode: code,
      aisleCount: aisles.length,
      note: 'No-op writes only — current values are resubmitted, so nothing actually changes.',
    };

    // Test 1: per-aisle stock no-op (safe, touches one slot)
    out.stockUpdateTest = {
      endpoint: '/ext/aisle/stock/update',
      sent: { aisleCode: target.code, currStock: target.currStock || 0 },
      result: await weimi.updateAisleStock(CFG, code, [{ aisleCode: target.code, currStock: target.currStock || 0 }]),
    };

    // Test 2: whole-machine goods/info no-op (price+stock+product) — only on demand
    if (full) {
      const aisleList = valid.map(a => ({
        aisleCode: a.code,
        currStock: a.currStock || 0,
        goodsId:   String(a.goodsId || a.id),
        price:     a.price || 0,
        measurement: a.measurement || 0,
      }));
      out.goodsInfoTest = {
        endpoint: '/ext/aisle/goods/info/update (whole-machine)',
        aisleCount: aisleList.length,
        result: await weimi.updateAisleGoodsInfo(CFG, code, aisleList),
      };
    }
    ok(res, out);
  } catch (e) {
    json(res, 502, { ok: false, error: e.message });
  }
}

// ─── Nayax handlers ──────────────────────────────────────────────────────────

const nayax = require('./nayax');

/**
 * GET /api/v1/nayax/status
 * Reports whether Nayax is configured and reachable.
 */
async function handleNayaxStatus(req, res) {
  if (!nayax.isConfigured()) {
    return ok(res, { configured: false, message: 'NAYAX_TOKEN not set' });
  }
  try {
    const ping = await nayax.ping();
    ok(res, { configured: true, ...ping });
  } catch (e) {
    json(res, 200, { ok: true, data: { configured: true, error: e.code || 'UNKNOWN', detail: e.message } });
  }
}

/**
 * GET /api/v1/nayax/machines
 * Lists machines visible in the Nayax account. Used by the link UI so the
 * operator can pick which Nayax machine to associate with which Snarl & Sopi machine.
 *
 * Query params: limit, offset, machineName (filter)
 */
async function handleNayaxList(req, res) {
  if (!nayax.isConfigured()) return badRequest(res, 'NAYAX_TOKEN not set');
  const { limit, offset, machineName } = req.query || {};
  try {
    const data = await nayax.listMachines({
      limit:  limit  ? parseInt(limit, 10)  : 100,
      offset: offset ? parseInt(offset, 10) : 0,
      machineName,
    });
    // The Lynx API response shape may be either {Results:[...]} or a bare array; normalize.
    const list = Array.isArray(data) ? data : (data?.Results || []);
    ok(res, list, { total: list.length, raw: data });
  } catch (e) {
    nayaxErrorResponse(res, e);
  }
}

/**
 * POST /api/v1/machines/:deviceCode/nayax/link
 * Manually associate a Snarl & Sopi machine with a Nayax MachineID.
 *
 * Body: { nayaxMachineId: "12345" }  (or null/"" to unlink)
 */
function handleNayaxLink(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, 'Machine not found');
  const newId = req.body?.nayaxMachineId;
  if (newId !== null && newId !== '' && typeof newId !== 'string' && typeof newId !== 'number') {
    return badRequest(res, 'nayaxMachineId must be a string, number, or null');
  }
  m.nayaxMachineId = (newId === '' || newId === null) ? null : String(newId);
  m.updatedAt      = new Date().toISOString();
  storage.upsertMachine(m);
  ok(res, { deviceCode: m.deviceCode, nayaxMachineId: m.nayaxMachineId });
}

/**
 * POST /api/v1/machines/:deviceCode/nayax/sync
 * Pull the latest info for one machine from Nayax and cache it.
 */
async function handleNayaxSyncOne(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, 'Machine not found');
  if (!m.nayaxMachineId) return badRequest(res, 'Machine has no nayaxMachineId — link it first');
  if (!nayax.isConfigured()) return badRequest(res, 'NAYAX_TOKEN not set');

  try {
    const data = await nayax.getMachineById(m.nayaxMachineId);
    applyNayaxData(m, data);
    storage.upsertMachine(m);
    ok(res, { deviceCode: m.deviceCode, syncedAt: m.nayaxLastSyncAt, data });
  } catch (e) {
    nayaxErrorResponse(res, e);
  }
}

/**
 * POST /api/v1/nayax/sync-all
 * Sync every linked machine. AG admin only because it does N API calls.
 */
async function handleNayaxSyncAll(req, res) {
  if (!nayax.isConfigured()) return badRequest(res, 'NAYAX_TOKEN not set');
  const all = storage.listMachines().filter(m => m.nayaxMachineId);
  if (!all.length) return ok(res, { synced: 0, errors: 0, machines: [] });

  const results = [];
  let synced = 0, errors = 0;
  for (const m of all) {
    try {
      const data = await nayax.getMachineById(m.nayaxMachineId);
      applyNayaxData(m, data);
      storage.upsertMachine(m);
      synced++;
      results.push({ deviceCode: m.deviceCode, ok: true });
    } catch (e) {
      errors++;
      results.push({ deviceCode: m.deviceCode, ok: false, error: e.code || e.message });
      // If auth is broken there's no point continuing
      if (e.code === 'NAYAX_AUTH' || e.code === 'NAYAX_NOT_CONFIGURED') break;
    }
  }
  ok(res, { synced, errors, machines: results });
}

/**
 * GET /api/v1/machines/:deviceCode/nayax/sales
 * Recent sales for one machine from Nayax. Live, not cached.
 */
async function handleNayaxSalesOne(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, 'Machine not found');
  if (!m.nayaxMachineId) return badRequest(res, 'Machine has no nayaxMachineId');
  if (!nayax.isConfigured()) return badRequest(res, 'NAYAX_TOKEN not set');
  const limit = req.query?.limit ? parseInt(req.query.limit, 10) : 50;
  try {
    const data = await nayax.getLastSales(m.nayaxMachineId, { limit });
    ok(res, data);
  } catch (e) {
    nayaxErrorResponse(res, e);
  }
}

/**
 * Apply a Nayax machine info response to our local machine record.
 * We don't assume a specific Lynx response shape — we look for common keys
 * (Status, MachineName, LastActivity) and fall back to storing the raw blob.
 */
function applyNayaxData(machine, data) {
  // Look for status fields. Nayax uses different key names depending on endpoint;
  // be lenient and check the common candidates.
  const statusStr   = pickFirst(data, ['Status', 'MachineStatus', 'OperationalStatus']);
  const isOnline    = pickFirst(data, ['IsOnline', 'Online']);
  const lastActive  = pickFirst(data, ['LastActivity', 'LastSeen', 'LastReportDate', 'LastCommunication']);
  const nayaxName   = pickFirst(data, ['MachineName', 'Name', 'DisplayName']);

  // Normalise online: explicit boolean, otherwise infer from a "status" string.
  let online = null;
  if (typeof isOnline === 'boolean') online = isOnline;
  else if (typeof statusStr === 'string') {
    const s = statusStr.toLowerCase();
    if (s.includes('online') || s.includes('active') || s.includes('ok')) online = true;
    else if (s.includes('offline') || s.includes('disconnected') || s.includes('down')) online = false;
  }

  if (online !== null) {
    machine.isOnline  = online;
    machine.isRunning = online; // Nayax doesn't distinguish — treat them the same
  }
  // Don't overwrite our deviceName from Nayax automatically — keep our naming
  // in case operators have renamed locally. Make the Nayax name available separately.
  machine.nayaxLastSyncAt = new Date().toISOString();
  machine.nayaxData       = {
    rawStatus:    statusStr || null,
    nayaxName:    nayaxName || null,
    lastActivity: lastActive || null,
    fetchedAt:    machine.nayaxLastSyncAt,
    full:         data,
  };
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return null;
}

function nayaxErrorResponse(res, e) {
  const map = {
    NAYAX_NOT_CONFIGURED: 400,
    NAYAX_AUTH:           502,
    NAYAX_RATE_LIMITED:   429,
    NAYAX_NETWORK:        502,
    NAYAX_API_ERROR:      502,
  };
  const status = map[e.code] || 500;
  console.error('[NAYAX]', e.code, e.message);
  json(res, status, { ok: false, error: e.code || 'NAYAX_ERROR', detail: e.message });
}

// ─── View models ──────────────────────────────────────────────────────────────

function handleAssignOperator(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const { operatorId } = req.body || {};
  if (!operatorId) return badRequest(res, 'operatorId is required');
  const op = operators[operatorId];
  if (!op) return badRequest(res, `Operator ${operatorId} not found`);
  m.operatorId = operatorId;
  m.profile  = m.profile  || {}; m.profile.operatorName  = op.name;
  // Drop any per-machine support contact so the kiosk re-derives it from the
  // new operator's customer email/phone (see buildConfigResponse).
  m.profile.supportEmail = '';
  m.profile.supportPhone = null;
  m.settings = m.settings || {}; m.settings.operatorName = op.name;
  m.updatedAt = new Date().toISOString();
  machines[code] = m; // persists via storage.upsertMachine
  console.log(`[OPERATOR] ${code} → ${op.name} (${operatorId})`);
  ok(res, machineSummary(machines[code]));
}

function machineSummary(m) {
  const proxy = require('./proxy');
  const storage = require('./storage');
  // Kiosk is "alive" if its WebSocket is connected (legacy) OR it made an
  // authenticated HTTP call recently. Derived fresh each read so it can't go stale.
  const kioskAlive = proxy.isConnected(m.deviceCode) || storage.isKioskAlive(m.deviceCode);
  // Last visit = last detected restock. Use the recorded value; if absent, backfill
  // once from stock history and cache it so future reads are cheap.
  let lastVisitMs = Number(storage.getMeta(`lastvisit:${m.deviceCode}`)) || null;
  if (!lastVisitMs) {
    try {
      const computed = storage.getLastRestockAt(m.deviceCode);
      if (computed) { storage.setMeta(`lastvisit:${m.deviceCode}`, computed); lastVisitMs = computed; }
    } catch (e) { /* non-fatal */ }
  }
  return {
    deviceCode: m.deviceCode, deviceName: m.deviceName, location: m.location,
    isOnline: m.isOnline || kioskAlive, isRunning: m.isRunning || kioskAlive, kioskVersion: m.kioskVersion,
    kioskConnected: kioskAlive,
    proxyConnected: kioskAlive,
    totalCurrStock: m.totalCurrStock, maxStock: m.maxStock,
    stockPercent: m.maxStock > 0 ? Math.round(m.totalCurrStock / m.maxStock * 100) : 0,
    unsupported: m.unsupported || false,
    operatorName: m.profile.operatorName,
    operatorId: m.operatorId,
    lastVisitAt: lastVisitMs,
    nayaxMachineId: m.nayaxMachineId || null,
    configVersion: m.configVersion,
    updatedAt: m.updatedAt,
  };
}

function machineDetail(m) {
  return { ...machineSummary(m), profile: m.profile, featured: m.featured, ads: m.ads, settings: m.settings, productOverrides: m.productOverrides, createdAt: m.createdAt };
}

function publicUser(u) {
  const { password, ...safe } = u;
  const op = operators[u.operatorId];
  return {
    ...safe,
    operatorName: op?.name || null,
    isAGVending:  op?.isAGVending || false,
  };
}

module.exports = { router };
