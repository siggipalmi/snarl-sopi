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
  buildConfigResponse, touchConfig, fridgeSpec,
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
  { method:'GET',  pattern:'/downloads',                                     handler: handleDownloadsPage },
  { method:'GET',  pattern:'/api/v1/downloads',                             handler: handleGetDownloads,  middleware:[requireAuth, requireAgAdmin] },
  { method:'PUT',  pattern:'/api/v1/downloads',                             handler: handleSetDownloads,  middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/whatismyip',                                    handler: handleWhatIsMyIp },
  { method:'GET',  pattern:'/api/v1/proxy/status',                           handler: handleProxyStatus, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/debug/outbound-ip',                       handler: handleOutboundIp },
  { method:'GET',  pattern:'/api/v1/debug/weimi-test',                        handler: handleWeimiTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-orders',                      handler: handleWeimiOrdersTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-device',                      handler: handleWeimiDeviceDigest },
  { method:'GET',  pattern:'/api/v1/debug/product-details',                  handler: handleDebugProductDetails },
  { method:'GET',  pattern:'/api/v1/debug/shipment-status',                   handler: (req,res)=>ok(res,{ breakdown: require('./storage').shipmentStatusBreakdown(), note:'shipmentStatus 1 = delivered; anything else = not dispensed' }) },
  { method:'GET',  pattern:'/api/v1/debug/kiosk-config',                      handler: (req,res)=>{ const c=req.query?.deviceCode; const m=c&&machines[c]; if(!m) return json(res,404,{ok:false,error:'machine not found — pass ?deviceCode='}); return ok(res, buildConfigResponse(m)); } },
  { method:'GET',  pattern:'/api/v1/debug/telemetry',                         handler: (req,res)=>{ const c=req.query?.deviceCode; if(!c) return ok(res,{ all: lastTelemetry }); return ok(res, lastTelemetry[c] || { note:'no telemetry received yet for '+c }); } },
  { method:'GET',  pattern:'/api/v1/debug/weimi-write-test',                  handler: handleWeimiWriteTest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-fleet',                       handler: handleWeimiFleetDigest },
  { method:'GET',  pattern:'/api/v1/debug/weimi-goods-library',               handler: handleWeimiGoodsLibrary },
  { method:'GET',  pattern:'/api/v1/debug/r2-test',                           handler: handleR2Test },
  { method:'GET',  pattern:'/api/v1/debug/product',                           handler: handleDebugProduct },
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
  { method:'GET',  pattern:'/api/v1/products/search',                         handler: handleProductSearch,  middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/products/images/review',                  handler: handleImageReview,   middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/products/images/resolution',              handler: handleImageResolution, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/images/backfill-dims',           handler: handleBackfillDims,  middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/products/duplicates',                      handler: handleProductDuplicates, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/dedupe',                          handler: handleDedupeProducts, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/images/migrate',                 handler: handleMigrateImages, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/images/clean-backgrounds',       handler: handleCleanBackgrounds, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/:goodsId/image',                 handler: handleProductImage,  middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/enrich',                         handler: handleProductEnrich, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/match-details',                  handler: handleMatchDetails, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/products/apply-details',                  handler: handleApplyDetails, middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/products/import-seed',                    handler: handleImportSeed,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/products/import',                         handler: handleImportProducts, middleware:[requireAuth] },
  // ─── Receipts → product cost prices (feature A) ───
  { method:'GET',  pattern:'/api/v1/receipts/ping',                           handler: handleReceiptPing,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/receipts/extract',                        handler: handleReceiptExtract, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/receipts',                                handler: handleListReceipts,   middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/receipts/:id',                            handler: handleGetReceipt,     middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/receipts/:id/confirm',                    handler: handleConfirmReceipt, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/product-drafts',                          handler: handleListDrafts,     middleware:[requireAuth] },
  { method:'DELETE', pattern:'/api/v1/product-drafts/:id',                    handler: handleDeleteDraft,    middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/products',                               handler: handleCreateProduct, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/products',                               handler: handleListProducts,  middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/products/:goodsId',                      handler: handleUpdateProduct, middleware:[requireAuth] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/slots/product',      handler: handleSlotProduct, middleware:[requireAuth, requireMachineAccess] },
  // Expiry tracking (operator-facing; no kiosk change in v1)
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/batches',            handler: handleGetBatches,        middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/idle',               handler: handleIdlePreview,       middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/batches',            handler: handleSetBatches,        middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/products/:goodsId/perishable',            handler: handleSetPerishable,     middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/expiry/soon',                             handler: handleExpirySoon,        middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/expiry/settings',                         handler: handleGetExpirySettings, middleware:[requireAuth] },
  { method:'PUT',  pattern:'/api/v1/expiry/settings',                         handler: handleSetExpirySettings, middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/debug/expiry',                            handler: handleDebugExpiry,       middleware:[] },

  // ─── Remote machine commands + drop-sensor mode (contract v0.5) ───────────
  // Kiosk-facing (X-Machine-Key): pull pending commands, post results.
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/commands',            handler: handleGetCommands,    middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/commands/:id/result', handler: handleCommandResult,  middleware:[requireMachineKey] },
  // Operator-facing: enqueue a command, read history, flip drop-sensor mode.
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/commands',            handler: handleEnqueueCommand, middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/commands/history',    handler: handleCommandHistory, middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/hardware',            handler: handleSetHardware,    middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/debug/commands',                           handler: handleDebugCommands,  middleware:[] },
  { method:'GET',  pattern:'/api/v1/debug/orders',                             handler: handleDebugOrders,    middleware:[] },
  { method:'GET',  pattern:'/api/v1/debug/payday',                             handler: handleDebugPayday,    middleware:[] },

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
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/quote',             handler: handleQuote,       middleware:[requireMachineKey] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/product-details',   handler: handleMachineProductDetails, middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/sales',             handler: handleSalesIngest, middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/fridge/settlement', handler: handleFridgeSettlement, middleware:[requireMachineKey] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/fridge/baskets',     handler: handleGetFridgeBaskets, middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/fridge/baskets',     handler: handleSetFridgeBaskets, middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/fridge/settlements',  handler: handleListFridgeSettlements, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/telemetry',         handler: handleTelemetry,      middleware:[requireMachineKey] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/telemetry',         handler: handleTelemetrySeries, middleware:[requireAuth, requireMachineAccess] },
  { method:'GET',  pattern:'/api/v1/machines/:deviceCode/app-update',        handler: handleAppUpdate,      middleware:[requireMachineKey] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/revert-report',     handler: handleRevertReport,   middleware:[requireMachineKey] },
  { method:'GET',  pattern:'/api/v1/app-release',                            handler: handleGetAppRelease,  middleware:[requireAuth, requireAgAdmin] },
  { method:'PUT',  pattern:'/api/v1/app-release',                            handler: handlePublishAppRelease, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/app-release/rollout',                    handler: handleSetAppRollout,  middleware:[requireAuth, requireAgAdmin] },
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
  { method:'POST', pattern:'/api/v1/operators/:operatorId/suspend',          handler: handleSuspendOperator, middleware:[requireAuth, requireAgAdmin] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/out-of-service',     handler: handleMachineOutOfService, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/restart',           handler: handleMachineRestart, middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/cooling',           handler: handleCooling,        middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/grid-order',         handler: handleSetGridOrder, middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/ads',               handler: handleSetAds,       middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/settings',          handler: handleUpdateSettings,middleware:[requireAuth, requireMachineAccess] },
  { method:'PUT',  pattern:'/api/v1/machines/:deviceCode/stock-source',      handler: handleStockSource, middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/machines/:deviceCode/revoke-key',        handler: handleRevokeKey,    middleware:[requireAuth, requireMachineAccess] },
  { method:'POST', pattern:'/api/v1/machines',                               handler: handleAddMachine,   middleware:[requireAuth, requireOperatorAdmin] },

  // ── Operators (multi-tenant management) ───────────────────────────────────
  { method:'GET',  pattern:'/api/v1/operators',                              handler: handleListOperators, middleware:[requireAuth] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId',                  handler: handleGetOperator,   middleware:[requireAuth, requireOperatorAccess] },
  { method:'PUT',  pattern:'/api/v1/operators/:operatorId',                  handler: handleUpdateOperator,middleware:[requireAuth, requireOperatorAccess, requireOperatorAdmin] },
  { method:'POST', pattern:'/api/v1/operators',                              handler: handleCreateOperator,middleware:[requireAuth, requireAgAdmin] },
  { method:'DELETE',pattern:'/api/v1/operators/:operatorId',                 handler: handleDeleteOperator,middleware:[requireAuth, requireAgAdmin] },
  // Operator billing portal (read-only Payday).
  { method:'PUT',  pattern:'/api/v1/operators/:operatorId/payday-link',      handler: handleSetPaydayLink,    middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',    pattern:'/api/v1/deals',                                 handler: handleListDeals,  middleware:[requireAuth] },
  { method:'POST',   pattern:'/api/v1/deals',                                 handler: handleCreateDeal, middleware:[requireAuth, requireAgAdmin] },
  { method:'PUT',    pattern:'/api/v1/deals/:id',                             handler: handleUpdateDeal, middleware:[requireAuth, requireAgAdmin] },
  { method:'DELETE', pattern:'/api/v1/deals/:id',                             handler: handleDeleteDeal, middleware:[requireAuth, requireAgAdmin] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId/invoices',         handler: handleOperatorInvoices, middleware:[requireAuth, requireOperatorAccess] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId/ledger',           handler: handleOperatorLedger,   middleware:[requireAuth, requireOperatorAccess] },
  { method:'GET',  pattern:'/api/v1/operators/:operatorId/invoices/:invoiceId/pdf', handler: handleOperatorInvoicePdf, middleware:[requireAuth, requireOperatorAccess] },
  // Signup automation: the leasing Zap calls this after creating the Payday customer.
  { method:'POST', pattern:'/api/v1/operators/provision',                     handler: handleProvisionOperator, middleware:[] },
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

  // Lease-unit assignment (Zapier lease flow — secret-header auth)
  { method:'POST', pattern:'/api/v1/leases/claim', handler: handleLeaseClaim,     middleware:[requireLeaseKey] },
  { method:'POST', pattern:'/api/v1/leases/free',  handler: handleLeaseFree,      middleware:[requireLeaseKey] },
  // Dashboard read (operator auth)
  { method:'GET',  pattern:'/api/v1/leases/units', handler: handleListLeaseUnits, middleware:[requireAuth, requireAgAdmin] },
  // Dashboard maintenance (top operator) — free one unit / reseed inventory
  { method:'POST', pattern:'/api/v1/leases/units/:machineId/free', handler: handleLeaseFreeOne,    middleware:[requireAuth, requireAgAdmin] },
  { method:'POST', pattern:'/api/v1/leases/reseed',                handler: handleLeaseReseedAdmin, middleware:[requireAuth, requireAgAdmin] },
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

// ─── Lease-claim key middleware (for the Zapier lease flow) ──────────────────
const LEASE_CLAIM_SECRET = process.env.LEASE_CLAIM_SECRET || 'lease-dev-secret';
function requireLeaseKey(req, res, next) {
  const key = req.headers['x-lease-key'];
  if (key !== LEASE_CLAIM_SECRET) {
    return json(res, 401, { error: 'Unauthorized — bad or missing X-Lease-Key' });
  }
  next();
}

// ─── Health ───────────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  let version = '0.0.0';
  try { version = require('../package.json').version; } catch (e) {}
  ok(res, {
    status: 'ok', version, contract: 'v0.1', uptime: process.uptime(),
    node: process.version,
    imaging: (() => { try { require('sharp'); return 'ok'; } catch (e) { return 'unavailable'; } })(),
    // Onboarding readiness — booleans only, never the secret values. Lets you confirm the
    // operator-signup path is wired before running a real operator through it.
    onboarding: {
      operatorProvisionKey: !!process.env.PROVISION_KEY,     // gates POST /operators/provision (the Zap)
      machineProvisionSecret: !!process.env.PROVISION_SECRET, // gates kiosk machine provisioning
      email: !!process.env.SENDGRID_API_KEY ? 'sendgrid' : 'console-only',
      emailFrom: process.env.EMAIL_FROM || 'hallo@snarlogsopi.is',
      appUrl: process.env.APP_URL || 'https://admin.agvending.is',
    },
    // Receipt extraction readiness. Boolean only — never the key value. Confirms the
    // ANTHROPIC_API_KEY variable name/casing is right and a key is visible to the backend.
    // This does NOT prove the key works (billing/validity) — use GET /api/v1/receipts/ping for that.
    receiptsVision: !!process.env.ANTHROPIC_API_KEY ? 'key-present' : 'no-key',
    db: { path: storage.dbPath || null, persistent: storage.dbPersistent !== false },
  });
}

// ─── Lease-unit assignment handlers ──────────────────────────────────────────
/**
 * POST /api/v1/leases/claim
 * Body: { einfaldur, tvofaldur, skjar, assignedTo, kennitala }
 * Claims the next available unit(s) per type, marks them used, returns
 * contract-ready serial blocks.
 */
function handleLeaseClaim(req, res) {
  const b = req.body || {};
  const wants = {
    'Einfaldur': Number(b.einfaldur) || 0,
    'Tvöfaldur': Number(b.tvofaldur) || 0,
    '55"':       Number(b.skjar)     || 0,
  };
  const totalWanted = wants['Einfaldur'] + wants['Tvöfaldur'] + wants['55"'];
  if (totalWanted <= 0) {
    return badRequest(res, 'No units requested (einfaldur/tvofaldur/skjar all zero)');
  }

  const { claimed, warnings } =
    storage.claimLeaseUnits(wants, b.assignedTo || '', b.kennitala || '');

  const order = ['Einfaldur', 'Tvöfaldur', '55"'];
  const flat = [];
  order.forEach(t => (claimed[t] || []).forEach(u => flat.push({ type: t, ...u })));

  ok(res, {
    radnumer_sjalfsala: flat.map(u => u.machineId).join('\n'),
    radnumer_nayax:     flat.map(u => u.nayaxId).join('\n'),
    units: flat,
    counts: {
      einfaldur: (claimed['Einfaldur'] || []).length,
      tvofaldur: (claimed['Tvöfaldur'] || []).length,
      skjar:     (claimed['55"'] || []).length,
    },
    warnings,
  });
}

/** GET /api/v1/leases/units — dashboard view (operator auth) */
function handleListLeaseUnits(req, res) {
  ok(res, { units: storage.listLeaseUnits() });
}

/** POST /api/v1/leases/units/:machineId/free — top operator frees one unit from the dashboard */
function handleLeaseFreeOne(req, res) {
  const machineId = String(req.params.machineId || '').trim();
  try {
    const unit = storage.getLeaseUnit(machineId);
    if (!unit) return notFound(res, 'Unknown lease unit: ' + machineId);
    storage.freeLeaseUnit(machineId);
    ok(res, { freed: machineId, unit: storage.getLeaseUnit(machineId) });
  } catch (e) {
    console.error('[LEASE] admin free failed', e);
    json(res, 500, { ok: false, error: 'free_failed', message: String((e && e.message) || e) });
  }
}

/** POST /api/v1/leases/reseed — top operator resets inventory to the seed baseline (destructive) */
function handleLeaseReseedAdmin(req, res) {
  try {
    const n = storage.reseedLeaseUnits();
    const units = storage.listLeaseUnits();
    const available = units.filter(u => u.status === 'available').length;
    ok(res, { reseeded: n, available, used: units.length - available });
  } catch (e) {
    console.error('[LEASE] admin reseed failed', e);
    json(res, 500, { ok: false, error: 'reseed_failed', message: String((e && e.message) || e) });
  }
}

/**
 * POST /api/v1/leases/free
 * Body: { machineId }  — returns a single unit to 'available' (clears assignee).
 * Used to reset test claims. Secret-header protected like claim.
 */
function handleLeaseFree(req, res) {
  const b = req.body || {};

  // Mode 1: reseed — wipe and restore the exact starting inventory (test cleanup)
  if (b.reseed === true || b.reseed === 'true') {
    const n = storage.reseedLeaseUnits();
    return ok(res, { reseeded: n });
  }

  // Mode 2: free all units assigned to a given name (clears a test batch)
  if (b.assignedTo) {
    const freed = storage.freeLeaseUnitsByAssignee(b.assignedTo.toString());
    return ok(res, { freedByAssignee: b.assignedTo, count: freed });
  }

  // Mode 3: free a single unit by machineId
  const machineId = (b.machineId || '').toString().trim();
  if (!machineId) return badRequest(res, 'Provide machineId, assignedTo, or reseed:true');
  const unit = storage.getLeaseUnit(machineId);
  if (!unit) return json(res, 404, { error: 'Unknown machineId: ' + machineId });
  storage.freeLeaseUnit(machineId);
  ok(res, { freed: machineId, unit: storage.getLeaseUnit(machineId) });
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
  if (user.role !== 'ag_admin' && user.operatorId) {
    const op = operators[user.operatorId];
    if (op && op.suspended) {
      return json(res, 403, { ok: false, error: 'This account is suspended. Please contact AG Vending.' });
    }
  }
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
// Normalise a sale timestamp to epoch ms. Accepts ISO strings, epoch ms, or
// epoch seconds (auto-detected by magnitude).
function normalizeSaleTs(at) {
  if (typeof at === 'number') return at < 1e12 ? Math.round(at * 1000) : Math.round(at);
  if (typeof at === 'string') {
    const ms = Date.parse(at);
    if (!isNaN(ms)) return ms;
    const n = Number(at);
    if (!isNaN(n)) return n < 1e12 ? n * 1000 : n;
  }
  return Date.now();
}

// Accept both sales shapes:
//   (a) canonical per-item: { tradeNo, goodsId, amountKr, timestamp, status, qty? }
//   (b) kiosk checkout envelope: { saleId, at, totalIsk, lines:[{goodsId, qty, amountIsk}] }
// (b) is expanded into one canonical record per line, with a stable per-line
// tradeNo derived from saleId so re-sends stay idempotent. Envelope sales are
// completed payments → status 1.
function normalizeSaleRecords(raw) {
  const out = [];
  for (const r of (raw || [])) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { out.push(r); continue; }
    if (r.tradeNo) { out.push(r); continue; } // already canonical
    if (r.saleId && Array.isArray(r.lines)) {
      const ts = normalizeSaleTs(r.at);
      if (!r.lines.length) {
        out.push({ tradeNo: String(r.saleId), goodsId: null, productName: '', amountKr: Number(r.totalIsk) || 0, timestamp: ts, status: 1 });
        continue;
      }
      r.lines.forEach((ln, i) => {
        ln = ln || {};
        const goodsId = ln.goodsId != null ? String(ln.goodsId) : (ln.gid != null ? String(ln.gid) : (ln.productId != null ? String(ln.productId) : null));
        const qty = Math.max(1, Math.round(Number(ln.qty != null ? ln.qty : (ln.quantity != null ? ln.quantity : 1)) || 1));
        const amountKr = Number(ln.amountIsk != null ? ln.amountIsk : (ln.amountKr != null ? ln.amountKr : (ln.priceIsk != null ? ln.priceIsk : (ln.amount != null ? ln.amount : 0)))) || 0;
        out.push({
          tradeNo: `${r.saleId}#${i}`,
          goodsId,
          productName: ln.name || ln.productName || '',
          amountKr, qty, timestamp: ts, status: 1,
        });
      });
      continue;
    }
    out.push(r); // unknown shape → validation will report its keys
  }
  return out;
}

// POST /api/v1/machines/:deviceCode/fridge/settlement — record a fridge session (report-only
// audit trail; the Nayax terminal already charged). Idempotent on orderId (offline retries are
// safe). The backend RECOMPUTES quantity/line/total from the planogram and flags any mismatch
// against the app's claimed values — so this is an audit trail, not an echo of the app.
function handleFridgeSettlement(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) return contractError(res, 404, 'device_not_found', `Vélnúmer ${deviceCode} er ekki skráð.`, `Device ${deviceCode} is not registered.`);
  const b = req.body || {};
  if (!b.orderId) return contractError(res, 400, 'order_id_required', 'orderId vantar.', 'orderId is required.');

  const plan = {};
  for (const bk of (storage.listFridgeBaskets(deviceCode) || [])) {
    const p = bk.productId ? storage.getProduct(bk.productId) : null;
    plan[bk.cabinet + ':' + bk.basket] = {
      unitWeightG: bk.unitWeightG != null ? bk.unitWeightG : (p && p.weightGrams != null ? p.weightGrams : null),
      priceIsk: bk.priceIsk != null ? bk.priceIsk : (p && p.salePriceIsk != null ? p.salePriceIsk : null),
    };
  }

  const lines = Array.isArray(b.lines) ? b.lines : [];
  let recomputedIsk = 0;
  const lineRows = lines.map(l => {
    const key = (l.cabinet || 'A') + ':' + l.basket;
    const pl = plan[key] || {};
    const unitW = pl.unitWeightG != null ? pl.unitWeightG : (l.unitWeightG != null ? l.unitWeightG : null);
    const delta = (l.startWeightG != null && l.endWeightG != null) ? (l.startWeightG - l.endWeightG) : (l.deltaG != null ? -l.deltaG : null);
    const recomputedQty = (unitW && delta != null) ? Math.max(0, Math.round(delta / unitW)) : null;
    const price = pl.priceIsk != null ? pl.priceIsk : (l.priceIsk != null ? l.priceIsk : null);
    const recomputedLineIsk = (recomputedQty != null && price != null) ? recomputedQty * price : null;
    if (recomputedLineIsk != null) recomputedIsk += recomputedLineIsk;
    const lineMismatch = (l.quantity != null && recomputedQty != null && l.quantity !== recomputedQty) ||
                         (l.lineIsk != null && recomputedLineIsk != null && l.lineIsk !== recomputedLineIsk) ? 1 : 0;
    return {
      deviceCode, orderId: b.orderId, cabinet: l.cabinet || null, basket: l.basket != null ? Math.round(l.basket) : null,
      productId: l.productId || null,
      startWeightG: l.startWeightG != null ? Math.round(l.startWeightG) : null,
      endWeightG: l.endWeightG != null ? Math.round(l.endWeightG) : null,
      deltaG: l.deltaG != null ? Math.round(l.deltaG) : (delta != null ? -Math.round(delta) : null),
      unitWeightG: unitW != null ? Math.round(unitW) : null,
      quantity: l.quantity != null ? Math.round(l.quantity) : null,
      recomputedQty,
      priceIsk: price != null ? Math.round(price) : null,
      lineIsk: l.lineIsk != null ? Math.round(l.lineIsk) : null,
      lineMismatch,
    };
  });

  const totalMismatch = (b.totalIsk != null && recomputedIsk !== b.totalIsk) ? 1 : 0;
  const anyLineMismatch = lineRows.some(r => r.lineMismatch) ? 1 : 0;
  const settlement = {
    orderId: String(b.orderId), deviceCode,
    startedAt: b.startedAt || null, closedAt: b.closedAt || null,
    cabinetsOpened: JSON.stringify(Array.isArray(b.cabinetsOpened) ? b.cabinetsOpened : []),
    outcome: b.outcome || null,
    totalIsk: b.totalIsk != null ? Math.round(b.totalIsk) : null,
    recomputedIsk,
    mismatch: (totalMismatch || anyLineMismatch) ? 1 : 0,
    nayaxRef: b.nayaxRef || null,
    anomalies: JSON.stringify(Array.isArray(b.anomalies) ? b.anomalies : []),
    receivedAt: Date.now(), updatedAt: Date.now(),
  };

  const isRepost = !!storage.getFridgeSettlement(deviceCode, b.orderId);
  storage.saveFridgeSettlement(settlement, lineRows);
  if (settlement.mismatch) {
    console.warn(`[FRIDGE] settlement ${b.orderId} MISMATCH: app total ${settlement.totalIsk} vs recomputed ${recomputedIsk}`);
  }
  json(res, 200, { ok: true, orderId: b.orderId, recorded: true, wasRepost: isRepost, recomputedIsk, mismatch: !!settlement.mismatch });
}

// GET /api/v1/machines/:deviceCode/fridge/baskets — admin view of the fridge planogram.
function handleGetFridgeBaskets(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) return notFound(res, `Device ${deviceCode} not found`);
  const baskets = storage.listFridgeBaskets(deviceCode).map(b => {
    const p = b.productId ? storage.getProduct(b.productId) : null;
    return { ...b, productName: p ? p.name : null, productImg: p ? p.imgUrl : null,
             effectiveWeightG: b.unitWeightG != null ? b.unitWeightG : (p ? p.weightGrams : null),
             effectivePriceIsk: b.priceIsk != null ? b.priceIsk : (p ? p.salePriceIsk : null) };
  });
  ok(res, { deviceCode, model: m.model, baskets });
}

// PUT /api/v1/machines/:deviceCode/fridge/baskets — set the planogram. Body: { baskets: [ {cabinet,
// basket, productId, serialLockNum?, priceIsk?, unitWeightG?, toleranceG?, measurementFlag?, enabled?} ] }.
function handleSetFridgeBaskets(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) return notFound(res, `Device ${deviceCode} not found`);
  const list = Array.isArray(req.body?.baskets) ? req.body.baskets : [];
  if (!list.length) return badRequest(res, 'baskets array required');
  let n = 0;
  const rejected = [];
  for (const b of list) {
    if (b.cabinet == null || b.basket == null) continue;
    // A basket that is enabled and stocked MUST have a resolvable unit weight, or the machine
    // cannot price what leaves it — and since the door exposes every basket at once, the app
    // can't safely open at all. Catch it here rather than let a bad row reach the machine.
    const enabled = b.enabled !== false;
    if (enabled && b.productId) {
      const p = storage.getProduct(b.productId);
      const w = b.unitWeightG != null ? Number(b.unitWeightG) : (p && p.weightGrams != null ? Number(p.weightGrams) : null);
      if (!w || !(w > 0)) {
        rejected.push({ cabinet: b.cabinet, basket: b.basket, reason: 'no_unit_weight',
          detail: p ? `Product ${b.productId} has no weightGrams and no per-basket unitWeightG.` : `Product ${b.productId} not found.` });
        continue;
      }
    }
    storage.upsertFridgeBasket({ ...b, deviceCode });
    n++;
  }
  // The fridge planogram is delivered inside the config response, and the kiosk polls with
  // If-None-Match: <configVersion>. Without bumping the version here a planogram change would
  // return 304 and the machine would never see it — a silent failure.
  if (n) touchConfig(m);
  if (rejected.length) {
    return json(res, 400, { ok: false, error: 'Some baskets were rejected: every enabled basket needs a unit weight.',
      updated: n, rejected, configVersion: m.configVersion });
  }
  ok(res, { deviceCode, updated: n, configVersion: m.configVersion });
}

// GET /api/v1/machines/:deviceCode/fridge/settlements — recent settlement audit records.
function handleListFridgeSettlements(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) return notFound(res, `Device ${deviceCode} not found`);
  const rows = storage.listFridgeSettlements(deviceCode, Number(req.query.limit) || 100).map(s => ({
    ...s,
    cabinetsOpened: _safeJsonParse(s.cabinetsOpened, []),
    anomalies: _safeJsonParse(s.anomalies, []),
  }));
  ok(res, { deviceCode, settlements: rows });
}

function _safeJsonParse(s, fallback) { try { return JSON.parse(s); } catch (e) { return fallback; } }

function handleSalesIngest(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${deviceCode} er ekki skráð.`,
      `Device ${deviceCode} is not registered.`);
  }

  const records = normalizeSaleRecords(Array.isArray(req.body) ? req.body : [req.body]);
  const errors  = [];
  const accepted = [];
  const duplicates = [];
  let kioskStockTouched = false;

  // Kiosk cart lines carry goodsId but no product name — resolve it from the
  // planogram (authoritative, and what the kiosk displays) so orders aren't "(unknown)".
  const lpNames = storage.layoutProductsForDevice(deviceCode) || {};
  const resolveName = (gid) => (gid && lpNames[String(gid)] && lpNames[String(gid)].name) || '';

  records.forEach((r, i) => {
    if (!r.tradeNo)                                   { errors.push(`[${i}] tradeNo required — received keys: [${(r && typeof r === 'object' && !Array.isArray(r)) ? Object.keys(r).join(', ') : (Array.isArray(r) ? 'array' : typeof r)}]`); return; }
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
      productName:r.productName || resolveName(r.goodsId) || '',
      totalAmount:Math.round(r.amountKr * 100), // store in hundredths matching Weimi
      amountKr:   r.amountKr,
      status:     r.status,
      statusLabel:{1:'success',2:'failed',3:'refunded'}[r.status],
      createTime: r.timestamp,
    });
    accepted.push(r.tradeNo);

    // For successful sales, decrement stock and detect sold-out transitions
    if (r.status === 1 && r.goodsId) {
      if (m.stockSource === 'kiosk') {
        // Backend is system of record: decrement the planogram the kiosk reads,
        // applying the stale-vend timestamp guard against the bay's last restock.
        storage.applySaleToLayout(deviceCode, String(r.goodsId), r.qty || 1, r.timestamp);
        kioskStockTouched = true;
      } else {
        storage.applySaleToStock({
          deviceCode,
          goodsId:     String(r.goodsId),
          productName: r.productName || '',
        });
      }
    }
  });

  if (errors.length) {
    // Diagnostic echo (temporary): surface exactly what the backend received so a
    // rejected vend's response — which the kiosk logs in full — reveals the mismatch.
    const first = Array.isArray(req.body) ? req.body[0] : req.body;
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    return json(res, 400, {
      ok: false, error: 'Validation failed', detail: errors,
      debug: {
        parseError: !!req._bodyParseError,
        bodyType: Array.isArray(req.body) ? 'array' : typeof req.body,
        recordCount: records.length,
        topKeys: isObj(req.body) ? Object.keys(req.body).slice(0, 15) : null,
        firstRecordType: Array.isArray(first) ? 'array' : typeof first,
        firstRecordKeys: isObj(first) ? Object.keys(first).slice(0, 25) : null,
        rawLen: typeof req.rawBody === 'string' ? req.rawBody.length : null,
        rawPreview: typeof req.rawBody === 'string' ? req.rawBody.slice(0, 500) : null,
      },
    });
  }

  // Kiosk machines: refresh the cached machine total from the planogram. No
  // config bump — the kiosk already decremented locally and re-syncs on its own.
  if (m.stockSource === 'kiosk' && kioskStockTouched) {
    const lp = storage.layoutProductsForDevice(deviceCode);
    m.totalCurrStock = Object.values(lp).reduce((s, p) => s + (p.stock || 0), 0);
    m.updatedAt = new Date().toISOString();
    storage.upsertMachine(m);
  }

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

/**
 * POST /api/v1/machines/:deviceCode/quote — machine-key auth.
 * Prices a cart with deals applied (read-only, no inventory hold).
 * Body: { items: [ { goodsId, qty } ] }
 * Returns: { lines, subtotalIsk, discountIsk, totalIsk, appliedDeals }
 * The kiosk charges totalIsk. On any failure the kiosk should fall back to
 * base price rather than block the sale.
 */
function handleQuote(req, res) {
  const machine = machines[req.params.deviceCode];
  if (!machine) {
    return contractError(res, 404, 'device_not_found',
      `Vélnúmer ${req.params.deviceCode} er ekki skráð í kerfinu.`,
      `Device ${req.params.deviceCode} is not registered.`);
  }
  const body = req.body || {};
  if (!Array.isArray(body.items)) {
    return contractError(res, 400, 'bad_request', 'Beiðnin verður að innihalda items fylki.', 'Body must include an items array.');
  }
  try {
    ok(res, storage.priceCartForMachine(req.params.deviceCode, body.items));
  } catch (e) {
    console.error('[QUOTE] failed', e);
    contractError(res, 500, 'quote_failed', 'Verðútreikningur mistókst.', String((e && e.message) || e));
  }
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
  const { deviceCode, deviceName, location, operatorName, model } = req.body || {};
  if (!deviceCode || !deviceName) return badRequest(res, 'deviceCode and deviceName required');
  if (machines[deviceCode]) return badRequest(res, 'Device code already exists');
  // model matters: it's how a gravity fridge is identified (GR-*), which decides whether the
  // config carries a fridge planogram. Defaulting silently to the coil model would register a
  // fridge as a coil machine and it would never receive its baskets.
  const chosenModel = (model && String(model).trim()) || 'VM-WM55DL';
  const spec = fridgeSpec(chosenModel);
  machines[deviceCode] = {
    deviceCode, deviceName, location: location || '', isOnline: false, isRunning: false,
    model: chosenModel, isKioskModel: !spec.isFridge,
    kioskVersion: null, totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: operatorName || 'AG Vending', supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: deviceName },
    featured: [], ads: [],
    configVersion: new Date().toISOString(),
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: true, heatedGlassDefaultOn: true, hasLedStrips: true, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  // Persist. Without this the machine lives only in memory and disappears on the next restart,
  // taking its provisioned machine key's target with it.
  storage.upsertMachine(machines[deviceCode]);
  console.log(`[MACHINE] added ${deviceCode} (${chosenModel}${spec.isFridge ? `, fridge: ${spec.basketCount} baskets ${spec.cabinets.join('+')}` : ''})`);
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
  // Allow correcting the model. This is how a machine registered without one (e.g. a fridge
  // that came in before model support existed) gets set to GR-* so its config carries the
  // fridge planogram. Changing the model changes machine kind, so recompute isKioskModel.
  if (req.body.model !== undefined && String(req.body.model).trim()) {
    m.model = String(req.body.model).trim();
    const spec = fridgeSpec(m.model);
    m.isKioskModel = !spec.isFridge;
  }
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

// ── Expiry tracking ───────────────────────────────────────────────────────────
// Dated batches per slot for short-life products. Operator-maintained; the
// fleet "expiring soon" list is the restocker's pull-list. No kiosk change yet.
function expiryDeviceCodes(req) {
  const all = Object.values(machines);
  if (req.user.role === 'ag_admin') return all.map(m => m.deviceCode);
  return all.filter(m => m.operatorId === req.user.operatorId).map(m => m.deviceCode);
}
function expiryAlertDays() {
  const n = Number(storage.getMeta('expiry:alertDays'));
  return Number.isInteger(n) && n > 0 ? n : 3;
}
function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}
function batchStatus(daysLeft) {
  if (daysLeft < 0)  return 'expired';
  if (daysLeft <= 1) return 'critical';
  if (daysLeft <= 3) return 'soon';
  return 'ok';
}

// GET /machines/:deviceCode/batches?goodsId=CODE
function handleGetBatches(req, res) {
  const { deviceCode } = req.params;
  const goodsId = String((req.query && req.query.goodsId) || '').trim();
  if (!goodsId) return badRequest(res, 'goodsId required');
  const batches = storage.listBatchesForSlot(deviceCode, goodsId).map(b => ({
    ...b, daysLeft: daysUntil(b.expiryDate), status: batchStatus(daysUntil(b.expiryDate)),
  }));
  ok(res, { deviceCode, goodsId, batches, totalQuantity: batches.reduce((s, b) => s + (b.quantity || 0), 0) });
}

// Resolved idle-screen promo for one machine (powers the dashboard preview and
// is the same payload sent to the kiosk in config under `idle`).
function handleIdlePreview(req, res) {
  const { deviceCode } = req.params;
  ok(res, storage.resolveIdleForMachine(deviceCode));
}

// PUT /machines/:deviceCode/batches  body { goodsId, batches:[{expiryDate,quantity}] }
function handleSetBatches(req, res) {
  const { deviceCode } = req.params;
  const goodsId = String((req.body && req.body.goodsId) || '').trim();
  if (!goodsId) return badRequest(res, 'goodsId required');
  const raw = Array.isArray(req.body && req.body.batches) ? req.body.batches : null;
  if (!raw) return badRequest(res, 'batches must be an array');
  const errors = [], clean = [];
  raw.forEach((b, i) => {
    const date = String(b.expiryDate || '').trim();
    const qty  = Number(b.quantity);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`[${i}] expiryDate must be YYYY-MM-DD`);
    if (!Number.isInteger(qty) || qty < 0 || qty > 9999) errors.push(`[${i}] quantity must be 0–9999`);
    if (!errors.length) clean.push({ expiryDate: date, quantity: qty });
  });
  if (errors.length) return badRequest(res, errors.join('; '));
  const saved = storage.replaceBatchesForSlot(deviceCode, goodsId, clean, req.user.name)
    .map(b => ({ ...b, daysLeft: daysUntil(b.expiryDate), status: batchStatus(daysUntil(b.expiryDate)) }));
  ok(res, { deviceCode, goodsId, batches: saved, totalQuantity: saved.reduce((s, b) => s + (b.quantity || 0), 0) });
}

// PUT /products/:goodsId/perishable  body { perishable: true|false }
function handleSetPerishable(req, res) {
  const goodsId = req.params.goodsId;
  if (!storage.getProduct(goodsId)) {
    const name = (req.body && req.body.name) || storage.productNameFromStock(goodsId) || null;
    storage.ensureProductStub(goodsId, name);
  }
  if (!storage.getProduct(goodsId)) return notFound(res, 'Product not found');
  const val = !!(req.body && req.body.perishable);
  storage.setProductPerishable(goodsId, val);
  ok(res, { goodsId, perishable: val });
}

// GET /expiry/soon?withinDays=N  → fleet pull-list, scoped to the user's machines
function handleExpirySoon(req, res) {
  const within = Math.max(0, Math.min(60, parseInt(req.query.withinDays, 10) || expiryAlertDays()));
  const codes = new Set(expiryDeviceCodes(req));
  const rows = storage.listAllBatches()
    .filter(b => codes.has(b.deviceCode) && (b.quantity || 0) > 0)
    .map(b => {
      const daysLeft = daysUntil(b.expiryDate);
      return {
        deviceCode:  b.deviceCode,
        machineName: machines[b.deviceCode]?.deviceName || b.deviceCode,
        goodsId:     b.goodsId,
        name:        storage.getProduct(b.goodsId)?.name || b.goodsId,
        expiryDate:  b.expiryDate,
        quantity:    b.quantity,
        daysLeft,
        status:      batchStatus(daysLeft),
      };
    })
    .filter(r => r.daysLeft <= within)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.machineName.localeCompare(b.machineName));
  ok(res, rows, { total: rows.length, withinDays: within });
}

function handleGetExpirySettings(req, res) {
  ok(res, { alertDays: expiryAlertDays() });
}
function handleSetExpirySettings(req, res) {
  const n = parseInt(req.body && req.body.alertDays, 10);
  if (!Number.isInteger(n) || n < 1 || n > 60) return badRequest(res, 'alertDays must be 1–60');
  storage.setMeta('expiry:alertDays', n);
  ok(res, { alertDays: n });
}

// GET /debug/expiry?deviceCode=...  (public — for verification without the UI)
function handleDebugExpiry(req, res) {
  const deviceCode = String(req.query.deviceCode || '').trim();
  const rows = storage.listAllBatches()
    .filter(b => !deviceCode || b.deviceCode === deviceCode)
    .map(b => ({
      deviceCode: b.deviceCode,
      goodsId:    b.goodsId,
      name:       storage.getProduct(b.goodsId)?.name || b.goodsId,
      expiryDate: b.expiryDate,
      quantity:   b.quantity,
      daysLeft:   daysUntil(b.expiryDate),
      status:     batchStatus(daysUntil(b.expiryDate)),
    }));
  json(res, 200, { alertDays: expiryAlertDays(), count: rows.length, batches: rows });
}

// ─── Remote machine commands + drop-sensor mode (contract v0.5) ──────────────
// The backend cannot reach the motor board; it stores intent, the kiosk polls
// and runs it locally, then posts the result back. No push channel.

const CMD_TYPES = ['clear_aisle_fault', 'set_drop_sensor', 'query_channel_status', 'restart_app', 'restart_machine', 'set_temp', 'set_cooling', 'defrost'];
const CMD_TTL_MS = 5 * 60 * 1000;
const isoOrNull = (ms) => (ms ? new Date(ms).toISOString() : null);

// POST /machines/:deviceCode/commands  (operator) — enqueue one command.
function handleEnqueueCommand(req, res) {
  const { deviceCode } = req.params;
  if (!machines[deviceCode]) return notFound(res, `Machine ${deviceCode} not found`);
  const type = String((req.body && req.body.type) || '').trim();
  if (!CMD_TYPES.includes(type)) return badRequest(res, `type must be one of: ${CMD_TYPES.join(', ')}`);
  const params = (req.body && req.body.params && typeof req.body.params === 'object' && !Array.isArray(req.body.params))
    ? req.body.params : {};
  if (type === 'clear_aisle_fault') {
    if (!params.aisle || typeof params.aisle !== 'string') return badRequest(res, 'clear_aisle_fault requires params.aisle (string)');
  } else if (type === 'set_drop_sensor') {
    if (typeof params.enabled !== 'boolean') return badRequest(res, 'set_drop_sensor requires params.enabled (boolean)');
  } else if (type === 'set_temp') {
    const t = Math.round(Number(params.targetC));
    if (!Number.isFinite(t) || t < 1 || t > 15) return badRequest(res, 'set_temp requires params.targetC (integer 1–15 °C)');
    params.targetC = t;
  } else if (type === 'set_cooling') {
    if (typeof params.on !== 'boolean') return badRequest(res, 'set_cooling requires params.on (boolean)');
  }
  const id = 'cmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const issuedAt = Date.now();
  storage.enqueueCommand({
    id, deviceCode, type,
    params: JSON.stringify(params),
    issuedBy: (req.user && (req.user.name || req.user.email)) || null,
    issuedAt,
  });
  ok(res, { id, deviceCode, type, params, status: 'pending', issuedAt: isoOrNull(issuedAt) });
}

// GET /machines/:deviceCode/commands  (kiosk, X-Machine-Key) — pull pending.
function handleGetCommands(req, res) {
  const { deviceCode } = req.params;
  storage.expirePendingCommands(deviceCode, Date.now() - CMD_TTL_MS);
  const commands = storage.listPendingCommands(deviceCode).map(c => ({
    id: c.id,
    type: c.type,
    params: c.params ? JSON.parse(c.params) : {},
    issuedAt: isoOrNull(c.issuedAt),
  }));
  ok(res, { commands });
}

// POST /machines/:deviceCode/commands/:id/result  (kiosk, X-Machine-Key).
function handleCommandResult(req, res) {
  const { deviceCode, id } = req.params;
  const cmd = storage.getCommand(id);
  if (!cmd || cmd.deviceCode !== deviceCode) return notFound(res, 'Command not found');
  const status = String((req.body && req.body.status) || '').trim();
  if (!['ok', 'failed', 'unsupported'].includes(status)) {
    return badRequest(res, 'status must be ok | failed | unsupported');
  }
  // Idempotent: first result wins; a repeat for an already-finalized id is a no-op.
  if (cmd.status !== 'pending') {
    return ok(res, { id, status: cmd.status, alreadyRecorded: true });
  }
  const result = {
    detail: (req.body && typeof req.body.detail === 'string') ? req.body.detail : null,
    // channelStatus shape is provisional (open Q3) — stored verbatim, not yet
    // used to refresh our isBroken layout flags. Wire that once confirmed on a
    // real sensor machine.
    channelStatus: Array.isArray(req.body && req.body.channelStatus) ? req.body.channelStatus : null,
    completedAt: (req.body && typeof req.body.completedAt === 'string') ? req.body.completedAt : new Date().toISOString(),
  };
  const finalStatus = status === 'ok' ? 'done' : status; // 'done' | 'failed' | 'unsupported'
  const applied = storage.completeCommand(id, finalStatus, JSON.stringify(result), Date.now());
  if (!applied) {
    const fresh = storage.getCommand(id);
    return ok(res, { id, status: fresh ? fresh.status : finalStatus, alreadyRecorded: true });
  }
  ok(res, { id, status: finalStatus });
}

// GET /machines/:deviceCode/commands/history  (operator) — recent commands.
function handleCommandHistory(req, res) {
  const { deviceCode } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const commands = storage.listRecentCommands(deviceCode, limit).map(c => ({
    id: c.id,
    type: c.type,
    params: c.params ? JSON.parse(c.params) : {},
    status: c.status,
    issuedBy: c.issuedBy || null,
    issuedAt: isoOrNull(c.issuedAt),
    result: c.result ? JSON.parse(c.result) : null,
    completedAt: isoOrNull(c.completedAt),
  }));
  ok(res, { commands });
}

// PUT /machines/:deviceCode/hardware  (operator) — durable drop-sensor mode.
function handleSetHardware(req, res) {
  const { deviceCode } = req.params;
  const m = machines[deviceCode];
  if (!m) return notFound(res, `Machine ${deviceCode} not found`);
  const v = String((req.body && req.body.dropSensor) || '').trim();
  if (!['on', 'off'].includes(v)) return badRequest(res, "dropSensor must be 'on' or 'off'");
  m.settings = m.settings || {};
  m.settings.dropSensor = v;
  touchConfig(m); // bumps configVersion → kiosk applies on next config poll
  ok(res, { deviceCode, dropSensor: v, configVersion: m.configVersion });
}

// GET /debug/commands?deviceCode=...  (public — verification without the UI)
function handleDebugCommands(req, res) {
  const deviceCode = String(req.query.deviceCode || '').trim();
  if (!deviceCode) return badRequest(res, 'deviceCode query param required');
  storage.expirePendingCommands(deviceCode, Date.now() - CMD_TTL_MS);
  const m = machines[deviceCode];
  const fmt = (c) => ({
    id: c.id, type: c.type, params: c.params ? JSON.parse(c.params) : {},
    status: c.status, issuedBy: c.issuedBy || null, issuedAt: isoOrNull(c.issuedAt),
    result: c.result ? JSON.parse(c.result) : null, completedAt: isoOrNull(c.completedAt),
  });
  json(res, 200, {
    deviceCode,
    stockSource: (m && m.stockSource) || null,
    configVersion: m ? m.configVersion : null,
    dropSensor: (m && m.settings && m.settings.dropSensor === 'on') ? 'on' : 'off',
    restart: {
      restartApp:     (m && m.settings && m.settings.restartAppAt)     ? new Date(m.settings.restartAppAt).toISOString()     : null,
      restartMachine: (m && m.settings && m.settings.restartMachineAt) ? new Date(m.settings.restartMachineAt).toISOString() : null,
    },
    pending: storage.listPendingCommands(deviceCode).map(fmt),
    recent: storage.listRecentCommands(deviceCode, 10).map(fmt),
  });
}

// GET /debug/orders?deviceCode=... — diagnostic: why does revenue-series show
// nothing? Reveals stored order status values, amount scaling, and time range.
function handleDebugOrders(req, res) {
  const deviceCode = String(req.query.deviceCode || '').trim();
  if (!deviceCode) return badRequest(res, 'deviceCode query param required');
  const statusBreakdown = storage.debugOrderStatusCounts(deviceCode).map(r => ({
    status: r.status,
    statusLabel: r.statusLabel,
    count: r.n,
    sumAmountKr: r.sumKr,
    sumTotalAmount: r.sumTotal,
    earliest: r.minT ? new Date(r.minT).toISOString() : null,
    latest: r.maxT ? new Date(r.maxT).toISOString() : null,
  }));
  const sample = storage.debugOrdersByDevice(deviceCode, 15).map(o => ({
    tradeNo: o.tradeNo,
    status: o.status,
    statusLabel: o.statusLabel,
    totalAmount: o.totalAmount,
    amountKr: o.amountKr,
    createTime: o.createTime ? new Date(o.createTime).toISOString() : null,
  }));
  json(res, 200, { deviceCode, now: new Date().toISOString(), statusBreakdown, sample });
}

// GET /debug/weimi-orders?deviceCode=... — read-only: what Weimi returns for
// this device's orders (raw), to see whether the sync has anything to import.
async function handleDebugPayday(req, res) {
  try {
    const customerId = String(req.query.customerId || '').trim() || null;
    const ssn = String(req.query.ssn || '').trim() || null;
    ok(res, await require('./payday').debugProbe(customerId, ssn));
  } catch (e) {
    ok(res, { error: String((e && e.message) || e) });
  }
}

async function handleDebugWeimiOrders(req, res) {
  const deviceCode = String(req.query.deviceCode || '').trim();
  if (!deviceCode) return badRequest(res, 'deviceCode query param required');
  try {
    const out = await require('./weimiSync').debugQueryOrders(deviceCode);
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { deviceCode, error: String((e && e.message) || e) });
  }
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

// ── POST /api/v1/operators/:operatorId/suspend  (AG admin) ────────────────────
// Billing lever: suspend blocks all of an operator's users from logging in.
function handleSuspendOperator(req, res) {
  const id = req.params.operatorId;
  const op = operators[id];
  if (!op) return json(res, 404, { ok: false, error: 'operator not found' });
  if (op.isAGVending) return badRequest(res, 'cannot suspend AG Vending');
  const suspended = !!(req.body && req.body.suspended);
  require('./storage').setOperatorSuspended(id, suspended);
  ok(res, { id, suspended });
}

// ── PUT /api/v1/machines/:deviceCode/out-of-service ───────────────────────────
// Sets a flag the kiosk honors to show a closed screen and stop selling.
function handleMachineOutOfService(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return json(res, 404, { ok: false, error: 'machine not found' });
  m.settings = m.settings || {};
  m.settings.outOfService = !!(req.body && req.body.outOfService);
  m.settings.outOfServiceReason = (req.body && req.body.reason) ? String(req.body.reason) : null;
  touchConfig(m);
  ok(res, { deviceCode: code, outOfService: m.settings.outOfService, configVersion: m.configVersion });
}

// ── POST /api/v1/machines/:deviceCode/restart ─────────────────────────────────
// One-shot command (timestamp). The kiosk restarts the app, or reboots the
// device, when it sees a newer timestamp than the one it last acted on.
function handleMachineRestart(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return json(res, 404, { ok: false, error: 'machine not found' });
  const target = (req.body && req.body.target) === 'machine' ? 'machine' : 'app';
  m.settings = m.settings || {};
  const now = Date.now();
  if (target === 'machine') m.settings.restartMachineAt = now;
  else m.settings.restartAppAt = now;
  touchConfig(m);
  // Deliver on BOTH channels so it works regardless of which the kiosk implements:
  //  (1) config.commands.restartApp/restartMachine timestamp (above, via touchConfig)
  //  (2) the pull-queue (GET /commands), which also acks back into command history.
  const cmdId = 'cmd_' + now.toString(36) + Math.random().toString(36).slice(2, 10);
  storage.enqueueCommand({
    id: cmdId, deviceCode: code,
    type: target === 'machine' ? 'restart_machine' : 'restart_app',
    params: '{}',
    issuedBy: (req.user && (req.user.name || req.user.email)) || null,
    issuedAt: now,
  });
  ok(res, { deviceCode: code, target, issuedAt: now, commandId: cmdId, configVersion: m.configVersion });
}

// POST /api/v1/machines/:deviceCode/cooling — operator cooling control.
// body: { action:'set_temp', targetC } | { action:'set_cooling', on } | { action:'defrost' }
// Stores the intended state for dashboard display (no config bump) and enqueues the
// command on the pull-queue. Server-side range guard mirrors the kiosk (1–15 °C).
function handleCooling(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const b = req.body || {};
  const action = b.action;
  m.settings = m.settings || {};
  const now = Date.now();
  let type, params;
  if (action === 'set_temp') {
    const t = Math.round(Number(b.targetC));
    if (!Number.isFinite(t) || t < 1 || t > 15) return badRequest(res, 'targetC must be an integer between 1 and 15 °C');
    type = 'set_temp'; params = { targetC: t };
    m.settings.coolingSetpointC = t;
  } else if (action === 'set_cooling') {
    if (typeof b.on !== 'boolean') return badRequest(res, "set_cooling requires 'on' (boolean)");
    type = 'set_cooling'; params = { on: b.on };
    m.settings.coolingOn = b.on;
  } else if (action === 'defrost') {
    type = 'defrost'; params = {};
  } else {
    return badRequest(res, "action must be 'set_temp', 'set_cooling', or 'defrost'");
  }
  m.settings.coolingUpdatedAt = now;
  m.updatedAt = new Date().toISOString();
  storage.upsertMachine(m); // store intended state; no config bump (display only)
  const id = 'cmd_' + now.toString(36) + Math.random().toString(36).slice(2, 10);
  storage.enqueueCommand({
    id, deviceCode: code, type,
    params: JSON.stringify(params),
    issuedBy: (req.user && (req.user.name || req.user.email)) || null,
    issuedAt: now,
  });
  ok(res, { id, deviceCode: code, type, params, status: 'pending', issuedAt: now });
}

// POST /api/v1/machines/:deviceCode/telemetry  (X-Machine-Key)
// Body: { at(ISO), cabinetTempC(number), humidity(int|null), evaporator(int|null), statusOk(bool|null) }
// Stores the sample, caches latest, and evaluates temp/fault alerts. Best-effort: the kiosk
// drops anything non-2xx, so we accept liberally and only 400 on a missing temperature.
function handleTelemetry(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const b = req.body || {};
  if (b.cabinetTempC == null || !Number.isFinite(Number(b.cabinetTempC))) {
    return badRequest(res, 'cabinetTempC (number) is required');
  }
  const s = m.settings || {};
  const maxC = (s.tempMaxC != null) ? Number(s.tempMaxC) : undefined;        // per-machine override
  const dwellMin = (s.tempDwellMin != null) ? Number(s.tempDwellMin) : undefined;
  storage.recordTelemetry(
    { deviceCode: code, at: b.at, cabinetTempC: Number(b.cabinetTempC), humidity: b.humidity, evaporator: b.evaporator, statusOk: b.statusOk },
    { deviceName: m.deviceName, maxC, dwellMin }
  );
  ok(res, { accepted: true });
}

// GET /api/v1/machines/:deviceCode/telemetry?hours=24&buckets=48 — downsampled series for the sparkline.
function handleTelemetrySeries(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const hours = Math.max(1, Math.min(Number(req.query.hours) || 24, 720));
  const buckets = Math.max(8, Math.min(Number(req.query.buckets) || 48, 240));
  const sinceMs = Date.now() - hours * 3600000;
  const series = storage.telemetrySeries(code, sinceMs, buckets);
  const latest = storage.latestTelemetry(code);
  ok(res, { deviceCode: code, hours, series, latest });
}

// ── On-site downloads page ───────────────────────────────────────────────────
// A shared-key-gated page listing installable app packages, so on-site setup doesn't need
// a login or a giant Drive URL. GET /downloads?key=… renders HTML; the key is checked against
// DOWNLOADS_KEY env. Registry is managed by ag-admin; files live at their URLs (not hosted here).

function downloadsKeyOk(req) {
  const want = process.env.DOWNLOADS_KEY || '';
  if (!want) return false;
  const got = (req.query && req.query.key) || '';
  return got === want;
}

function handleDownloadsPage(req, res) {
  if (!downloadsKeyOk(req)) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#1A1A1A;color:#FAF7F2;display:flex;height:100vh;margin:0;align-items:center;justify-content:center"><div style="text-align:center"><div style="font-size:15px;opacity:.7">Access key required.</div></div></body>');
  }
  const items = storage.listDownloads();
  const byApp = {};
  for (const d of items) { (byApp[d.app || 'Other'] = byApp[d.app || 'Other'] || []).push(d); }
  for (const app of Object.keys(byApp)) byApp[app].sort((a, b) => (b.versionCode || 0) - (a.versionCode || 0));

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sections = Object.keys(byApp).sort().map(app => {
    const rows = byApp[app].map((d, i) => `
      <a class="pkg" href="${esc(d.url)}"${/\.apk(\?|$)/i.test(d.url) ? ' download' : ''}>
        <div class="pkg-main">
          <div class="pkg-name">${esc(d.versionName || d.app)}${i === 0 ? '<span class="latest">latest</span>' : ''}</div>
          ${d.notes ? `<div class="pkg-notes">${esc(d.notes)}</div>` : ''}
        </div>
        <div class="pkg-meta">
          ${d.versionCode ? `<span class="vc">build ${esc(d.versionCode)}</span>` : ''}
          <span class="arrow">&darr;</span>
        </div>
      </a>`).join('');
    return `<section><h2>${esc(app)}</h2>${rows || '<div class="empty">No packages yet.</div>'}</section>`;
  }).join('');

  const html = `<!doctype html><html lang="is"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Downloads &middot; Snarl &amp; Sopi</title>
<style>
  :root{--cream:#FAF7F2;--shadow:#E8DFD0;--ink:#1A1A1A;--bronze:#8B6B3E;--line:#00000014;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:linear-gradient(180deg,var(--cream),var(--shadow));color:var(--ink);min-height:100vh;padding:28px 18px 60px;}
  .wrap{max-width:560px;margin:0 auto;}
  h1{font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:27px;margin:0 0 4px;}
  .sub{font-size:13px;color:#00000077;margin-bottom:26px;}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--bronze);margin:26px 0 10px;font-weight:600;}
  .pkg{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#FFFFFFcc;border:.5px solid var(--line);border-radius:14px;padding:15px 16px;margin-bottom:9px;text-decoration:none;color:inherit;transition:transform .06s ease;}
  .pkg:active{transform:scale(.985);}
  .pkg-name{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}
  .latest{font-size:9.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#fff;background:var(--bronze);padding:2px 7px;border-radius:999px;}
  .pkg-notes{font-size:12px;color:#00000088;margin-top:3px;}
  .pkg-meta{display:flex;align-items:center;gap:12px;flex:none;}
  .vc{font-family:ui-monospace,monospace;font-size:11px;color:#00000066;}
  .arrow{font-size:19px;color:var(--bronze);}
  .empty{font-size:13px;color:#00000066;padding:8px 2px;}
  footer{margin-top:34px;font-size:11px;color:#00000055;text-align:center;}
</style></head><body><div class="wrap">
  <h1>downloads.</h1>
  <div class="sub">Install packages for on-site machine setup. Tap to download.</div>
  ${sections || '<div class="empty">No packages published yet.</div>'}
  <footer>Snarl &amp; Sopi &middot; AG Vending</footer>
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

function handleGetDownloads(req, res) { ok(res, { downloads: storage.listDownloads() }); }

function handleSetDownloads(req, res) {
  const list = Array.isArray(req.body?.downloads) ? req.body.downloads : null;
  if (!list) return badRequest(res, 'downloads array required');
  const clean = [];
  for (const d of list) {
    if (!d || !d.url || !/^https?:\/\//.test(d.url)) continue;
    clean.push({
      app: String(d.app || 'Other').slice(0, 40),
      versionName: d.versionName ? String(d.versionName).slice(0, 80) : null,
      versionCode: d.versionCode != null ? Math.round(Number(d.versionCode)) : null,
      url: String(d.url),
      notes: d.notes ? String(d.notes).slice(0, 200) : null,
      addedAt: d.addedAt || new Date().toISOString(),
    });
  }
  storage.setDownloads(clean);
  ok(res, { downloads: clean });
}

// ── OTA app-update ───────────────────────────────────────────────────────────
async function computeApkSha256(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return require('crypto').createHash('sha256').update(buf).digest('hex');
  } finally { clearTimeout(to); }
}

// GET manifest for one machine (kiosk, machine-key). Records the kiosk's reported version.
function handleAppUpdate(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const vc = req.headers['x-app-version-code'] || (req.query && req.query.vc);
  if (vc != null && vc !== '') storage.recordAppVersion(code, vc);
  const rel = storage.getAppRelease();
  // Served BARE (no {ok,data} envelope): the kiosk updater reads manifest fields off the
  // top level, and pre-0.72 field builds can ONLY self-heal if this endpoint is unwrapped.
  if (!rel || !rel.targetVersionCode) return json(res, 200, { rolloutEnabled: false });
  const inCohort = rel.cohort === 'all' || (Array.isArray(rel.cohort) && rel.cohort.includes(code));
  json(res, 200, {
    targetVersionCode: rel.targetVersionCode,
    versionName: rel.versionName || null,
    apkUrl: rel.apkUrl || null,
    sha256: rel.sha256 || null,
    rolloutEnabled: !!rel.rolloutEnabled && inCohort,
  });
}

// GET current release + per-machine versions (ag-admin dashboard).
function handleGetAppRelease(req, res) {
  const rel = storage.getAppRelease();
  const list = Object.values(machines).map(m => {
    const v = storage.getAppVersion(m.deviceCode);
    const rv = storage.getAppRevert(m.deviceCode);
    return { deviceCode: m.deviceCode, deviceName: m.deviceName, operatorId: m.operatorId,
      versionCode: (v && v.vc != null) ? v.vc : null, lastCheck: (v && v.at) ? v.at : null,
      rejectedVersionCode: (rv && rv.rejected != null) ? rv.rejected : null };
  });
  ok(res, { release: rel || null, machines: list });
}

// PUT publish/replace the single active release (ag-admin).
async function handlePublishAppRelease(req, res) {
  const b = req.body || {};
  const tvc = Math.round(Number(b.targetVersionCode));
  if (!Number.isFinite(tvc) || tvc <= 0) return badRequest(res, 'targetVersionCode must be a positive integer');
  if (!b.apkUrl || typeof b.apkUrl !== 'string' || !/^https:\/\//.test(b.apkUrl)) return badRequest(res, 'apkUrl must be an https URL');
  let cohort = 'all';
  if (Array.isArray(b.cohort)) cohort = b.cohort.map(String);
  else if (b.cohort && b.cohort !== 'all') return badRequest(res, "cohort must be 'all' or an array of device codes");
  let sha256 = (typeof b.sha256 === 'string' && b.sha256) ? b.sha256.toLowerCase() : null;
  let note = null;
  if (!sha256) {
    try { sha256 = await computeApkSha256(b.apkUrl); }
    catch (e) { note = 'sha256 not computed (' + e.message + ') — publishing without it; Android still signature-checks.'; }
  }
  const rel = {
    targetVersionCode: tvc,
    versionName: b.versionName ? String(b.versionName) : null,
    apkUrl: b.apkUrl,
    sha256,
    cohort,
    rolloutEnabled: b.rolloutEnabled !== false,
    publishedAt: new Date().toISOString(),
    publishedBy: (req.user && (req.user.name || req.user.email)) || null,
  };
  storage.setAppRelease(rel);
  ok(res, { release: rel, note });
}

// POST revert report (kiosk, machine-key): a machine auto-reverted a crash-looping build.
// Records it, reflects the healed version, and raises an alert (idempotent per rejected build).
function handleRevertReport(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return notFound(res, `Machine ${code} not found`);
  const b = req.body || {};
  const rejected = Math.round(Number(b.rejectedVersionCode));
  if (!Number.isFinite(rejected)) return badRequest(res, 'rejectedVersionCode (integer) is required');
  const revertedTo = Number.isFinite(Math.round(Number(b.revertedVersionCode)))
    ? Math.round(Number(b.revertedVersionCode))
    : (Number.isFinite(Math.round(Number(b.revertedToVersionCode))) ? Math.round(Number(b.revertedToVersionCode)) : null);
  const at = (b.at && !isNaN(Date.parse(b.at))) ? new Date(b.at).toISOString() : new Date().toISOString();
  storage.recordAppRevert(code, { rejected, revertedTo, at });
  if (revertedTo != null) storage.recordAppVersion(code, revertedTo); // fleet table reflects the healed build
  const id = 'alert_app_revert_' + code + '_' + rejected;             // idempotent on (device, rejected)
  if (!storage.getAlert(id)) {
    storage.insertAlert({
      id, type: 'app_revert', severity: 'warning',
      title: `App update reverted — ${m.deviceName || code}`,
      detail: `Build ${rejected} crash-looped and was rolled back${revertedTo != null ? ' to ' + revertedTo : ''}. Ship the fix as a higher versionCode (this machine has blocked ${rejected}).`,
      deviceCode: code, resolved: 0, resolvedAt: null, createdAt: at,
    });
  }
  ok(res, { recorded: true });
}

// POST halt/resume the rollout (ag-admin). body { on: bool }
function handleSetAppRollout(req, res) {
  const rel = storage.getAppRelease();
  if (!rel) return notFound(res, 'No active release to halt');
  rel.rolloutEnabled = !!(req.body && req.body.on === true);
  storage.setAppRelease(rel);
  ok(res, { release: rel });
}

// ── PUT /api/v1/machines/:deviceCode/grid-order ───────────────────────────────
// Sets the customer-facing product order (list of product codes). The kiosk
// renders its browse grid in this order; unlisted products fall to the end.
function handleSetGridOrder(req, res) {
  const code = req.params.deviceCode;
  const m = machines[code];
  if (!m) return json(res, 404, { ok: false, error: 'machine not found' });
  const order = Array.isArray(req.body && req.body.gridOrder)
    ? req.body.gridOrder.map(String).filter(Boolean)
    : [];
  m.settings = m.settings || {};
  m.settings.gridOrder = order;
  touchConfig(m);
  ok(res, { deviceCode: code, gridOrder: order, configVersion: m.configVersion });
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

// ── PUT /machines/:deviceCode/stock-source ────────────────────────────────────
// Top-operator flips a machine between Weimi-managed and kiosk-managed stock.
// 'kiosk' makes the backend the system of record: restock writes the planogram
// directly and the kiosk reports sales. The current layout becomes the start.
function handleStockSource(req, res) {
  const m = machines[req.params.deviceCode];
  if (!m) return notFound(res, `Machine ${req.params.deviceCode} not found`);
  const src = req.body && req.body.stockSource;
  if (src !== 'weimi' && src !== 'kiosk') return badRequest(res, "stockSource must be 'weimi' or 'kiosk'");
  m.stockSource = src;
  m.updatedAt = new Date().toISOString();
  storage.upsertMachine(m);
  ok(res, { deviceCode: m.deviceCode, stockSource: m.stockSource });
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

    // Prefer the net cost (already VSK-excluded, from confirmed receipts) when
    // present; fall back to the legacy gross cost, which we net down by the rate.
    const hasNetCost   = it.costPriceNetIsk != null;
    const hasGrossCost = it.costPriceIsk != null;
    const hasCost = hasNetCost || hasGrossCost;
    let profitC = null;
    if (hasCost) {
      const netCostC = hasNetCost ? (it.costPriceNetIsk * 100) : netOf(it.costPriceIsk * 100, rate);
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
  ok(res, { ...op, idleConfig: storage.operatorIdleConfig(op.id), machines: opMachines.map(machineSummary), users: opUsers });
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

// ── Product images: normalize + host on R2 ──────────────────────────────────

// Normalize bytes and put them on R2. Returns { url, hasBackground, note }.
async function normalizeAndHost(buf, goodsId, opts = {}) {
  const r2 = require('./r2');
  if (!r2.isConfigured()) throw new Error('image hosting not configured (R2 env missing)');
  const images = require('./images');
  const norm = await images.normalizeProductImage(buf, { knockoutWhite: !!opts.knockoutWhite });
  const safeId = String(goodsId).replace(/[^a-zA-Z0-9_-]/g, '') || 'p';
  // Versioned key: the URL changes when the image changes, so caches bust cleanly.
  const url = await r2.putObject(`products/${safeId}-${Date.now()}.webp`, norm.buffer, 'image/webp');
  return { url, hasBackground: norm.hasBackground, note: norm.note, bytes: norm.bytes, knockedOut: norm.knockedOut, clearedPct: norm.clearedPct, srcW: norm.srcW, srcH: norm.srcH };
}

function decodeImageBody(b64) {
  let data = String(b64 || '');
  const m = data.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) data = m[2];
  const buf = Buffer.from(data, 'base64');
  if (!buf || !buf.length) throw new Error('empty image');
  if (buf.length > 12 * 1024 * 1024) throw new Error('image too large (max 12MB)');
  return buf;
}

// POST /api/v1/products/:goodsId/image — dashboard upload/replace. Body:
// { imageBase64, knockoutWhite? }  (kiosk never uploads: it consumes images only)
async function handleProductImage(req, res) {
  const gid = req.params.goodsId;
  const p = storage.getProduct(gid);
  if (!p) return notFound(res, `Product ${gid} not found`);
  const b = req.body || {};
  if (!b.imageBase64) return badRequest(res, 'imageBase64 is required');
  let buf;
  try { buf = decodeImageBody(b.imageBase64); } catch (e) { return badRequest(res, e.message); }
  try {
    const r = await normalizeAndHost(buf, gid, { knockoutWhite: !!b.knockoutWhite });
    storage.setProductImage(gid, { imgUrl: r.url, hasBackground: r.hasBackground, clearedPct: r.clearedPct, srcW: r.srcW, srcH: r.srcH, weimiImgUrl: p.imageNormalizedAt ? null : (p.imgUrl || null) });
    ok(res, { goodsId: gid, imgUrl: r.url, imageHasBackground: r.hasBackground, knockedOut: r.knockedOut, bytes: r.bytes, note: r.note });
  } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
}

// POST /api/v1/products/images/migrate — one-time job: pull each product's existing
// (Weimi) image, normalize it, rehost on R2, and point imgUrl at ours. Idempotent:
// already-normalized products are skipped unless ?force=1. Body: { limit?, force? }
async function handleMigrateImages(req, res) {
  const r2 = require('./r2');
  if (!r2.isConfigured()) return json(res, 400, { ok: false, error: 'R2 not configured — set the R2_* env vars first.' });
  const b = req.body || {};
  const force = !!b.force;
  const limit = Math.max(1, Math.min(Number(b.limit) || 500, 2000));
  // Preflight: if the image library can't load (wrong Node version, missing binary),
  // say it ONCE instead of failing identically for every product in the batch.
  try { require('./images'); require('sharp'); }
  catch (e) {
    return json(res, 500, { ok: false,
      error: 'Image processing unavailable: ' + e.message.split('\n')[0]
           + ' — sharp needs Node >=20.9. Nothing was changed.' });
  }
  const all = storage.listProducts();
  const alreadyHosted = all.filter(p => p.imageNormalizedAt).length;

  // The image a machine actually shows is `catalog.imgUrl || planogram bay image`, so the
  // planogram is a real image source in its own right — for products whose catalog row has
  // no imgUrl, the bay's (Weimi) image is what's on screen. Migrate those too, otherwise
  // they keep serving Weimi URLs forever while the report claims "nothing left".
  const layoutImages = {};   // goodsId → { url, name }
  try {
    for (const m of storage.listMachines()) {
      const lp = storage.layoutProductsForDevice(m.deviceCode) || {};
      for (const gid of Object.keys(lp)) {
        const img = lp[gid] && lp[gid].image;
        if (img && /^https?:\/\//.test(img) && !layoutImages[gid]) layoutImages[gid] = { url: img, name: lp[gid].name || '' };
      }
    }
  } catch (e) { /* no layouts → catalog-only migration */ }

  const known = {};
  all.forEach(p => { known[p.goodsId] = p; });
  const eligible = [];
  for (const p of all) {
    if (p.imageNormalizedAt && !force) continue;
    const catalogSrc = (p.imgUrl && /^https?:\/\//.test(p.imgUrl)) ? p.imgUrl : null;
    const src = catalogSrc || (layoutImages[p.goodsId] && layoutImages[p.goodsId].url) || null;
    if (src) eligible.push({ goodsId: p.goodsId, name: p.name, src, fromLayout: !catalogSrc });
  }
  // Planogram products with no catalog row at all — stub them so the image has a home.
  for (const gid of Object.keys(layoutImages)) {
    if (known[gid]) continue;
    eligible.push({ goodsId: gid, name: layoutImages[gid].name, src: layoutImages[gid].url, fromLayout: true, stub: true });
  }

  const todo = eligible.slice(0, limit);
  const report = {
    total: all.length,
    alreadyHosted,                       // genuinely migrated before this run
    eligible: eligible.length,           // still need migrating
    attempted: todo.length,              // this batch
    fromPlanogram: todo.filter(t => t.fromLayout).length,
    migrated: 0, failed: 0,
    remaining: 0,                        // eligible beyond this batch (filled in below)
    notes: [],
  };
  for (const c of todo) {
    try {
      if (c.stub) storage.ensureProductStub(c.goodsId, c.name);
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      let buf;
      try {
        const resp = await fetch(c.src, { redirect: 'follow', signal: ctrl.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        buf = Buffer.from(await resp.arrayBuffer());
      } finally { clearTimeout(to); }
      const r = await normalizeAndHost(buf, c.goodsId, {});
      storage.setProductImage(c.goodsId, { imgUrl: r.url, hasBackground: r.hasBackground, weimiImgUrl: c.src, srcW: r.srcW, srcH: r.srcH });
      report.migrated++;
      if (r.note) report.notes.push({ goodsId: c.goodsId, name: c.name, note: r.note });
    } catch (e) {
      report.failed++;
      report.notes.push({ goodsId: c.goodsId, name: c.name, note: 'failed: ' + e.message });
    }
  }
  report.remaining = Math.max(0, eligible.length - todo.length);
  ok(res, report);
}

// POST /api/v1/products/images/clean-backgrounds — make product images transparent so the
// kiosk's tile colour wraps the product instead of stopping at a white box. Re-processes
// every product still flagged imageHasBackground, from its ORIGINAL source (weimiImgUrl),
// with white knockout. Reversible: the original URL is retained either way.
async function handleCleanBackgrounds(req, res) {
  const r2 = require('./r2');
  if (!r2.isConfigured()) return json(res, 400, { ok: false, error: 'R2 not configured.' });
  try { require('./images'); require('sharp'); }
  catch (e) { return json(res, 500, { ok: false, error: 'Image processing unavailable: ' + e.message.split('\n')[0] + ' — sharp needs Node >=20.9.' }); }

  const b = req.body || {};
  const limit = Math.max(1, Math.min(Number(b.limit) || 200, 1000));
  const only = Array.isArray(b.goodsIds) && b.goodsIds.length ? new Set(b.goodsIds.map(String)) : null;
  const all = storage.listProducts();
  const targets = all.filter(p => p.imageHasBackground === 1 && (p.weimiImgUrl || p.imgUrl) && (!only || only.has(p.goodsId))).slice(0, limit);

  const report = { withBackground: all.filter(p => p.imageHasBackground === 1).length, attempted: targets.length,
                   cleaned: 0, stillHasBackground: 0, failed: 0, check: [], manual: [], notes: [] };
  for (const p of targets) {
    const src = p.weimiImgUrl || p.imgUrl;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 30000);
      let buf;
      try {
        const resp = await fetch(src, { redirect: 'follow', signal: ctrl.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        buf = Buffer.from(await resp.arrayBuffer());
      } finally { clearTimeout(to); }

      const images = require('./images');
      const norm = await images.normalizeProductImage(buf, { knockoutWhite: true });
      const safeId = String(p.goodsId).replace(/[^a-zA-Z0-9_-]/g, '') || 'p';
      const url = await r2.putObject(`products/${safeId}-${Date.now()}.webp`, norm.buffer, 'image/webp');
      storage.setProductImage(p.goodsId, { imgUrl: url, hasBackground: norm.hasBackground, weimiImgUrl: src, clearedPct: norm.clearedPct, srcW: norm.srcW, srcH: norm.srcH });

      if (!norm.hasBackground) {
        report.cleaned++;
        // Heavy clears may mean a white product got eaten — surface for a human look.
        if (norm.clearedPct != null && norm.clearedPct > 82) report.check.push({ goodsId: p.goodsId, name: p.name, clearedPct: norm.clearedPct, url });
      } else {
        // Knockout couldn't help. `uniform:false` means we measured the border and it is a
        // photo/gradient — no tolerance fixes that, it needs a new source image.
        report.stillHasBackground++;
        report.manual.push({ goodsId: p.goodsId, name: p.name, url,
          reason: norm.uniform === false ? 'photo or gradient background' : (norm.note || 'could not separate background') });
      }
      if (norm.note) report.notes.push({ goodsId: p.goodsId, name: p.name, note: norm.note });
    } catch (e) {
      report.failed++;
      report.notes.push({ goodsId: p.goodsId, name: p.name, note: 'failed: ' + e.message });
    }
  }
  report.remaining = Math.max(0, report.withBackground - targets.length);
  ok(res, report);
}

// GET /api/v1/products/images/review[?format=csv] — the two lists that need human eyes,
// rebuilt from stored state so they survive a page reload (not just the last run's report).
//   check  — knockout removed a lot; a white product may have been eaten
//   manual — still has a background knockout can't remove (non-white backdrop) → needs a new photo
function handleImageReview(req, res) {
  const all = storage.listProducts();
  const threshold = Math.max(1, Math.min(Number(req.query.threshold) || 82, 99));
  const mk = (p, reason) => ({
    goodsId: p.goodsId, name: p.name || '', barcode: p.barcode || '',
    clearedPct: p.imageClearedPct != null ? p.imageClearedPct : null,
    hasBackground: p.imageHasBackground === 1,
    imgUrl: p.imgUrl || '', originalUrl: p.weimiImgUrl || '', reason,
  });
  const check  = all.filter(p => p.imageNormalizedAt && p.imageHasBackground === 0 && p.imageClearedPct != null && p.imageClearedPct > threshold)
                    .sort((a, b) => (b.imageClearedPct || 0) - (a.imageClearedPct || 0))
                    .map(p => mk(p, 'heavy clear — check product intact'));
  const manual = all.filter(p => p.imageNormalizedAt && p.imageHasBackground === 1)
                    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                    .map(p => mk(p, 'non-white background — needs replacement image'));

  if ((req.query.format || '') === 'csv') {
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['list', 'goodsId', 'name', 'barcode', 'clearedPct', 'reason', 'imgUrl', 'originalUrl'];
    const rows = [head.join(',')];
    check.forEach(r => rows.push(['check', r.goodsId, r.name, r.barcode, r.clearedPct, r.reason, r.imgUrl, r.originalUrl].map(esc).join(',')));
    manual.forEach(r => rows.push(['manual', r.goodsId, r.name, r.barcode, '', r.reason, r.imgUrl, r.originalUrl].map(esc).join(',')));
    const body = rows.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="product-images-review-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }
  ok(res, { threshold, checkCount: check.length, manualCount: manual.length, check, manual });
}

// GET /api/v1/debug/product?q=fanta — where does this product's image actually live?
// Shows the catalog row(s), any other rows sharing an id, and what each machine's
// planogram carries — so a mismatch between the id the dashboard edits and the id the
// catalog row is keyed on becomes visible instead of guessable.
function handleDebugProduct(req, res) {
  const q = String((req.query && (req.query.q || req.query.goodsId)) || '').trim().toLowerCase();
  if (!q) return json(res, 400, { ok: false, error: 'pass ?q=<name or goodsId>' });
  const all = storage.listProducts();
  const hits = all.filter(p =>
    String(p.goodsId || '').toLowerCase() === q ||
    String(p.name || '').toLowerCase().includes(q)
  ).slice(0, 12);

  // Where does each machine's planogram think this product's image is?
  const planogram = {};
  try {
    for (const m of storage.listMachines()) {
      const lp = storage.layoutProductsForDevice(m.deviceCode) || {};
      for (const gid of Object.keys(lp)) {
        const nm = String(lp[gid].name || '').toLowerCase();
        if (gid.toLowerCase() === q || nm.includes(q)) {
          (planogram[gid] = planogram[gid] || { name: lp[gid].name, image: lp[gid].image, machines: [] })
            .machines.push(m.deviceCode);
        }
      }
    }
  } catch (e) { /* ignore */ }

  const rows = hits.map(p => {
    const ids = [p.goodsId, p.goodsCode, p.weimiId, p.customCode].filter(Boolean);
    return {
      goodsId: p.goodsId, name: p.name,
      otherIds: { goodsCode: p.goodsCode || null, weimiId: p.weimiId || null, customCode: p.customCode || null },
      imgUrl: p.imgUrl || null,
      imageNormalizedAt: p.imageNormalizedAt ? new Date(p.imageNormalizedAt).toISOString() : null,
      imageHasBackground: p.imageHasBackground === 1,
      imageClearedPct: p.imageClearedPct != null ? p.imageClearedPct : null,
      weimiImgUrl: p.weimiImgUrl || null,
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
      // Does the dashboard edit this row under a different id than it is keyed on?
      inPlanogramUnderSameId: !!planogram[p.goodsId],
      planogramIdsMatchingOtherIds: ids.filter(i => planogram[i] && i !== p.goodsId),
    };
  });

  json(res, 200, {
    query: q,
    catalogRows: rows.length,
    rows,
    planogram,
    hint: 'If a planogram goodsId has no catalog row of its own, the dashboard edits that id while the real row is keyed on another — the image write lands on the wrong record.',
  });
}

// GET /api/v1/products/images/resolution[?format=csv] — source resolution of every hosted
// image, smallest first, so grainy (upscaled-from-tiny) products can be worked worst-first.
// Stored images are all 800x800; what matters is how big the SOURCE was before we padded it.
function handleImageResolution(req, res) {
  const all = storage.listProducts();
  const hosted = all.filter(p => p.imageNormalizedAt && p.imgUrl);
  const grade = (px) => px == null ? 'unknown' : px < 200 ? 'tiny' : px < 400 ? 'small' : px < 700 ? 'ok' : 'good';
  const rows = hosted.map(p => {
    const w = p.imageSrcW, h = p.imageSrcH;
    const minEdge = (w != null && h != null) ? Math.min(w, h) : null;
    return {
      goodsId: p.goodsId, name: p.name || '', barcode: p.barcode || '',
      srcW: w != null ? w : null, srcH: h != null ? h : null,
      minEdge, quality: grade(minEdge),
      imgUrl: p.imgUrl, hasBackground: p.imageHasBackground === 1,
    };
  }).sort((a, b) => {
    // unknowns first (need a backfill), then smallest min-edge first
    if (a.minEdge == null && b.minEdge != null) return -1;
    if (b.minEdge == null && a.minEdge != null) return 1;
    return (a.minEdge || 0) - (b.minEdge || 0);
  });

  const summary = { total: hosted.length, unknown: 0, tiny: 0, small: 0, ok: 0, good: 0 };
  rows.forEach(r => { summary[r.quality]++; });

  if ((req.query.format || '') === 'csv') {
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['goodsId', 'name', 'barcode', 'srcW', 'srcH', 'minEdge', 'quality', 'imgUrl'];
    const lines = [head.join(',')];
    rows.forEach(r => lines.push([r.goodsId, r.name, r.barcode, r.srcW, r.srcH, r.minEdge, r.quality, r.imgUrl].map(esc).join(',')));
    const body = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="product-image-resolution-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }
  ok(res, { summary, rows });
}

// POST /api/v1/products/images/backfill-dims — measure source dimensions for images hosted
// before we started recording them, by re-fetching the retained original. No re-upload.
async function handleBackfillDims(req, res) {
  try { require('sharp'); } catch (e) { return json(res, 500, { ok: false, error: 'sharp needs Node >=20.9' }); }
  const sharp = require('sharp');
  const b = req.body || {};
  const limit = Math.max(1, Math.min(Number(b.limit) || 200, 1000));
  const all = storage.listProducts();
  const todo = all.filter(p => p.imageNormalizedAt && p.imgUrl && p.imageSrcW == null).slice(0, limit);
  const report = { missing: all.filter(p => p.imageNormalizedAt && p.imageSrcW == null).length, attempted: todo.length, measured: 0, failed: 0, notes: [] };
  for (const p of todo) {
    const src = p.weimiImgUrl || p.imgUrl;   // prefer the original; fall back to our hosted copy
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 30000);
      let buf;
      try {
        const resp = await fetch(src, { redirect: 'follow', signal: ctrl.signal });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        buf = Buffer.from(await resp.arrayBuffer());
      } finally { clearTimeout(to); }
      const m = await sharp(buf, { failOn: 'none' }).metadata();
      storage.setProductImageDims(p.goodsId, m.width || null, m.height || null);
      report.measured++;
    } catch (e) { report.failed++; report.notes.push({ goodsId: p.goodsId, name: p.name, note: e.message }); }
  }
  report.remaining = Math.max(0, report.missing - todo.length);
  ok(res, report);
}

// GET /api/v1/products/duplicates — READ-ONLY audit of duplicate catalog rows (same product
// under two goodsIds sharing a weimiId/customCode). For each group, shows every row with its
// image state and how many places reference its goodsId, and recommends which to KEEP (the
// one that's normalized and/or most referenced) vs which are safe to remove. Deletes nothing.
function handleProductDuplicates(req, res) {
  const groups = storage.duplicateProductGroups();
  const out = groups.map(rows => {
    const enriched = rows.map(p => {
      const refs = storage.referenceCountsForGoods(p.goodsId);
      return {
        goodsId: p.goodsId, name: p.name,
        weimiId: p.weimiId || null, customCode: p.customCode || null,
        hasNormalizedImage: !!p.imageNormalizedAt,
        imageNormalizedAt: p.imageNormalizedAt ? new Date(p.imageNormalizedAt).toISOString() : null,
        imgUrl: p.imgUrl || null,
        refs, referencedTotal: refs.total,
      };
    });
    // Recommend keeping the row that is most "live": referenced first, then normalized,
    // then most recently touched. The others are removal candidates.
    const ranked = [...enriched].sort((a, b) =>
      (b.referencedTotal - a.referencedTotal) ||
      ((b.hasNormalizedImage ? 1 : 0) - (a.hasNormalizedImage ? 1 : 0)) ||
      ((b.imageNormalizedAt || '') > (a.imageNormalizedAt || '') ? 1 : -1));
    const keep = ranked[0];
    const remove = ranked.slice(1);
    // Only flag as safely auto-removable if the row has ZERO references anywhere.
    const safeToRemove = remove.filter(r => r.referencedTotal === 0);
    const needsManual  = remove.filter(r => r.referencedTotal > 0);
    return {
      name: keep.name,
      sharedWeimiId: keep.weimiId, sharedCustomCode: keep.customCode,
      rows: enriched,
      recommendKeep: keep.goodsId,
      safeToRemove: safeToRemove.map(r => r.goodsId),
      needsManualReview: needsManual.map(r => ({ goodsId: r.goodsId, referencedTotal: r.referencedTotal, refs: r.refs })),
    };
  });
  json(res, 200, {
    duplicateGroups: out.length,
    productsAffected: out.reduce((n, g) => n + g.rows.length, 0),
    safelyRemovable: out.reduce((n, g) => n + g.safeToRemove.length, 0),
    needManualReview: out.reduce((n, g) => n + g.needsManualReview.length, 0),
    groups: out,
    note: 'Read-only. Nothing was changed. "safeToRemove" rows have zero references anywhere; "needsManualReview" rows are referenced by stock/sales/planograms and must be repointed before removal.',
  });
}

// POST /api/v1/products/dedupe — remove orphaned duplicate catalog rows (the unreferenced
// copy of a product that exists under two goodsIds). DRY-RUN by default: returns exactly what
// it WOULD delete. Only deletes when body { confirm: "DELETE" } is sent, and even then each
// row's references are re-checked at delete time — a keeper or any referenced row is never
// touched. Deletes only rows the audit lists in safeToRemove.
function handleDedupeProducts(req, res) {
  const b = req.body || {};
  const confirmed = b.confirm === 'DELETE';
  const groups = storage.duplicateProductGroups();

  const plan = [];
  for (const rows of groups) {
    const enriched = rows.map(p => ({ p, refs: storage.referenceCountsForGoods(p.goodsId).total }));
    const ranked = [...enriched].sort((a, b2) =>
      (b2.refs - a.refs) ||
      ((b2.p.imageNormalizedAt ? 1 : 0) - (a.p.imageNormalizedAt ? 1 : 0)) ||
      ((b2.p.imageNormalizedAt || 0) - (a.p.imageNormalizedAt || 0)));
    const keep = ranked[0];
    for (const cand of ranked.slice(1)) {
      // Only ever a removal candidate if it has ZERO references. Anything referenced is
      // left for manual handling — this job never repoints, only removes true orphans.
      if (cand.refs === 0) plan.push({ name: keep.p.name, keep: keep.p.goodsId, remove: cand.p.goodsId });
    }
  }

  if (!confirmed) {
    return json(res, 200, {
      dryRun: true, wouldRemove: plan.length, plan,
      note: 'Nothing deleted. Re-send with { "confirm": "DELETE" } to remove these orphan rows. Each is re-checked for references at delete time.',
    });
  }

  const removed = [], skipped = [];
  for (const item of plan) {
    const r = storage.deleteProductIfUnreferenced(item.remove);
    if (r.deleted) removed.push(item.remove);
    else skipped.push({ goodsId: item.remove, reason: r.reason, refs: r.refs });
  }
  console.log(`[DEDUPE] ${req.user.name} removed ${removed.length} orphan product rows` + (skipped.length ? `, skipped ${skipped.length}` : ''));
  json(res, 200, { dryRun: false, removed: removed.length, skipped: skipped.length, removedIds: removed, skippedDetail: skipped });
}

// ── Operator billing portal (read-only Payday) ──────────────────────────────

// PUT /operators/:operatorId/payday-link — AG-admin links an operator to its Payday customer.
const _isGuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim());

function handleProductSearch(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return ok(res, []);
  const machines = String(req.query.machines || '').split(',').map(s => s.trim()).filter(Boolean);
  // Pre-build layout maps for the relevant machines once (image/price/stock truth).
  const codes = machines.length ? machines : storage.listMachines().map(m => m.deviceCode);
  const layoutMaps = codes.map(c => storage.layoutProductsForDevice(c));
  const layoutImg = gid => { for (const m of layoutMaps) if (m[gid] && m[gid].image) return m[gid].image; return null; };
  const layoutPrice = gid => { for (const m of layoutMaps) if (m[gid] && m[gid].priceIsk) return m[gid].priceIsk; return null; };
  // Candidates keyed by goodsId. Start from the catalog (name search)…
  const byId = new Map();
  for (const p of storage.searchProducts(q, 10)) {
    const gid = String(p.goodsId);
    byId.set(gid, {
      goodsId: gid, name: p.name, barcode: p.barcode || null,
      imgUrl: p.imgUrl || layoutImg(gid) || null,
      salePriceIsk: p.salePriceIsk != null ? p.salePriceIsk : layoutPrice(gid),
      stock: storage.stockForProduct(gid, machines),
    });
  }
  // …then add planogram products directly. The planogram is authoritative for
  // goodsId/stock/image: a product can live there under an id that differs from
  // (or isn't in) the catalog. Surfacing it as a candidate lets the name-dedup
  // below keep the real in-stock entry instead of an orphaned catalog record —
  // and means a deal stores the goodsId the kiosk actually matches at checkout.
  const termLc = q.toLowerCase();
  layoutMaps.forEach(lm => Object.values(lm).forEach(p => {
    if (!p || !p.name || !String(p.name).toLowerCase().includes(termLc)) return;
    const gid = String(p.goodsId);
    if (byId.has(gid)) {
      const e = byId.get(gid);
      if (!e.imgUrl && p.image) e.imgUrl = p.image;
      if (e.salePriceIsk == null && Number(p.priceIsk) > 0) e.salePriceIsk = Number(p.priceIsk);
      if (!e.name && p.name) e.name = p.name;
    } else {
      byId.set(gid, {
        goodsId: gid, name: p.name, barcode: null,
        imgUrl: p.image || null,
        salePriceIsk: Number(p.priceIsk) > 0 ? Number(p.priceIsk) : layoutPrice(gid),
        stock: storage.stockForProduct(gid, machines),
      });
    }
  }));
  const rows = [...byId.values()];
  // Collapse duplicate catalog records for one physical product: when the same
  // name appears as an in-stock record and an out-of-stock one (the planogram id
  // vs an orphaned catalog id), keep the in-stock record and carry over its
  // image/price so the picker shows a single, complete entry.
  const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const groups = new Map();
  rows.forEach(r => { const k = norm(r.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const out = [];
  for (const grp of groups.values()) {
    if (grp.length === 1) { out.push(grp[0]); continue; }
    const inStock = grp.filter(r => (r.stock || 0) > 0);
    if (!inStock.length) { grp.forEach(r => out.push(r)); continue; }
    const donors = grp.filter(r => (r.stock || 0) <= 0);
    inStock.forEach(k => {
      if (!k.imgUrl) { const d = donors.find(x => x.imgUrl); if (d) k.imgUrl = d.imgUrl; }
      if (k.salePriceIsk == null) { const d = donors.find(x => x.salePriceIsk != null); if (d) k.salePriceIsk = d.salePriceIsk; }
      out.push(k);
    });
  }
  ok(res, out);
}

const _DEAL_TYPES = ['markdown', 'expiry', 'multibuy', 'combo'];
function dealStatus(d) {
  if (!d.enabled) return 'paused';
  const s = d.schedule || {}; const now = new Date();
  if (s.kind === 'dates') {
    if (s.start && new Date(s.start) > now) return 'scheduled';
    if (s.end && new Date(s.end + 'T23:59:59') < now) return 'ended';
  }
  return 'active';
}
// Bump configVersion on the machines a deal targets so kiosks re-fetch (config uses 304-on-version).
function bumpDealsConfig(d) {
  try {
    const sc = (d && d.scope) || { kind: 'fleet' };
    const all = storage.listMachines();
    const targets = (sc.kind === 'machines' && Array.isArray(sc.machines))
      ? all.filter(m => sc.machines.includes(m.deviceCode))
      : all;
    targets.forEach(m => { try { touchConfig(m); } catch (e) {} });
  } catch (e) { /* best-effort */ }
}
function handleListDeals(req, res) {
  const list = storage.listDeals().map(d => ({ ...d, status: dealStatus(d) }));
  ok(res, list, { total: list.length });
}
function handleCreateDeal(req, res) {
  const b = req.body || {};
  if (!b.name) return badRequest(res, 'name required');
  if (!_DEAL_TYPES.includes(b.type)) return badRequest(res, 'invalid deal type');
  const id = 'deal_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const d = storage.upsertDeal({
    id, name: b.name, type: b.type, enabled: b.enabled !== false,
    config: b.config || {}, appliesTo: b.appliesTo || { kind: 'all' },
    scope: b.scope || { kind: 'fleet' }, schedule: b.schedule || { kind: 'always' }, stackable: !!b.stackable,
    showOnIdle: !!b.showOnIdle, idleOrder: b.idleOrder != null ? b.idleOrder : 0,
  });
  bumpDealsConfig(d);
  created(res, { ...d, status: dealStatus(d) });
}
function handleUpdateDeal(req, res) {
  const ex = storage.getDeal(req.params.id);
  if (!ex) return notFound(res, 'Deal not found');
  const b = req.body || {};
  if (b.type && !_DEAL_TYPES.includes(b.type)) return badRequest(res, 'invalid deal type');
  const d = storage.upsertDeal({
    id: ex.id,
    name: b.name !== undefined ? b.name : ex.name,
    type: b.type || ex.type,
    enabled: b.enabled !== undefined ? b.enabled : ex.enabled,
    config: b.config || ex.config,
    appliesTo: b.appliesTo || ex.appliesTo,
    scope: b.scope || ex.scope,
    schedule: b.schedule || ex.schedule,
    stackable: b.stackable !== undefined ? b.stackable : ex.stackable,
    showOnIdle: b.showOnIdle !== undefined ? b.showOnIdle : ex.showOnIdle,
    idleOrder: b.idleOrder !== undefined ? b.idleOrder : ex.idleOrder,
    createdAt: ex.createdAt,
  });
  bumpDealsConfig(d);
  ok(res, { ...d, status: dealStatus(d) });
}
function handleDeleteDeal(req, res) {
  const ex = storage.getDeal(req.params.id);
  if (!ex) return notFound(res, 'Deal not found');
  storage.deleteDeal(req.params.id);
  bumpDealsConfig(ex);
  ok(res, { deleted: true, id: req.params.id });
}

async function handleSetPaydayLink(req, res) {
  try {
    const id = req.params.operatorId;
    const op = operators[id] || storage.getOperator(id);
    if (!op) return notFound(res, 'Operator not found');
    let kennitala = String((req.body && req.body.kennitala) || '').replace(/[\s-]/g, '').trim() || null;
    const pidRaw = String((req.body && req.body.paydayCustomerId) || '').trim();
    // Only accept a genuine UUID as the customer id. If a kennitala was typed into
    // that field by mistake, fold it back into the kennitala and resolve from there.
    let paydayCustomerId = _isGuid(pidRaw) ? pidRaw : null;
    if (!paydayCustomerId && !kennitala && /^\d{6,12}$/.test(pidRaw.replace(/\D/g, ''))) {
      kennitala = pidRaw.replace(/\D/g, '');
    }
    let resolved = false, matchedName = null, lookupError = null;
    const payday = require('./payday');
    // If we don't yet have a UUID but have a kennitala, resolve the Payday customer id.
    if (!paydayCustomerId && kennitala && payday.paydayConfigured()) {
      try {
        const cust = await payday.findCustomerBySsn(kennitala);
        if (cust && cust.id) { paydayCustomerId = cust.id; resolved = true; matchedName = cust.name || null; }
      } catch (e) { lookupError = String(e.message || e); }
    }
    storage.setOperatorPaydayLink(id, kennitala, paydayCustomerId);
    if (operators[id]) { operators[id].kennitala = kennitala; operators[id].paydayCustomerId = paydayCustomerId; }
    ok(res, { operatorId: id, kennitala, paydayCustomerId, resolved, matchedName, lookupError });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// Normalise a Payday invoice to the shape the portal renders. Field names are
// tolerant + CONFIRM-able against a real response.
function _normInvoice(inv) {
  const n = v => Number(v || 0);
  return {
    id: inv.id,
    number: inv.number != null ? inv.number : inv.id,
    issuedAt: inv.invoiceDate || inv.created || null,
    dueDate: inv.finalDueDate || inv.dueDate || null,
    paidDate: inv.paidDate || null,
    amount: n(inv.amountIncludingVat != null ? inv.amountIncludingVat : (inv.total || inv.amount)),
    lateFee: 0,                                   // Payday carries no discrete late-fee amount on the invoice
    status: String(inv.status || '').toLowerCase(),
    currency: inv.currencyCode || 'ISK',
  };
}

// GET /operators/:operatorId/invoices
async function handleOperatorInvoices(req, res) {
  const payday = require('./payday');
  try {
    if (!payday.paydayConfigured()) return ok(res, { configured: false, linked: false, invoices: [] });
    const op = storage.getOperator(req.params.operatorId);
    if (!op) return notFound(res, 'Operator not found');
    if (!op.paydayCustomerId || !_isGuid(op.paydayCustomerId)) return ok(res, { configured: true, linked: false, invoices: [] });
    const raw = await payday.getCustomerInvoices(op.paydayCustomerId);
    ok(res, { configured: true, linked: true, invoices: raw.map(_normInvoice) });
  } catch (e) {
    ok(res, { configured: true, linked: true, error: String(e.message || e), invoices: [] });
  }
}

// GET /operators/:operatorId/ledger
async function handleOperatorLedger(req, res) {
  const payday = require('./payday');
  try {
    if (!payday.paydayConfigured()) return ok(res, { configured: false, linked: false, movements: [], balance: 0 });
    const op = storage.getOperator(req.params.operatorId);
    if (!op) return notFound(res, 'Operator not found');
    if (!op.paydayCustomerId || !_isGuid(op.paydayCustomerId)) return ok(res, { configured: true, linked: false, movements: [], balance: 0 });
    const inv = await payday.getCustomerInvoices(op.paydayCustomerId);
    const movements = payday.buildLedger(inv);
    ok(res, { configured: true, linked: true, movements, balance: movements.length ? movements[0].balance : 0 });
  } catch (e) {
    ok(res, { configured: true, linked: true, error: String(e.message || e), movements: [], balance: 0 });
  }
}

// GET /operators/:operatorId/invoices/:invoiceId/pdf — stream the Payday PDF.
async function handleOperatorInvoicePdf(req, res) {
  const payday = require('./payday');
  try {
    if (!payday.paydayConfigured()) return json(res, 503, { ok: false, error: 'Payday not configured' });
    const op = storage.getOperator(req.params.operatorId);
    if (!op || !op.paydayCustomerId) return notFound(res, 'Operator not linked to Payday');
    const pdf = await payday.getInvoicePdf(req.params.invoiceId);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="invoice-${req.params.invoiceId}.pdf"` });
    res.end(pdf);
  } catch (e) {
    json(res, 502, { ok: false, error: String(e.message || e) });
  }
}

// POST /operators/provision — called by the signup Zap after it creates the Payday
// customer. Creates the operator (idempotent on kennitala / customer id), links it
// to Payday, and sends the onboarding invite email. Authenticated by a shared key
// (header X-Provision-Key), not a user session, since the caller is the automation.
async function handleProvisionOperator(req, res) {
  const KEY = process.env.PROVISION_KEY;
  if (!KEY) return json(res, 503, { ok: false, error: 'Provisioning disabled (PROVISION_KEY not set)' });
  if ((req.headers['x-provision-key'] || '') !== KEY) return json(res, 401, { ok: false, error: 'Invalid provision key' });

  const b = req.body || {};
  const name = String(b.name || '').trim();
  const emailAddr = String(b.email || '').trim();
  if (!name || !emailAddr) return badRequest(res, 'name and email are required');
  const kennitala = String(b.kennitala || '').replace(/[\s-]/g, '').trim() || null;
  const paydayCustomerId = String(b.paydayCustomerId || '').trim() || null;

  // Idempotent: a matching operator (same kennitala or Payday customer) means the
  // Zap already ran — return it without creating a duplicate or re-emailing.
  const existing = Object.values(operators).find(o =>
    (kennitala && o.kennitala === kennitala) ||
    (paydayCustomerId && o.paydayCustomerId === paydayCustomerId));
  if (existing) return ok(res, { operatorId: existing.id, created: false, invited: false, note: 'Operator already exists' });

  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let id = `op_${slug || Date.now()}`;
  if (operators[id]) id = `${id}-${Math.random().toString(36).slice(2, 6)}`;

  let invite, inviteUrl;
  try {
    operators[id] = {
      id, name, isAGVending: false,
      contactEmail: emailAddr, contactPhone: String(b.contactPhone || ''),
      address: '', logoUrl: '', kennitala, paydayCustomerId,
      createdAt: new Date().toISOString(),
    };
    storage.upsertOperator(operators[id]);
    storage.setOperatorPaydayLink(id, kennitala, paydayCustomerId);

    invite = createInvitation({ email: emailAddr, name, role: 'operator_admin', operatorId: id, inviterId: null, machineAccess: 'all' });
    inviteUrl = `${process.env.APP_URL || 'https://admin.agvending.is'}/?invite=${invite.token}`;
  } catch (e) {
    // Never let a storage failure kill the request with no response (that surfaces as a
    // platform 502). Return a real error the caller can see and we can read in the logs.
    console.error(`[PROVISION] failed creating operator ${name}: ${e.message}`);
    delete operators[id];
    return json(res, 500, { ok: false, error: 'Could not create operator: ' + e.message });
  }

  // Send the invite WITHOUT blocking the response. The operator is already created and the
  // invite token is valid, so a slow email must not hold the request open (that was 502-ing
  // the provision call at the platform edge). The email has its own timeout; we log the
  // outcome. The response reports the invite as queued, not confirmed-delivered.
  email.sendInvitation({ to: emailAddr, name, inviterName: 'AG Vending', operatorName: name, role: 'operator_admin', inviteToken: invite.token })
    .then(() => console.log(`[PROVISION] invite emailed → ${emailAddr}`))
    .catch(e => console.warn(`[PROVISION] invite email FAILED → ${emailAddr}: ${e.message} (operator ${id} still created; invite link: ${inviteUrl})`));

  console.log(`[PROVISION] operator ${name} (${id}) created; invite queued → ${emailAddr}`);
  ok(res, { operatorId: id, created: true, inviteQueued: true, linked: Boolean(kennitala || paydayCustomerId), inviteUrl });
}

async function handleUpdateOperator(req, res) {
  const op = operators[req.params.operatorId];
  if (!op) return notFound(res, 'Operator not found');
  const allowed = ['name', 'contactEmail', 'contactPhone', 'address'];
  allowed.forEach(k => { if (req.body[k] !== undefined) op[k] = req.body[k]; });
  // Per-operator idle-screen settings (applies to all the operator's machines).
  if (req.body.idleRotationSeconds !== undefined || req.body.idleAttractTimeoutSeconds !== undefined) {
    const cur = storage.operatorIdleConfig(op.id);
    const rot = (req.body.idleRotationSeconds !== undefined) ? Math.round(Number(req.body.idleRotationSeconds)) : cur.rotationSeconds;
    const att = (req.body.idleAttractTimeoutSeconds !== undefined) ? Math.round(Number(req.body.idleAttractTimeoutSeconds)) : cur.attractTimeoutSeconds;
    if (!Number.isFinite(rot) || rot < 3 || rot > 30) return badRequest(res, 'idleRotationSeconds must be an integer 3–30');
    if (!Number.isFinite(att) || att < 10 || att > 120) return badRequest(res, 'idleAttractTimeoutSeconds must be an integer 10–120');
    storage.setOperatorIdleConfig(op.id, { rotationSeconds: rot, attractTimeoutSeconds: att });
  }
  if (req.body.logoBase64) {
    try { op.logoUrl = await uploadBase64Image(req.body.logoBase64, req.body.logoType, `operators/${op.id}`); }
    catch (e) { return json(res, 502, { error: 'logo upload failed: ' + e.message }); }
  }
  storage.upsertOperator(op);
  ok(res, { ...op, idleConfig: storage.operatorIdleConfig(op.id) });
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

  // Kiosk machines: the backend is the system of record — write the planogram
  // directly (no Weimi), stamp restockAt, and bump config so the kiosk applies it.
  const kioskMachine = machines[code];
  if (kioskMachine && kioskMachine.stockSource === 'kiosk') {
    const r = storage.applyRestockToLayout(code, clean);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error, message: r.message });
    kioskMachine.totalCurrStock = r.totalCurrStock;
    touchConfig(kioskMachine); // bumps configVersion + persists
    return ok(res, { deviceCode: code, updated: r.updated, mode: 'kiosk', notFound: r.notFound, totalCurrStock: r.totalCurrStock });
  }

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

  const warnings = [];

  // ── 1. Image first, and INDEPENDENT of Weimi ────────────────────────────
  // We host our own product images now. Weimi being unreachable, rejecting the
  // save, or not knowing this product at all must never stop an operator from
  // replacing a photo — that dependency is exactly what we removed.
  let newImgUrl = null, imageHasBackground = null, clearedPct = null, imgSrcW = null, imgSrcH = null;
  if (b.imageBase64) {
    if (!r2.isConfigured()) return json(res, 500, { ok: false, error: 'image hosting not configured' });
    let buf;
    try { buf = decodeImageBody(b.imageBase64); }
    catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    try {
      const norm = await normalizeAndHost(buf, goodsId, { knockoutWhite: !!b.knockoutWhite });
      newImgUrl = norm.url; imageHasBackground = norm.hasBackground; clearedPct = norm.clearedPct; imgSrcW = norm.srcW; imgSrcH = norm.srcH;
      if (norm.note) warnings.push(norm.note);
    } catch (e) { return json(res, 502, { ok: false, stage: 'image_upload', error: e.message }); }
  }

  // ── 2. Persist OUR image straight away ──────────────────────────────────
  const existing = storage.getProduct(goodsId) || {};
  if (newImgUrl) {
    try {
      const stubbed = !existing.goodsId;
      if (stubbed) storage.ensureProductStub(goodsId, b.goodsName || null);
      const r = storage.setProductImage(goodsId, {
        imgUrl: newImgUrl, hasBackground: imageHasBackground, clearedPct, srcW: imgSrcW, srcH: imgSrcH,
        weimiImgUrl: existing.imageNormalizedAt ? null : (existing.imgUrl || null),
      });
      // `changes: 0` means the UPDATE matched no row — the write silently went nowhere.
      // That is exactly the failure mode we are hunting, so make it loud.
      console.log(`[IMG] ${goodsId} save: existing=${!!existing.goodsId} stubbed=${stubbed} rowsChanged=${r && r.changes} url=${newImgUrl}`);
      if (r && r.changes === 0) {
        console.error(`[IMG] ${goodsId} WROTE NOTHING — no products row with that goodsId`);
        warnings.push('The image was hosted but no catalog row matched this product id — please report this.');
      }
    } catch (e) {
      console.error(`[IMG] ${goodsId} save FAILED:`, e.message);
      return json(res, 500, { ok: false, stage: 'save_image', error: e.message });
    }
  }

  // ── 3. Weimi lookup — best effort ───────────────────────────────────────
  let current = null;
  for (const keyName of ['goodsId', 'goodsCode', 'goodsCustomCode']) {
    try {
      const q = await weimi.queryGoodsRaw({ endpoint: 'prod' }, { [keyName]: goodsId });
      const d = JSON.parse(q.bodyPreview)?.data || null;
      if (d && d.goodsId) { current = d; break; }
    } catch { /* try next identifier */ }
  }

  // Not in Weimi (e.g. a planogram-only product we stubbed locally). That is fine —
  // our catalog is the system of record for images. Save what we can locally.
  if (!current || !current.goodsId) {
    if (!newImgUrl && !existing.goodsId) return json(res, 404, { ok: false, error: 'product not found' });
    const numField = (v, keep) => (v === undefined) ? keep : (v == null || v === '' ? null : Math.max(0, Math.round(Number(v))));
    const name = (b.goodsName != null && String(b.goodsName).trim()) ? String(b.goodsName).trim().slice(0, 200) : (existing.name || null);
    try {
      storage.upsertProduct({
        goodsId, weimiId: existing.weimiId || null, goodsCode: existing.goodsCode || null,
        customCode: existing.customCode || null, name,
        salePriceIsk: existing.salePriceIsk != null ? existing.salePriceIsk : null,
        vatRate: (b.vatRate != null) ? (Number(b.vatRate) === 24 ? 24 : 11) : (existing.vatRate != null ? existing.vatRate : 11),
        costPriceIsk: numField(b.costPriceIsk, existing.costPriceIsk != null ? existing.costPriceIsk : null),
        weightGrams: numField(b.weightGrams, existing.weightGrams != null ? existing.weightGrams : null),
        measurement: (b.measurement != null) ? (Number(b.measurement) === 1 ? 1 : 0) : (existing.measurement || 0),
        barcode: (b.barcode != null) ? String(b.barcode).slice(0, 32) : (existing.barcode || null),
        imgUrl: newImgUrl || existing.imgUrl || null,
      });
      if (newImgUrl) storage.setProductImage(goodsId, { imgUrl: newImgUrl, hasBackground: imageHasBackground, clearedPct, srcW: imgSrcW, srcH: imgSrcH, weimiImgUrl: null });
    } catch (e) { console.error('[products] local upsert failed:', e.message); }
    warnings.push('Saved locally. This product is not in the Weimi catalog, so nothing was sent there.');
    return ok(res, { ok: true, goodsId, goodsName: name, imgUrl: newImgUrl || existing.imgUrl || null,
                     imageHasBackground, weimi: 'not_found', warnings });
  }

  const imgUrl       = newImgUrl || current.imgUrl;
  const thumbnailUrl = newImgUrl || current.thumbnailUrl || current.imgUrl;
  const goodsName   = (b.goodsName != null && String(b.goodsName).trim()) ? String(b.goodsName).trim().slice(0, 200) : current.goodsName;
  const measurement = (b.measurement != null) ? (Number(b.measurement) === 1 ? 1 : 0) : (current.measurement || 0);
  const barcode     = (b.barcode != null) ? String(b.barcode).slice(0, 32) : (current.barcode || '');

  // ── 4. Push to Weimi — best effort, never blocks our own save ───────────
  const fields = {
    goodsId: current.goodsId, goodsName,
    goodsCustomCode: current.goodsCustomCode,
    retailPrice: current.retailPrice,
    imgUrl, thumbnailUrl, measurement,
  };
  if (barcode) fields.barcode = barcode;

  let weimiState = 'ok';
  try {
    const result = await weimi.saveGoodsRaw({ endpoint: 'prod' }, fields);
    if (result.weimiCode !== 200) {
      weimiState = 'rejected';
      warnings.push('Weimi rejected the update: ' + weimi.fixMojibake(result.weimiMsg || 'unknown') + '. Saved on our side.');
    }
  } catch (e) {
    weimiState = 'unreachable';
    warnings.push('Could not reach Weimi (' + e.message + '). Saved on our side.');
  }

  // ── 5. Our own attributes ───────────────────────────────────────────────
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
    // upsertProduct deliberately won't move imgUrl on an already-normalized product (that
    // guard stops Weimi sync clobbering us). An operator upload IS authoritative, and it
    // was already written in step 2 — re-assert here in case upsert reverted it.
    if (newImgUrl) {
      storage.setProductImage(goodsId, {
        imgUrl: newImgUrl, hasBackground: imageHasBackground, clearedPct, srcW: imgSrcW, srcH: imgSrcH,
        weimiImgUrl: existing.imageNormalizedAt ? null : (existing.imgUrl || null),
      });
    }
  } catch (e) { console.error('[products] upsert failed:', e.message); }

  ok(res, { ok: true, goodsId, goodsName, imgUrl, imageHasBackground, vatRate, costPriceIsk,
            weightGrams, measurement, barcode: barcode || null, weimi: weimiState,
            warnings: warnings.length ? warnings : undefined });
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
    imgUrl: p.imgUrl, updatedAt: p.updatedAt, perishable: p.perishable === 1 || p.perishable === true,
    imageNormalizedAt: p.imageNormalizedAt || null, imageHasBackground: p.imageHasBackground === 1,
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

// ─── Receipts → cost prices (feature A) ─────────────────────────────────────────
// Small id helper matching the codebase convention (cmd_/deal_ style).
function receiptId(pfx) { return pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// Tokenize a product name into significant lowercase tokens. Keeps brand and
// flavour WORDS plus SIZE numbers (330, 500, 55) — which distinguish variants —
// while dropping pack COUNTS and unit words. Size numbers matter: "pepsi max 330"
// should reach "Pepsi Max 330 ml", not tie with the 500 ml variant.
//
// Key rule for pack specs like "18x330": the number AFTER the x is the size (keep),
// the number BEFORE is the pack count (drop). A standalone number is treated as a
// size and kept. Unit words (ml, gr, dós, stk, pk…) are dropped.
function nameTokens(s) {
  const STOP = new Set(['ml','cl','l','gr','g','kg','dos','dós','dosir','dósir','stk','pk','pakk','x','og','the','mons','m']);
  let str = String(s || '').toLowerCase();
  const sizes = [];
  // Pull the size out of every "NxM" pack spec (M = size), then remove the spec.
  str = str.replace(/(\d+)\s*x\s*(\d+)/g, (_, cnt, size) => { sizes.push(size); return ' '; });
  const words = str
    .replace(/[^\p{L}\p{N}]+/gu, ' ')       // punctuation → space (unicode-aware)
    .split(/\s+/)
    .filter(Boolean);
  const toks = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w)) { sizes.push(w); continue; } // standalone number = size
    toks.push(w);
  }
  // Normalize sizes: keep 2- and 3-digit sizes (55, 330, 500); drop tiny counts
  // like a lone "6" that are more likely pack counts than a meaningful size.
  for (const n of sizes) if (n.length >= 2) toks.push(n);
  return toks;
}

// Score how well a candidate product matches the receipt line's tokens.
// Overlap of line tokens found in the candidate, weighted so that matching
// ALL line tokens scores highest; longer candidates are lightly penalized so
// "Pepsi Max" beats "Pepsi Max Electric" for a plain "pepsi max" line.
function scoreCandidate(lineToks, prodToks) {
  if (!lineToks.length || !prodToks.length) return 0;
  const pset = new Set(prodToks);
  const hit = lineToks.filter(t => pset.has(t)).length;
  const coverage = hit / lineToks.length;                 // how much of the line is explained
  const extra = Math.max(0, prodToks.length - hit) * 0.03; // small penalty for extra prod words
  return coverage - extra;
}

// Match one extracted line to a catalog product. Barcode first (invoices), then
// tokenized name scoring. Auto-matches ONLY when a single candidate clearly leads;
// otherwise returns the top few candidates for the operator to pick.
function matchLine(line) {
  const storage = require('./storage');

  // 0) Learned alias — a description confirmed before maps straight to a product.
  //    Highest priority and a confident auto-match: this is what makes repeat
  //    receipts mostly pre-matched and self-heals odd supplier names.
  const alias = storage.lookupAlias(line.description);
  if (alias && alias.goodsId) {
    return { matchedGoodsId: alias.goodsId, matchStatus: 'auto', candidates: [], viaAlias: true };
  }

  // 1) Barcode exact (invoices usually carry EANs).
  if (line.barcode) {
    const byBar = storage.searchProducts(String(line.barcode), 5).filter(p => p.barcode === line.barcode);
    if (byBar.length === 1) return { matchedGoodsId: byBar[0].goodsId, matchStatus: 'auto', candidates: byBar };
    if (byBar.length > 1)  return { matchedGoodsId: null, matchStatus: 'unmatched', candidates: byBar };
  }

  // 2) Tokenized name search. Query the strongest 2 tokens so the LIKE is broad
  //    enough to return the variant set, then score locally.
  const lineToks = nameTokens(line.description);
  if (lineToks.length < 1) return { matchedGoodsId: null, matchStatus: 'unmatched', candidates: [] };

  // Gather candidates from a couple of token queries (union, de-duped by goodsId).
  const seen = new Map();
  for (const q of [lineToks.slice(0, 2).join(' '), lineToks[0]]) {
    if (!q || q.length < 3) continue;
    for (const p of storage.searchProducts(q, 12)) if (!seen.has(p.goodsId)) seen.set(p.goodsId, p);
  }
  const scored = [...seen.values()]
    .map(p => ({ p, s: scoreCandidate(lineToks, nameTokens(p.name)) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (!scored.length) return { matchedGoodsId: null, matchStatus: 'unmatched', candidates: [] };

  const top = scored[0], second = scored[1];
  const candidates = scored.slice(0, 5).map(x => x.p);

  // Auto-match only when the leader is strong AND clearly ahead of the runner-up.
  const clearLeader = top.s >= 0.75 && (!second || top.s - second.s >= 0.34);
  if (clearLeader) return { matchedGoodsId: top.p.goodsId, matchStatus: 'auto', candidates };
  return { matchedGoodsId: null, matchStatus: 'unmatched', candidates };
}

// Compare a line's computed net cost against the product's existing cost. Returns
// a verdict the review UI renders: 'confident' | 'suggest' | 'mismatch'.
function costVerdict(goodsId, computedNet) {
  const storage = require('./storage');
  if (!goodsId || computedNet == null) return { verdict: 'suggest', existingNet: null, ratio: null };
  const cur = storage.currentNetCost(goodsId);
  if (!cur.found || cur.existingNet == null) return { verdict: 'suggest', existingNet: null, ratio: null };
  const ratio = computedNet / cur.existingNet;
  // Within 15% → confident. Near a clean pack factor → likely missed multiplier.
  if (ratio >= 0.85 && ratio <= 1.15) return { verdict: 'confident', existingNet: cur.existingNet, ratio };
  const cleanFactors = [2, 3, 4, 6, 8, 10, 12, 18, 20, 24];
  const nearFactor = cleanFactors.find(f => Math.abs(ratio - f) / f < 0.12 || Math.abs(ratio - 1 / f) * f < 0.12);
  if (nearFactor) return { verdict: 'mismatch', existingNet: cur.existingNet, ratio, factor: nearFactor };
  return { verdict: 'suggest', existingNet: cur.existingNet, ratio };
}

// GET /api/v1/receipts/ping — one tiny real API call to prove the ANTHROPIC key
// works (or say exactly why not). No receipt, negligible cost. Use after /health
// shows receiptsVision 'key-present' to confirm the key is actually valid.
async function handleReceiptPing(req, res) {
  const receipts = require('./receipts');
  ok(res, await receipts.ping());
}

// POST /api/v1/receipts/extract  body: { fileBase64, mediaType }
// Reads the receipt via Claude vision, matches lines, runs the cost sanity check,
// persists a DRAFT receipt, and returns it for operator review. No cost is written.
async function handleReceiptExtract(req, res) {
  const receipts = require('./receipts');
  const storage  = require('./storage');
  let { fileBase64, mediaType } = req.body || {};
  if (!fileBase64) return badRequest(res, 'fileBase64 required');

  // Accept a data URL or bare base64; infer mediaType from the data URL if present.
  const m = String(fileBase64).match(/^data:([^;]+);base64,(.*)$/s);
  if (m) { mediaType = mediaType || m[1]; fileBase64 = m[2]; }
  if (!mediaType) return badRequest(res, 'mediaType required (image/jpeg, image/png, application/pdf)');

  let draft;
  try {
    draft = await receipts.extract(fileBase64, mediaType);
  } catch (e) {
    return serverError(res, new Error('extraction failed: ' + e.message));
  }

  const id = receiptId('rcpt');
  const now = Date.now();
  const operatorId = req.user.role === 'ag_admin' ? (req.body.operatorId || null) : req.user.operatorId;

  // Match + verdict per line; these decorate the response and seed matchStatus.
  const reviewLines = draft.lines.map((l, i) => {
    const match = matchLine(l);
    const cv = costVerdict(match.matchedGoodsId, l.netUnitCostIsk);
    return { ...l, ...match, ...cv, idx: i };
  });

  const receiptRow = {
    id, operatorId, supplier: draft.supplier, supplierKt: draft.supplierKt,
    date: draft.date, number: draft.number, sourceType: draft.sourceType, priceBasis: draft.priceBasis,
    netTotalIsk: draft.netTotalIsk, vskTotalIsk: draft.vskTotalIsk, grossTotalIsk: draft.grossTotalIsk,
    createdBy: req.user.name || req.user.id, createdAt: now,
  };
  const lineRows = reviewLines.map(l => ({
    id: receiptId('rl'), receiptId: id, idx: l.idx,
    description: l.description, packSize: l.packSize, unitsPerPack: l.unitsPerPack,
    qtyPacks: l.qtyPacks, barcode: l.barcode, priceBasis: l.priceBasis,
    pricePerPackIsk: l.pricePerPackIsk, lineTotalIsk: l.lineTotalIsk, vatRate: l.vatRate,
    netUnitCostIsk: l.netUnitCostIsk, matchedGoodsId: l.matchedGoodsId, matchStatus: l.matchStatus,
  }));

  let saved;
  try { saved = storage.createReceipt(receiptRow, lineRows); }
  catch (e) { return serverError(res, new Error('save failed: ' + e.message)); }

  // Return the persisted receipt plus the review decorations (candidates/verdict)
  // that aren't stored but the UI needs.
  ok(res, {
    receipt: saved,
    review: reviewLines.map(l => ({
      idx: l.idx, matchedGoodsId: l.matchedGoodsId, matchStatus: l.matchStatus,
      candidates: l.candidates, verdict: l.verdict, existingNet: l.existingNet,
      ratio: l.ratio, factor: l.factor,
    })),
  });
}

// GET /api/v1/receipts — list receipts for the operator (or all, for ag_admin).
function handleListReceipts(req, res) {
  const storage = require('./storage');
  const op = req.user.role === 'ag_admin' ? (req.query.operatorId || null) : req.user.operatorId;
  ok(res, { receipts: storage.listReceipts(op, 50) });
}

// GET /api/v1/receipts/:id — one receipt with its lines, re-decorated for review.
function handleGetReceipt(req, res) {
  const storage = require('./storage');
  const r = storage.getReceiptFull(req.params.id);
  if (!r) return notFound(res, 'receipt not found');
  if (req.user.role !== 'ag_admin' && r.operatorId !== req.user.operatorId) return notFound(res, 'receipt not found');
  const review = r.lines.map(l => {
    const cv = costVerdict(l.matchedGoodsId, l.netUnitCostIsk);
    const candidates = l.matchedGoodsId ? [] : matchLine(l).candidates;
    return { idx: l.idx, matchedGoodsId: l.matchedGoodsId, matchStatus: l.matchStatus, candidates, ...cv };
  });
  ok(res, { receipt: r, review });
}

// POST /api/v1/receipts/:id/confirm  body: { lines: [{ id, matchedGoodsId,
//   netUnitCostIsk, matchStatus }] }  — operator's corrected lines.
// Writes net cost to each matched product and marks the receipt confirmed.
// Every line must be matched (a goodsId) or explicitly skipped (matchStatus 'skip').
function handleConfirmReceipt(req, res) {
  const storage = require('./storage');
  const r = storage.getReceiptFull(req.params.id);
  if (!r) return notFound(res, 'receipt not found');
  if (req.user.role !== 'ag_admin' && r.operatorId !== req.user.operatorId) return notFound(res, 'receipt not found');
  if (r.status === 'confirmed') return badRequest(res, 'receipt already confirmed');

  const edits = Array.isArray(req.body?.lines) ? req.body.lines : [];
  const editById = {}; edits.forEach(e => { if (e.id) editById[e.id] = e; });

  // A line is resolved if it's matched to a product, skipped, or drafted (a new
  // product to be created later, with its cost parked).
  const unresolved = r.lines.filter(l => {
    const e = editById[l.id] || {};
    const gid = e.matchedGoodsId ?? l.matchedGoodsId;
    const skipped = (e.matchStatus === 'skip');
    const drafted = (e.matchStatus === 'draft');
    return !gid && !skipped && !drafted;
  });
  if (unresolved.length) {
    return badRequest(res, 'unresolved lines', unresolved.map(l => ({ id: l.id, description: l.description })));
  }

  const draftId = pfx => pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const writes = [];
  const drafts = [];
  for (const l of r.lines) {
    const e = editById[l.id] || {};
    if (e.matchStatus === 'skip') continue;
    const net = (e.netUnitCostIsk != null) ? Math.round(Number(e.netUnitCostIsk)) : l.netUnitCostIsk;
    if (e.matchStatus === 'draft') {
      // Park a new-product draft with the line's cost and attributes.
      drafts.push({
        id: draftId('draft'), lineId: l.id,
        name: (e.draftName || l.description || '').trim(),
        barcode: l.barcode || null, packSize: l.packSize || null,
        vatRate: e.vatRate || l.vatRate || 11,
        costPriceNetIsk: net != null ? net : 0,
        unitsPerPack: l.unitsPerPack, qtyPacks: l.qtyPacks,
        priceBasis: l.priceBasis, pricePerPackIsk: l.pricePerPackIsk,
      });
      continue;
    }
    const gid = e.matchedGoodsId ?? l.matchedGoodsId;
    if (!gid || net == null) continue;
    writes.push({ line: l, goodsId: gid, net, matchStatus: e.matchStatus });
  }

  let result;
  try { result = storage.confirmReceiptWrites(r.id, writes, drafts); }
  catch (e) { return serverError(res, new Error('confirm failed: ' + e.message)); }

  ok(res, { confirmed: true, written: result.written, drafts: result.drafts,
            count: result.written.length, draftCount: result.drafts.length });
}

// GET /api/v1/product-drafts — pending drafts (products to create). Global, since
// the catalog is one shared catalog.
function handleListDrafts(req, res) {
  const storage = require('./storage');
  ok(res, { drafts: storage.listPendingDrafts(100) });
}

// DELETE /api/v1/product-drafts/:id — discard a pending draft (operator decided
// not to create it). The parked cost is simply dropped.
function handleDeleteDraft(req, res) {
  const storage = require('./storage');
  const d = storage.getDraftById(req.params.id);
  if (!d) return notFound(res, 'draft not found');
  storage.removeDraft(req.params.id);
  ok(res, { deleted: true });
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

  // If this creation resolves a receipt draft, transfer the parked net cost onto
  // the new product and mark the draft done. Explicit + self-reporting so the
  // outcome is visible (the transfer is what carries the receipt cost).
  let draftResolved = null;
  if (b.draftId) {
    try {
      const draft = storage.getDraftById(b.draftId);
      if (!draft) {
        draftResolved = { ok: false, reason: 'draft-not-found', draftId: b.draftId };
      } else {
        const net = (draft.costPriceNetIsk != null) ? Math.max(0, Math.round(draft.costPriceNetIsk)) : null;
        if (net != null) storage.setProductNetCost(catalogKey, net);
        storage.markDraftResolved(b.draftId, catalogKey);
        // Read back to prove the cost landed on the product.
        const check = storage.getProduct(catalogKey);
        draftResolved = { ok: true, draftId: b.draftId, goodsId: catalogKey,
                          netCostParked: net, netCostOnProduct: check ? check.costPriceNetIsk : null };
      }
    } catch (e) {
      draftResolved = { ok: false, reason: e.message, draftId: b.draftId };
      console.error('[products] draft resolve failed:', e.message);
    }
  }

  ok(res, { ok: true, goodsId, goodsCode, catalogKey, customCode, imgUrl, goodsName: fields.goodsName,
            salePriceIsk: Math.round(isk), vatRate, costPriceIsk, weightGrams, measurement,
            barcode: fields.barcode || null, draftResolved });
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
      if (!byGoods[gid]) byGoods[gid] = { goodsId: gid, name: b.name || '', image: b.image || '', priceCounts: {}, machines: new Set(), slotCount: 0, currStock: 0, codes: [] };
      const g = byGoods[gid];
      if (!g.name && b.name) g.name = b.name;
      if (!g.image && b.image) g.image = b.image;
      const isk = Number(b.priceIsk);
      if (Number.isFinite(isk) && isk > 0) g.priceCounts[isk] = (g.priceCounts[isk] || 0) + 1;
      g.currStock += Number(b.currStock) || 0;
      if (b.code) g.codes.push(b.code);
      g.machines.add(code);
      g.slotCount += 1;
    }));
  }

  const products = Object.values(byGoods).map(g => {
    let priceIsk = 0, best = -1;   // representative price = most common across slots
    for (const [p, n] of Object.entries(g.priceCounts)) { if (n > best) { best = n; priceIsk = Number(p); } }
    const machineList = [...g.machines].map(code => ({ deviceCode: code, deviceName: (machines[code] && machines[code].deviceName) || code }));
    return { goodsId: g.goodsId, name: g.name || ('#' + g.goodsId), image: g.image || '', priceIsk, machineCount: g.machines.size, slotCount: g.slotCount, machines: machineList, currStock: g.currStock, soldOut: g.currStock <= 0, slots: g.codes };
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

// ── Product-detail import: fuzzy name matching ───────────────────────────────
// Catalog names are often abbreviated ("Oat King Choco Caram 95g") while the
// import sheet spells them out ("Oat King Chocolate Caramel 95g"). We fold
// accents, drop pack-size tokens, and match tokens with PREFIX tolerance so
// "choco"~"chocolate", "caram"~"caramel", "prot"~"protein", "jard"~"jardarber".
function pdFold(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}
function pdTokens(s) {
  return pdFold(s)
    .replace(/\b\d+([.,]\d+)?\s*(g|kg|mg|ml|cl|dl|l|stk|st|pcs|pk|x)\b/g, ' ')   // pack sizes
    .replace(/[^a-z0-9\u00fe\u00f0\u00e6\u00f8\u00e5]+/g, ' ')                     // keep latin + þ ð æ ø å
    .split(/\s+/).filter(t => t && t.length > 1);
}
function pdTokenMatch(a, b) {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  return m >= 3 && (a.startsWith(b) || b.startsWith(a));
}
function pdScore(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const used = new Array(bTokens.length).fill(false);
  let matched = 0;
  for (const a of aTokens) {
    for (let j = 0; j < bTokens.length; j++) {
      if (!used[j] && pdTokenMatch(a, bTokens[j])) { used[j] = true; matched++; break; }
    }
  }
  let score = (2 * matched) / (aTokens.length + bTokens.length);
  if (aTokens[0] && bTokens[0] && pdTokenMatch(aTokens[0], bTokens[0])) score = Math.min(1, score + 0.12);
  return score;
}
function pdSafeParse(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function pdHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return String(h); }
// Split a combined "Allergens / notes" string into clean lists for kiosk pills:
//   "Contains wheat, egg. May contain nuts. Vegan" → contains:[Wheat,Egg], mayContain:[Nuts], notes:"Vegan"
// Keyword-driven so descriptive-only cells (e.g. "Vegan, gluten-free") become notes, not allergen pills.
function pdSplitList(s) {
  return String(s || '').split(/[,/;]| and /i)
    .map(x => x.trim().replace(/^[.\s]+|[.\s]+$/g, '')).filter(Boolean)
    .map(x => x.charAt(0).toUpperCase() + x.slice(1));
}
function pdParseAllergens(raw) {
  const out = { contains: [], mayContain: [], notes: '' };
  let text = String(raw || '').trim();
  if (!text) return out;
  const mc = text.match(/\bmay\s+contains?\b\s*:?\s*([^.;]+)/i);
  if (mc) { out.mayContain = pdSplitList(mc[1]); text = text.replace(mc[0], ' '); }
  const c = text.match(/\bcontains?\b\s*:?\s*([^.;]+)/i);
  if (c) { out.contains = pdSplitList(c[1]); text = text.replace(c[0], ' '); }
  const rest = text.replace(/\s+/g, ' ').replace(/^[\s.,;]+|[\s.,;]+$/g, '').trim();
  if (rest) out.notes = rest;
  return out;
}
function pdExisting(p) {
  return {
    packSize: p.packSize || '', basis: p.nutritionBasis || '', ingredients: p.ingredients || '',
    allergens: p.allergens || '', mayContain: p.mayContain || '', notes: p.detailNotes || '',
    nutrition: pdSafeParse(p.nutrition),
  };
}

/**
 * POST /api/v1/products/match-details   (AG admin)
 * Body: { rows: [{ name, details:{packSize,basis,ingredients,allergens,mayContain,notes,nutrition} }] }
 * Returns a proposed catalog match per row with ranked candidates so the operator
 * can confirm, pick, or skip. No writes.
 */
// Deduped products actually loaded in a machine's layout (device codes + shelf name/image/price).
function pdMachineProducts(code) {
  const storage = require('./storage');
  let layout;
  try { const raw = storage.getMeta(`layout:${code}`); layout = raw ? JSON.parse(raw) : null; } catch { layout = null; }
  const by = {};
  if (Array.isArray(layout)) layout.forEach(layer => (layer.bays || []).forEach(b => {
    if (!b || b.goodsId == null || !String(b.goodsId)) return;
    const gid = String(b.goodsId);
    if (!by[gid]) by[gid] = { goodsId: gid, name: b.name || '', image: b.image || '', priceIsk: Number(b.priceIsk) || 0 };
    else { if (!by[gid].name && b.name) by[gid].name = b.name; if (!by[gid].image && b.image) by[gid].image = b.image; }
  }));
  return Object.values(by);
}

function handleMatchDetails(req, res) {
  const storage = require('./storage');
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return badRequest(res, 'rows required');
  const deviceCode = req.body && req.body.deviceCode;
  // Machine-scoped: candidates are the products actually loaded on that machine (so
  // details land on codes the kiosk serves). Otherwise fall back to the whole table.
  let pool;
  if (deviceCode) {
    pool = pdMachineProducts(deviceCode).map(c => {
      const row = storage.getProduct(c.goodsId);
      return { goodsId: c.goodsId, name: c.name || (row && row.name) || ('#' + c.goodsId), image: c.image || (row && row.imgUrl) || '', priceIsk: c.priceIsk, existing: row ? pdExisting(row) : { packSize:'', basis:'', ingredients:'', allergens:'', mayContain:'', notes:'', nutrition:null } };
    });
  } else {
    pool = storage.listProducts().map(p => ({ goodsId: p.goodsId, name: p.name || '', image: p.imgUrl || '', priceIsk: p.salePriceIsk || 0, existing: pdExisting(p) }));
  }
  const cand = pool.map(c => ({ ...c, tokens: pdTokens(c.name) }));
  const results = rows.map((r, idx) => {
    const sTok = pdTokens(r && r.name);
    const scored = cand.map(c => ({
      goodsId: c.goodsId, name: c.name, image: c.image, priceIsk: c.priceIsk,
      score: Math.round(pdScore(sTok, c.tokens) * 100) / 100, existing: c.existing,
    })).sort((a, b) => b.score - a.score).slice(0, 6);
    const top = scored[0], second = scored[1];
    let status;
    if (top && top.score >= 0.6 && (!second || top.score - second.score >= 0.12)) status = 'ready';
    else if (top && top.score >= 0.35) status = 'pick';
    else status = 'nomatch';
    return {
      index: idx, name: (r && r.name) || '', details: (r && r.details) || {},
      status, suggestedGoodsId: status === 'nomatch' ? null : (top ? top.goodsId : null),
      candidates: scored,
    };
  });
  ok(res, { results, deviceScoped: !!deviceCode, candidateCount: cand.length });
}

/**
 * POST /api/v1/products/apply-details   (AG admin)
 * Body: { items: [{ goodsId, details:{...}, name?, image?, priceIsk? }] }
 * Details already conflict-resolved in the review screen. If a chosen product
 * has no database row yet (loaded on a machine but never imported), we create a
 * minimal row under its device code first, so details land where the kiosk reads.
 */
function handleApplyDetails(req, res) {
  const storage = require('./storage');
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return badRequest(res, 'items required');
  let applied = 0, created = 0;
  for (const it of items) {
    if (!it || !it.goodsId) continue;
    if (!storage.getProduct(it.goodsId)) {
      storage.upsertProduct({ goodsId: String(it.goodsId), name: it.name || ('#' + it.goodsId), salePriceIsk: it.priceIsk != null ? it.priceIsk : null, imgUrl: it.image || null });
      created++;
    }
    if (!storage.getProduct(it.goodsId)) continue;
    storage.setProductDetails(it.goodsId, it.details || {});
    applied++;
  }
  storage.setMeta('productDetailsRev', String(Date.now()));
  ok(res, { applied, created });
}

/**
 * GET /api/v1/machines/:deviceCode/product-details   (machine key)
 * Detail for the products loaded in this machine, keyed by product code. Only
 * products that actually have details are included; the rest fall back to the
 * photo-only screen on the kiosk. 304 on matching `version` (If-None-Match).
 */
function handleMachineProductDetails(req, res) {
  const storage = require('./storage');
  const code = req.params.deviceCode;
  let layout;
  try { const raw = storage.getMeta(`layout:${code}`); layout = raw ? JSON.parse(raw) : null; } catch { layout = null; }
  const codes = new Set();
  if (Array.isArray(layout)) layout.forEach(layer => (layer.bays || []).forEach(b => {
    if (b && b.goodsId != null && String(b.goodsId)) codes.add(String(b.goodsId));
  }));
  const products = {};
  codes.forEach(gid => {
    const p = storage.getProduct(gid);
    if (!p) return;
    if (!(p.packSize || p.ingredients || p.allergens || p.mayContain || p.detailNotes || p.nutrition)) return;
    const ax = pdParseAllergens(p.allergens);
    products[gid] = {
      packSize: p.packSize || null, basis: p.nutritionBasis || null, ingredients: p.ingredients || null,
      allergens: ax.contains,
      mayContain: p.mayContain ? pdSplitList(p.mayContain) : ax.mayContain,
      notes: p.detailNotes || ax.notes || null,
      nutrition: pdSafeParse(p.nutrition),
    };
  });
  const version = 'pd-' + pdHash(JSON.stringify(products));
  const inm = req.headers['if-none-match'];
  if (inm && inm === version) { res.writeHead(304); res.end(); return; }
  ok(res, { version, products });
}

// GET /api/v1/debug/product-details?deviceCode=  (public; browser verification)
function handleDebugProductDetails(req, res) {
  const code = req.query && req.query.deviceCode;
  if (!code) return json(res, 400, { ok: false, error: 'deviceCode required' });
  req.params = Object.assign({}, req.params, { deviceCode: code });
  return handleMachineProductDetails(req, res);
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
  const telem = storage.latestTelemetry(m.deviceCode);
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
    stockSource: m.stockSource || 'weimi',
    coolingSetpointC: (m.settings && m.settings.coolingSetpointC != null) ? m.settings.coolingSetpointC : null,
    coolingOn: (m.settings && typeof m.settings.coolingOn === 'boolean') ? m.settings.coolingOn : null,
    lastTempC: (telem && telem.tempC != null) ? telem.tempC : null,
    lastTempAt: (telem && telem.atMs != null) ? telem.atMs : null,
    lastStatusOk: (telem && telem.statusOk != null) ? (telem.statusOk === 1 || telem.statusOk === true) : null,
    lastAppVersionCode: (() => { const v = storage.getAppVersion(m.deviceCode); return (v && v.vc != null) ? v.vc : null; })(),
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
