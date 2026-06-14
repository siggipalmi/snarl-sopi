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
    nayaxMachineId  TEXT,
    nayaxLastSyncAt TEXT,
    nayaxDataJson   TEXT,
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

  -- One row per line item in an order (detailVOList). A single gravity-fridge
  -- purchase is often several items, so the profit/VSK report works off these,
  -- not the order total. payAmount is the per-line amount in cents.
  CREATE TABLE IF NOT EXISTS order_items (
    tradeNo       TEXT NOT NULL,
    lineIndex     INTEGER NOT NULL,
    deviceCode    TEXT NOT NULL,
    goodsId       TEXT,
    productName   TEXT,
    payAmount     INTEGER NOT NULL DEFAULT 0,   -- per-line amount, cents
    shipmentStatus INTEGER NOT NULL DEFAULT 0,  -- 1 = delivered
    createTime    INTEGER NOT NULL,
    PRIMARY KEY (tradeNo, lineIndex)
  );
  CREATE INDEX IF NOT EXISTS idx_oitems_time   ON order_items(createTime);
  CREATE INDEX IF NOT EXISTS idx_oitems_device ON order_items(deviceCode);
  CREATE INDEX IF NOT EXISTS idx_oitems_goods  ON order_items(goodsId);

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

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token       TEXT PRIMARY KEY,
    userId      TEXT NOT NULL,
    createdAt   INTEGER NOT NULL,
    expiresAt   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user    ON auth_tokens(userId);
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens(expiresAt);

  CREATE TABLE IF NOT EXISTS stock_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceCode   TEXT NOT NULL,
    goodsId      TEXT NOT NULL,
    productName  TEXT,
    stock        INTEGER NOT NULL,
    recordedAt   INTEGER NOT NULL,
    source       TEXT NOT NULL DEFAULT 'unknown'
  );
  CREATE INDEX IF NOT EXISTS idx_stock_hist_device   ON stock_history(deviceCode, goodsId);
  CREATE INDEX IF NOT EXISTS idx_stock_hist_recorded ON stock_history(recordedAt);

  CREATE TABLE IF NOT EXISTS sold_out_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceCode     TEXT NOT NULL,
    goodsId        TEXT NOT NULL,
    productName    TEXT,
    soldOutAt      INTEGER NOT NULL,
    restockedAt    INTEGER,
    durationHours  REAL
  );
  CREATE INDEX IF NOT EXISTS idx_soldout_device    ON sold_out_events(deviceCode);
  CREATE INDEX IF NOT EXISTS idx_soldout_soldoutat ON sold_out_events(soldOutAt);

  -- Fast lookup of current stock per (machine, product), updated on every sale and sync
  CREATE TABLE IF NOT EXISTS slot_stock (
    deviceCode    TEXT NOT NULL,
    goodsId       TEXT NOT NULL,
    productName   TEXT,
    stock         INTEGER NOT NULL,
    updatedAt     INTEGER NOT NULL,
    PRIMARY KEY (deviceCode, goodsId)
  );
  CREATE INDEX IF NOT EXISTS idx_slot_stock_device ON slot_stock(deviceCode);

  CREATE TABLE IF NOT EXISTS complaints (
    id              TEXT PRIMARY KEY,
    tradeNo         TEXT NOT NULL,
    deviceCode      TEXT NOT NULL,
    operatorId      TEXT NOT NULL,
    customerEmail   TEXT NOT NULL,
    note            TEXT,
    itemsJson       TEXT NOT NULL,
    totalIsk        INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'open',
    refundedAt      TEXT,
    refundedAmount  INTEGER,
    refundedBy      TEXT,
    repliedAt       TEXT,
    repliedBy       TEXT,
    replyText       TEXT,
    kioskAppVersion TEXT,
    kioskOsLocale   TEXT,
    timestampMs     INTEGER NOT NULL,
    createdAt       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_complaints_device   ON complaints(deviceCode);
  CREATE INDEX IF NOT EXISTS idx_complaints_operator ON complaints(operatorId);
  CREATE INDEX IF NOT EXISTS idx_complaints_status   ON complaints(status);
  CREATE INDEX IF NOT EXISTS idx_complaints_created  ON complaints(createdAt);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_complaints_trade ON complaints(tradeNo);

  -- Our own product attributes (weight, VSK rate, cost) that Weimi's catalog API
  -- does not store. Keyed by Weimi's internal goodsId (matches orders.goodsId).
  CREATE TABLE IF NOT EXISTS products (
    goodsId       TEXT PRIMARY KEY,
    customCode    TEXT,
    name          TEXT,
    salePriceIsk  INTEGER,          -- gross sale price (kr, VSK included)
    vatRate       INTEGER,          -- VSK rate: 11 or 24
    costPriceIsk  INTEGER,          -- gross cost price (kr, VSK included), nullable
    weightGrams   INTEGER,          -- unit weight for gravity scales, nullable
    measurement   INTEGER DEFAULT 0,-- 0 = item, 1 = weight
    barcode       TEXT,
    imgUrl        TEXT,
    createdAt     INTEGER,
    updatedAt     INTEGER
  );

  -- Dated batches per slot for short-life products. A slot can hold several
  -- batches with different best-before dates. Operator-maintained in v1.
  CREATE TABLE IF NOT EXISTS product_batches (
    id          TEXT PRIMARY KEY,
    deviceCode  TEXT NOT NULL,
    goodsId     TEXT NOT NULL,
    expiryDate  TEXT NOT NULL,            -- 'YYYY-MM-DD'
    quantity    INTEGER NOT NULL DEFAULT 0,
    addedAt     INTEGER NOT NULL,
    addedBy     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_batches_slot   ON product_batches(deviceCode, goodsId);
  CREATE INDEX IF NOT EXISTS idx_batches_expiry ON product_batches(expiryDate);

  -- Remote command queue (contract v0.5). Backend stores intent; the kiosk
  -- polls, runs it on the motor board, and posts the result back.
  CREATE TABLE IF NOT EXISTS machine_commands (
    id          TEXT PRIMARY KEY,
    deviceCode  TEXT NOT NULL,
    type        TEXT NOT NULL,
    params      TEXT,                              -- JSON
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending|done|failed|unsupported|expired
    issuedBy    TEXT,
    issuedAt    INTEGER NOT NULL,
    result      TEXT,                              -- JSON
    completedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_cmd_device_status ON machine_commands(deviceCode, status);
  CREATE INDEX IF NOT EXISTS idx_cmd_issuedat      ON machine_commands(issuedAt);
`);

// ─── Lightweight migrations ───────────────────────────────────────────────────
// SQLite tolerates re-adding columns badly, so we check pragma first.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[STORAGE] Migrated: added ${table}.${column}`);
  }
}
ensureColumn('machines', 'nayaxMachineId',  'TEXT');
ensureColumn('machines', 'nayaxLastSyncAt', 'TEXT');
ensureColumn('machines', 'nayaxDataJson',   'TEXT');
// products are keyed by the device-facing product code (goodsCode); we also keep
// Weimi's internal record id and any of the other ids so the catalog can match a
// placed slot to its product no matter which identifier the layout carries.
ensureColumn('products', 'weimiId',   'TEXT');
ensureColumn('products', 'goodsCode', 'TEXT');
// Consumer-facing product detail (shown on the kiosk product screen). Filled via
// the "product details" import; nutrition is a JSON blob of per-100g/ml values.
ensureColumn('products', 'packSize',       'TEXT');
ensureColumn('products', 'ingredients',    'TEXT');
ensureColumn('products', 'allergens',      'TEXT');
ensureColumn('products', 'mayContain',     'TEXT');
ensureColumn('products', 'detailNotes',    'TEXT');
ensureColumn('products', 'nutritionBasis', 'TEXT');
ensureColumn('products', 'nutrition',      'TEXT');
// Short-life products opt in to expiry tracking (dated batches + markdown).
ensureColumn('products', 'perishable',     'INTEGER');   // 1 = track expiry
// Operator profile: postal address, customer-facing logo (R2 URL).
ensureColumn('operators', 'address', 'TEXT');
ensureColumn('operators', 'logoUrl', 'TEXT');
ensureColumn('operators', 'suspended', 'INTEGER');
// Billing link: an operator maps to a Payday customer by kennitala (the human
// match key) and customer id (the UUID the Payday API actually queries with).
ensureColumn('operators', 'kennitala',        'TEXT');
ensureColumn('operators', 'paydayCustomerId', 'TEXT');

