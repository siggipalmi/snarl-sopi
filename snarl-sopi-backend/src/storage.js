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
    return { path: wanted, fellBack: false };
  } catch (e) {
    // The /tmp fallback is for local dev only. In a hosted environment it would
    // silently serve an EMPTY ephemeral database (and reseed demo data) — exactly
    // the "no data" failure we hit. So when persistence is expected, fail loudly
    // instead of pretending everything is fine.
    const flag = (process.env.REQUIRE_PERSISTENT_DB || '').trim();
    let persistRequired;
    if (/^(0|false|no)$/i.test(flag)) persistRequired = false;        // explicit opt-out (allow /tmp)
    else if (/^(1|true|yes)$/i.test(flag)) persistRequired = true;    // explicit opt-in
    else persistRequired = Object.keys(process.env).some(k => k.startsWith('RAILWAY_')); // auto-detect hosting
    if (persistRequired) {
      console.error(`[STORAGE] FATAL: database directory ${dir} is not writable, but a persistent volume is required here.`);
      console.error('[STORAGE] Refusing to start on an ephemeral fallback — that would serve an EMPTY database and reseed demo data.');
      console.error(`[STORAGE] Fix: mount the Railway volume at ${dir} (or set DB_PATH to the mounted path). To allow the /tmp fallback anyway, set REQUIRE_PERSISTENT_DB=0.`);
      throw new Error('Persistent database volume not available at ' + dir);
    }
    console.warn(`[STORAGE] ${dir} not writable, falling back to /tmp (local dev). Set REQUIRE_PERSISTENT_DB=1 to make this fatal.`);
    return { path: '/tmp/snarl-sopi.db', fellBack: true };
  }
}

