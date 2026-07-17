/**
 * Snarl & Sopi frá AG Vending — Operator Backend
 *
 * This module is the persistence layer + permission helpers.
 * All data is stored in SQLite via storage.js.
 *
 * On first startup (empty database), seeds operators, machines, and default
 * AG Vending users from the data below. Subsequent restarts read from disk.
 */

const crypto  = require('crypto');
const storage = require('./storage');

// ─── Default settings for new machines ────────────────────────────────────────

const DEFAULT_SETTINGS = {
  showAdRegion: true, showLeftHero: true, showRightHero: true,
  showIdleScreen: false, idleTimeoutSeconds: 60,
  defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'],
  hasHeatedGlass: false, heatedGlassDefaultOn: false,
  hasLedStrips: false, ledBrightness: 8,
  motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0,
};

const DEFAULT_PROFILE = (operatorName, machineLabel) => ({
  operatorName, supportEmail: 'hallo@snarlogsopi.is',
  supportPhone: null, machineLabel,
});

// ─── SEED DATA ────────────────────────────────────────────────────────────────

// Auto-generated operators
const SEED_OPERATORS = [
  { id: "op_ice", name: "ICE", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_ag-rekstur", name: "AG Rekstur", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_holaskoli", name: "Holaskoli", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_reykjalundur", name: "Reykjalundur", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_al", name: "AL", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_kef", name: "KEF", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_evanger", name: "Evanger", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_ir", name: "ÍR", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_burfell", name: "Burfell", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_iwo", name: "IWO", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_bus", name: "Bus", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_dyrholar", name: "Dyrholar", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_alano", name: "Alanó", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_fsa", name: "FSA", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_fylkir", name: "Fylkir", isAGVending: false, contactEmail: '', contactPhone: '' },
  { id: "op_ag-vending", name: "AG Vending", isAGVending: true, contactEmail: '', contactPhone: '' },
  { id: "op_unassigned", name: "Unassigned", isAGVending: false, contactEmail: '', contactPhone: '' },
];