// ─── Statements (prepared once for speed) ─────────────────────────────────────

const stmts = {
  // Operators
  getOperator:    db.prepare('SELECT * FROM operators WHERE id = ?'),
  listOperators:  db.prepare('SELECT * FROM operators'),
  upsertOperator: db.prepare(`INSERT INTO operators (id, name, isAGVending, contactEmail, contactPhone, address, logoUrl, createdAt)
                              VALUES (@id, @name, @isAGVending, @contactEmail, @contactPhone, @address, @logoUrl, @createdAt)
                              ON CONFLICT(id) DO UPDATE SET
                                name=excluded.name, isAGVending=excluded.isAGVending,
                                contactEmail=excluded.contactEmail, contactPhone=excluded.contactPhone,
                                address=excluded.address, logoUrl=excluded.logoUrl`),
  deleteOperator: db.prepare('DELETE FROM operators WHERE id = ?'),

  // Machines
  getMachine:     db.prepare('SELECT * FROM machines WHERE deviceCode = ?'),
  listMachines:   db.prepare('SELECT * FROM machines'),
  upsertMachine:  db.prepare(`INSERT INTO machines
    (deviceCode, deviceName, location, operatorId, model, isKioskModel, isOnline, isRunning, kioskVersion,
     totalCurrStock, maxStock, unsupported, nayaxMachineId, nayaxLastSyncAt, nayaxDataJson,
     profileJson, featuredJson, adsJson, settingsJson,
     productsJson, productOverridesJson, configVersion, createdAt, updatedAt)
    VALUES (@deviceCode, @deviceName, @location, @operatorId, @model, @isKioskModel, @isOnline, @isRunning, @kioskVersion,
            @totalCurrStock, @maxStock, @unsupported, @nayaxMachineId, @nayaxLastSyncAt, @nayaxDataJson,
            @profileJson, @featuredJson, @adsJson, @settingsJson,
            @productsJson, @productOverridesJson, @configVersion, @createdAt, @updatedAt)
    ON CONFLICT(deviceCode) DO UPDATE SET
      deviceName=excluded.deviceName, location=excluded.location, operatorId=excluded.operatorId,
      model=excluded.model, isKioskModel=excluded.isKioskModel, isOnline=excluded.isOnline,
      isRunning=excluded.isRunning, kioskVersion=excluded.kioskVersion,
      totalCurrStock=excluded.totalCurrStock, maxStock=excluded.maxStock, unsupported=excluded.unsupported,
      nayaxMachineId=excluded.nayaxMachineId, nayaxLastSyncAt=excluded.nayaxLastSyncAt, nayaxDataJson=excluded.nayaxDataJson,
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
  updateUser:        db.prepare('UPDATE users SET name=@name, role=@role, operatorId=@operatorId, machineAccess=@machineAccess WHERE id=@id'),

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
  listOrdersToday:   db.prepare('SELECT * FROM orders WHERE createTime >= ? AND createTime < ? AND status = 1'),
  listOrdersScoped:  db.prepare('SELECT * FROM orders WHERE deviceCode IN (SELECT value FROM json_each(?)) ORDER BY createTime DESC LIMIT ? OFFSET ?'),
  countOrdersScoped: db.prepare('SELECT COUNT(*) AS c FROM orders WHERE deviceCode IN (SELECT value FROM json_each(?))'),

  // Order line items (one per detailVOList entry)
  upsertOrderItem: db.prepare(`INSERT INTO order_items
      (tradeNo, lineIndex, deviceCode, goodsId, productName, payAmount, shipmentStatus, createTime)
      VALUES (@tradeNo, @lineIndex, @deviceCode, @goodsId, @productName, @payAmount, @shipmentStatus, @createTime)
      ON CONFLICT(tradeNo, lineIndex) DO UPDATE SET
        goodsId=excluded.goodsId, productName=excluded.productName,
        payAmount=excluded.payAmount, shipmentStatus=excluded.shipmentStatus`),
  // Report rows: delivered line items in a window, joined to our product attrs.
  reportItems: db.prepare(`
    SELECT oi.tradeNo, oi.deviceCode, oi.goodsId, oi.payAmount, oi.createTime,
           COALESCE(p.name, oi.productName) AS name,
           p.vatRate AS vatRate, p.costPriceIsk AS costPriceIsk
    FROM order_items oi
    LEFT JOIN products p ON p.goodsId = oi.goodsId
    WHERE oi.createTime >= ? AND oi.createTime < ?
      AND oi.shipmentStatus = 1
      AND oi.deviceCode IN (SELECT value FROM json_each(?))`),
  countOrderItems: db.prepare('SELECT COUNT(*) AS c FROM order_items'),
  // Lines the customer paid for but the machine did not dispense (shipmentStatus != 1).
  dispenseIssues: db.prepare(`
    SELECT oi.tradeNo, oi.deviceCode, oi.goodsId, oi.payAmount, oi.shipmentStatus, oi.createTime,
           COALESCE(p.name, oi.productName) AS name
    FROM order_items oi
    LEFT JOIN products p ON p.goodsId = oi.goodsId
    WHERE oi.createTime >= ? AND oi.createTime < ?
      AND oi.shipmentStatus != 1
      AND oi.payAmount > 0
      AND oi.deviceCode IN (SELECT value FROM json_each(?))
    ORDER BY oi.createTime DESC`),
  shipmentStatusBreakdown: db.prepare(`
    SELECT shipmentStatus, COUNT(*) AS c FROM order_items GROUP BY shipmentStatus`),

  // Products (our own attributes — weight, VSK, cost)
  upsertProduct: db.prepare(`INSERT INTO products
      (goodsId, weimiId, goodsCode, customCode, name, salePriceIsk, vatRate, costPriceIsk, weightGrams, measurement, barcode, imgUrl, createdAt, updatedAt)
      VALUES (@goodsId, @weimiId, @goodsCode, @customCode, @name, @salePriceIsk, @vatRate, @costPriceIsk, @weightGrams, @measurement, @barcode, @imgUrl, @createdAt, @updatedAt)
      ON CONFLICT(goodsId) DO UPDATE SET
        weimiId=COALESCE(excluded.weimiId, products.weimiId),
        goodsCode=COALESCE(excluded.goodsCode, products.goodsCode),
        customCode=excluded.customCode, name=excluded.name, salePriceIsk=excluded.salePriceIsk,
        vatRate=excluded.vatRate, costPriceIsk=excluded.costPriceIsk, weightGrams=excluded.weightGrams,
        measurement=excluded.measurement, barcode=excluded.barcode, imgUrl=excluded.imgUrl, updatedAt=excluded.updatedAt`),
  getProduct:   db.prepare('SELECT * FROM products WHERE goodsId = ?'),
  listProducts: db.prepare('SELECT * FROM products ORDER BY updatedAt DESC'),
  setProductDetails: db.prepare(`UPDATE products SET
      packSize=@packSize, ingredients=@ingredients, allergens=@allergens,
      mayContain=@mayContain, detailNotes=@detailNotes, nutritionBasis=@nutritionBasis,
      nutrition=@nutrition, updatedAt=@updatedAt
    WHERE goodsId=@goodsId`),

  // Alerts
  insertAlert:       db.prepare(`INSERT OR REPLACE INTO alerts (id, type, severity, title, detail, deviceCode, resolved, resolvedAt, createdAt)
                                 VALUES (@id, @type, @severity, @title, @detail, @deviceCode, @resolved, @resolvedAt, @createdAt)`),
  listAlerts:        db.prepare('SELECT * FROM alerts'),
  getAlert:          db.prepare('SELECT * FROM alerts WHERE id = ?'),
  resolveAlert:      db.prepare('UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE id = ?'),

  // Auth tokens (persistent across restarts so sessions survive redeploys)
  insertAuthToken:   db.prepare('INSERT INTO auth_tokens (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)'),
  getAuthToken:      db.prepare('SELECT * FROM auth_tokens WHERE token = ?'),
  deleteAuthToken:   db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  deleteUserTokens:  db.prepare('DELETE FROM auth_tokens WHERE userId = ?'),
  cleanupExpiredAuthTokens: db.prepare('DELETE FROM auth_tokens WHERE expiresAt < ?'),

  // Stock history (append-only)
  insertStockHistory: db.prepare(`INSERT INTO stock_history (deviceCode, goodsId, productName, stock, recordedAt, source)
                                  VALUES (@deviceCode, @goodsId, @productName, @stock, @recordedAt, @source)`),
  getRecentStockHistory: db.prepare(`SELECT * FROM stock_history WHERE deviceCode = ? AND goodsId = ?
                                     ORDER BY recordedAt DESC LIMIT ?`),
  cleanupOldStockHistory: db.prepare('DELETE FROM stock_history WHERE recordedAt < ?'),
  // Most recent time any product's stock INCREASED between authoritative syncs
  // (a restock = a manual visit; sales only ever decrease, so increases are refills).
  lastRestockAt: db.prepare(`
    SELECT MAX(recordedAt) AS lastRestock FROM (
      SELECT recordedAt,
             stock - LAG(stock) OVER (PARTITION BY goodsId ORDER BY recordedAt, rowid) AS delta
      FROM stock_history
      WHERE deviceCode = ? AND source = 'weimi_sync'
    ) WHERE delta > 0`),

  // Slot stock (current state, fast lookup)
  upsertSlotStock: db.prepare(`INSERT INTO slot_stock (deviceCode, goodsId, productName, stock, updatedAt)
                               VALUES (@deviceCode, @goodsId, @productName, @stock, @updatedAt)
                               ON CONFLICT(deviceCode, goodsId) DO UPDATE SET
                                 productName = excluded.productName,
                                 stock = excluded.stock,
                                 updatedAt = excluded.updatedAt`),
  getSlotStock: db.prepare('SELECT * FROM slot_stock WHERE deviceCode = ? AND goodsId = ?'),
  listSlotStockForDevice: db.prepare('SELECT * FROM slot_stock WHERE deviceCode = ? ORDER BY stock ASC, productName'),
  listEmptySlotsForDevice: db.prepare(`SELECT * FROM slot_stock WHERE deviceCode = ? AND stock <= 0 ORDER BY updatedAt DESC`),
  listAllEmptySlots: db.prepare(`SELECT * FROM slot_stock WHERE stock <= 0 ORDER BY updatedAt DESC`),

  // Sold-out events
  openSoldOutEvent: db.prepare(`INSERT INTO sold_out_events (deviceCode, goodsId, productName, soldOutAt, restockedAt, durationHours)
                                VALUES (?, ?, ?, ?, NULL, NULL)`),
  getOpenSoldOutEvent: db.prepare(`SELECT * FROM sold_out_events WHERE deviceCode = ? AND goodsId = ? AND restockedAt IS NULL
                                   ORDER BY soldOutAt DESC LIMIT 1`),
  closeSoldOutEvent: db.prepare(`UPDATE sold_out_events SET restockedAt = ?, durationHours = ? WHERE id = ?`),
  listSoldOutEventsScoped: db.prepare(`SELECT * FROM sold_out_events
                                       WHERE deviceCode IN (SELECT value FROM json_each(?))
                                         AND soldOutAt >= ?
                                       ORDER BY soldOutAt DESC LIMIT ?`),
  listOpenSoldOutScoped: db.prepare(`SELECT * FROM sold_out_events
                                     WHERE deviceCode IN (SELECT value FROM json_each(?))
                                       AND restockedAt IS NULL
                                     ORDER BY soldOutAt ASC`),

  // Sales aggregation
  listOrdersInRange: db.prepare(`SELECT * FROM orders
                                 WHERE deviceCode IN (SELECT value FROM json_each(?))
                                   AND createTime >= ? AND createTime < ?
                                   AND status = 1
                                 ORDER BY createTime ASC`),
  listAllOrdersInRange: db.prepare(`SELECT * FROM orders
                                    WHERE createTime >= ? AND createTime < ? AND status = 1
                                    ORDER BY createTime ASC`),
  debugOrdersByDevice:   db.prepare('SELECT tradeNo, status, statusLabel, totalAmount, amountKr, createTime FROM orders WHERE deviceCode = ? ORDER BY createTime DESC LIMIT ?'),
  debugOrderStatusCounts: db.prepare('SELECT status, statusLabel, COUNT(*) n, MIN(createTime) minT, MAX(createTime) maxT, SUM(amountKr) sumKr, SUM(totalAmount) sumTotal FROM orders WHERE deviceCode = ? GROUP BY status, statusLabel'),

  // Complaints
  insertComplaint:   db.prepare(`INSERT INTO complaints
    (id, tradeNo, deviceCode, operatorId, customerEmail, note, itemsJson, totalIsk, status,
     kioskAppVersion, kioskOsLocale, timestampMs, createdAt)
    VALUES (@id, @tradeNo, @deviceCode, @operatorId, @customerEmail, @note, @itemsJson, @totalIsk, @status,
            @kioskAppVersion, @kioskOsLocale, @timestampMs, @createdAt)`),
  getComplaint:      db.prepare('SELECT * FROM complaints WHERE id = ?'),
  getComplaintByTradeNo: db.prepare('SELECT * FROM complaints WHERE tradeNo = ?'),
  listComplaints:    db.prepare('SELECT * FROM complaints ORDER BY createdAt DESC'),
  listComplaintsByOp:db.prepare('SELECT * FROM complaints WHERE operatorId = ? ORDER BY createdAt DESC'),
  countComplaintsForMachineSince: db.prepare('SELECT COUNT(*) AS c FROM complaints WHERE deviceCode = ? AND timestampMs >= ?'),
  markComplaintRefunded: db.prepare('UPDATE complaints SET status = ?, refundedAt = ?, refundedAmount = ?, refundedBy = ? WHERE id = ?'),
  markComplaintReplied:  db.prepare('UPDATE complaints SET repliedAt = ?, repliedBy = ?, replyText = ? WHERE id = ?'),
  markComplaintStatus:   db.prepare('UPDATE complaints SET status = ? WHERE id = ?'),

  // Meta
  getMeta:           db.prepare('SELECT value FROM schema_meta WHERE key = ?'),
  setMeta:           db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)'),

  // Expiry batches
  listBatchesForSlot:   db.prepare('SELECT * FROM product_batches WHERE deviceCode = ? AND goodsId = ? ORDER BY expiryDate ASC'),
  listAllBatches:       db.prepare('SELECT * FROM product_batches ORDER BY expiryDate ASC'),
  deleteBatchesForSlot: db.prepare('DELETE FROM product_batches WHERE deviceCode = ? AND goodsId = ?'),
  insertBatch:          db.prepare(`INSERT INTO product_batches (id, deviceCode, goodsId, expiryDate, quantity, addedAt, addedBy)
                                     VALUES (@id, @deviceCode, @goodsId, @expiryDate, @quantity, @addedAt, @addedBy)`),
  setPerishable:        db.prepare('UPDATE products SET perishable = ?, updatedAt = ? WHERE goodsId = ?'),

  // Remote command queue
  insertCommand:        db.prepare(`INSERT INTO machine_commands (id, deviceCode, type, params, status, issuedBy, issuedAt)
                                     VALUES (@id, @deviceCode, @type, @params, 'pending', @issuedBy, @issuedAt)`),
  listPendingCommands:  db.prepare("SELECT * FROM machine_commands WHERE deviceCode = ? AND status = 'pending' ORDER BY issuedAt ASC"),
  expirePendingCmds:    db.prepare("UPDATE machine_commands SET status = 'expired' WHERE deviceCode = ? AND status = 'pending' AND issuedAt < ?"),
  getCommand:           db.prepare('SELECT * FROM machine_commands WHERE id = ?'),
  completeCommand:      db.prepare("UPDATE machine_commands SET status = ?, result = ?, completedAt = ? WHERE id = ? AND status = 'pending'"),
  listRecentCommands:   db.prepare('SELECT * FROM machine_commands WHERE deviceCode = ? ORDER BY issuedAt DESC LIMIT ?'),
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
    nayaxMachineId:  row.nayaxMachineId || null,
    nayaxLastSyncAt: row.nayaxLastSyncAt || null,
    nayaxData:       row.nayaxDataJson ? JSON.parse(row.nayaxDataJson) : null,
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
    nayaxMachineId:  m.nayaxMachineId || null,
    nayaxLastSyncAt: m.nayaxLastSyncAt || null,
    nayaxDataJson:   m.nayaxData ? JSON.stringify(m.nayaxData) : null,
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
    suspended:    !!row.suspended,
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

function rowToComplaint(row) {
  if (!row) return null;
  return {
    id:              row.id,
    tradeNo:         row.tradeNo,
    deviceCode:      row.deviceCode,
    operatorId:      row.operatorId,
    customerEmail:   row.customerEmail,
    note:            row.note,
    items:           JSON.parse(row.itemsJson || '[]'),
    totalIsk:        row.totalIsk,
    status:          row.status,
    refundedAt:      row.refundedAt,
    refundedAmount:  row.refundedAmount,
    refundedBy:      row.refundedBy,
    repliedAt:       row.repliedAt,
    repliedBy:       row.repliedBy,
    replyText:       row.replyText,
    kioskAppVersion: row.kioskAppVersion,
    kioskOsLocale:   row.kioskOsLocale,
    timestampMs:     row.timestampMs,
    createdAt:       row.createdAt,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const storage = {
  // Operators
  getOperator(id)      { return rowToOperator(stmts.getOperator.get(id)); },
  listOperators()      { return stmts.listOperators.all().map(rowToOperator); },
  setOperatorSuspended(id, val) { db.prepare('UPDATE operators SET suspended = ? WHERE id = ?').run(val ? 1 : 0, id); },
  setOperatorPaydayLink(id, kennitala, paydayCustomerId) {
    db.prepare('UPDATE operators SET kennitala = ?, paydayCustomerId = ? WHERE id = ?')
      .run(kennitala || null, paydayCustomerId || null, id);
  },
  upsertOperator(op) {
    stmts.upsertOperator.run({
      id: op.id, name: op.name,
      isAGVending: op.isAGVending ? 1 : 0,
      contactEmail: op.contactEmail || '',
      contactPhone: op.contactPhone || '',
      address: op.address || '',
      logoUrl: op.logoUrl || '',
      createdAt: op.createdAt || new Date().toISOString(),
    });
  },
  deleteOperator(id) { return stmts.deleteOperator.run(id); },

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
  updateUser(u)            { stmts.updateUser.run({ id:u.id, name:u.name, role:u.role, operatorId:u.operatorId, machineAccess: u.machineAccess || 'all' }); },

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
  listOrdersToday(sinceUTC, untilUTC) { return stmts.listOrdersToday.all(sinceUTC, untilUTC); },
  listOrdersScoped(deviceCodes, limit, offset) {
    return stmts.listOrdersScoped.all(JSON.stringify(deviceCodes), limit, offset);
  },
  countOrdersScoped(deviceCodes) {
    return stmts.countOrdersScoped.get(JSON.stringify(deviceCodes)).c;
  },
  upsertOrderItem(it) {
    stmts.upsertOrderItem.run({
      tradeNo: it.tradeNo, lineIndex: it.lineIndex, deviceCode: it.deviceCode,
      goodsId: it.goodsId || null, productName: it.productName || '',
      payAmount: it.payAmount || 0, shipmentStatus: it.shipmentStatus ? 1 : 0,
      createTime: it.createTime,
    });
  },
  reportItems(sinceUTC, untilUTC, deviceCodes) {
    return stmts.reportItems.all(sinceUTC, untilUTC, JSON.stringify(deviceCodes));
  },
  countOrderItems() { return stmts.countOrderItems.get().c; },
  dispenseIssues(sinceUTC, untilUTC, deviceCodes) {
    return stmts.dispenseIssues.all(sinceUTC, untilUTC, JSON.stringify(deviceCodes));
  },
  shipmentStatusBreakdown() { return stmts.shipmentStatusBreakdown.all(); },

  // Products (our weight / VSK / cost attributes)
  upsertProduct(p) {
    const now = Date.now();
    return stmts.upsertProduct.run({
      goodsId: p.goodsId,
      weimiId: p.weimiId || null,
      goodsCode: p.goodsCode || null,
      customCode: p.customCode || null,
      name: p.name || null,
      salePriceIsk: p.salePriceIsk != null ? Math.round(p.salePriceIsk) : null,
      vatRate: p.vatRate != null ? p.vatRate : null,
      costPriceIsk: p.costPriceIsk != null ? Math.round(p.costPriceIsk) : null,
      weightGrams: p.weightGrams != null ? Math.round(p.weightGrams) : null,
      measurement: p.measurement != null ? p.measurement : 0,
      barcode: p.barcode || null,
      imgUrl: p.imgUrl || null,
      createdAt: p.createdAt || now,
      updatedAt: now,
    });
  },
  getProduct(goodsId) { return stmts.getProduct.get(goodsId); },
  listProducts()      { return stmts.listProducts.all(); },
  setProductDetails(goodsId, d) {
    const n = d && d.nutrition && typeof d.nutrition === 'object' ? JSON.stringify(d.nutrition) : (d && d.nutrition) || null;
    return stmts.setProductDetails.run({
      goodsId,
      packSize:       (d && d.packSize) || null,
      ingredients:    (d && d.ingredients) || null,
      allergens:      (d && d.allergens) || null,
      mayContain:     (d && d.mayContain) || null,
      detailNotes:    (d && d.notes) || null,
      nutritionBasis: (d && d.basis) || null,
      nutrition:      n,
      updatedAt:      Date.now(),
    });
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

  // Auth tokens
  insertAuthToken(token, userId, expiresAt) {
    stmts.insertAuthToken.run(token, userId, Date.now(), expiresAt);
  },
  getAuthToken(token) {
    const row = stmts.getAuthToken.get(token);
    if (!row) return null;
    if (row.expiresAt < Date.now()) return null; // expired (but still in DB until cleanup)
    return row;
  },
  deleteAuthToken(token)        { stmts.deleteAuthToken.run(token); },
  deleteUserTokens(userId)      { stmts.deleteUserTokens.run(userId); },
  cleanupExpiredAuthTokens()    { stmts.cleanupExpiredAuthTokens.run(Date.now()); },

  // Stock & sold-out tracking
  recordStockSnapshot({ deviceCode, goodsId, productName, stock, source = 'unknown' }) {
    const now = Date.now();
    stmts.insertStockHistory.run({
      deviceCode, goodsId, productName: productName || null,
      stock, recordedAt: now, source,
    });
    stmts.upsertSlotStock.run({
      deviceCode, goodsId, productName: productName || null,
      stock, updatedAt: now,
    });

    // Detect transitions: 0→positive (restock) or positive→0 (sold out)
    const previousOpen = stmts.getOpenSoldOutEvent.get(deviceCode, goodsId);
    if (stock <= 0 && !previousOpen) {
      // Going from in-stock to sold-out: open an event
      stmts.openSoldOutEvent.run(deviceCode, goodsId, productName || null, now);
    } else if (stock > 0 && previousOpen) {
      // Restock: close the open event
      const durationHours = (now - previousOpen.soldOutAt) / 3600000;
      stmts.closeSoldOutEvent.run(now, durationHours, previousOpen.id);
    }
  },

  /**
   * Apply a successful sale: decrement the slot stock by 1.
   * Called from the sales-ingest handler.
   */
  applySaleToStock({ deviceCode, goodsId, productName }) {
    if (!goodsId) return; // can't track without a goodsId
    const current = stmts.getSlotStock.get(deviceCode, goodsId);
    const newStock = current ? Math.max(0, current.stock - 1) : 0;
    // Even if we don't have prior stock, record the sale-derived value.
    // (Will be reconciled when an authoritative sync happens.)
    this.recordStockSnapshot({
      deviceCode, goodsId, productName,
      stock: newStock,
      source: 'sale_decrement',
    });
  },

  getCurrentStock(deviceCode, goodsId) {
    return stmts.getSlotStock.get(deviceCode, goodsId);
  },
  getLastRestockAt(deviceCode) {
    const r = stmts.lastRestockAt.get(deviceCode);
    return r && r.lastRestock ? r.lastRestock : null;
  },
  listSlotStockForDevice(deviceCode) {
    return stmts.listSlotStockForDevice.all(deviceCode);
  },
  listEmptySlotsForDevice(deviceCode) {
    return stmts.listEmptySlotsForDevice.all(deviceCode);
  },
  listEmptySlotsForDevices(deviceCodes) {
    if (!deviceCodes || deviceCodes.length === 0) return [];
    const placeholders = deviceCodes.map(() => '?').join(',');
    return db.prepare(
      `SELECT * FROM slot_stock WHERE stock <= 0 AND deviceCode IN (${placeholders}) ORDER BY updatedAt DESC`
    ).all(...deviceCodes);
  },
  listSoldOutEventsScoped(deviceCodes, sinceMs, limit = 100) {
    if (!deviceCodes || deviceCodes.length === 0) return [];
    return stmts.listSoldOutEventsScoped.all(JSON.stringify(deviceCodes), sinceMs, limit);
  },
  listOpenSoldOutScoped(deviceCodes) {
    if (!deviceCodes || deviceCodes.length === 0) return [];
    return stmts.listOpenSoldOutScoped.all(JSON.stringify(deviceCodes));
  },

  // Sales aggregation helpers
  listOrdersInRange(deviceCodes, fromMs, toMs) {
    if (!deviceCodes || deviceCodes.length === 0) return [];
    return stmts.listOrdersInRange.all(JSON.stringify(deviceCodes), fromMs, toMs);
  },
  debugOrdersByDevice(deviceCode, limit) { return stmts.debugOrdersByDevice.all(deviceCode, limit || 15); },
  debugOrderStatusCounts(deviceCode) { return stmts.debugOrderStatusCounts.all(deviceCode); },
  cleanupOldStockHistory(olderThanMs) {
    stmts.cleanupOldStockHistory.run(olderThanMs);
  },

  // Complaints
  insertComplaint(c) {
    stmts.insertComplaint.run({
      id: c.id, tradeNo: c.tradeNo, deviceCode: c.deviceCode,
      operatorId: c.operatorId, customerEmail: c.customerEmail,
      note: c.note || null,
      itemsJson: JSON.stringify(c.items || []),
      totalIsk: c.totalIsk || 0,
      status: c.status || 'open',
      kioskAppVersion: c.kioskAppVersion || null,
      kioskOsLocale: c.kioskOsLocale || null,
      timestampMs: c.timestampMs,
      createdAt: c.createdAt,
    });
  },
  getComplaint(id) {
    const r = stmts.getComplaint.get(id);
    return r ? rowToComplaint(r) : null;
  },
  getComplaintByTradeNo(tradeNo) {
    const r = stmts.getComplaintByTradeNo.get(tradeNo);
    return r ? rowToComplaint(r) : null;
  },
  listComplaints() {
    return stmts.listComplaints.all().map(rowToComplaint);
  },
  listComplaintsByOperator(operatorId) {
    return stmts.listComplaintsByOp.all(operatorId).map(rowToComplaint);
  },
  countComplaintsForMachineSince(deviceCode, sinceMs) {
    return stmts.countComplaintsForMachineSince.get(deviceCode, sinceMs).c;
  },
  markComplaintRefunded(id, amount, refundedBy) {
    stmts.markComplaintRefunded.run('refunded', new Date().toISOString(), amount, refundedBy, id);
  },
  markComplaintReplied(id, replyText, repliedBy) {
    stmts.markComplaintReplied.run(new Date().toISOString(), repliedBy, replyText, id);
  },
  markComplaintStatus(id, status) {
    stmts.markComplaintStatus.run(status, id);
  },

  // Meta
  getMeta(key)         { return stmts.getMeta.get(key)?.value; },
  setMeta(key, value)  { stmts.setMeta.run(key, String(value)); },

  // Expiry batches (dated stock per slot for short-life products)
  listBatchesForSlot(deviceCode, goodsId) { return stmts.listBatchesForSlot.all(deviceCode, goodsId); },
  listAllBatches() { return stmts.listAllBatches.all(); },
  replaceBatchesForSlot(deviceCode, goodsId, batches, addedBy) {
    const tx = db.transaction((rows) => {
      stmts.deleteBatchesForSlot.run(deviceCode, goodsId);
      const now = Date.now();
      for (const b of rows) {
        stmts.insertBatch.run({
          id: `b_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          deviceCode, goodsId,
          expiryDate: b.expiryDate,
          quantity:   b.quantity,
          addedAt:    now,
          addedBy:    addedBy || null,
        });
      }
    });
    tx(batches);
    return stmts.listBatchesForSlot.all(deviceCode, goodsId);
  },
  setProductPerishable(goodsId, val) { stmts.setPerishable.run(val ? 1 : 0, Date.now(), goodsId); },

  // ─── Remote command queue (contract v0.5) ─────────────────────────────────
  enqueueCommand(c) { stmts.insertCommand.run(c); return stmts.getCommand.get(c.id); },
  listPendingCommands(deviceCode) { return stmts.listPendingCommands.all(deviceCode); },
  expirePendingCommands(deviceCode, beforeTs) { return stmts.expirePendingCmds.run(deviceCode, beforeTs).changes; },
  getCommand(id) { return stmts.getCommand.get(id); },
  // First result wins: only flips a still-pending command, so duplicate
  // result POSTs for the same id are a no-op. Returns true if it took effect.
  completeCommand(id, status, result, completedAt) { return stmts.completeCommand.run(status, result, completedAt, id).changes > 0; },
  listRecentCommands(deviceCode, limit) { return stmts.listRecentCommands.all(deviceCode, limit || 25); },

  // ─── Kiosk presence (HTTP last-seen) ──────────────────────────────────────
  // Recorded on every authenticated kiosk call; "alive" is derived from the
  // timestamp so it auto-expires with no background sweep.
  recordKioskSeen(deviceCode) { stmts.setMeta.run(`kiosk_seen:${deviceCode}`, String(Date.now())); },
  getKioskSeen(deviceCode)    { const r = stmts.getMeta.get(`kiosk_seen:${deviceCode}`); return r ? Number(r.value) : 0; },
  isKioskAlive(deviceCode, thresholdMs = Number(process.env.KIOSK_PRESENCE_THRESHOLD_MS) || 300000) {
    const t = this.getKioskSeen(deviceCode);
    return t > 0 && (Date.now() - t) < thresholdMs;
  },

  // Raw access for migration
  db,
};

// Set schema version
storage.setMeta('schema_version', SCHEMA_VERSION);

// One-time correction: orders imported before the UTC+8 fix were stored 8 hours
// too late (Weimi reports China time, we'd parsed it as UTC). Shift them back 8h,
// once. New orders are parsed correctly via weimi.parseWeimiTime, so they're not
// touched (this runs at startup, before any new orders are synced).
if (!storage.getMeta('migration:orderTzUtc8:v1')) {
  try {
    const r = db.prepare('UPDATE orders SET createTime = createTime - 28800000').run();
    storage.setMeta('migration:orderTzUtc8:v1', new Date().toISOString());
    console.log(`[STORAGE] order-time UTC+8 fix: shifted ${r.changes} existing orders -8h`);
  } catch (e) {
    console.error('[STORAGE] order-time UTC+8 migration failed:', e.message);
  }
}

console.log('[STORAGE] Schema ready');

module.exports = storage;
