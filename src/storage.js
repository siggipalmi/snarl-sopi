/**
 * SQLite-backed persistent storage.
 *
 * The database file lives at the path in DB_PATH (env), defaulting to
 * /data/snarl-sopi.db so it picks up the Railway volume mount.
 *
 * Falls back to /tmp/snarl-sopi.db if /data isn't writable (local dev).
 *
 * On first startup, the database is seeded from the in-memory defaults
 * in db.js so the dashboard works the same as before, but now changes
 * persist across restarts.
 */

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ─── Resolve database path ────────────────────────────────────────────────────

function resolveDbPath() {
  const wanted = process.env.DB_PATH || '/data/snarl-sopi.db';
  const dir    = path.dirname(wanted);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Try writing a sentinel to confirm the directory is writable
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return wanted;
  } catch (e) {
    console.warn(`[STORAGE] ${dir} not writable, falling back to /tmp`);
    return '/tmp/snarl-sopi.db';
  }
}

const DB_PATH = resolveDbPath();
console.log(`[STORAGE] Database: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');     // Better concurrency
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS operators (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    isAGVending   INTEGER NOT NULL DEFAULT 0,
    contactEmail  TEXT,
    contactPhone  TEXT,
    createdAt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS machines (
    deviceCode      TEXT PRIMARY KEY,
    deviceName      TEXT NOT NULL,
    location        TEXT,
    operatorId      TEXT NOT NULL REFERENCES operators(id),
    model           TEXT,
    isKioskModel    INTEGER NOT NULL DEFAULT 1,
    isOnline        INTEGER NOT NULL DEFAULT 0,
    isRunning       INTEGER NOT NULL DEFAULT 0,
    kioskVersion    TEXT,
    totalCurrStock  INTEGER NOT NULL DEFAULT 0,
    maxStock        INTEGER NOT NULL DEFAULT 0,
    unsupported     INTEGER NOT NULL DEFAULT 0,
    profileJson     TEXT NOT NULL DEFAULT '{}',
    featuredJson    TEXT NOT NULL DEFAULT '[]',
    adsJson         TEXT NOT NULL DEFAULT '[]',
    settingsJson    TEXT NOT NULL DEFAULT '{}',
    productsJson    TEXT NOT NULL DEFAULT '[]',
    productOverridesJson TEXT NOT NULL DEFAULT '{}',
    configVersion   TEXT NOT NULL,
    createdAt       TEXT NOT NULL,
    updatedAt       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    password        TEXT NOT NULL,
    role            TEXT NOT NULL,
    operatorId      TEXT NOT NULL REFERENCES operators(id),
    machineAccess   TEXT NOT NULL DEFAULT 'all',
    lastActiveAt    TEXT,
    createdAt       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invitations (
    token         TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    name          TEXT NOT NULL,
    role          TEXT NOT NULL,
    operatorId    TEXT NOT NULL REFERENCES operators(id),
    inviterId     TEXT NOT NULL,
    machineAccess TEXT NOT NULL DEFAULT 'all',
    createdAt     INTEGER NOT NULL,
    expiresAt     INTEGER NOT NULL,
    consumedAt    INTEGER
  );

  CREATE TABLE IF NOT EXISTS machine_keys (
    deviceCode  TEXT PRIMARY KEY REFERENCES machines(deviceCode),
    apiKey      TEXT NOT NULL,
    createdAt   TEXT NOT NULL,
    revokedAt   TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    tradeNo      TEXT PRIMARY KEY,
    deviceCode   TEXT NOT NULL,
    goodsId      TEXT,
    productName  TEXT,
    totalAmount  INTEGER NOT NULL DEFAULT 0,
    amountKr     INTEGER NOT NULL DEFAULT 0,
    status       INTEGER NOT NULL DEFAULT 1,
    statusLabel  TEXT,
    createTime   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_device ON orders(deviceCode);
  CREATE INDEX IF NOT EXISTS idx_orders_time   ON orders(createTime);

  CREATE TABLE IF NOT EXISTS alerts (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    severity    TEXT NOT NULL,
    title       TEXT NOT NULL,
    detail      TEXT,
    deviceCode  TEXT,
    resolved    INTEGER NOT NULL DEFAULT 0,
    resolvedAt  TEXT,
    createdAt   TEXT NOT NULL
  );
`);

// ─── Statements (prepared once for speed) ─────────────────────────────────────