const _dbResolved = resolveDbPath();
const DB_PATH = _dbResolved.path;
const DB_IS_FALLBACK = _dbResolved.fellBack;
console.log(`[STORAGE] Database: ${DB_PATH}${DB_IS_FALLBACK ? ' (EPHEMERAL FALLBACK — data will NOT persist)' : ''}`);

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
    stockSource     TEXT NOT NULL DEFAULT 'weimi',
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

  CREATE TABLE IF NOT EXISTS lease_units (
    machineId    TEXT PRIMARY KEY,
    nayaxId      TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'available',   -- 'available' | 'used'
    assignedTo   TEXT,
    kennitala    TEXT,
    assignedDate TEXT,
    createdAt    TEXT NOT NULL,
    updatedAt    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lease_units_type_status ON lease_units(type, status);

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

  CREATE TABLE IF NOT EXISTS telemetry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    deviceCode   TEXT NOT NULL,
    at           TEXT NOT NULL,
    atMs         INTEGER NOT NULL,
    cabinetTempC REAL,
    humidity     INTEGER,
    evaporator   INTEGER,
    statusOk     INTEGER,
    receivedAt   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_device_at ON telemetry(deviceCode, atMs);

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

  CREATE TABLE IF NOT EXISTS deals (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,            -- markdown | expiry | multibuy | combo
    enabled     INTEGER NOT NULL DEFAULT 1,
    config      TEXT,                     -- JSON, type-specific
    appliesTo   TEXT,                     -- JSON { kind, group?, products? }
    scope       TEXT,                     -- JSON { kind:'fleet'|'machines', machines? }
    schedule    TEXT,                     -- JSON { kind:'always'|'dates'|'hours', start?, end?, days?, from?, to? }
    stackable   INTEGER NOT NULL DEFAULT 0,
    createdAt   TEXT,
    updatedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_deals_enabled ON deals(enabled);

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
ensureColumn('machines', 'stockSource',     "TEXT NOT NULL DEFAULT 'weimi'");
// products are keyed by the device-facing product code (goodsCode); we also keep
// Weimi's internal record id and any of the other ids so the catalog can match a
// placed slot to its product no matter which identifier the layout carries.
ensureColumn('products', 'weimiId',   'TEXT');
ensureColumn('products', 'goodsCode', 'TEXT');
// Image hosting/normalization (v5.46): imgUrl becomes OUR R2 url once normalized.
ensureColumn('products', 'imageHasBackground', 'INTEGER');  // 1 = baked-in bg (kiosk frames on white card), 0 = cut-out
ensureColumn('products', 'weimiImgUrl',        'TEXT');     // original Weimi url, kept as transition fallback
ensureColumn('products', 'imageNormalizedAt',  'INTEGER');  // set once we host it; also guards against sync clobber
ensureColumn('products', 'imageClearedPct',    'REAL');     // % removed by knockout — high values may mean a white product got eaten
ensureColumn('products', 'imageSrcW',          'INTEGER');  // source width before we padded to 800 — small = grainy on the machine
ensureColumn('products', 'imageSrcH',          'INTEGER');  // source height
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
// Idle-screen promo: a deal can be featured on the kiosk attract loop, in order.
ensureColumn('deals', 'show_on_idle', 'INTEGER');
ensureColumn('deals', 'idle_order',   'INTEGER');

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
  deleteOperatorRow: db.prepare('DELETE FROM operators WHERE id = ?'),

  // Machines
  getMachine:     db.prepare('SELECT * FROM machines WHERE deviceCode = ?'),
  listMachines:   db.prepare('SELECT * FROM machines'),
  upsertMachine:  db.prepare(`INSERT INTO machines
    (deviceCode, deviceName, location, operatorId, model, isKioskModel, isOnline, isRunning, kioskVersion,
     totalCurrStock, maxStock, unsupported, nayaxMachineId, nayaxLastSyncAt, nayaxDataJson,
     profileJson, featuredJson, adsJson, settingsJson,
     productsJson, productOverridesJson, stockSource, configVersion, createdAt, updatedAt)
    VALUES (@deviceCode, @deviceName, @location, @operatorId, @model, @isKioskModel, @isOnline, @isRunning, @kioskVersion,
            @totalCurrStock, @maxStock, @unsupported, @nayaxMachineId, @nayaxLastSyncAt, @nayaxDataJson,
            @profileJson, @featuredJson, @adsJson, @settingsJson,
            @productsJson, @productOverridesJson, @stockSource, @configVersion, @createdAt, @updatedAt)
    ON CONFLICT(deviceCode) DO UPDATE SET
      deviceName=excluded.deviceName, location=excluded.location, operatorId=excluded.operatorId,
      model=excluded.model, isKioskModel=excluded.isKioskModel, isOnline=excluded.isOnline,
      isRunning=excluded.isRunning, kioskVersion=excluded.kioskVersion,
      totalCurrStock=excluded.totalCurrStock, maxStock=excluded.maxStock, unsupported=excluded.unsupported,
      nayaxMachineId=excluded.nayaxMachineId, nayaxLastSyncAt=excluded.nayaxLastSyncAt, nayaxDataJson=excluded.nayaxDataJson,
      profileJson=excluded.profileJson, featuredJson=excluded.featuredJson, adsJson=excluded.adsJson,
      settingsJson=excluded.settingsJson, productsJson=excluded.productsJson,
      productOverridesJson=excluded.productOverridesJson, stockSource=excluded.stockSource, configVersion=excluded.configVersion,
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
  deleteInvitationsByOperator: db.prepare('DELETE FROM invitations WHERE operatorId = ?'),
  cleanupExpired:    db.prepare('DELETE FROM invitations WHERE expiresAt < ?'),

  // Machine keys
  getMachineKey:     db.prepare('SELECT * FROM machine_keys WHERE deviceCode = ?'),
  insertMachineKey:  db.prepare(`INSERT INTO machine_keys (deviceCode, apiKey, createdAt, revokedAt)
                                 VALUES (?, ?, ?, NULL)
                                 ON CONFLICT(deviceCode) DO UPDATE SET apiKey=excluded.apiKey, createdAt=excluded.createdAt, revokedAt=NULL`),
  revokeMachineKey:  db.prepare('UPDATE machine_keys SET revokedAt = ? WHERE deviceCode = ?'),

  // Lease units
  getLeaseUnit:        db.prepare('SELECT * FROM lease_units WHERE machineId = ?'),
  listLeaseUnits:      db.prepare('SELECT * FROM lease_units ORDER BY type, machineId'),
  listLeaseUnitsByTypeStatus: db.prepare(
    'SELECT * FROM lease_units WHERE type = ? AND status = ? ORDER BY machineId'),
  countLeaseAvailable: db.prepare(
    "SELECT COUNT(*) AS c FROM lease_units WHERE type = ? AND status = 'available'"),
  insertLeaseUnit: db.prepare(`INSERT INTO lease_units
      (machineId, nayaxId, type, status, assignedTo, kennitala, assignedDate, createdAt, updatedAt)
      VALUES (@machineId, @nayaxId, @type, @status, @assignedTo, @kennitala, @assignedDate, @createdAt, @updatedAt)
      ON CONFLICT(machineId) DO NOTHING`),
  markLeaseUnitUsed: db.prepare(`UPDATE lease_units
      SET status='used', assignedTo=@assignedTo, kennitala=@kennitala,
          assignedDate=@assignedDate, updatedAt=@updatedAt
      WHERE machineId=@machineId AND status='available'`),
  freeLeaseUnit: db.prepare(`UPDATE lease_units
      SET status='available', assignedTo=NULL, kennitala=NULL, assignedDate=NULL, updatedAt=@updatedAt
      WHERE machineId=@machineId`),
  freeLeaseUnitsByAssignee: db.prepare(`UPDATE lease_units
      SET status='available', assignedTo=NULL, kennitala=NULL, assignedDate=NULL, updatedAt=@updatedAt
      WHERE assignedTo=@assignedTo`),
  deleteAllLeaseUnits: db.prepare('DELETE FROM lease_units'),

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
        measurement=excluded.measurement, barcode=excluded.barcode,
        -- Once we host a normalized image, a later Weimi sync must NOT drag imgUrl back to
        -- their URL. Their incoming URL is kept in weimiImgUrl as a transition fallback.
        imgUrl=CASE WHEN products.imageNormalizedAt IS NOT NULL THEN products.imgUrl ELSE excluded.imgUrl END,
        weimiImgUrl=CASE WHEN products.imageNormalizedAt IS NOT NULL THEN COALESCE(excluded.imgUrl, products.weimiImgUrl) ELSE products.weimiImgUrl END,
        updatedAt=excluded.updatedAt`),
  getProduct:   db.prepare('SELECT * FROM products WHERE goodsId = ?'),
  setProductImageDims: db.prepare('UPDATE products SET imageSrcW=@imageSrcW, imageSrcH=@imageSrcH WHERE goodsId=@goodsId'),
  setProductImage: db.prepare(`UPDATE products SET imgUrl=@imgUrl, imageHasBackground=@imageHasBackground,
      weimiImgUrl=COALESCE(@weimiImgUrl, weimiImgUrl), imageNormalizedAt=@imageNormalizedAt,
      imageClearedPct=@imageClearedPct, imageSrcW=@imageSrcW, imageSrcH=@imageSrcH, updatedAt=@updatedAt
      WHERE goodsId=@goodsId`),
  insertProductStub: db.prepare(`INSERT INTO products (goodsId, name, createdAt, updatedAt)
                                 VALUES (@goodsId, @name, @now, @now) ON CONFLICT(goodsId) DO NOTHING`),
  productNameFromStock: db.prepare(`SELECT productName FROM slot_stock
                                    WHERE goodsId = ? AND productName IS NOT NULL AND productName <> '' LIMIT 1`),
  listProducts: db.prepare('SELECT * FROM products ORDER BY updatedAt DESC'),
  searchProducts: db.prepare(`SELECT goodsId, name, barcode, imgUrl, salePriceIsk
                              FROM products
                              WHERE name LIKE @like OR barcode LIKE @pfx OR customCode LIKE @like
                              ORDER BY CASE WHEN name LIKE @pfx THEN 0 ELSE 1 END, name
                              LIMIT @lim`),
  sumSlotStock: db.prepare('SELECT COALESCE(SUM(stock),0) AS n FROM slot_stock WHERE goodsId = ?'),
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

  // Telemetry (temperature time-series)
  insertTelemetry:   db.prepare(`INSERT INTO telemetry (deviceCode, at, atMs, cabinetTempC, humidity, evaporator, statusOk, receivedAt)
                                 VALUES (@deviceCode, @at, @atMs, @cabinetTempC, @humidity, @evaporator, @statusOk, @receivedAt)`),
  telemetrySince:    db.prepare('SELECT atMs, cabinetTempC, statusOk FROM telemetry WHERE deviceCode = ? AND atMs >= ? ORDER BY atMs ASC'),
  pruneTelemetry:    db.prepare('DELETE FROM telemetry WHERE atMs < ?'),

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
  listMetaKeys:      db.prepare('SELECT key FROM schema_meta WHERE key LIKE ?'),

  // Expiry batches
  listBatchesForSlot:   db.prepare('SELECT * FROM product_batches WHERE deviceCode = ? AND goodsId = ? ORDER BY expiryDate ASC'),
  listAllBatches:       db.prepare('SELECT * FROM product_batches ORDER BY expiryDate ASC'),
  deleteBatchesForSlot: db.prepare('DELETE FROM product_batches WHERE deviceCode = ? AND goodsId = ?'),
  insertBatch:          db.prepare(`INSERT INTO product_batches (id, deviceCode, goodsId, expiryDate, quantity, addedAt, addedBy)
                                     VALUES (@id, @deviceCode, @goodsId, @expiryDate, @quantity, @addedAt, @addedBy)`),
  setPerishable:        db.prepare('UPDATE products SET perishable = ?, updatedAt = ? WHERE goodsId = ?'),

  // Discounts & deals
  listDeals:   db.prepare('SELECT * FROM deals ORDER BY createdAt DESC'),
  getDeal:     db.prepare('SELECT * FROM deals WHERE id = ?'),
  deleteDeal:  db.prepare('DELETE FROM deals WHERE id = ?'),
  upsertDeal:  db.prepare(`INSERT INTO deals (id,name,type,enabled,config,appliesTo,scope,schedule,stackable,show_on_idle,idle_order,createdAt,updatedAt)
                           VALUES (@id,@name,@type,@enabled,@config,@appliesTo,@scope,@schedule,@stackable,@show_on_idle,@idle_order,@createdAt,@updatedAt)
                           ON CONFLICT(id) DO UPDATE SET
                             name=excluded.name, type=excluded.type, enabled=excluded.enabled,
                             config=excluded.config, appliesTo=excluded.appliesTo, scope=excluded.scope,
                             schedule=excluded.schedule, stackable=excluded.stackable,
                             show_on_idle=excluded.show_on_idle, idle_order=excluded.idle_order, updatedAt=excluded.updatedAt`),

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
    stockSource:     row.stockSource || 'weimi',
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
    stockSource:     (m.stockSource === 'kiosk') ? 'kiosk' : 'weimi',
    configVersion:   m.configVersion || new Date().toISOString(),
    createdAt:       m.createdAt || new Date().toISOString(),
    updatedAt:       m.updatedAt || new Date().toISOString(),
  };
}

function rowToOperator(row) {
  if (!row) return null;
  return {
    id:               row.id,
    name:             row.name,
    isAGVending:      !!row.isAGVending,
    contactEmail:     row.contactEmail || '',
    contactPhone:     row.contactPhone || '',
    address:          row.address || '',
    logoUrl:          row.logoUrl || '',
    suspended:        !!row.suspended,
    kennitala:        row.kennitala || null,
    paydayCustomerId: row.paydayCustomerId || null,
    createdAt:        row.createdAt,
  };
}

