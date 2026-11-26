/**
 * Locker messages (6.128.0): what is sent, what Twilio reports back, and the page the link
 * opens. Twilio is stubbed; numbers, names and orders are invented.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DB_PATH = path.join(os.tmpdir(), 'locker-sms-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';

const { routes } = require('../src/router');
const { machines, storage } = require('../src/db');
const parcels = require('../src/parcels');
const lockerSms = require('../src/lockerSms');

const SENDER = 'MG' + '0123456789abcdef'.repeat(2);
function machine(deviceCode, sms) {
  return { deviceCode, deviceName: 'AG Test', location: 'Prufugata 1', operatorId: 'op-sms-test', model: 'LK-AGV19', isKioskModel: 0,
    isOnline: 1, isRunning: 1, kioskVersion: '', products: [], stockSource: 'kiosk', configVersion: 1,
    settings: { locker: { info: { findNote: 'Í anddyrinu', accessNote: 'Dyrakóði 0000' }, boxes: [{ n: 1, size: 'small', board: 1, lock: 1 }, { n: 2, size: 'small', board: 1, lock: 2 }, { n: 3, size: 'small', board: 1, lock: 3 }], ...(sms ? { sms: { messagingServiceSid: SENDER } } : {}) } },
    profile: { operatorName: 'Test', machineLabel: deviceCode }, featured: [], ads: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
storage.upsertOperator({ id: 'op-sms-test', name: 'SMS test', isAGVending: 0, contactEmail: '', contactPhone: '', address: '', logoUrl: '', createdAt: new Date().toISOString() });
const M = machine('LKS-1', true), BARE = machine('LKS-2', false);
for (const m of [M, BARE]) { storage.upsertMachine(m); machines[m.deviceCode] = m; }
const machineOf = (code) => machines[code];

const sentToTwilio = [];
let nextAnswer = null;
lockerSms._setTransport(async (msg) => {
  sentToTwilio.push(msg);
  return nextAnswer || { ok: true, sid: 'SM' + crypto.randomBytes(16).toString('hex'), status: 'queued' };
});

const T0 = Date.parse('2026-11-25T12:00:00Z');
let seq = 0;
function stored(m, at = T0) {
  const orderNumber = '6' + String(++seq).padStart(4, '0');
  parcels.registerOrder(m.operatorId, { orderNumber, phone: '5550100', firstName: 'Anna' }, at);
  const s = parcels.startDeposit(m, { orderNumber, size: 'small' }, at);
  parcels.finishDeposit(m, s.parcelId, { outcome: 'stored' }, at);
  return { orderNumber, parcelId: s.parcelId, ...parcels._secretsOf(s.parcelId) };
}
const types = (m, id) => parcels.getParcel(m, id).events.map(e => e.type);
function sign(params) {
  const data = lockerSms.callbackUrl() + Object.keys(params).sort().map(k => k + params[k]).join('');
  return crypto.createHmac('sha1', 'test-auth-token').update(data).digest('base64');
}
const form = (params) => new URLSearchParams(params).toString();
const free = (m, id) => parcels.clearParcel(m, id, 'test', {});

test('the first message names the order, the locker, the code and the link, and goes to the parcel\'s number', async () => {
  const p = stored(M);
  const r = await lockerSms.send(M, p.parcelId, 'first', 'backend', T0);
  assert.equal(r.ok, true);
  const msg = sentToTwilio.at(-1);
  assert.equal(msg.to, '+3545550100');
  assert.equal(msg.messagingServiceSid, SENDER);
  assert.equal(msg.body, `Pöntunin þín ${p.orderNumber} er tilbúin í skápnum AG Test. Kóði: ${p.code}. QR-kóði: sms.agvending.is/p/${p.token}`);
  assert.equal(msg.statusCallback, 'https://admin.agvending.is/api/v1/twilio/locker-sms-status');
  const view = parcels.getParcel(M, p.parcelId);
  assert.equal(view.parcel.sms.status, 'queued');
  assert.ok(view.parcel.notifiedAt);
  // The history says a message was accepted, and holds neither the number nor the code.
  assert.deepEqual(types(M, p.parcelId).slice(-1), ['sms_accepted']);
  assert.equal(JSON.stringify(view.events).includes('5550100'), false);
  assert.equal(JSON.stringify(view.events).includes(p.code), false);
  free(M, p.parcelId);
});

test('Twilio\'s reports land in the parcel\'s history, in order, and only when Twilio signed them', async () => {
  const p = stored(M);
  await lockerSms.send(M, p.parcelId, 'first', 'backend', T0);
  const MessageSid = 'SMreport' + p.orderNumber;
  nextAnswer = { ok: true, sid: MessageSid, status: 'queued' };
  await lockerSms.resend(M, p.parcelId, 'op@example.test', T0 + 5 * 60000);
  nextAnswer = null;

  const report = (status, extra) => { const params = { MessageSid, MessageStatus: status, ...(extra || {}) }; return lockerSms.handleReport(form(params), sign(params), T0 + 6 * 60000); };
  assert.equal(lockerSms.handleReport(form({ MessageSid, MessageStatus: 'delivered' }), 'not-a-signature').status, 403);
  assert.equal(lockerSms.handleReport(form({ MessageSid, MessageStatus: 'delivered' }), undefined).status, 403);
  assert.equal(parcels.getParcel(M, p.parcelId).parcel.sms.status, 'queued', 'an unsigned report changes nothing');

  assert.equal(report('sent').status, 204);
  assert.equal(report('delivered').status, 204);
  assert.equal(report('sent').result.ignored, true, 'a late "sent" does not undo "delivered"');
  assert.equal(report('delivered').result.ignored, true, 'the same report twice is one line');
  assert.deepEqual(types(M, p.parcelId).slice(-3), ['sms_accepted', 'sms_sent', 'sms_delivered']);
  assert.equal(parcels.getParcel(M, p.parcelId).parcel.sms.status, 'delivered');
  assert.equal(parcels.getParcel(M, p.parcelId).events.at(-1).actor, 'twilio');
  // A report about a message that is not ours is acknowledged and ignored.
  const other = { MessageSid: 'SMunknown', MessageStatus: 'delivered' };
  assert.equal(lockerSms.handleReport(form(other), sign(other)).result.unknown, true);
  free(M, p.parcelId);
});

test('a message that does not arrive is recorded with Twilio\'s error code', async () => {
  const p = stored(M);
  nextAnswer = { ok: true, sid: 'SMfail' + p.orderNumber, status: 'queued' };
  await lockerSms.send(M, p.parcelId, 'first', 'backend', T0);
  nextAnswer = null;
  const params = { MessageSid: 'SMfail' + p.orderNumber, MessageStatus: 'undelivered', ErrorCode: '30003' };
  lockerSms.handleReport(form(params), sign(params), T0 + 60000);
  const last = parcels.getParcel(M, p.parcelId).events.at(-1);
  assert.equal(last.type, 'sms_undelivered');
  assert.match(last.detail, /error 30003/);
  assert.equal(parcels.getParcel(M, p.parcelId).parcel.sms.errorCode, '30003');
  free(M, p.parcelId);
});

test('when nothing can be sent the history says why, and nothing reaches Twilio', async () => {
  const before = sentToTwilio.length;
  const bare = stored(BARE);
  const r = await lockerSms.send(BARE, bare.parcelId, 'first', 'backend', T0);
  assert.equal(r.code, 'no_sender');
  assert.equal(parcels.getParcel(BARE, bare.parcelId).events.at(-1).type, 'sms_not_sent');
  assert.match(parcels.getParcel(BARE, bare.parcelId).events.at(-1).detail, /no SMS sender/);

  const p = stored(M);
  nextAnswer = { ok: false, error: 'Twilio 400 code 21211' };
  const refused = await lockerSms.send(M, p.parcelId, 'first', 'backend', T0);
  nextAnswer = null;
  assert.equal(refused.code, 'twilio_refused');
  assert.equal(refused.status, 424);
  assert.match(parcels.getParcel(M, p.parcelId).events.at(-1).detail, /21211/);
  assert.equal(parcels.getParcel(M, p.parcelId).parcel.notifiedAt, null);

  const saved = process.env.TWILIO_AUTH_TOKEN; process.env.TWILIO_AUTH_TOKEN = '';
  assert.equal((await lockerSms.send(M, p.parcelId, 'first', 'backend', T0)).code, 'sms_not_configured');
  process.env.TWILIO_AUTH_TOKEN = saved;
  assert.equal(sentToTwilio.length, before + 1, 'only the call Twilio refused went out');

  parcels.markCollected(M, p.parcelId, 'op@example.test', T0);
  assert.equal((await lockerSms.send(M, p.parcelId, 'first', 'backend', T0)).code, 'wrong_state');
  assert.equal((await lockerSms.send(BARE, p.parcelId, 'first', 'backend', T0)).code, 'parcel_not_found');
  free(BARE, bare.parcelId);
});

test('one reminder after 48 hours, by day, and never a second', async () => {
  const p = stored(M, T0), young = stored(M, T0 + 40 * 3600000);
  const n = () => sentToTwilio.length;
  let before = n();
  await lockerSms.remindWaiting(machineOf, T0 + 47 * 3600000);
  assert.equal(n(), before, 'not before 48 hours');
  const night = await lockerSms.remindWaiting(machineOf, Date.parse('2026-11-28T03:00:00Z'));
  assert.equal(night.skipped, 'outside hours');
  assert.equal(n(), before);
  const day = await lockerSms.remindWaiting(machineOf, Date.parse('2026-11-28T10:30:00Z'));
  assert.equal(day.sent, 1, 'the parcel stored 30 hours ago is not reminded');
  const msg = sentToTwilio.find(m => m.body.startsWith('Áminning') && m.body.includes(p.orderNumber));
  assert.equal(msg.body, `Áminning: Pöntunin þín ${p.orderNumber} bíður þín enn í skápnum AG Test. Kóði: ${p.code}. QR-kóði: sms.agvending.is/p/${p.token}`);
  before = n();
  await lockerSms.remindWaiting(machineOf, Date.parse('2026-11-29T10:30:00Z'));
  assert.equal(sentToTwilio.slice(before).filter(m => m.body.includes(p.orderNumber)).length, 0, 'no second reminder');
  assert.ok(types(M, p.parcelId).includes('reminder_attempted'));
  free(M, p.parcelId); free(M, young.parcelId);
});

test('an operator can send the message again, but not within a minute', async () => {
  const p = stored(M);
  await lockerSms.send(M, p.parcelId, 'first', 'backend', T0);
  assert.equal((await lockerSms.resend(M, p.parcelId, 'op@example.test', T0 + 30000)).code, 'too_soon');
  const r = await lockerSms.resend(M, p.parcelId, 'op@example.test', T0 + 90000);
  assert.equal(r.ok, true);
  assert.equal(parcels.getParcel(M, p.parcelId).events.at(-1).actor, 'op@example.test');
  free(M, p.parcelId);
});

test('the page behind the link shows the QR code, the code and the locker; afterwards only that it was collected', async () => {
  const p = stored(M);
  const page = await lockerSms.pickupPage(p.token, machineOf);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('PÖNTUN ' + p.orderNumber));
  assert.ok(page.html.includes(p.code.slice(0, 3) + ' ' + p.code.slice(3)));
  assert.ok(page.html.includes('<svg'));
  assert.ok(page.html.includes('Í anddyrinu') && page.html.includes('Dyrakóði 0000') && page.html.includes('Opna á korti'));
  assert.equal(page.html.includes('5550100'), false, 'the phone number is not on the page');
  assert.equal((await lockerSms.pickupPage(p.token.toUpperCase(), machineOf)).status, 200);

  const s = parcels.startPickup(M, { scan: 'https://sms.agvending.is/p/' + p.token }, T0);
  parcels.finishPickup(M, s.parcelId, { opened: true }, T0);
  const after = await lockerSms.pickupPage(p.token, machineOf);
  assert.ok(after.html.includes('Pöntunin hefur verið sótt'));
  assert.equal(after.html.includes(p.code.slice(0, 3) + ' ' + p.code.slice(3)), false);
  assert.equal(after.html.includes('Dyrakóði'), false, 'the access note is gone with the parcel');

  for (const bad of ['abcdefgh2345', 'short', '../../etc', '']) assert.equal((await lockerSms.pickupPage(bad, machineOf)).status, 404);
  const cleared = stored(M); free(M, cleared.parcelId);
  assert.equal((await lockerSms.pickupPage(cleared.token, machineOf)).status, 404);
});

test('markup in what an operator typed cannot reach the page as markup', async () => {
  const p = stored(M);
  const nasty = JSON.parse(JSON.stringify(machineOf('LKS-1')));
  nasty.settings.locker.info.accessNote = '<script>alert(1)</script>';
  const page = await lockerSms.pickupPage(p.token, () => nasty);
  assert.equal(page.html.includes('<script>alert'), false);
  assert.ok(page.html.includes('&lt;script&gt;'));
  free(M, p.parcelId);
});

test('routes: the report and the page are open, resending needs a signed-in user, and AG alone sets the sender', () => {
  const find = (m, p) => routes.find(r => r.method === m && r.pattern === p);
  assert.deepEqual(find('POST', lockerSms.CALLBACK_PATH).middleware, []);
  assert.deepEqual(find('GET', '/p/:token').middleware, []);
  assert.deepEqual(find('POST', '/api/v1/machines/:deviceCode/locker/parcels/:id/sms').middleware.map(f => f.name), ['requireAuth', 'requireMachineAccess']);

  const put = (body, role) => {
    let status = 0, text = '';
    const res = { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } };
    find('PUT', '/api/v1/machines/:deviceCode/locker').handler({ params: { deviceCode: 'LKS-2' }, body, query: {}, headers: {}, user: { role, email: 'someone@example.test', operatorId: 'op-sms-test' } }, res);
    return { status, body: JSON.parse(text) };
  };
  assert.equal(put({ sms: { messagingServiceSid: SENDER } }, 'operator_admin').status, 403);
  assert.equal(put({ sms: { messagingServiceSid: 'nonsense' } }, 'ag_admin').status, 400);
  const ok = put({ sms: { messagingServiceSid: SENDER } }, 'ag_admin');
  assert.equal(ok.body.data.sms.messagingServiceSid, SENDER);
  // Changing the details afterwards keeps the sender.
  assert.equal(put({ info: { findNote: 'Við innganginn' } }, 'operator_admin').body.data.sms.messagingServiceSid, SENDER);
  assert.equal(storage.getMachine('LKS-2').settings.locker.sms.messagingServiceSid, SENDER);

  // An unsigned report through the route is refused.
  let status = 0;
  find('POST', lockerSms.CALLBACK_PATH).handler({ rawBody: 'MessageSid=SMx&MessageStatus=delivered', headers: {}, params: {}, query: {} }, { writeHead(s) { status = s; }, end() {} });
  assert.equal(status, 403);
});

// ── 6.129.0: the wording is the locker's own ──────────────────────────────────────────────────

test('an operator writes the locker\'s messages; a locker without its own wording keeps the default', async () => {
  const lockers = require('../src/lockers');
  const find = (m, p) => routes.find(r => r.method === m && r.pattern === p);
  const put = (body) => {
    let status = 0, text = '';
    find('PUT', '/api/v1/machines/:deviceCode/locker').handler({ params: { deviceCode: 'LKS-1' }, body, query: {}, headers: {}, user: { role: 'operator_admin', email: 'op@example.test', operatorId: 'op-sms-test' } },
      { writeHead(s) { status = s; }, end(b) { text = b ? b.toString() : ''; } });
    return { status, body: JSON.parse(text) };
  };
  assert.equal(put({ messages: { first: 'Sendingin er komin.' } }).status, 400, 'a message without {code} cannot open a box');
  assert.equal(put({ messages: { first: 'Kóði {code}, {kodi}' } }).status, 400, 'a mistyped field is caught');
  assert.equal(put({ messages: { third: 'Kóði {code}' } }).status, 400);
  assert.equal(put({ messages: { first: 'x{code}'.padEnd(lockers.MESSAGE_MAX + 1, 'x') } }).status, 400);

  const saved = put({ messages: { first: 'Hæ! Pöntun {order} bíður í {locker}. Kóði {code} eða {link}' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.messagesCustom.first, true);
  assert.equal(saved.body.data.messagesCustom.reminder, false);
  assert.equal(saved.body.data.messages.reminder, lockers.DEFAULT_MESSAGES.reminder);
  assert.equal(saved.body.data.sms.messagingServiceSid, SENDER, 'the sender is untouched');

  const p = stored(machineOf('LKS-1'));
  await lockerSms.send(machineOf('LKS-1'), p.parcelId, 'first', 'backend', T0);
  assert.equal(sentToTwilio.at(-1).body, `Hæ! Pöntun ${p.orderNumber} bíður í AG Test. Kóði ${p.code} eða sms.agvending.is/p/${p.token}`);
  await lockerSms.send(machineOf('LKS-1'), p.parcelId, 'reminder', 'backend', T0 + 120000);
  assert.ok(sentToTwilio.at(-1).body.startsWith('Áminning: '), 'the reminder is still the default');

  // An empty string puts the message back to the default.
  const back = put({ messages: { first: '' } });
  assert.equal(back.body.data.messagesCustom.first, false);
  assert.equal(back.body.data.messages.first, lockers.DEFAULT_MESSAGES.first);
  free(machineOf('LKS-1'), p.parcelId);
});