const stmts = {
  // Operators
  getOperator:    db.prepare('SELECT * FROM operators WHERE id = ?'),
  listOperators:  db.prepare('SELECT * FROM operators'),
  upsertOperator: db.prepare(`INSERT INTO operators (id, name, isAGVending, contactEmail, contactPhone, createdAt)
                              VALUES (@id, @name, @isAGVending, @contactEmail, @contactPhone, @createdAt)
                              ON CONFLICT(id) DO UPDATE SET
                                name=excluded.name, isAGVending=excluded.isAGVending,
                                contactEmail=excluded.contactEmail, contactPhone=excluded.contactPhone`),
  deleteOperator: db.prepare('DELETE FROM operators WHERE id = ?'),

  // Machines
  getMachine:     db.prepare('SELECT * FROM machines WHERE deviceCode = ?'),
  listMachines:   db.prepare('SELECT * FROM machines'),
  upsertMachine:  db.prepare(`INSERT INTO machines
    (deviceCode, deviceName, location, operatorId, model, isKioskModel, isOnline, isRunning, kioskVersion,
     totalCurrStock, maxStock, unsupported, profileJson, featuredJson, adsJson, settingsJson,
     productsJson, productOverridesJson, configVersion, createdAt, updatedAt)
    VALUES (@deviceCode, @deviceName, @location, @operatorId, @model, @isKioskModel, @isOnline, @isRunning, @kioskVersion,
            @totalCurrStock, @maxStock, @unsupported, @profileJson, @featuredJson, @adsJson, @settingsJson,
            @productsJson, @productOverridesJson, @configVersion, @createdAt, @updatedAt)
    ON CONFLICT(deviceCode) DO UPDATE SET
      deviceName=excluded.deviceName, location=excluded.location, operatorId=excluded.operatorId,
      model=excluded.model, isKioskModel=excluded.isKioskModel, isOnline=excluded.isOnline,
      isRunning=excluded.isRunning, kioskVersion=excluded.kioskVersion,
      totalCurrStock=excluded.totalCurrStock, maxStock=excluded.maxStock, unsupported=excluded.unsupported,
      profileJson=excluded.profileJson, featuredJson=excluded.featuredJson, adsJson=excluded.adsJson,
      settingsJson=excluded.settingsJson, productsJson=excluded.productsJson,
      productOverridesJson=excluded.productOverridesJson, configVersion=excluded.configVersion,
      updatedAt=excluded.updatedAt`),
  updateMachineConfigVersion: db.prepare('UPDATE machines SET configVersion = ?, updatedAt = ? WHERE deviceCode = ?'),
  updateMachineField: (col) => db.prepare(`UPDATE machines SET ${col} = ?, updatedAt = ? WHERE deviceCode = ?`),

  // Users
  getUser:           db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail:    db.prepare('SELECT * FROM users WHERE email = ?'),
  listUsers:         db.prepare('SELECT * FROM users'),
  listUsersByOp:     db.prepare('SELECT * FROM users WHERE operatorId = ?'),
  insertUser:        db.prepare(`INSERT INTO users (id, name, email, password, role, operatorId, machineAccess, lastActiveAt, createdAt)
                                 VALUES (@id, @name, @email, @password, @role, @operatorId, @machineAccess, @lastActiveAt, @createdAt)`),
  updateLastActive:  db.prepare('UPDATE users SET lastActiveAt = ? WHERE id = ?'),
  updateUserPassword:db.prepare('UPDATE users SET password = ? WHERE id = ?'),

  // Invitations
  getInvitation:     db.prepare('SELECT * FROM invitations WHERE token = ?'),
  listInvitations:   db.prepare('SELECT * FROM invitations WHERE consumedAt IS NULL AND expiresAt > ?'),
  listInvitesByOp:   db.prepare('SELECT * FROM invitations WHERE consumedAt IS NULL AND expiresAt > ? AND operatorId = ?'),
  listInvitesByEmail:db.prepare('SELECT * FROM invitations WHERE email = ? AND consumedAt IS NULL AND expiresAt > ?'),
  insertInvitation:  db.prepare(`INSERT INTO invitations (token, email, name, role, operatorId, inviterId, machineAccess, createdAt, expiresAt, consumedAt)
                                 VALUES (@token, @email, @name, @role, @operatorId, @inviterId, @machineAccess, @createdAt, @expiresAt, @consumedAt)`),
  consumeInvitation: db.prepare('UPDATE invitations SET consumedAt = ? WHERE token = ?'),
  deleteInvitation:  db.prepare('DELETE FROM invitations WHERE token = ?'),
  cleanupExpired:    db.prepare('DELETE FROM invitations WHERE expiresAt < ?'),

  // Machine keys
  getMachineKey:     db.prepare('SELECT * FROM machine_keys WHERE deviceCode = ?'),
  insertMachineKey:  db.prepare(`INSERT INTO machine_keys (deviceCode, apiKey, createdAt, revokedAt)
                                 VALUES (?, ?, ?, NULL)
                                 ON CONFLICT(deviceCode) DO UPDATE SET apiKey=excluded.apiKey, createdAt=excluded.createdAt, revokedAt=NULL`),
  revokeMachineKey:  db.prepare('UPDATE machine_keys SET revokedAt = ? WHERE deviceCode = ?'),

  // Orders
  insertOrder:       db.prepare(`INSERT INTO orders (tradeNo, deviceCode, goodsId, productName, totalAmount, amountKr, status, statusLabel, createTime)
                                 VALUES (@tradeNo, @deviceCode, @goodsId, @productName, @totalAmount, @amountKr, @status, @statusLabel, @createTime)`),
  getOrder:          db.prepare('SELECT * FROM orders WHERE tradeNo = ?'),
  listOrdersToday:   db.prepare('SELECT * FROM orders WHERE createTime >= ? AND status = 1'),
  listOrdersScoped:  db.prepare('SELECT * FROM orders WHERE deviceCode IN (SELECT value FROM json_each(?)) ORDER BY createTime DESC LIMIT ? OFFSET ?'),
  countOrdersScoped: db.prepare('SELECT COUNT(*) AS c FROM orders WHERE deviceCode IN (SELECT value FROM json_each(?))'),

  // Alerts
  insertAlert:       db.prepare(`INSERT OR REPLACE INTO alerts (id, type, severity, title, detail, deviceCode, resolved, resolvedAt, createdAt)
                                 VALUES (@id, @type, @severity, @title, @detail, @deviceCode, @resolved, @resolvedAt, @createdAt)`),
  listAlerts:        db.prepare('SELECT * FROM alerts'),
  getAlert:          db.prepare('SELECT * FROM alerts WHERE id = ?'),
  resolveAlert:      db.prepare('UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE id = ?'),

  // Meta
  getMeta:           db.prepare('SELECT value FROM schema_meta WHERE key = ?'),
  setMeta:           db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)'),
};

