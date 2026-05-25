/**
 * Snarl & Sopi frá AG Vending — Operator Backend
 * Data store with multi-tenant operator model
 *
 * Hierarchy:
 *   AG Vending (super-admin operator, isAGVending=true)
 *     ├── Sees and manages everything across all operators
 *     └── Invites operator admins
 *
 *   Customer Operators (Fylkir, IWO, ICE, etc.)
 *     ├── See only their own machines
 *     ├── Have admin/manager/viewer users
 *     └── Admin invites their own staff
 *
 *   Machines belong to one operator via operatorId
 *
 * Roles:
 *   ag_admin       — full access (AG Vending users only)
 *   operator_admin — manage own operator, invite staff, edit machines
 *   operator_manager — edit assigned machines, view sales
 *   operator_viewer  — read-only access to assigned machines
 */

const crypto = require('crypto');

// ─── OPERATORS ────────────────────────────────────────────────────────────────
const operators = {
  'op_ag-rekstur': {
    id: 'op_ag-rekstur',
    name: "AG Rekstur",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_ag-vending': {
    id: 'op_ag-vending',
    name: "AG Vending",
    isAGVending: true,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_al': {
    id: 'op_al',
    name: "AL",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_alano': {
    id: 'op_alano',
    name: "Alanó",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_burfell': {
    id: 'op_burfell',
    name: "Burfell",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_bus': {
    id: 'op_bus',
    name: "Bus",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_dyrholar': {
    id: 'op_dyrholar',
    name: "Dyrholar",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_evanger': {
    id: 'op_evanger',
    name: "Evanger",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_fsa': {
    id: 'op_fsa',
    name: "FSA",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_fylkir': {
    id: 'op_fylkir',
    name: "Fylkir",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_holaskoli': {
    id: 'op_holaskoli',
    name: "Holaskoli",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_ice': {
    id: 'op_ice',
    name: "ICE",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_ir': {
    id: 'op_ir',
    name: "ÍR",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_iwo': {
    id: 'op_iwo',
    name: "IWO",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_kef': {
    id: 'op_kef',
    name: "KEF",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
  'op_reykjalundur': {
    id: 'op_reykjalundur',
    name: "Reykjalundur",
    isAGVending: false,
    contactEmail: '',
    contactPhone: '',
    createdAt: '2026-05-22T08:00:00Z',
  },
};

// ─── MACHINE KEYS ─────────────────────────────────────────────────────────────
const machineKeys = {};

function generateMachineKey() { return 'mk_live_' + crypto.randomBytes(24).toString('hex'); }

function provisionMachine(deviceCode) {
  if (!machines[deviceCode]) return { error: 'device_not_found', status: 404 };
  if (machineKeys[deviceCode] && !machineKeys[deviceCode].revokedAt) return { error: 'already_provisioned', status: 409 };
  const key = generateMachineKey();
  machineKeys[deviceCode] = { key, createdAt: new Date().toISOString(), revokedAt: null };
  return { machineKey: key, deviceCode };
}

function validateMachineKey(deviceCode, key) {
  const entry = machineKeys[deviceCode];
  if (!entry || entry.revokedAt) return false;
  return entry.key === key;
}

function revokeKey(deviceCode) {
  if (machineKeys[deviceCode]) machineKeys[deviceCode].revokedAt = new Date().toISOString();
}

// ─── MACHINES ─────────────────────────────────────────────────────────────────
const machines = {
  '62160042': {
    deviceCode: '62160042', deviceName: "Gamli Gerpla", location: "",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Gamli Gerpla" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160043': {
    deviceCode: '62160043', deviceName: "Valur I", location: "Hlíðarenda, 102 Reykjavík",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valur I" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160472': {
    deviceCode: '62160472', deviceName: "Fylkir 2", location: "Fylkisvegi",
    operatorId: 'op_fylkir', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Fylkir", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Fylkir 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160473': {
    deviceCode: '62160473', deviceName: "F. Skautafélag Akureyrar", location: "",
    operatorId: 'op_fsa', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "FSA", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "F. Skautafélag Akureyrar" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160474': {
    deviceCode: '62160474', deviceName: "12 Sporahúsið", location: "Vallarkór 12-14, 203 Kópavogur",
    operatorId: 'op_alano', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Alanó", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "12 Sporahúsið" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160475': {
    deviceCode: '62160475', deviceName: "Dyrhólaey", location: "",
    operatorId: 'op_dyrholar', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Dyrholar", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Dyrhólaey" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160476': {
    deviceCode: '62160476', deviceName: "Mjódd", location: "Þönglabakki 4,109 Reykjavík",
    operatorId: 'op_bus', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Bus", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Mjódd" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160477': {
    deviceCode: '62160477', deviceName: "Orkan Miklabraut N", location: "Miklabraut",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Orkan Miklabraut N" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160478': {
    deviceCode: '62160478', deviceName: "Laugardagshöll", location: "",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Laugardagshöll" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160479': {
    deviceCode: '62160479', deviceName: "Grótta vinstri", location: "Suðurströnd 8, 170 Seltjarnarnes",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Grótta vinstri" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160480': {
    deviceCode: '62160480', deviceName: "Stjarnan", location: "Smáratorg 3, 201 Kópavogur",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Stjarnan" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160481': {
    deviceCode: '62160481', deviceName: "Klettatröð - IWO", location: "Klettatröð 10, 262 Reykjanesbær",
    operatorId: 'op_iwo', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IWO", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Klettatröð - IWO" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160482': {
    deviceCode: '62160482', deviceName: "Hótel Búrfell", location: "Holtagörðum, 104 Reykjavík",
    operatorId: 'op_burfell', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Burfell", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hótel Búrfell" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160483': {
    deviceCode: '62160483', deviceName: "KR", location: "Frostaskjól",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "KR" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160484': {
    deviceCode: '62160484', deviceName: "Grótta hægri", location: "Suðurströnd 8, 170 Seltjarnarnes",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Grótta hægri" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160485': {
    deviceCode: '62160485', deviceName: "Leiknir", location: "",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Leiknir" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160486': {
    deviceCode: '62160486', deviceName: "Golfhermir", location: "Borgartún 24b",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Golfhermir" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160487': {
    deviceCode: '62160487', deviceName: "Íþróttafélag Reykjavíkur", location: "ir@ir.is",
    operatorId: 'op_ir', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ÍR", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Íþróttafélag Reykjavíkur" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160488': {
    deviceCode: '62160488', deviceName: "Evanger", location: "Gránugata 24, 580 Siglufjörður",
    operatorId: 'op_evanger', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Evanger", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Evanger" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160489': {
    deviceCode: '62160489', deviceName: "Valur II", location: "Hlíðarenda, 102 Reykjavík",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valur II" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160490': {
    deviceCode: '62160490', deviceName: "Keflavík", location: "Flugvellir 6",
    operatorId: 'op_kef', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "KEF", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Keflavík" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160491': {
    deviceCode: '62160491', deviceName: "Faxatorg", location: "Faxatorg",
    operatorId: 'op_al', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AL", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Faxatorg" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160492': {
    deviceCode: '62160492', deviceName: "Valhúsaskóli", location: "",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valhúsaskóli" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160493': {
    deviceCode: '62160493', deviceName: "Skjól 1", location: "",
    operatorId: 'op_ag-rekstur', model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Skjól 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160674': {
    deviceCode: '82160674', deviceName: "Reykjalundur", location: "Reykjalundur, 270 Mosfellsbær",
    operatorId: 'op_reykjalundur', model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Reykjalundur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Reykjalundur" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160675': {
    deviceCode: '82160675', deviceName: "Newrest", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Newrest" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160676': {
    deviceCode: '82160676', deviceName: "Hólaskóli", location: "",
    operatorId: 'op_holaskoli', model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Holaskoli", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hólaskóli" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160677': {
    deviceCode: '82160677', deviceName: "Airport Associates", location: "",
    operatorId: 'op_ag-rekstur', model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AG Rekstur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Airport Associates" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160784': {
    deviceCode: '82160784', deviceName: "Hlaðdeild 2", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hlaðdeild 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160785': {
    deviceCode: '82160785', deviceName: "Crew 3", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 3" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160786': {
    deviceCode: '82160786', deviceName: "Crew 1", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160787': {
    deviceCode: '82160787', deviceName: "Crew 2", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160788': {
    deviceCode: '82160788', deviceName: "Hlaðdeild 1", location: "Fálkavellir 2",
    operatorId: 'op_ice', model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hlaðdeild 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
};

// ─── ALERTS ───────────────────────────────────────────────────────────────────
const alerts = [
  { id:'a1', type:'offline', severity:'critical', title:'Machine offline — Gamli Gerpla', detail:'62160042 · offline since 2026-05-19', deviceCode:'62160042', resolved:false, createdAt: new Date(Date.now()-4*86400000).toISOString() },
  { id:'a2', type:'offline', severity:'critical', title:'Machine offline — Leiknir',      detail:'62160485 · offline since 2026-02-20', deviceCode:'62160485', resolved:false, createdAt: new Date(Date.now()-90*86400000).toISOString() },
  { id:'a3', type:'offline', severity:'warning',  title:'Machine offline — Stjarnan',     detail:'62160480 · offline since 2025-07-10', deviceCode:'62160480', resolved:false, createdAt: new Date(Date.now()-316*86400000).toISOString() },
  { id:'a4', type:'kiosk',   severity:'info',     title:'Kiosk app v0.22 ready to deploy',detail:'VM-WM55DL machines on v0.21',         deviceCode:null,       resolved:false, createdAt: new Date(Date.now()-3*3600000).toISOString() },
];

// ─── ORDERS ───────────────────────────────────────────────────────────────────
const orders = [];

// ─── USERS ────────────────────────────────────────────────────────────────────
// Seed AG Vending users; operator admins are invited later
const users = [
  { id:'u1', name:'Sky K.',       email:'sky@agvending.is',       password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all', lastActiveAt: new Date().toISOString() },
  { id:'u2', name:'Jane L.',      email:'jane@agvending.is',      password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all', lastActiveAt: new Date(Date.now()-2*3600000).toISOString() },
  { id:'u3', name:'Mike R.',      email:'mike@agvending.is',      password:'demo', role:'ag_admin', operatorId:'op_ag-vending', machineAccess:'all', lastActiveAt: new Date(Date.now()-86400000).toISOString() },
  // Example operator users for testing scoped access
  { id:'u4', name:'Fylkir Admin', email:'admin@fylkir.is',        password:'demo', role:'operator_admin',   operatorId:'op_fylkir', machineAccess:'all', lastActiveAt: null },
  { id:'u5', name:'ICE Admin',    email:'admin@icelandair.is',    password:'demo', role:'operator_admin',   operatorId:'op_ice',    machineAccess:'all', lastActiveAt: null },
];

// ─── INVITATIONS ──────────────────────────────────────────────────────────────
// Pending user invitations. Indexed by token (single-use, expires in 7 days).
const invitations = new Map(); // token → invitation record

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

function createInvitation({ email, name, role, operatorId, inviterId, machineAccess = 'all' }) {
  const token = 'inv_' + crypto.randomBytes(24).toString('hex');
  const invite = {
    token, email, name, role, operatorId, inviterId, machineAccess,
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITATION_TTL_MS,
    consumedAt: null,
  };
  invitations.set(token, invite);
  return invite;
}

function getInvitation(token) {
  const inv = invitations.get(token);
  if (!inv) return null;
  if (inv.consumedAt) return null;       // already used
  if (inv.expiresAt < Date.now()) return null; // expired
  return inv;
}

function consumeInvitation(token) {
  const inv = invitations.get(token);
  if (inv) inv.consumedAt = Date.now();
}

// Cleanup expired invitations once a day
setInterval(() => {
  const now = Date.now();
  for (const [token, inv] of invitations) {
    if (inv.expiresAt < now - INVITATION_TTL_MS) invitations.delete(token);
  }
}, 24 * 3600 * 1000).unref();

// ─── AUTH TOKENS ──────────────────────────────────────────────────────────────
const authTokens = new Map();

// ─── API CONFIG ───────────────────────────────────────────────────────────────
const apiConfig = {
  appId:     process.env.WEIMI_APP_ID     || '8c98f0207729893439e089e3703b6b37',
  secretKey: process.env.WEIMI_SECRET_KEY || '1M1@#MLH4w#ko1k!/1D$',
  endpoint:  process.env.WEIMI_ENV        || 'prod',
};

// ─── PERMISSION HELPERS ───────────────────────────────────────────────────────

/** Does this user have access to this machine? */
function userCanAccessMachine(user, deviceCode) {
  if (!user) return false;
  const m = machines[deviceCode];
  if (!m) return false;
  // AG Vending sees all
  if (user.role === 'ag_admin') return true;
  // Other users only see their operator's machines
  if (m.operatorId !== user.operatorId) return false;
  // If user has machine-level scoping, check it
  if (user.machineAccess === 'all') return true;
  if (Array.isArray(user.machineAccess)) return user.machineAccess.includes(deviceCode);
  return false;
}

/** Does this user have access to this operator? */
function userCanAccessOperator(user, operatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  return user.operatorId === operatorId;
}

/** Filter a list of machines down to what the user can see. */
function machinesForUser(user) {
  return Object.values(machines).filter(m => userCanAccessMachine(user, m.deviceCode));
}

/** Filter a list of operators down to what the user can see. */
function operatorsForUser(user) {
  if (user.role === 'ag_admin') return Object.values(operators);
  return Object.values(operators).filter(o => o.id === user.operatorId);
}

/** Can this user invite other users to a target operator? */
function userCanInviteTo(user, targetOperatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  if (user.role === 'operator_admin' && user.operatorId === targetOperatorId) return true;
  return false;
}

/** Can this user reassign machines within an operator? */
function userCanReassignWithin(user, operatorId) {
  if (!user) return false;
  if (user.role === 'ag_admin') return true;
  if (user.role === 'operator_admin' && user.operatorId === operatorId) return true;
  return false;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildConfigResponse(machine) {
  return {
    profile: {
      operatorName: machine.profile.operatorName,
      supportEmail: machine.profile.supportEmail,
      supportPhone: machine.profile.supportPhone || null,
      machineLabel: machine.profile.machineLabel || null,
    },
    featured: (machine.featured || []).slice().sort((a,b) => a.order - b.order),
    ads: machine.ads || [],
    configVersion: machine.configVersion,
  };
}

function touchConfig(machine) {
  machine.configVersion = new Date().toISOString();
  machine.updatedAt     = machine.configVersion;
}

module.exports = {
  operators, machines, alerts, orders, users, authTokens, apiConfig,
  machineKeys, provisionMachine, validateMachineKey, revokeKey,
  buildConfigResponse, touchConfig,
  userCanAccessMachine, userCanAccessOperator, machinesForUser, operatorsForUser,
  userCanInviteTo, userCanReassignWithin,
  invitations, createInvitation, getInvitation, consumeInvitation,
};
