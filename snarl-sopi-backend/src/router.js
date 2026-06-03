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
  { method:'GET',  pattern:'/api/v1/debug/weimi-fleet',                       handler: handleWeimiFleetDigest },

  // Weimi fleet sync (direct, production)
  { method:'GET',  pattern:'/api/v1/weimi/last-sync',                         handler: handleWeimiLastSync, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/weimi/sync-all',                          handler: handleWeimiSyncAll, middleware:[requireAuth, requireAgAdmin] },
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

  // Operator complaint management (dashboard-facing)
  { method:'GET',  pattern:'/api/v1/complaints',                             handler: handleListComplaints, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/complaints/:complaintId',                handler: handleGetComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/reply',          handler: handleReplyComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/refund',         handler: handleRefundComplaint, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/complaints/:complaintId/status',         handler: handleSetComplaintStatus, middleware:[requireAuth] },

  // ── Operator dashboard — machines ─────────────────────────────────────────
  { method:'GET',  pattern:'/api/v1/machines',                               handler: handleListMachines, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode',                   handler: handleGetMachine,   middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/profile',           handler: handleUpdateProfile,middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/featured',          handler: handleSetFeatured,  middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/ads',               handler: handleSetAds,       middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/settings',          handler: handleUpdateSettings,middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/revoke-key',        handler: handleRevokeKey,    middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines',                               handler: handleAddMachine,   middleware:[requireAuth, requireOperatorAdmin] },

  // ── Operators (multi-tenant management) ───────────────────────────────────
  { method:'GET',  pattern:'/api/v1/operators',                              handler: handleListOperators, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId',                  handler: handleGetOperator,   middleware:[requireAuth, requireOperatorAccess] },
  { method:'PUT',  pattern:'/api/v1/operators/:operatorId',                  handler: handleUpdateOperator,middleware:[requireAuth, requireOperatorAccess, requireOperatorAdmin] },
  { method:'POST', pattern:'/api/v1/operators',                              handler: handleCreateOperator,middleware:[requireAuth, requireAgAdmin] },
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
  { method:'GET',  pattern:'/api/v1/reports/hourly',                         handler: handleHourlyHeatmap, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/sold-out',                               handler: handleSoldOut, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/detail',            handler: handleMachineDetail, middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/users',                                  handler: handleListUsers,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/users',                                  handler: handleInviteUser,   middleware:[requireAuth, requireOperatorAdmin] },
  { method:'GET',  pattern:'/api/v1/invitations',                            handler: handleListInvitations, middleware:[requireAuth, requireOperatorAdmin] },
  { method:'DELETE', pattern:'/api/v1/invitations/:token',                   handler: handleRevokeInvitation, middleware:[requireAuth, requireOperatorAdmin] },

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

  const allowed    = machinesForUser(req.user).map(m => m.deviceCode);
  const allowedSet = new Set(allowed);
  const todayOrders = storage.listOrdersToday(todayUTC).filter(o => allowedSet.has(o.deviceCode));

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

function getAccessibleDeviceCodes(user, requestedDeviceCode) {
  const allowed = machinesForUser(user).map(m => m.deviceCode);
  if (requestedDeviceCode) {
    if (!allowed.includes(requestedDeviceCode)) return null; // access denied
    return [requestedDeviceCode];
  }
  return allowed;
}

/**
 * GET /api/v1/reports/revenue-series?days=7&deviceCode=...
 * Returns daily revenue + order-count buckets for the chart on the dashboard.
 */
function handleRevenueSeries(req, res) {
  const days = getDaysParam(req.query, 7);
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode);
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
  const accessible = machinesForUser(req.user);
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

  const top = list.slice().sort((a, b) => b.revenueKr - a.revenueKr).slice(0, limit);
  const slow = list.slice().sort((a, b) => a.units - b.units).slice(0, limit);

  ok(res, { days, top, slow, totalProducts: list.length });
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
  const codes = getAccessibleDeviceCodes(req.user, req.query?.deviceCode);
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

  // Send the email
  try {
    await email.sendInvitation({
      to:           inviteeEmail,
      name,
      inviterName:  req.user.name,
      operatorName: operators[targetOpId].name,
      role,
      inviteToken:  invite.token,
    });
  } catch (err) {
    console.error('[INVITE] Failed to send email:', err.message);
    // Don't fail the request — the operator can resend the link manually
  }

  created(res, {
    email: invite.email,
    name:  invite.name,
    role:  invite.role,
    operatorId: invite.operatorId,
    operatorName: operators[invite.operatorId].name,
    expiresAt: new Date(invite.expiresAt).toISOString(),
    token: invite.token, // For dev: shown so you can copy the link in console
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

function handleUpdateOperator(req, res) {
  const op = operators[req.params.operatorId];
  if (!op) return notFound(res, 'Operator not found');
  const allowed = ['name', 'contactEmail', 'contactPhone'];
  allowed.forEach(k => { if (req.body[k] !== undefined) op[k] = req.body[k]; });
  storage.upsertOperator(op);
  ok(res, op);
}

function handleCreateOperator(req, res) {
  const { name, contactEmail } = req.body || {};
  if (!name) return badRequest(res, 'name required');
  // Slug for id
  const slug = name.toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `op_${slug}`;
  if (operators[id]) return badRequest(res, 'Operator with this name already exists');
  operators[id] = {
    id, name, isAGVending: false,
    contactEmail: contactEmail || '', contactPhone: '',
    createdAt: new Date().toISOString(),
  };
  created(res, operators[id]);
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

function machineSummary(m) {
  const proxy = require('./proxy');
  const isProxyConnected = proxy.isConnected(m.deviceCode);
  return {
    deviceCode: m.deviceCode, deviceName: m.deviceName, location: m.location,
    isOnline: m.isOnline, isRunning: m.isRunning, kioskVersion: m.kioskVersion,
    proxyConnected: isProxyConnected,
    totalCurrStock: m.totalCurrStock, maxStock: m.maxStock,
    stockPercent: m.maxStock > 0 ? Math.round(m.totalCurrStock / m.maxStock * 100) : 0,
    unsupported: m.unsupported || false,
    operatorName: m.profile.operatorName,
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
