/**
 * Snarl & Sopi frá AG Vending — Operator Backend
 * Data store — API Contract v0.1
 *
 * Machine data sourced from Machineops export 2026-05-23.
 * 33 machines across 3 models:
 *   GR-WM22Z680  — Icelandair compact units (5x)
 *   GR-WM22Z1260 — Medium units (4x)
 *   VM-WM55DL    — Standard kiosk with touchscreen, runs the app (24x)
 */

const crypto = require('crypto');

// ─── MACHINE KEYS ─────────────────────────────────────────────────────────────
const machineKeys = {};

function generateMachineKey() {
  return 'mk_live_' + crypto.randomBytes(24).toString('hex');
}

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

// ─── MACHINES (all 33 from Weimi export) ─────────────────────────────────────
const machines = {
  '82160788': {
    deviceCode: '82160788', deviceName: "Hlaðdeild 1", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hlaðdeild 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160787': {
    deviceCode: '82160787', deviceName: "Crew 2", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160786': {
    deviceCode: '82160786', deviceName: "Crew 1", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160785': {
    deviceCode: '82160785', deviceName: "Crew 3", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Crew 3" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160784': {
    deviceCode: '82160784', deviceName: "Hlaðdeild 2", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z680", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hlaðdeild 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160677': {
    deviceCode: '82160677', deviceName: "Airport Associates", location: "",
    operatorName: "IS10001", model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Airport Associates" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160676': {
    deviceCode: '82160676', deviceName: "Hólaskóli", location: "",
    operatorName: "Holaskoli", model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Holaskoli", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hólaskóli" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160675': {
    deviceCode: '82160675', deviceName: "Newrest", location: "Fálkavellir 2",
    operatorName: "ICE", model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ICE", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Newrest" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '82160674': {
    deviceCode: '82160674', deviceName: "Reykjalundur", location: "Reykjalundur, 270 Mosfellsbær",
    operatorName: "Reykjalundur", model: "GR-WM22Z1260", isKioskModel: false,
    isOnline: true, isRunning: true, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Reykjalundur", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Reykjalundur" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160493': {
    deviceCode: '62160493', deviceName: "Skjól 1", location: "",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Skjól 1" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160492': {
    deviceCode: '62160492', deviceName: "Valhúsaskóli", location: "",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valhúsaskóli" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160491': {
    deviceCode: '62160491', deviceName: "Faxatorg", location: "Faxatorg",
    operatorName: "AL", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "AL", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Faxatorg" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160490': {
    deviceCode: '62160490', deviceName: "Keflavík", location: "Flugvellir 6",
    operatorName: "KEF", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "KEF", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Keflavík" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160489': {
    deviceCode: '62160489', deviceName: "Valur II", location: "Hlíðarenda, 102 Reykjavík",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valur II" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160488': {
    deviceCode: '62160488', deviceName: "Evanger", location: "Gránugata 24, 580 Siglufjörður",
    operatorName: "Evanger", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Evanger", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Evanger" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160487': {
    deviceCode: '62160487', deviceName: "Íþróttafélag Reykjavíkur", location: "ir@ir.is",
    operatorName: "ÍR", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "ÍR", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Íþróttafélag Reykjavíkur" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160486': {
    deviceCode: '62160486', deviceName: "Golfhermir", location: "Borgartún 24b",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Golfhermir" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160485': {
    deviceCode: '62160485', deviceName: "Leiknir", location: "",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Leiknir" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160484': {
    deviceCode: '62160484', deviceName: "Grótta hægri", location: "Suðurströnd 8, 170 Seltjarnarnes",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Grótta hægri" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160483': {
    deviceCode: '62160483', deviceName: "KR", location: "Frostaskjól",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "KR" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160482': {
    deviceCode: '62160482', deviceName: "Hótel Búrfell", location: "Holtagörðum, 104 Reykjavík",
    operatorName: "Burfell", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Burfell", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Hótel Búrfell" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160481': {
    deviceCode: '62160481', deviceName: "Klettatröð - IWO", location: "Klettatröð 10, 262 Reykjanesbær",
    operatorName: "IWO", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IWO", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Klettatröð - IWO" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160480': {
    deviceCode: '62160480', deviceName: "Stjarnan", location: "Smáratorg 3, 201 Kópavogur",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Stjarnan" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160479': {
    deviceCode: '62160479', deviceName: "Grótta vinstri", location: "Suðurströnd 8, 170 Seltjarnarnes",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Grótta vinstri" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160478': {
    deviceCode: '62160478', deviceName: "Laugardagshöll", location: "",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Laugardagshöll" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160477': {
    deviceCode: '62160477', deviceName: "Orkan Miklabraut N", location: "Miklabraut",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Orkan Miklabraut N" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160476': {
    deviceCode: '62160476', deviceName: "Mjódd", location: "Þönglabakki 4,109 Reykjavík",
    operatorName: "Bus", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Bus", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Mjódd" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160475': {
    deviceCode: '62160475', deviceName: "Dyrhólaey", location: "",
    operatorName: "Dyrholar", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Dyrholar", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Dyrhólaey" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160474': {
    deviceCode: '62160474', deviceName: "12 Sporahúsið", location: "Vallarkór 12-14, 203 Kópavogur",
    operatorName: "Alanó", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Alanó", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "12 Sporahúsið" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160473': {
    deviceCode: '62160473', deviceName: "F. Skautafélag Akureyrar", location: "",
    operatorName: "FSA", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "FSA", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "F. Skautafélag Akureyrar" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160472': {
    deviceCode: '62160472', deviceName: "Fylkir 2", location: "Fylkisvegi",
    operatorName: "Fylkir", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "Fylkir", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Fylkir 2" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160043': {
    deviceCode: '62160043', deviceName: "Valur I", location: "Hlíðarenda, 102 Reykjavík",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: true, isRunning: true, kioskVersion: '0.21',
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Valur I" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
  '62160042': {
    deviceCode: '62160042', deviceName: "Gamli Gerpla", location: "",
    operatorName: "IS10001", model: "VM-WM55DL", isKioskModel: true,
    isOnline: false, isRunning: false, kioskVersion: null,
    totalCurrStock: 0, maxStock: 0,
    profile: { operatorName: "IS10001", supportEmail: 'hallo@snarlogsopi.is', supportPhone: null, machineLabel: "Gamli Gerpla" },
    featured: [], ads: [], configVersion: '2026-05-22T08:00:00Z',
    settings: { showAdRegion: true, showLeftHero: true, showRightHero: true, showIdleScreen: false, idleTimeoutSeconds: 60, defaultLanguage: 'Icelandic', availableLanguages: ['Icelandic', 'English'], hasHeatedGlass: false, heatedGlassDefaultOn: false, hasLedStrips: false, ledBrightness: 8, motorSerialPort: '/dev/ttyS3', controlBoardAddress: 0 },
    products: [], productOverrides: {},
    createdAt: '2026-05-22T08:00:00Z', updatedAt: '2026-05-22T08:00:00Z',
  },
};

// ─── ALERTS ───────────────────────────────────────────────────────────────────
const alerts = [
  { id:'a1', type:'offline',  severity:'critical', title:'Machine offline — Gamli Gerpla',         detail:'62160042 · offline since 2026-05-19',    deviceCode:'62160042', resolved:false, createdAt: new Date(Date.now()-4*86400000).toISOString() },
  { id:'a2', type:'offline',  severity:'critical', title:'Machine offline — Leiknir',              detail:'62160485 · offline since 2026-02-20',    deviceCode:'62160485', resolved:false, createdAt: new Date(Date.now()-90*86400000).toISOString() },
  { id:'a3', type:'offline',  severity:'warning',  title:'Machine offline — Stjarnan',             detail:'62160480 · offline since 2025-07-10',    deviceCode:'62160480', resolved:false, createdAt: new Date(Date.now()-316*86400000).toISOString() },
  { id:'a4', type:'kiosk',    severity:'info',     title:'Kiosk app v0.22 ready to deploy',        detail:'VM-WM55DL machines on v0.21',            deviceCode:null,       resolved:false, createdAt: new Date(Date.now()-3*3600000).toISOString() },
  { id:'a5', type:'config',   severity:'warning',  title:'Sub-operator name hardcoded in kiosk',  detail:'VendingViewModel — needs backend integration', deviceCode:null, resolved:false, createdAt: new Date(Date.now()-6*3600000).toISOString() },
];

// ─── ORDERS ───────────────────────────────────────────────────────────────────
// Empty initially. Populated by kiosk app via POST /api/v1/machines/:deviceCode/sales
const orders = [];

// ─── USERS ────────────────────────────────────────────────────────────────────
const users = [
  { id:'u1', name:'Sky K.',  email:'sky@agvending.is',  password:'demo', role:'super_admin', machineAccess:'all',     lastActiveAt: new Date().toISOString() },
  { id:'u2', name:'Jane L.', email:'jane@agvending.is', password:'demo', role:'operator',    machineAccess:'group_a', lastActiveAt: new Date(Date.now()-2*3600000).toISOString() },
  { id:'u3', name:'Mike R.', email:'mike@agvending.is', password:'demo', role:'technician',  machineAccess:'all',     lastActiveAt: new Date(Date.now()-86400000).toISOString() },
];

const authTokens = new Map();

const apiConfig = {
  appId:     process.env.WEIMI_APP_ID     || '8c98f0207729893439e089e3703b6b37',
  secretKey: process.env.WEIMI_SECRET_KEY || '1M1@#MLH4w#ko1k!/1D$',
  endpoint:  process.env.WEIMI_ENV        || 'prod',
};

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

module.exports = { machines, alerts, orders, users, authTokens, apiConfig, machineKeys, provisionMachine, validateMachineKey, revokeKey, buildConfigResponse, touchConfig };