// ─── Helper to deserialise machine rows ───────────────────────────────────────

function rowToMachine(row) {
  if (!row) return null;
  return {
    deviceCode:      row.deviceCode,
    deviceName:      row.deviceName,
    location:        row.location || '',
    operatorId:      row.operatorId,
    model:           row.model,
    isKioskModel:    !!row.isKioskModel,
    isOnline:        !!row.isOnline,
    isRunning:       !!row.isRunning,
    kioskVersion:    row.kioskVersion,
    totalCurrStock:  row.totalCurrStock,
    maxStock:        row.maxStock,
    unsupported:     !!row.unsupported,
    profile:         JSON.parse(row.profileJson || '{}'),
    featured:        JSON.parse(row.featuredJson || '[]'),
    ads:             JSON.parse(row.adsJson || '[]'),
    settings:        JSON.parse(row.settingsJson || '{}'),
    products:        JSON.parse(row.productsJson || '[]'),
    productOverrides:JSON.parse(row.productOverridesJson || '{}'),
    configVersion:   row.configVersion,
    createdAt:       row.createdAt,
    updatedAt:       row.updatedAt,
  };
}

function machineToRow(m) {
  return {
    deviceCode:      m.deviceCode,
    deviceName:      m.deviceName,
    location:        m.location || '',
    operatorId:      m.operatorId,
    model:           m.model || 'VM-WM55DL',
    isKioskModel:    m.isKioskModel ? 1 : 0,
    isOnline:        m.isOnline ? 1 : 0,
    isRunning:       m.isRunning ? 1 : 0,
    kioskVersion:    m.kioskVersion || null,
    totalCurrStock:  m.totalCurrStock || 0,
    maxStock:        m.maxStock || 0,
    unsupported:     m.unsupported ? 1 : 0,
    profileJson:     JSON.stringify(m.profile || {}),
    featuredJson:    JSON.stringify(m.featured || []),
    adsJson:         JSON.stringify(m.ads || []),
    settingsJson:    JSON.stringify(m.settings || {}),
    productsJson:    JSON.stringify(m.products || []),
    productOverridesJson: JSON.stringify(m.productOverrides || {}),
    configVersion:   m.configVersion || new Date().toISOString(),
    createdAt:       m.createdAt || new Date().toISOString(),
    updatedAt:       m.updatedAt || new Date().toISOString(),
  };
}

function rowToOperator(row) {
  if (!row) return null;
  return {
    id:           row.id,
    name:         row.name,
    isAGVending:  !!row.isAGVending,
    contactEmail: row.contactEmail || '',
    contactPhone: row.contactPhone || '',
    createdAt:    row.createdAt,
  };
}