function rowToDeal(r) {
  if (!r) return null;
  const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
  return {
    id: r.id, name: r.name, type: r.type, enabled: !!r.enabled,
    config: j(r.config, {}), appliesTo: j(r.appliesTo, { kind: 'all' }),
    scope: j(r.scope, { kind: 'fleet' }), schedule: j(r.schedule, { kind: 'always' }),
    stackable: !!r.stackable, createdAt: r.createdAt, updatedAt: r.updatedAt,
    showOnIdle: !!r.show_on_idle, idleOrder: r.idle_order != null ? r.idle_order : 0,
  };
}
// Is a deal's schedule live right now? (server clock; Iceland runs on UTC year-round)
function dealInSchedule(s, now) {
  if (!s || s.kind === 'always') return true;
  if (s.kind === 'dates') {
    if (s.start && new Date(s.start) > now) return false;
    if (s.end && new Date(s.end + 'T23:59:59') < now) return false;
    return true;
  }
  if (s.kind === 'hours') {
    const dow = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][now.getDay()];
    if (Array.isArray(s.days) && s.days.length && !s.days.includes(dow)) return false;
    const toM = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const hm = now.getHours() * 60 + now.getMinutes();
    const f = toM(s.from), t = toM(s.to);
    if (f != null && t != null) { if (f <= t) { if (hm < f || hm > t) return false; } else { if (hm < f && hm > t) return false; } }
    return true;
  }
  return true;
}
function dealScopeMatches(sc, deviceCode) {
  if (!sc || sc.kind === 'fleet') return true;
  if (sc.kind === 'machines') return Array.isArray(sc.machines) && sc.machines.includes(deviceCode);
  return true;
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
  // Deleting an operator must first clear rows that FK-reference it. Machines and users are
  // guarded in the handler (must be reassigned first), but INVITATIONS reference operators(id)
  // too and were never cleaned up — a pending/consumed invite left the delete failing on a
  // foreign-key constraint. Clear invites and delete in one transaction.
  deleteOperator: db.transaction((id) => {
    stmts.deleteInvitationsByOperator.run(id);
    return stmts.deleteOperatorRow.run(id);
  }),

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

  // ── Lease units ───────────────────────────────────────────────
  getLeaseUnit(machineId) { return stmts.getLeaseUnit.get(machineId); },
  listLeaseUnits()        { return stmts.listLeaseUnits.all(); },
  countLeaseAvailable(type) { return stmts.countLeaseAvailable.get(type).c; },
  insertLeaseUnit(u) {
    const now = new Date().toISOString();
    stmts.insertLeaseUnit.run({
      machineId: u.machineId, nayaxId: u.nayaxId || '', type: u.type,
      status: u.status || 'available',
      assignedTo: u.assignedTo || null, kennitala: u.kennitala || null,
      assignedDate: u.assignedDate || null,
      createdAt: now, updatedAt: now,
    });
  },
  freeLeaseUnit(machineId) {
    stmts.freeLeaseUnit.run({ machineId, updatedAt: new Date().toISOString() });
  },
  freeLeaseUnitsByAssignee(assignedTo) {
    const r = stmts.freeLeaseUnitsByAssignee.run({ assignedTo, updatedAt: new Date().toISOString() });
    return r.changes;
  },
  // Wipe and re-seed from the seed file — restores exact starting inventory.
  reseedLeaseUnits() {
    const seed = require('./data/lease-units-seed.json');
    const tx = db.transaction(() => {
      stmts.deleteAllLeaseUnits.run();
      const now = new Date().toISOString();
      seed.forEach(u => stmts.insertLeaseUnit.run({
        machineId: u.machineId, nayaxId: u.nayaxId || '', type: u.type,
        status: u.status || 'available',
        assignedTo: u.assignedTo || null, kennitala: u.kennitala || null,
        assignedDate: u.assignedDate || null, createdAt: now, updatedAt: now,
      }));
    });
    tx();
    return seed.length;
  },
  // Atomically claim N available units per type. wants = { 'Einfaldur':2, '55"':1 }
  claimLeaseUnits(wants, assignedTo, kennitala) {
    const tx = db.transaction((wants, assignedTo, kennitala) => {
      const claimed = {};
      const warnings = [];
      const assignedDate = new Date().toISOString().slice(0, 10);
      const updatedAt = new Date().toISOString();
      for (const [type, qtyRaw] of Object.entries(wants)) {
        const qty = Number(qtyRaw) || 0;
        if (qty <= 0) continue;
        claimed[type] = [];
        const available = stmts.listLeaseUnitsByTypeStatus.all(type, 'available');
        if (available.length < qty) {
          warnings.push(`Only ${available.length} '${type}' available, ${qty} requested`);
        }
        const take = available.slice(0, qty);
        for (const unit of take) {
          const r = stmts.markLeaseUnitUsed.run({
            machineId: unit.machineId, assignedTo: assignedTo || null,
            kennitala: kennitala || null, assignedDate, updatedAt,
          });
          if (r.changes === 1) {
            claimed[type].push({ machineId: unit.machineId, nayaxId: unit.nayaxId || '' });
          }
        }
      }
      return { claimed, warnings };
    });
    return tx(wants, assignedTo, kennitala);
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

  // ── Duplicate detection (read-only) ──────────────────────────────────────
  // Products are "the same" when they share a weimiId or a customCode (that's how the
  // real duplicates arose — one product ingested under two goodsIds). Returns groups of
  // 2+ rows keyed by the shared identity.
  duplicateProductGroups() {
    const all = stmts.listProducts.all();
    const byKey = {};
    for (const p of all) {
      for (const key of [p.weimiId && 'w:' + p.weimiId, p.customCode && 'c:' + p.customCode]) {
        if (!key) continue;
        (byKey[key] = byKey[key] || []).push(p);
      }
    }
    // Collapse rows that share ANY key into one group (union), so a row linked by weimiId
    // to one and customCode to another still lands in a single group.
    const groupOf = {};   // goodsId -> group id
    let gid = 0;
    const groups = {};
    for (const key of Object.keys(byKey)) {
      const rows = byKey[key];
      if (rows.length < 2) continue;
      // find an existing group among these rows, else make one
      let g = null;
      for (const r of rows) if (groupOf[r.goodsId] != null) { g = groupOf[r.goodsId]; break; }
      if (g == null) { g = gid++; groups[g] = new Set(); }
      for (const r of rows) { groupOf[r.goodsId] = g; groups[g].add(r.goodsId); }
    }
    const byId = {}; all.forEach(p => byId[p.goodsId] = p);
    return Object.values(groups).map(set => Array.from(set).map(id => byId[id])).filter(g => g.length > 1);
  },

  // How many places reference this goodsId — so we can tell a live row from an orphan.
  referenceCountsForGoods(goodsId) {
    const one = (sql) => { try { return db.prepare(sql).get(goodsId).n; } catch (e) { return 0; } };
    const counts = {
      orders:       one('SELECT COUNT(*) n FROM order_items WHERE goodsId = ?'),
      slotStock:    one('SELECT COUNT(*) n FROM slot_stock WHERE goodsId = ?'),
      stockHistory: one('SELECT COUNT(*) n FROM stock_history WHERE goodsId = ?'),
      batches:      one('SELECT COUNT(*) n FROM product_batches WHERE goodsId = ?'),
      soldOut:      one('SELECT COUNT(*) n FROM sold_out_events WHERE goodsId = ?'),
    };
    // planograms (goodsId is a key in each machine's layout) and deals — walk machines.
    let planograms = 0;
    try {
      for (const m of this.listMachines()) {
        const lp = this.layoutProductsForDevice(m.deviceCode) || {};
        if (lp[goodsId]) planograms++;
      }
    } catch (e) {}
    counts.planograms = planograms;
    counts.total = counts.orders + counts.slotStock + counts.stockHistory + counts.batches + counts.soldOut + counts.planograms;
    return counts;
  },

  setProductImageDims(goodsId, w, h) {
    return stmts.setProductImageDims.run({ goodsId,
      imageSrcW: (w == null ? null : Math.round(Number(w))),
      imageSrcH: (h == null ? null : Math.round(Number(h))) });
  },

  // Point a product at an image we host (normalized). Records the background mode the
  // kiosk renders from, and stamps imageNormalizedAt so Weimi sync can't clobber it.
  setProductImage(goodsId, { imgUrl, hasBackground, weimiImgUrl, clearedPct, srcW, srcH }) {
    return stmts.setProductImage.run({
      goodsId,
      imgUrl: imgUrl || null,
      imageHasBackground: hasBackground ? 1 : 0,
      weimiImgUrl: weimiImgUrl || null,
      imageNormalizedAt: Date.now(),
      imageClearedPct: (clearedPct == null ? null : Number(clearedPct)),
      imageSrcW: (srcW == null ? null : Math.round(Number(srcW))),
      imageSrcH: (srcH == null ? null : Math.round(Number(srcH))),
      updatedAt: Date.now(),
    });
  },
  productNameFromStock(goodsId) { const r = stmts.productNameFromStock.get(goodsId); return r ? r.productName : null; },
  // Create a minimal catalog row for a product that exists in machine stock but
  // was never added to the catalog (so attributes like perishable can be stored).
  ensureProductStub(goodsId, name) {
    const now = Date.now();
    stmts.insertProductStub.run({ goodsId, name: name || null, now });
    return stmts.getProduct.get(goodsId);
  },
  listProducts()      { return stmts.listProducts.all(); },
  searchProducts(q, limit = 10) {
    const term = String(q || '').trim();
    if (term.length < 3) return [];
    return stmts.searchProducts.all({ like: '%' + term + '%', pfx: term + '%', lim: limit });
  },
  // Current stock + name/image/price per product on a machine, read from the
  // machine layout (operator-maintained planogram) — the same source the catalog
  // and expiry views use. slot_stock only fills on Weimi sync/sales, so the layout
  // is the reliable stock truth for machines that aren't syncing.
  // Per-goodsId current stock map for the kiosk config (summed across bays,
  // includes 0-stock so the kiosk can stop offering emptied bays). System of
  // record for kiosk machines; the kiosk re-baselines its local count to this.
  stockMapForMachine(deviceCode) {
    const lp = this.layoutProductsForDevice(deviceCode) || {};
    const out = {};
    for (const gid of Object.keys(lp)) out[gid] = Number(lp[gid].stock) || 0;
    return out;
  },

  // goodsId → { url, hasBackground } for everything in this machine's planogram.
  // Lets the kiosk source grid images from US instead of the local Weimi catalog.
  // Only products we actually host are emitted; anything not yet migrated is omitted
  // so the kiosk keeps its current fallback for those.
  imageMapForMachine(deviceCode) {
    const lp = this.layoutProductsForDevice(deviceCode) || {};
    const out = {};
    for (const gid of Object.keys(lp)) {
      const p = stmts.getProduct.get(gid);
      if (!p || !p.imgUrl || !p.imageNormalizedAt) continue;
      out[gid] = { url: p.imgUrl, hasBackground: p.imageHasBackground === 1 };
    }
    return out;
  },

  layoutProductsForDevice(deviceCode) {
    let layout;
    try { const raw = this.getMeta('layout:' + deviceCode); layout = raw ? JSON.parse(raw) : null; } catch (e) { layout = null; }
    const m = {};
    if (Array.isArray(layout)) layout.forEach(layer => (layer.bays || []).forEach(b => {
      const gid = (b && b.goodsId != null) ? String(b.goodsId) : '';
      if (!gid) return;
      if (!m[gid]) m[gid] = { goodsId: gid, stock: 0, name: b.name || '', image: b.image || '', priceIsk: 0 };
      m[gid].stock += Number(b.currStock) || 0;
      if (!m[gid].name && b.name) m[gid].name = b.name;
      if (!m[gid].image && b.image) m[gid].image = b.image;
      if (!m[gid].priceIsk && Number(b.priceIsk) > 0) m[gid].priceIsk = Number(b.priceIsk);
    }));
    return m;
  },

  stockForProduct(goodsId, machines) {
    const gid = String(goodsId);
    const codes = (Array.isArray(machines) && machines.length) ? machines : this.listMachines().map(x => x.deviceCode);
    let total = 0;
    for (const code of codes) { const m = this.layoutProductsForDevice(code); total += (m[gid] && m[gid].stock) || 0; }
    return total;
  },
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

  // ── Telemetry (temperature) ────────────────────────────────────────────────
  // Defaults (per-machine overridable via settings, passed in by the caller).
  _telemDefaults: { maxC: 8, dwellMin: 30, staleMin: 20, retainDays: 90 },

  _raiseTelemAlert(deviceCode, type, severity, title, detail) {
    const id = 'alert_' + type + '_' + deviceCode;
    const ex = stmts.getAlert.get(id);
    if (ex && !ex.resolved) return; // already open — don't churn
    stmts.insertAlert.run({ id, type, severity, title, detail: detail || '', deviceCode, resolved: 0, resolvedAt: null, createdAt: new Date().toISOString() });
  },
  _clearTelemAlert(deviceCode, type) {
    const id = 'alert_' + type + '_' + deviceCode;
    const ex = stmts.getAlert.get(id);
    if (ex && !ex.resolved) stmts.resolveAlert.run(new Date().toISOString(), id);
  },

  // Ingest one sample: store it, cache latest, evaluate high-temp + board-fault,
  // and clear any stale alert (a sample just arrived). `opts` carries deviceName + thresholds.
  recordTelemetry(sample, opts = {}) {
    const deviceCode = sample.deviceCode;
    const atMs = Date.parse(sample.at) || Date.now();
    const tempC = (sample.cabinetTempC == null) ? null : Number(sample.cabinetTempC);
    const statusOk = (sample.statusOk == null) ? null : (sample.statusOk ? 1 : 0);
    stmts.insertTelemetry.run({
      deviceCode, at: sample.at || new Date(atMs).toISOString(), atMs,
      cabinetTempC: tempC,
      humidity: (sample.humidity == null) ? null : Math.round(Number(sample.humidity)),
      evaporator: (sample.evaporator == null) ? null : Math.round(Number(sample.evaporator)),
      statusOk, receivedAt: new Date().toISOString(),
    });
    const name = opts.deviceName || deviceCode;
    this.setMeta('telem:' + deviceCode, JSON.stringify({ tempC, atMs, statusOk, name }));
    const maxC = (opts.maxC != null) ? opts.maxC : this._telemDefaults.maxC;
    const dwellMin = (opts.dwellMin != null) ? opts.dwellMin : this._telemDefaults.dwellMin;
    this._clearTelemAlert(deviceCode, 'temp_stale'); // fresh sample → not stale

    // board fault
    if (statusOk === 0) this._raiseTelemAlert(deviceCode, 'board_fault', 'critical', `Cooling board fault — ${name}`, 'Board reported a fault status (statusOk=false).');
    else this._clearTelemAlert(deviceCode, 'board_fault');

    // sustained high temp: continuously above max across the whole dwell window.
    // Fetch with a one-cadence grace so a sample just before the window proves coverage
    // (the in-window samples alone can never span more than dwellMin).
    if (tempC != null) {
      const now = Date.now();
      const windowStart = now - dwellMin * 60000;
      const lookback = stmts.telemetrySince.all(deviceCode, windowStart - 6 * 60000);
      const covered = lookback.length > 0 && (now - lookback[0].atMs) >= dwellMin * 60000;
      const inWindow = lookback.filter(r => r.atMs >= windowStart);
      const allHigh = inWindow.length > 0 && inWindow.every(r => r.cabinetTempC != null && r.cabinetTempC > maxC);
      if (covered && allHigh && tempC > maxC) this._raiseTelemAlert(deviceCode, 'temp_high', 'warning', `High temperature — ${name}`, `Cabinet above ${maxC}°C for over ${dwellMin} min (now ${tempC}°C).`);
      else if (tempC <= maxC) this._clearTelemAlert(deviceCode, 'temp_high');
    }
    return { ok: true, atMs, tempC };
  },

  latestTelemetry(deviceCode) {
    try { const raw = this.getMeta('telem:' + deviceCode); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  },

  // Downsampled series for the sparkline: average cabinetTempC per time bucket.
  telemetrySeries(deviceCode, sinceMs, buckets) {
    const rows = stmts.telemetrySince.all(deviceCode, sinceMs);
    if (!rows.length) return [];
    const now = Date.now();
    const span = Math.max(1, now - sinceMs);
    const n = Math.max(1, Math.min(buckets || 48, 240));
    const width = span / n;
    const acc = new Array(n).fill(null).map(() => ({ sum: 0, c: 0 }));
    for (const r of rows) {
      if (r.cabinetTempC == null) continue;
      let i = Math.floor((r.atMs - sinceMs) / width);
      if (i < 0) i = 0; if (i >= n) i = n - 1;
      acc[i].sum += r.cabinetTempC; acc[i].c++;
    }
    const out = [];
    for (let i = 0; i < n; i++) if (acc[i].c) out.push({ t: Math.round(sinceMs + (i + 0.5) * width), tempC: Math.round((acc[i].sum / acc[i].c) * 10) / 10 });
    return out;
  },

  // Periodic: machines that have reported but gone quiet → stale alert; prune old rows.
  telemetrySweep() {
    const now = Date.now();
    const staleMin = this._telemDefaults.staleMin;
    let machineList = [];
    try { machineList = this.listMachines(); } catch (e) { machineList = []; }
    const nameByCode = {}; machineList.forEach(m => { nameByCode[m.deviceCode] = m.deviceName || m.deviceCode; });
    let keys = [];
    try { keys = stmts.listMetaKeys ? stmts.listMetaKeys.all('telem:%').map(r => r.key) : []; } catch (e) { keys = []; }
    for (const k of keys) {
      const code = k.slice('telem:'.length);
      let cache; try { cache = JSON.parse(this.getMeta(k)); } catch (e) { continue; }
      if (!cache || cache.atMs == null) continue;
      const name = nameByCode[code] || cache.name || code;
      if ((now - cache.atMs) > staleMin * 60000) {
        this._raiseTelemAlert(code, 'temp_stale', 'warning', `No temperature data — ${name}`, `No reading for over ${staleMin} min — board, app, or power may be down.`);
      } else {
        this._clearTelemAlert(code, 'temp_stale');
      }
    }
    try { stmts.pruneTelemetry.run(now - this._telemDefaults.retainDays * 86400000); } catch (e) {}
  },

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

  // Discounts & deals
  listDeals() { return stmts.listDeals.all().map(rowToDeal); },
  getDeal(id) { return rowToDeal(stmts.getDeal.get(id)); },
  deleteDeal(id) { stmts.deleteDeal.run(id); },
  upsertDeal(d) {
    const now = new Date().toISOString();
    stmts.upsertDeal.run({
      id: d.id, name: d.name || '', type: d.type || 'markdown', enabled: d.enabled ? 1 : 0,
      config: JSON.stringify(d.config || {}), appliesTo: JSON.stringify(d.appliesTo || { kind: 'all' }),
      scope: JSON.stringify(d.scope || { kind: 'fleet' }), schedule: JSON.stringify(d.schedule || { kind: 'always' }),
      stackable: d.stackable ? 1 : 0, createdAt: d.createdAt || now, updatedAt: now,
      show_on_idle: d.showOnIdle ? 1 : 0, idle_order: d.idleOrder != null ? d.idleOrder : 0,
    });
    return this.getDeal(d.id);
  },
  activeDealsForMachine(deviceCode) {
    const now = new Date();
    return this.listDeals().filter(d => d.enabled && dealInSchedule(d.schedule, now) && dealScopeMatches(d.scope, deviceCode));
  },
  // Resolve which featured deals show on a machine's idle screen, with the
  // actual matching products on THAT machine (in stock, and within the expiry
  // window for expiry deals). Deals with nothing to show are dropped.
  // Per-operator idle-screen settings (stored in meta; applies to all the operator's machines).
  operatorIdleConfig(operatorId) {
    const def = { rotationSeconds: 6, attractTimeoutSeconds: 30 };
    if (!operatorId) return def;
    try {
      const raw = this.getMeta('idlecfg:' + operatorId);
      if (!raw) return def;
      const j = JSON.parse(raw);
      return {
        rotationSeconds: (j.rotationSeconds != null && j.rotationSeconds > 0) ? j.rotationSeconds : def.rotationSeconds,
        attractTimeoutSeconds: (j.attractTimeoutSeconds != null && j.attractTimeoutSeconds > 0) ? j.attractTimeoutSeconds : def.attractTimeoutSeconds,
      };
    } catch (e) { return def; }
  },
  setOperatorIdleConfig(operatorId, cfg) {
    this.setMeta('idlecfg:' + operatorId, JSON.stringify({
      rotationSeconds: cfg.rotationSeconds,
      attractTimeoutSeconds: cfg.attractTimeoutSeconds,
    }));
  },

  // ── OTA app-update (single active release + per-machine version) ───────────
  getAppRelease() { try { const raw = this.getMeta('app_release'); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } },
  setAppRelease(rel) { this.setMeta('app_release', JSON.stringify(rel)); },
  recordAppVersion(deviceCode, versionCode) {
    if (!deviceCode || versionCode == null || versionCode === '') return;
    const vc = Math.round(Number(versionCode));
    this.setMeta('appver:' + deviceCode, JSON.stringify({ vc: Number.isFinite(vc) ? vc : null, at: Date.now() }));
  },
  getAppVersion(deviceCode) { try { const raw = this.getMeta('appver:' + deviceCode); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } },
  recordAppRevert(deviceCode, info) {
    this.setMeta('revert:' + deviceCode, JSON.stringify({
      rejected: info.rejected != null ? info.rejected : null,
      revertedTo: info.revertedTo != null ? info.revertedTo : null,
      at: info.at || new Date().toISOString(),
    }));
  },
  getAppRevert(deviceCode) { try { const raw = this.getMeta('revert:' + deviceCode); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } },

  resolveIdleForMachine(deviceCode, opts) {
    const cap = (opts && opts.cap) || 4;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const r0 = (n) => Math.round(n);
    const daysLeftOf = (s) => Math.round((new Date(s + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const lp = this.layoutProductsForDevice(deviceCode);
    const inStock = (gid) => lp[gid] && lp[gid].stock > 0;
    const info = (gid, fb) => {
      const p = stmts.getProduct.get(gid) || {};
      const l = lp[gid] || {};
      const price = (l.priceIsk != null && l.priceIsk > 0) ? l.priceIsk : (p.salePriceIsk != null ? p.salePriceIsk : null);
      return {
        goodsId: gid,
        name: p.name || fb || l.name || gid,
        imgUrl: p.imgUrl || l.image || null,
        priceIsk: price != null ? price : null,
        perishable: !!p.perishable,
      };
    };
    const minDaysLeft = (gid) => {
      const bs = stmts.listBatchesForSlot.all(deviceCode, gid) || [];
      let best = null;
      for (const b of bs) { if (!b.expiryDate || (b.quantity | 0) <= 0) continue; const dl = daysLeftOf(b.expiryDate); if (best == null || dl < best) best = dl; }
      return best;
    };
    const deals = this.listDeals()
      .filter(d => d.enabled && d.showOnIdle && dealInSchedule(d.schedule, now) && dealScopeMatches(d.scope, deviceCode))
      .sort((a, b) => (a.idleOrder || 0) - (b.idleOrder || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));

    const cards = [];
    for (const d of deals) {
      const at = d.appliesTo || { kind: 'all' };
      const cfg = d.config || {};

      if (d.type === 'combo') {
        const groups = (cfg.groups || []);
        const out = []; let ok = groups.length > 0;
        for (const g of groups) {
          const reps = (g.products || []).filter(p => inStock(p.goodsId)).map(p => info(p.goodsId, p.name));
          if (!reps.length) { ok = false; break; }
          out.push({ items: reps.slice(0, 3) });
        }
        if (!ok) continue;
        cards.push({
          dealId: d.id, dealName: d.name, type: 'combo',
          discount: { kind: 'combo', mode: (cfg.reward && cfg.reward.mode) || 'price', value: (cfg.reward && cfg.reward.value) || 0 },
          groups: out, items: out.map(g => g.items[0]), itemCount: out.length,
        });
        continue;
      }

      let ids = [];
      if (at.kind === 'products') ids = (at.products || []).map(p => String(p.goodsId));
      else if (at.kind === 'all') ids = Object.keys(lp);
      else if (at.kind === 'all_perishable') ids = Object.keys(lp).filter(gid => { const p = stmts.getProduct.get(gid); return p && p.perishable; });
      else if (at.kind === 'group') ids = []; // group targeting needs product categories (not yet present)
      ids = ids.filter(inStock);

      let items = [];
      for (const gid of ids) {
        const it = info(gid);
        if (d.type === 'expiry') {
          const dl = minDaysLeft(gid);
          if (dl == null) continue;
          const tiers = (cfg.tiers || []).slice().sort((a, b) => a.daysLeft - b.daysLeft);
          const applicable = tiers.filter(t => dl <= t.daysLeft);
          if (!applicable.length) continue;
          const pct = Math.max(...applicable.map(t => t.percent || 0));
          it.percent = pct; it.daysLeft = dl;
          it.discountedPriceIsk = it.priceIsk != null ? r0(it.priceIsk * (1 - pct / 100)) : null;
        } else if (d.type === 'markdown') {
          if (it.priceIsk != null) {
            if (cfg.mode === 'percent') it.discountedPriceIsk = r0(it.priceIsk * (1 - (cfg.value || 0) / 100));
            else if (cfg.mode === 'fixed') it.discountedPriceIsk = Math.max(0, it.priceIsk - (cfg.value || 0));
            else if (cfg.mode === 'price') it.discountedPriceIsk = cfg.value || 0;
          }
        }
        items.push(it);
      }
      if (!items.length) continue;
      if (d.type === 'expiry') items.sort((a, b) => (a.daysLeft != null ? a.daysLeft : 999) - (b.daysLeft != null ? b.daysLeft : 999));
      else items.sort((a, b) => ((lp[a.goodsId] ? lp[a.goodsId].stock : 0) - (lp[b.goodsId] ? lp[b.goodsId].stock : 0)) || String(a.name).localeCompare(String(b.name)));
      const itemCount = items.length;
      items = items.slice(0, cap);

      let discount;
      if (d.type === 'markdown') discount = { kind: cfg.mode || 'percent', value: cfg.value || 0 };
      else if (d.type === 'expiry') discount = { kind: 'expiry', maxPercent: Math.max(0, ...(cfg.tiers || []).map(t => t.percent || 0)) };
      else if (d.type === 'multibuy') discount = { kind: 'multibuy', qty: cfg.qty || 0, totalKr: cfg.totalKr || 0 };

      cards.push({ dealId: d.id, dealName: d.name, type: d.type, discount, items, itemCount });
    }
    const mach = this.getMachine(deviceCode);
    const idleCfg = this.operatorIdleConfig(mach && mach.operatorId);
    return { rotationSeconds: idleCfg.rotationSeconds, attractTimeoutSeconds: idleCfg.attractTimeoutSeconds, cards };
  },

  // ── Shared deal helpers (quote + offers) ───────────────────────────────
  // True if a deal's appliesTo set covers a product. 'group' (category)
  // targeting is not yet supported — needs a product-category field.
  _dealCoversProduct(at, gid) {
    at = at || { kind: 'all' };
    if (at.kind === 'all') return true;
    if (at.kind === 'products') return (at.products || []).some(p => String(p.goodsId) === String(gid));
    if (at.kind === 'all_perishable') { const p = stmts.getProduct.get(gid); return !!(p && p.perishable); }
    return false; // 'group' and unknown kinds → not covered
  },
  // Best expiry percent applying to a product on a machine right now, or null.
  // { percent, daysLeft, deal } — max applicable tier across active expiry deals.
  _expiryForProduct(deviceCode, gid, expiryDeals, today) {
    const daysLeftOf = (s) => Math.round((new Date(s + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
    const bs = stmts.listBatchesForSlot.all(deviceCode, gid) || [];
    let dl = null;
    for (const b of bs) { if (!b.expiryDate || (b.quantity | 0) <= 0) continue; const d = daysLeftOf(b.expiryDate); if (dl == null || d < dl) dl = d; }
    if (dl == null) return null;
    let best = null, deal = null;
    for (const d of expiryDeals) {
      if (!this._dealCoversProduct(d.appliesTo, gid)) continue;
      const tiers = ((d.config && d.config.tiers) || []).filter(t => dl <= t.daysLeft);
      if (!tiers.length) continue;
      const pct = Math.max(...tiers.map(t => t.percent || 0));
      if (best == null || pct > best) { best = pct; deal = d; }
    }
    return best == null ? null : { percent: best, daysLeft: dl, deal };
  },

  // Price a whole cart with deals applied. Precedence (per operator decision):
  //   expiry > multibuy > combo > markdown > base.
  // Expiry consumes the product entirely (voids other deals for it). Each unit
  // is discounted at most once and never charged above its base price.
  // items = [{ goodsId, qty }] → { lines, subtotalIsk, discountIsk, totalIsk, appliedDeals }
  priceCartForMachine(deviceCode, items) {
    const today = new Date().toISOString().slice(0, 10);
    const r0 = (n) => Math.round(n);
    const lp = this.layoutProductsForDevice(deviceCode) || {};
    const priceOf = (gid) => { const l = lp[gid] || {}; const p = stmts.getProduct.get(gid) || {}; if (l.priceIsk != null && l.priceIsk > 0) return l.priceIsk; return (p.salePriceIsk != null) ? p.salePriceIsk : 0; };
    const nameOf  = (gid) => { const p = stmts.getProduct.get(gid) || {}; const l = lp[gid] || {}; return p.name || l.name || String(gid); };

    const active = this.activeDealsForMachine(deviceCode);
    const expiryDeals   = active.filter(d => d.type === 'expiry');
    const multibuyDeals = active.filter(d => d.type === 'multibuy');
    const comboDeals    = active.filter(d => d.type === 'combo');
    const markdownDeals = active.filter(d => d.type === 'markdown');

    // Expand into individual units (vending carts are tiny).
    const units = [];
    for (const it of (items || [])) {
      const gid = String(it.goodsId);
      const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
      const base = priceOf(gid);
      for (let i = 0; i < qty; i++) units.push({ gid, base, price: null, dealId: null, dealName: null, type: null });
    }

    // Distribute a bundle total across its units, proportional to base price.
    // Guarantees no unit is priced above its own base and the parts sum to total.
    const distribute = (total, bundle, d, type) => {
      const baseSum = bundle.reduce((s, u) => s + u.base, 0) || 1;
      let assigned = 0;
      for (let i = 0; i < bundle.length; i++) {
        const u = bundle[i];
        let p = (i === bundle.length - 1) ? (total - assigned) : Math.round(total * (u.base / baseSum));
        if (i < bundle.length - 1) assigned += p;
        u.price = Math.max(0, Math.min(p, u.base));
        u.dealId = d.id; u.dealName = d.name; u.type = type;
      }
    };

    // 1) EXPIRY — top precedence, consumes the product.
    for (const u of units) {
      if (u.price != null) continue;
      const ex = this._expiryForProduct(deviceCode, u.gid, expiryDeals, today);
      if (ex) { u.price = r0(u.base * (1 - ex.percent / 100)); u.dealId = ex.deal.id; u.dealName = ex.deal.name; u.type = 'expiry'; }
    }

    // 2) MULTIBUY — N units for a fixed total; bundle highest-priced units first.
    for (const d of multibuyDeals) {
      const cfg = d.config || {};
      const qty = Math.max(0, Math.floor(cfg.qty || 0));
      const totalKr = Math.max(0, Math.floor(cfg.totalKr || 0));
      if (qty < 1) continue;
      const pickPool = () => units.filter(u => u.price == null && this._dealCoversProduct(d.appliesTo, u.gid)).sort((a, b) => b.base - a.base);
      let pool = pickPool();
      while (pool.length >= qty) {
        const bundle = pool.slice(0, qty);
        const baseSum = bundle.reduce((s, u) => s + u.base, 0);
        if (totalKr >= baseSum) break; // no benefit — leave for later passes / base
        distribute(totalKr, bundle, d, 'multibuy');
        pool = pickPool();
      }
    }

    // 3) COMBO — one unit per group; reward is a set price or % off the set.
    for (const d of comboDeals) {
      const cfg = d.config || {};
      const groups = (cfg.groups || []).map(g => (g.products || []).map(p => String(p.goodsId)));
      if (!groups.length || groups.some(g => !g.length)) continue;
      const reward = cfg.reward || {};
      while (true) {
        const chosen = []; let okc = true;
        for (const g of groups) {
          const cand = units.filter(u => u.price == null && g.includes(u.gid)).sort((a, b) => b.base - a.base)[0];
          if (!cand) { okc = false; break; }
          cand.price = -1; chosen.push(cand); // tentatively reserve
        }
        if (!okc) { for (const u of chosen) u.price = null; break; }
        const baseSum = chosen.reduce((s, u) => s + u.base, 0);
        const total = reward.mode === 'percent' ? r0(baseSum * (1 - (reward.value || 0) / 100)) : Math.max(0, Math.floor(reward.value || 0));
        if (total >= baseSum) { for (const u of chosen) u.price = null; break; } // no benefit
        for (const u of chosen) u.price = null; // clear the -1 markers before distributing
        distribute(total, chosen, d, 'combo');
      }
    }

    // 4) MARKDOWN — per-item on remaining units; best markdown wins.
    for (const u of units) {
      if (u.price != null) continue;
      let best = null, bd = null;
      for (const d of markdownDeals) {
        if (!this._dealCoversProduct(d.appliesTo, u.gid)) continue;
        const cfg = d.config || {};
        let p;
        if (cfg.mode === 'percent') p = r0(u.base * (1 - (cfg.value || 0) / 100));
        else if (cfg.mode === 'fixed') p = Math.max(0, u.base - (cfg.value || 0));
        else if (cfg.mode === 'price') p = Math.max(0, Math.floor(cfg.value || 0));
        else continue;
        if (best == null || p < best) { best = p; bd = d; }
      }
      if (best != null && best < u.base) { u.price = best; u.dealId = bd.id; u.dealName = bd.name; u.type = 'markdown'; }
    }

    // 5) BASE — anything unpriced; clamp every unit to ≤ base.
    for (const u of units) { if (u.price == null) u.price = u.base; u.price = Math.min(u.price, u.base); }

    // Aggregate units → per-product lines.
    const byGid = {};
    for (const u of units) {
      if (!byGid[u.gid]) byGid[u.gid] = { goodsId: u.gid, name: nameOf(u.gid), qty: 0, unitPriceIsk: u.base, lineBaseIsk: 0, lineTotalIsk: 0, deals: {}, dealNames: {} };
      const L = byGid[u.gid];
      L.qty += 1; L.lineBaseIsk += u.base; L.lineTotalIsk += u.price;
      if (u.dealId) { L.deals[u.dealId] = (L.deals[u.dealId] || 0) + (u.base - u.price); L.dealNames[u.dealId] = u.dealName; }
    }
    const lines = Object.values(byGid).map(L => {
      let bestId = null, bestAmt = 0, bestName = null;
      for (const id of Object.keys(L.deals)) { if (L.deals[id] > bestAmt) { bestAmt = L.deals[id]; bestId = id; bestName = L.dealNames[id]; } }
      return { goodsId: L.goodsId, name: L.name, qty: L.qty, unitPriceIsk: L.unitPriceIsk,
        lineBaseIsk: L.lineBaseIsk, lineDiscountIsk: L.lineBaseIsk - L.lineTotalIsk, lineTotalIsk: L.lineTotalIsk,
        appliedDealId: bestId, appliedDealName: bestName };
    });
    const subtotalIsk = lines.reduce((s, l) => s + l.lineBaseIsk, 0);
    const totalIsk    = lines.reduce((s, l) => s + l.lineTotalIsk, 0);
    const dealAgg = {};
    for (const u of units) { if (u.dealId && u.base - u.price > 0) { if (!dealAgg[u.dealId]) dealAgg[u.dealId] = { dealId: u.dealId, dealName: u.dealName, type: u.type, amountIsk: 0 }; dealAgg[u.dealId].amountIsk += (u.base - u.price); } }

    // Near-miss hints for a checkout nudge: a basket one item short of a combo (or multibuy).
    // Computed from the SAME reserved units and reward math as the pricing above, so the
    // add-on price the kiosk shows equals what the customer pays after they tap.
    const comboNearMiss = this._nearMissForCart(deviceCode, {
      units, priceOf, comboDeals, multibuyDeals, stock: this.stockMapForMachine(deviceCode),
    });

    return { lines, subtotalIsk, discountIsk: subtotalIsk - totalIsk, totalIsk, appliedDeals: Object.values(dealAgg),
      comboNearMiss: comboNearMiss.length ? comboNearMiss : undefined };
  },

  // Detect combos/multibuys that ONE more item would complete, and price that item.
  // Read-only: never mutates the cart. Returns the memo's comboNearMiss shape, or [].
  _nearMissForCart(deviceCode, ctx) {
    const { units, priceOf, comboDeals, multibuyDeals, stock } = ctx;
    const r0 = (n) => Math.round(n);
    const inStock = (gid) => (Number(stock[gid]) || 0) > 0;
    // What's actually in the basket (goodsId → count), independent of how it was priced.
    const have = {};
    for (const u of units) have[u.gid] = (have[u.gid] || 0) + 1;
    const out = [];

    // ── COMBOS ──────────────────────────────────────────────────────────────
    for (const d of comboDeals) {
      const cfg = d.config || {};
      const groups = (cfg.groups || []).map(g => ({
        label: g.label || null,
        ids: (g.products || []).map(p => String(p.goodsId)),
      }));
      if (!groups.length || groups.some(g => !g.ids.length)) continue;
      const reward = cfg.reward || {};

      // Greedily assign basket items to groups (highest-base first, mirroring pricing),
      // each item used once. Then see if exactly ONE group is left unfilled.
      const used = {};
      const take = (ids) => {
        const cand = ids
          .filter(gid => (have[gid] || 0) - (used[gid] || 0) > 0)
          .sort((a, b) => priceOf(b) - priceOf(a))[0];
        if (cand) { used[cand] = (used[cand] || 0) + 1; return cand; }
        return null;
      };
      const filled = [];
      const missing = [];
      for (const g of groups) { const got = take(g.ids); (got ? filled : missing).push({ g, got }); }
      if (missing.length !== 1) continue;         // only nudge when exactly one short
      const missingGroup = missing[0].g;

      // In-stock candidates for the empty group, cheapest-first (memo's ordering).
      const candidates = missingGroup.ids
        .filter(inStock)
        .sort((a, b) => priceOf(a) - priceOf(b));
      if (!candidates.length) continue;           // machine can't vend any — skip

      // Add-on price = combo total (priced against the items already reserved + the
      // CHEAPEST candidate, matching what they'd pay) minus what those reserved items cost.
      const reservedBase = filled.reduce((s, f) => s + priceOf(f.got), 0);
      const cheapest = priceOf(candidates[0]);
      const setBase = reservedBase + cheapest;
      const comboTotal = reward.mode === 'percent'
        ? r0(setBase * (1 - (reward.value || 0) / 100))
        : Math.max(0, Math.floor(reward.value || 0));
      const addOn = comboTotal - reservedBase;
      if (!(addOn > 0) || addOn >= cheapest) continue;   // no benefit or can't compute → omit

      out.push({
        comboId: d.id,
        label: d.name || 'combo',
        missingGroupLabel: missingGroup.label || null,
        addOnPriceIsk: addOn,
        candidates: candidates.slice(0, 6).map(gid => ({ goodsId: gid })),
      });
    }

    // ── MULTIBUY ────────────────────────────────────────────────────────────
    // "N for totalKr" where the basket holds N-1 qualifying units. Add-on = totalKr minus
    // the base of the N-1 already present (their share toward the bundle).
    for (const d of multibuyDeals) {
      const cfg = d.config || {};
      const qty = Math.max(0, Math.floor(cfg.qty || 0));
      const totalKr = Math.max(0, Math.floor(cfg.totalKr || 0));
      if (qty < 2) continue;                       // "one short" only meaningful for qty ≥ 2
      const qualifying = units.filter(u => this._dealCoversProduct(d.appliesTo, u.gid));
      const present = qualifying.length % qty;     // units toward an as-yet-incomplete bundle
      if (present !== qty - 1) continue;           // must be exactly one short

      // The N-1 highest-base qualifying units are the ones that would bundle.
      const inBundle = qualifying.map(u => u.gid).sort((a, b) => priceOf(b) - priceOf(a)).slice(0, qty - 1);
      const reservedBase = inBundle.reduce((s, gid) => s + priceOf(gid), 0);

      const candidates = Object.keys(stock)
        .filter(gid => inStock(gid) && this._dealCoversProduct(d.appliesTo, gid))
        .sort((a, b) => priceOf(a) - priceOf(b));
      if (!candidates.length) continue;

      const addOn = totalKr - reservedBase;
      const cheapest = priceOf(candidates[0]);
      if (!(addOn > 0) || addOn >= cheapest) continue;

      out.push({
        comboId: d.id,
        label: d.name || 'tilboð',
        missingGroupLabel: null,
        addOnPriceIsk: addOn,
        kind: 'multibuy',
        candidates: candidates.slice(0, 6).map(gid => ({ goodsId: gid })),
      });
    }

    return out;
  },

  // Per-product "on offer" flags for the grid badge. One entry per in-stock
  // product, by the same precedence pricing uses (expiry > markdown > multibuy
  // > combo) so the badge always matches what actually gets charged.
  offersForMachine(deviceCode) {
    const r0 = Math.round;
    const today = new Date().toISOString().slice(0, 10);
    const lp = this.layoutProductsForDevice(deviceCode) || {};
    const inStock = (gid) => lp[gid] && lp[gid].stock > 0;
    const priceOf = (gid) => (lp[gid] && Number(lp[gid].priceIsk) > 0) ? Number(lp[gid].priceIsk) : 0;
    const nameOf  = (gid) => (lp[gid] && lp[gid].name) || (stmts.getProduct.get(gid) || {}).name || gid;
    const active = this.activeDealsForMachine(deviceCode);
    const expiryDeals   = active.filter(d => d.type === 'expiry');
    const markdownDeals = active.filter(d => d.type === 'markdown');
    const multibuyDeals = active.filter(d => d.type === 'multibuy');
    const comboDeals    = active.filter(d => d.type === 'combo');
    const out = {}; // goodsId → { offer, _prec }
    const setIf = (gid, offer, prec) => { if (!inStock(gid)) return; const cur = out[gid]; if (!cur || prec < cur._prec) out[gid] = { ...offer, _prec: prec }; };

    // Per-product discounted price off the machine price — matches the quote base
    // so the tile and checkout agree (no kiosk-side rounding drift). null if no base.
    const discPrice = (gid, mode, value) => {
      const base = priceOf(gid); if (base <= 0) return null;
      if (mode === 'percent') return r0(base * (1 - (value || 0) / 100));
      if (mode === 'fixed')   return Math.max(0, base - (value || 0));
      if (mode === 'price')   return Math.max(0, Math.floor(value || 0));
      return null;
    };

    // 0) EXPIRY — carries daysLeft + discounted price.
    for (const gid of Object.keys(lp)) {
      const ex = this._expiryForProduct(deviceCode, gid, expiryDeals, today);
      if (!ex) continue;
      const offer = { goodsId: gid, kind: 'expiry', value: ex.percent, daysLeft: ex.daysLeft };
      const dp = discPrice(gid, 'percent', ex.percent); if (dp != null) offer.discountedPriceIsk = dp;
      setIf(gid, offer, 0);
    }
    // 1) MARKDOWN — percent/fixed/price; carries discounted price.
    for (const d of markdownDeals) {
      const cfg = d.config || {}; const mode = cfg.mode || 'percent';
      for (const gid of Object.keys(lp)) {
        if (!this._dealCoversProduct(d.appliesTo, gid)) continue;
        const offer = { goodsId: gid, kind: mode, value: cfg.value || 0 };
        const dp = discPrice(gid, mode, cfg.value || 0); if (dp != null) offer.discountedPriceIsk = dp;
        setIf(gid, offer, 1);
      }
    }
    // 2) MULTIBUY — carries qty + totalKr so the tile can render the real label.
    for (const d of multibuyDeals) {
      const cfg = d.config || {};
      const qty = Math.max(0, Math.floor(cfg.qty || 0));
      const totalKr = Math.max(0, Math.floor(cfg.totalKr || 0));
      for (const gid of Object.keys(lp)) if (this._dealCoversProduct(d.appliesTo, gid)) setIf(gid, { goodsId: gid, kind: 'multibuy', qty, totalKr }, 2);
    }
    // 3) COMBO — carries comboId + the group member lists (for the pairing prompt).
    for (const d of comboDeals) {
      const cfg = d.config || {};
      const groups = (cfg.groups || []).map(g => ({
        label: g.label || g.name || null,
        items: (g.products || []).map(p => ({ goodsId: String(p.goodsId), name: nameOf(String(p.goodsId)) })),
      }));
      for (const g of (cfg.groups || [])) for (const p of (g.products || [])) {
        setIf(String(p.goodsId), { goodsId: String(p.goodsId), kind: 'combo', comboId: d.id, groups }, 3);
      }
    }
    return Object.values(out).map(o => { const { _prec, ...rest } = o; return rest; });
  },

  // ── Kiosk stock writes (backend is system-of-record for kiosk machines) ────
  // Operator restock: set bay currStock + stamp restockAt; recompute total.
  applyRestockToLayout(deviceCode, pairs) {
    let layout;
    try { const raw = this.getMeta('layout:' + deviceCode); layout = raw ? JSON.parse(raw) : null; } catch (e) { layout = null; }
    if (!Array.isArray(layout)) return { ok: false, error: 'no_layout', message: 'No planogram stored for ' + deviceCode };
    const now = new Date().toISOString();
    const want = {};
    (pairs || []).forEach(p => { want[String(p.aisleCode)] = Math.max(0, Math.round(Number(p.currStock) || 0)); });
    let updated = 0, total = 0;
    const seen = {};
    layout.forEach(layer => (layer.bays || []).forEach(b => {
      if (Object.prototype.hasOwnProperty.call(want, b.code)) { b.currStock = want[b.code]; b.restockAt = now; updated++; seen[b.code] = true; }
      total += Number(b.currStock) || 0;
    }));
    const notFound = Object.keys(want).filter(c => !seen[c]);
    this.setMeta('layout:' + deviceCode, JSON.stringify(layout));
    this.setMeta('lastvisit:' + deviceCode, String(Date.now())); // a restock is a visit
    return { ok: true, updated, notFound, totalCurrStock: total };
  },

  // Kiosk sale → decrement the planogram (system of record for kiosk machines).
  // Decrements `qty` of `goodsId` across its bays, skipping any bay restocked
  // at/after the sale time (stale-vend guard for offline-queued vends). Clamps
  // >= 0. `soldAtMs` is epoch ms (the sale timestamp from the kiosk).
  // Returns the recomputed machine total stock.
  applySaleToLayout(deviceCode, goodsId, qty, soldAtMs) {
    let layout;
    try { const raw = this.getMeta('layout:' + deviceCode); layout = raw ? JSON.parse(raw) : null; } catch (e) { layout = null; }
    if (!Array.isArray(layout)) return { ok: false, totalCurrStock: null };
    let need = Math.max(0, Math.round(Number(qty) || 0));
    const saleMs = Number(soldAtMs) || Date.now();
    layout.forEach(layer => (layer.bays || []).forEach(b => {
      if (need <= 0) return;
      if (String(b.goodsId) !== String(goodsId)) return;
      if (b.restockAt && Date.parse(b.restockAt) >= saleMs) return; // restocked after this sale → skip
      const take = Math.min(need, Number(b.currStock) || 0);
      if (take > 0) { b.currStock = (Number(b.currStock) || 0) - take; need -= take; }
    }));
    let total = 0; layout.forEach(l => (l.bays || []).forEach(b => total += Number(b.currStock) || 0));
    this.setMeta('layout:' + deviceCode, JSON.stringify(layout));
    return { ok: true, decremented: Math.max(0, Math.round(Number(qty) || 0)) - need, totalCurrStock: total };
  },

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

storage.dbPath = DB_PATH;
storage.dbPersistent = !DB_IS_FALLBACK;

// Telemetry stale-sweep: flag machines that have reported temp but gone quiet,
// and prune rows past retention. Runs every 5 min (first run shortly after boot).
setTimeout(() => { try { storage.telemetrySweep(); } catch (e) { console.error('[TELEM] sweep error:', e.message); } }, 30_000);
setInterval(() => { try { storage.telemetrySweep(); } catch (e) { console.error('[TELEM] sweep error:', e.message); } }, 5 * 60 * 1000).unref();

module.exports = storage;