// Auto-generated machines
const SEED_MACHINES = [
  { deviceCode: '62160042', deviceName: "Gamli Gerpla", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: false, isRunning: false, kioskVersion: null },
  { deviceCode: '62160043', deviceName: "Valur I", location: "Hlíðarenda, 102 Reykjavík", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160472', deviceName: "Fylkir 2", location: "Fylkisvegi", operatorId: 'op_fylkir', operatorName: "Fylkir", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160473', deviceName: "F. Skautafélag Akureyrar", location: "", operatorId: 'op_fsa', operatorName: "FSA", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160474', deviceName: "12 Sporahúsið", location: "Vallarkór 12-14, 203 Kópavogur", operatorId: 'op_alano', operatorName: "Alanó", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160475', deviceName: "Dyrhólaey", location: "", operatorId: 'op_dyrholar', operatorName: "Dyrholar", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160476', deviceName: "Mjódd", location: "Þönglabakki 4,109 Reykjavík", operatorId: 'op_bus', operatorName: "Bus", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160477', deviceName: "Orkan Miklabraut N", location: "Miklabraut", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160478', deviceName: "Laugardagshöll", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160479', deviceName: "Grótta vinstri", location: "Suðurströnd 8, 170 Seltjarnarnes", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160480', deviceName: "Stjarnan", location: "Smáratorg 3, 201 Kópavogur", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: false, isRunning: false, kioskVersion: null },
  { deviceCode: '62160481', deviceName: "Klettatröð - IWO", location: "Klettatröð 10, 262 Reykjanesbær", operatorId: 'op_iwo', operatorName: "IWO", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160482', deviceName: "Hótel Búrfell", location: "Holtagörðum, 104 Reykjavík", operatorId: 'op_burfell', operatorName: "Burfell", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160483', deviceName: "KR", location: "Frostaskjól", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160484', deviceName: "Grótta hægri", location: "Suðurströnd 8, 170 Seltjarnarnes", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160485', deviceName: "Leiknir", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: false, isRunning: false, kioskVersion: null },
  { deviceCode: '62160486', deviceName: "Golfhermir", location: "Borgartún 24b", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160487', deviceName: "Íþróttafélag Reykjavíkur", location: "ir@ir.is", operatorId: 'op_ir', operatorName: "ÍR", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160488', deviceName: "Evanger", location: "Gránugata 24, 580 Siglufjörður", operatorId: 'op_evanger', operatorName: "Evanger", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160489', deviceName: "Valur II", location: "Hlíðarenda, 102 Reykjavík", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160490', deviceName: "Keflavík", location: "Flugvellir 6", operatorId: 'op_kef', operatorName: "KEF", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160491', deviceName: "Faxatorg", location: "Faxatorg", operatorId: 'op_al', operatorName: "AL", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160492', deviceName: "Valhúsaskóli", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '62160493', deviceName: "Skjól 1", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "VM-WM55DL", isKioskModel: true, isOnline: true, isRunning: true, kioskVersion: '0.21' },
  { deviceCode: '82160674', deviceName: "Reykjalundur", location: "Reykjalundur, 270 Mosfellsbær", operatorId: 'op_reykjalundur', operatorName: "Reykjalundur", model: "GR-WM22Z1260", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160675', deviceName: "Newrest", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z1260", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160676', deviceName: "Hólaskóli", location: "", operatorId: 'op_holaskoli', operatorName: "Holaskoli", model: "GR-WM22Z1260", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160677', deviceName: "Airport Associates", location: "", operatorId: 'op_ag-rekstur', operatorName: "AG Rekstur", model: "GR-WM22Z1260", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160784', deviceName: "Hlaðdeild 2", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160785', deviceName: "Crew 3", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160786', deviceName: "Crew 1", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160787', deviceName: "Crew 2", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
  { deviceCode: '82160788', deviceName: "Hlaðdeild 1", location: "Fálkavellir 2", operatorId: 'op_ice', operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false, isOnline: true, isRunning: true, kioskVersion: null },
];

const SEED_USERS = [
  { id:'u1', name:'Sky K.',  email:'sky@agvending.is',  password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all' },
  { id:'u2', name:'Jane L.', email:'jane@agvending.is', password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all' },
  { id:'u3', name:'Mike R.', email:'mike@agvending.is', password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all' },
];

const SEED_ALERTS = [
  { id:'a1', type:'offline', severity:'critical', title:'Machine offline — Gamli Gerpla', detail:'62160042 · offline since 2026-05-19', deviceCode:'62160042', resolved:false, createdAt: new Date(Date.now()-4*86400000).toISOString() },
  { id:'a2', type:'offline', severity:'critical', title:'Machine offline — Leiknir',      detail:'62160485 · offline since 2026-02-20', deviceCode:'62160485', resolved:false, createdAt: new Date(Date.now()-90*86400000).toISOString() },
  { id:'a3', type:'offline', severity:'warning',  title:'Machine offline — Stjarnan',     detail:'62160480 · offline since 2025-07-10', deviceCode:'62160480', resolved:false, createdAt: new Date(Date.now()-316*86400000).toISOString() },
  { id:'a4', type:'kiosk',   severity:'info',     title:'Kiosk app v0.22 ready to deploy',detail:'VM-WM55DL machines on v0.21',         deviceCode:null,       resolved:false, createdAt: new Date(Date.now()-3*3600000).toISOString() },
];

// ─── Seed on first run ────────────────────────────────────────────────────────

function seedIfEmpty() {
  // Check whether the operators table has any rows
  const opCount = storage.listOperators().length;
  if (opCount > 0) {
    console.log('[DB] Existing data found, skipping seed (' + opCount + ' operators)');
    return;
  }
  console.log('[DB] Empty database — seeding initial data...');

  // Operators
  SEED_OPERATORS.forEach(op => storage.upsertOperator({ ...op, createdAt: '2026-05-22T08:00:00Z' }));

  // Machines
  SEED_MACHINES.forEach(s => {
    storage.upsertMachine({
      deviceCode: s.deviceCode, deviceName: s.deviceName, location: s.location,
      operatorId: s.operatorId, model: s.model, isKioskModel: s.isKioskModel,
      isOnline: s.isOnline, isRunning: s.isRunning, kioskVersion: s.kioskVersion,
      totalCurrStock: 0, maxStock: 0,
      profile: DEFAULT_PROFILE(s.operatorName, s.deviceName),
      featured: [], ads: [],
      settings: { ...DEFAULT_SETTINGS },
      products: [], productOverrides: {},
      configVersion: '2026-05-22T08:00:00Z',
      createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
    });
  });

  // Users
  SEED_USERS.forEach(u => storage.insertUser({
    ...u, lastActiveAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }));

  // Alerts
  SEED_ALERTS.forEach(a => storage.insertAlert(a));

  console.log('[DB] Seeded ' + SEED_OPERATORS.length + ' operators, ' + SEED_MACHINES.length + ' machines, ' + SEED_USERS.length + ' users');
}

seedIfEmpty();

// ─── Seed lease units on first run (only if table empty) ─────────────────────
(function seedLeaseUnitsIfEmpty() {
  try {
    const existing = storage.listLeaseUnits().length;
    if (existing > 0) {
      console.log('[DB] lease_units present (' + existing + '), skipping seed');
      return;
    }
    const seed = require('./data/lease-units-seed.json');
    seed.forEach(u => storage.insertLeaseUnit(u));
    console.log('[DB] Seeded ' + seed.length + ' lease units');
  } catch (e) {
    console.error('[DB] lease unit seed failed:', e.message);
  }
})();

// ─── TEST KEY SEEDING (env-controlled) ───────────────────────────────────────
//
// To activate one or more machine keys at startup without writing a database
// row by hand, set TEST_MACHINE_KEYS in the environment as a comma-separated
// list of `deviceCode:machineKey` pairs:
//
//   TEST_MACHINE_KEYS=62160485:mk_live_abc...,62160472:mk_live_def...
//
// On every startup, the backend reads this variable and inserts any pairs
// that aren't already in the machine_keys table. Existing keys are left
// alone (so a key revoked by the dashboard stays revoked across deploys).
//
// To revoke a test key, clear it from the dashboard (revoke endpoint) AND
// remove it from TEST_MACHINE_KEYS — otherwise the next deploy will re-add
// it as an active key.
(function seedTestKeys() {
  const raw = process.env.TEST_MACHINE_KEYS;
  if (!raw) return;
  const pairs = raw.split(',').map(s => s.trim()).filter(Boolean);
  let added = 0;
  pairs.forEach(p => {
    const [deviceCode, machineKey] = p.split(':').map(s => s.trim());
    if (!deviceCode || !machineKey) {
      console.warn('[DB] Skipping malformed TEST_MACHINE_KEYS entry:', p);
      return;
    }
    if (!storage.getMachine(deviceCode)) {
      console.warn('[DB] TEST_MACHINE_KEYS: device ' + deviceCode + ' not in DB, skipping');
      return;
    }
    const existing = storage.getMachineKey(deviceCode);
    if (existing) {
      // If it's the same key, do nothing. If it's different and not revoked,
      // do not silently overwrite — log a warning. If it's revoked, we
      // intentionally leave the revoked state alone (operator chose to revoke it).
      if (existing.apiKey === machineKey && !existing.revokedAt) {
        // Already seeded and active — nothing to do
        return;
      }
      if (existing.revokedAt) {
        console.warn('[DB] TEST_MACHINE_KEYS: ' + deviceCode + ' has a revoked key; not re-activating');
        return;
      }
      console.warn('[DB] TEST_MACHINE_KEYS: ' + deviceCode + ' already has a different active key; not overwriting');
      return;
    }
    storage.insertMachineKey(deviceCode, machineKey);
    added++;
    console.log('[DB] TEST_MACHINE_KEYS: provisioned ' + deviceCode);
  });
  if (added > 0) console.log('[DB] TEST_MACHINE_KEYS: activated ' + added + ' key(s)');
})();

// ─── Compatibility layer ──────────────────────────────────────────────────────
// Many existing handlers read from `machines`, `users` etc. as if they were
// plain objects/arrays. We expose Proxy-backed views that look like objects
// but are actually reading from SQLite under the hood. This keeps the router
// changes minimal.

const machines = new Proxy({}, {
  get(_, deviceCode) {
    if (typeof deviceCode === 'symbol') return undefined;
    if (deviceCode === 'constructor') return Object;
    return storage.getMachine(deviceCode);
  },
  has(_, deviceCode) {
    return !!storage.getMachine(deviceCode);
  },
  ownKeys() {
    return storage.listMachines().map(m => m.deviceCode);
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
  set(_, deviceCode, machine) {
    storage.upsertMachine({ ...machine, deviceCode });
    return true;
  },
  deleteProperty() { return false; },
});

const operators = new Proxy({}, {
  get(_, id) {
    if (typeof id === 'symbol') return undefined;
    return storage.getOperator(id);
  },
  has(_, id) { return !!storage.getOperator(id); },
  ownKeys() { return storage.listOperators().map(o => o.id); },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  set(_, id, op) { storage.upsertOperator({ ...op, id }); return true; },
});

// Users is exposed as an Array-like (we use .find, .filter, .push, .length, .map)
const usersProxy = new Proxy([], {
  get(_, prop) {
    if (prop === 'length')   return storage.listUsers().length;
    if (prop === 'find')     return (fn) => storage.listUsers().find(fn);
    if (prop === 'filter')   return (fn) => storage.listUsers().filter(fn);
    if (prop === 'map')      return (fn) => storage.listUsers().map(fn);
    if (prop === 'forEach')  return (fn) => storage.listUsers().forEach(fn);
    if (prop === 'push')     return (user) => { storage.insertUser(user); return storage.listUsers().length; };
    if (prop === Symbol.iterator) return storage.listUsers()[Symbol.iterator].bind(storage.listUsers());
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return storage.listUsers()[parseInt(prop)];
    return undefined;
  },
});

// Alerts exposed similarly
const alertsProxy = new Proxy([], {
  get(_, prop) {
    if (prop === 'length')   return storage.listAlerts().length;
    if (prop === 'find')     return (fn) => storage.listAlerts().find(fn);
    if (prop === 'filter')   return (fn) => storage.listAlerts().filter(fn);
    if (prop === 'map')      return (fn) => storage.listAlerts().map(fn);
    if (prop === 'forEach')  return (fn) => storage.listAlerts().forEach(fn);
    if (prop === 'push')     return (a) => { storage.insertAlert(a); return storage.listAlerts().length; };
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return storage.listAlerts()[parseInt(prop)];
    return undefined;
  },
});

// Orders proxy
const ordersProxy = new Proxy([], {
  get(_, prop) {
    if (prop === 'length')  return storage.db.prepare('SELECT COUNT(*) AS c FROM orders').get().c;
    if (prop === 'find')    return (fn) => storage.db.prepare('SELECT * FROM orders').all().find(fn);
    if (prop === 'filter')  return (fn) => storage.db.prepare('SELECT * FROM orders').all().filter(fn);
    if (prop === 'map')     return (fn) => storage.db.prepare('SELECT * FROM orders').all().map(fn);
    if (prop === 'forEach') return (fn) => storage.db.prepare('SELECT * FROM orders').all().forEach(fn);
    if (prop === 'push')    return (o) => { storage.insertOrder(o); return 0; };
    if (prop === 'reduce')  return (fn, init) => storage.db.prepare('SELECT * FROM orders').all().reduce(fn, init);
    if (prop === 'unshift') return (...newOrders) => { newOrders.forEach(o => storage.insertOrder(o)); return 0; };
    return undefined;
  },
  set() { return true; }, // tolerate orders = [...]
});

// ─── Machine keys / provisioning ─────────────────────────────────────────────

function generateMachineKey() { return 'mk_live_' + crypto.randomBytes(24).toString('hex'); }

function provisionMachine(deviceCode) {
  if (!storage.getMachine(deviceCode)) return { error: 'device_not_found', status: 404 };
  const existing = storage.getMachineKey(deviceCode);
  if (existing && !existing.revokedAt) return { error: 'already_provisioned', status: 409 };
  const key = generateMachineKey();
  storage.insertMachineKey(deviceCode, key);
  return { machineKey: key, deviceCode };
}

function validateMachineKey(deviceCode, key) {
  const entry = storage.getMachineKey(deviceCode);
  if (!entry || entry.revokedAt) return false;
  return entry.apiKey === key;
}

function revokeKey(deviceCode) { storage.revokeMachineKey(deviceCode); }

// ─── Kiosk presence ───────────────────────────────────────────────────────────
// Called on every authenticated kiosk HTTP call (config poll, sales, complaints).
// Records last-seen and clears any open "offline" alert for the device, since a
// valid authenticated call proves the kiosk app is alive. Does NOT write isOnline
// to storage — online status is derived dynamically from last-seen so it can't
// go stale (replaces the WebSocket presence channel).
function markKioskSeen(deviceCode) {
  storage.recordKioskSeen(deviceCode);
  try {
    storage.listAlerts().forEach(a => {
      if (!a.resolved && a.deviceCode === deviceCode && a.type === 'offline') storage.resolveAlert(a.id);
    });
  } catch (e) { /* non-fatal */ }
}

function isKioskAlive(deviceCode) { return storage.isKioskAlive(deviceCode); }

// ─── Invitation helpers (SQL-backed wrappers) ────────────────────────────────

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

function createInvitation({ email, name, role, operatorId, inviterId, machineAccess = 'all' }) {
  const token = 'inv_' + crypto.randomBytes(24).toString('hex');
  const invite = {
    token, email, name, role, operatorId, inviterId, machineAccess,
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITATION_TTL_MS,
    consumedAt: null,
  };
  storage.insertInvitation(invite);
  return invite;
}

function getInvitation(token) {
  const inv = storage.getInvitation(token);
  if (!inv) return null;
  if (inv.consumedAt) return null;
  if (inv.expiresAt < Date.now()) return null;
  return inv;
}

function consumeInvitation(token) { storage.consumeInvitation(token); }

// Map-like wrapper for code that iterates `invitations.values()`
const invitations = {
  values() { return storage.listActiveInvitations(); },
  delete(token) { storage.deleteInvitation(token); },
  get(token) { return storage.getInvitation(token); },
};

// Cleanup expired invitations once per day
setInterval(() => storage.cleanupExpiredInvitations(), 24 * 3600 * 1000).unref();

// ─── Auth tokens (still in memory — they're session tokens, fine to lose) ────

const authTokens = new Map();

// ─── API config (env vars) ────────────────────────────────────────────────────

const apiConfig = {
  appId:     process.env.WEIMI_APP_ID     || '8c98f0207729893439e089e3703b6b37',
  secretKey: process.env.WEIMI_SECRET_KEY || '1M1@#MLH4w#ko1k!/1D\$',
  endpoint:  process.env.WEIMI_ENV        || 'prod',
};

// ─── Permission helpers ──────────────────────────────────────────────────────

function userCanAccessMachine(user, deviceCode) {
  if (!user) return false;
  const m = storage.getMachine(deviceCode);
  if (!m) return false;
  if (user.role === 'ag_admin') return true;
  if (m.operatorId !== user.operatorId) return false;
  if (user.machineAccess === 'all') return true;
  if (Array.isArray(user.machineAccess)) return user.machineAccess.includes(deviceCode);
  return false;
}

function userCanAccessOperator(user, operatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  return user.operatorId === operatorId;
}

function machinesForUser(user) {
  return storage.listMachines().filter(m => userCanAccessMachine(user, m.deviceCode));
}

function operatorsForUser(user) {
  if (user.role === 'ag_admin') return storage.listOperators();
  return storage.listOperators().filter(o => o.id === user.operatorId);
}

function userCanInviteTo(user, targetOperatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  if (user.role === 'operator_admin' && user.operatorId === targetOperatorId) return true;
  return false;
}

function userCanReassignWithin(user, operatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  if (user.role === 'operator_admin' && user.operatorId === operatorId) return true;
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildConfigResponse(machine) {
  const HOUSE_EMAIL = 'hallo@snarlogsopi.is';
  const op = operators[machine.operatorId] || {};
  const p = machine.profile || {};
  // A per-machine supportEmail is treated as a real override only when it's set
  // and isn't the legacy house default; otherwise fall back to the assigned
  // operator's customer-contact email, then to the house address.
  const machineEmail = (p.supportEmail && p.supportEmail !== HOUSE_EMAIL) ? p.supportEmail : '';
  const supportEmail = machineEmail || (op.contactEmail || '').trim() || HOUSE_EMAIL;
  const supportPhone = (p.supportPhone || '') || (op.contactPhone || '').trim() || null;
  const operatorName = p.operatorName || op.name || 'AG Vending';
  const cfg = machine.settings || {};
  return {
    profile: {
      operatorName,
      supportEmail,
      supportPhone: supportPhone || null,
      machineLabel: p.machineLabel || null,
    },
    outOfService: !!cfg.outOfService,
    outOfServiceReason: cfg.outOfServiceReason || null,
    commands: {
      restartApp: cfg.restartAppAt || null,
      restartMachine: cfg.restartMachineAt || null,
    },
    gridOrder: Array.isArray(cfg.gridOrder) ? cfg.gridOrder : [],
    featured: (machine.featured || []).slice().sort((a,b) => a.order - b.order),
    ads: machine.ads || [],
    deals: storage.activeDealsForMachine(machine.deviceCode) || [],
    idle: storage.resolveIdleForMachine(machine.deviceCode) || { rotationSeconds: 6, attractTimeoutSeconds: 30, cards: [] },
    offers: storage.offersForMachine(machine.deviceCode) || [],
    stockSource: machine.stockSource || 'weimi',
    stock: storage.stockMapForMachine(machine.deviceCode),
    // goodsId → { url, hasBackground } for products whose images we host+normalized.
    // Absent goodsId = not migrated yet; kiosk keeps its existing image source for those.
    images: storage.imageMapForMachine(machine.deviceCode),
    hardware: { dropSensor: cfg.dropSensor === 'on' ? 'on' : 'off' },
    configVersion: machine.configVersion,
  };
}

function touchConfig(machine) {
  machine.configVersion = new Date().toISOString();
  machine.updatedAt = machine.configVersion;
  storage.upsertMachine(machine);
}

module.exports = {
  operators, machines, alerts: alertsProxy, orders: ordersProxy,
  users: usersProxy, authTokens, apiConfig,
  storage,
  provisionMachine, validateMachineKey, revokeKey,
  markKioskSeen, isKioskAlive,
  buildConfigResponse, touchConfig,
  userCanAccessMachine, userCanAccessOperator, machinesForUser, operatorsForUser,
  userCanInviteTo, userCanReassignWithin,
  invitations, createInvitation, getInvitation, consumeInvitation,
};