function rowToInvitation(row) {
  if (!row) return null;
  return {
    token:         row.token,
    email:         row.email,
    name:          row.name,
    role:          row.role,
    operatorId:    row.operatorId,
    inviterId:     row.inviterId,
    machineAccess: row.machineAccess,
    createdAt:     row.createdAt,
    expiresAt:     row.expiresAt,
    consumedAt:    row.consumedAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const storage = {
  // Operators
  getOperator(id)      { return rowToOperator(stmts.getOperator.get(id)); },
  listOperators()      { return stmts.listOperators.all().map(rowToOperator); },
  upsertOperator(op) {
    stmts.upsertOperator.run({
      id: op.id, name: op.name,
      isAGVending: op.isAGVending ? 1 : 0,
      contactEmail: op.contactEmail || '',
      contactPhone: op.contactPhone || '',
      createdAt: op.createdAt || new Date().toISOString(),
    });
  },

  // Machines
  getMachine(code)     { return rowToMachine(stmts.getMachine.get(code)); },
  listMachines()       { return stmts.listMachines.all().map(rowToMachine); },
  upsertMachine(m)     { stmts.upsertMachine.run(machineToRow(m)); },

  // Users
  getUser(id)              { return stmts.getUser.get(id); },
  getUserByEmail(email)    { return stmts.getUserByEmail.get(email); },
  listUsers()              { return stmts.listUsers.all(); },
  listUsersByOperator(id)  { return stmts.listUsersByOp.all(id); },
  insertUser(user)         { stmts.insertUser.run(user); },
  updateLastActive(id)     { stmts.updateLastActive.run(new Date().toISOString(), id); },
  updateUserPassword(id, p){ stmts.updateUserPassword.run(p, id); },

  // Invitations
  getInvitation(token) {
    const row = stmts.getInvitation.get(token);
    return rowToInvitation(row);
  },
  listActiveInvitations() {
    return stmts.listInvitations.all(Date.now()).map(rowToInvitation);
  },
  listActiveInvitationsByOperator(operatorId) {
    return stmts.listInvitesByOp.all(Date.now(), operatorId).map(rowToInvitation);
  },
  hasPendingInvitation(email) {
    const rows = stmts.listInvitesByEmail.all(email, Date.now());
    return rows.length > 0;
  },
  insertInvitation(inv) {
    stmts.insertInvitation.run({
      token: inv.token, email: inv.email, name: inv.name,
      role: inv.role, operatorId: inv.operatorId, inviterId: inv.inviterId,
      machineAccess: inv.machineAccess || 'all',
      createdAt: inv.createdAt, expiresAt: inv.expiresAt,
      consumedAt: inv.consumedAt,
    });
  },
  consumeInvitation(token) { stmts.consumeInvitation.run(Date.now(), token); },
  deleteInvitation(token)  { stmts.deleteInvitation.run(token); },
  cleanupExpiredInvitations() { stmts.cleanupExpired.run(Date.now() - 30*24*3600*1000); },

  // Machine keys
  getMachineKey(deviceCode) { return stmts.getMachineKey.get(deviceCode); },
  insertMachineKey(deviceCode, key) {
    stmts.insertMachineKey.run(deviceCode, key, new Date().toISOString());
  },
  revokeMachineKey(deviceCode) {
    stmts.revokeMachineKey.run(new Date().toISOString(), deviceCode);
  },

  // Orders
  insertOrder(o) {
    stmts.insertOrder.run({
      tradeNo: o.tradeNo, deviceCode: o.deviceCode,
      goodsId: o.goodsId || null, productName: o.productName || '',
      totalAmount: o.totalAmount || 0, amountKr: o.amountKr || 0,
      status: o.status, statusLabel: o.statusLabel || null,
      createTime: o.createTime,
    });
  },
  getOrder(tradeNo)  { return stmts.getOrder.get(tradeNo); },
  listOrdersToday(sinceUTC) { return stmts.listOrdersToday.all(sinceUTC); },
  listOrdersScoped(deviceCodes, limit, offset) {
    return stmts.listOrdersScoped.all(JSON.stringify(deviceCodes), limit, offset);
  },
  countOrdersScoped(deviceCodes) {
    return stmts.countOrdersScoped.get(JSON.stringify(deviceCodes)).c;
  },

  // Alerts
  insertAlert(a) {
    stmts.insertAlert.run({
      id: a.id, type: a.type, severity: a.severity, title: a.title,
      detail: a.detail || '', deviceCode: a.deviceCode || null,
      resolved: a.resolved ? 1 : 0, resolvedAt: a.resolvedAt || null,
      createdAt: a.createdAt,
    });
  },
  listAlerts()       { return stmts.listAlerts.all().map(r => ({ ...r, resolved: !!r.resolved })); },
  getAlert(id)       { const r = stmts.getAlert.get(id); return r ? { ...r, resolved: !!r.resolved } : null; },
  resolveAlert(id)   { stmts.resolveAlert.run(new Date().toISOString(), id); },

  // Meta
  getMeta(key)         { return stmts.getMeta.get(key)?.value; },
  setMeta(key, value)  { stmts.setMeta.run(key, String(value)); },

  // Raw access for migration
  db,
};

// Set schema version
storage.setMeta('schema_version', SCHEMA_VERSION);

console.log('[STORAGE] Schema ready');

module.exports = storage;
