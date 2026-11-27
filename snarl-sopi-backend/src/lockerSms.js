'use strict';
/**
 * The messages a parcel locker sends, and the page they link to.
 *
 *   first     when the door closes on a parcel: the order is ready, with the code and the link
 *   reminder  once, when a parcel has waited 48 hours
 *   resend    the first message again, when an operator asks
 *   removed   the parcel was taken back out before pickup, when the operator chooses to say so
 *
 * Messages go through Twilio, from the Messaging Service set on the locker (settings.locker.sms).
 * Twilio is asked to report back on every message; each report (sent, delivered, undelivered,
 * failed, with Twilio's error code) is written to the parcel's history by src/parcels.js. "We
 * handed it to Twilio" and "it reached the phone" are different lines there.
 *
 * Environment:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   without both nothing is sent, and the history says so
 *   LOCKER_SMS_LINK_BASE      what the link in the SMS starts with (default sms.agvending.is)
 *   LOCKER_SMS_CALLBACK_BASE  where Twilio reaches this backend (default https://admin.agvending.is)
 */
const crypto = require('crypto');
const QRCode = require('qrcode');
const parcels = require('./parcels');
const lockers = require('./lockers');
const AG_LOGO = require('./agLogo');

const REMINDER_AFTER_HOURS = 48;
const REMINDER_HOURS_UTC = [10, 18];   // reminders go out by day, Iceland time (UTC)
const RESEND_GAP_MS = 60 * 1000;
const CALLBACK_PATH = '/api/v1/twilio/locker-sms-status';

const cfg = () => ({
  sid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
  token: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
  linkBase: (process.env.LOCKER_SMS_LINK_BASE || 'sms.agvending.is').trim().replace(/\/+$/, ''),
  callbackBase: (process.env.LOCKER_SMS_CALLBACK_BASE || 'https://admin.agvending.is').trim().replace(/\/+$/, ''),
});
const callbackUrl = () => cfg().callbackBase + CALLBACK_PATH;

// ── Wording ──────────────────────────────────────────────

// The wording is the locker's own (settings.locker.messages), with defaults in src/lockers.js.
function messageText(kind, f, record, linkBase) {
  const template = record.messages[kind === 'resend' ? 'first' : kind] || record.messages.first;
  return lockers.fillMessage(template, { order: f.orderNumber, locker: record.info.name, code: f.code, link: `${linkBase}/p/${f.token}` });
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────

/** The one place that talks to Twilio; tests replace it. Resolves { ok, sid, status } or { ok:false, error }. */
let transport = async function twilioSend({ accountSid, authToken, messagingServiceSid, to, body, statusCallback }) {
  const form = new URLSearchParams({ To: to, MessagingServiceSid: messagingServiceSid, Body: body, StatusCallback: statusCallback });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form, signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sid) return { ok: false, error: `Twilio ${res.status}${data.code ? ' code ' + data.code : ''}` };
  return { ok: true, sid: data.sid, status: data.status || 'queued' };
};

/**
 * Sends one message for a parcel. Every outcome is written to the parcel's history; the phone
 * number and the message text never are, and neither is logged.
 */
async function send(machine, parcelId, kind, actor, now = Date.now()) {
  const f = parcels.smsFacts(parcelId);
  if (!f || f.deviceCode !== machine.deviceCode) return { ok: false, status: 404, code: 'parcel_not_found', error: 'No such parcel at this locker.' };
  // A parcel in its box can be announced; one the operator took back out can be told so, once it is out.
  const fits = kind === 'removed' ? f.state === 'cleared' : f.state === 'stored';
  if (!fits) return { ok: false, status: 409, code: 'wrong_state', error: `This parcel is ${f.state}; there is nothing to tell the customer.` };
  if (kind === 'reminder') parcels.noteEvent(f.id, 'reminder_attempted', actor, null, now);
  const refuse = (code, error, status) => { parcels.noteEvent(f.id, 'sms_not_sent', actor, `${kind}: ${error}`, now); return { ok: false, status: status || 424, code, error }; };
  const c = cfg();
  if (!c.sid || !c.token) return refuse('sms_not_configured', 'the backend has no Twilio login', 503);
  const record = lockers.lockerRecord(machine);
  if (!record.sms.messagingServiceSid) return refuse('no_sender', 'this locker has no SMS sender set', 409);
  if (!f.phone) return refuse('no_phone', 'the parcel has no phone number', 409);
  let r;
  try {
    r = await transport({ accountSid: c.sid, authToken: c.token, messagingServiceSid: record.sms.messagingServiceSid, to: f.phone,
                          body: record.sms.plainLetters ? lockers.plainLetters(messageText(kind, f, record, c.linkBase)) : messageText(kind, f, record, c.linkBase),
                          statusCallback: callbackUrl() });
  } catch (e) { r = { ok: false, error: 'Twilio could not be reached' }; }
  if (!r.ok) return refuse('twilio_refused', r.error || 'Twilio refused the message');
  parcels.smsAccepted(f.id, r.sid, kind, r.status, actor, now);
  return { ok: true, kind, status: r.status };
}

/** An operator asks for the message again. Not within a minute of the last one. */
async function resend(machine, parcelId, who, now = Date.now()) {
  const f = parcels.smsFacts(parcelId);
  if (f && f.lastSms && now - Date.parse(f.lastSms.createdAt) < RESEND_GAP_MS) {
    return { ok: false, status: 429, code: 'too_soon', error: 'A message was sent to this customer less than a minute ago.' };
  }
  return send(machine, parcelId, 'resend', who || 'operator', now);
}

/** One reminder per parcel that has waited 48 hours, sent by day. */
async function remindWaiting(machineOf, now = Date.now()) {
  const hour = new Date(now).getUTCHours();
  if (hour < REMINDER_HOURS_UTC[0] || hour >= REMINDER_HOURS_UTC[1]) return { sent: 0, failed: 0, skipped: 'outside hours' };
  let sent = 0, failed = 0;
  for (const id of parcels.parcelsNeedingReminder(REMINDER_AFTER_HOURS, now)) {
    const f = parcels.smsFacts(id), m = f && machineOf(f.deviceCode);
    if (!m) continue;
    const r = await send(m, id, 'reminder', 'backend', now);
    if (r.ok) sent++; else failed++;
  }
  return { sent, failed };
}

// ── Twilio's delivery reports ─────────────────────────────────────────────────────────────────

/** Twilio signs each report: HMAC-SHA1 over the URL it called and the sorted form fields. */
function signatureValid(url, params, given, authToken) {
  if (!given || !authToken) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = Buffer.from(crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64'));
  const actual = Buffer.from(String(given));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Handles the raw body of a report. Returns { status } for the HTTP answer. */
function handleReport(rawBody, signature, now = Date.now()) {
  const params = Object.fromEntries(new URLSearchParams(String(rawBody || '')));
  if (!signatureValid(callbackUrl(), params, signature, cfg().token)) return { status: 403 };
  const r = parcels.smsReport(params.MessageSid || params.SmsSid, params.MessageStatus || params.SmsStatus, params.ErrorCode, now);
  return { status: 204, result: r };
}

// ── The page the link opens ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function shell(title, body) {
  return `<!doctype html><html lang="is"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@500;600;700;800;900&display=swap">
<style>
*{box-sizing:border-box}body{margin:0;background:#FFFFFF;color:#111111;font-family:'Libre Franklin',system-ui,sans-serif;font-weight:600}
main{max-width:460px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column}
header{padding:20px 24px 16px;border-bottom:2px solid #111111;display:flex;align-items:center;gap:10px;font-size:13px;font-weight:800;letter-spacing:1.5px}
header i{width:16px;height:16px;background:#FFC72C;display:block}
section{flex:1;display:flex;flex-direction:column;gap:14px;padding:24px}
h1{margin:0;font-size:40px;line-height:40px;font-weight:900;letter-spacing:-1.4px}
p{margin:0;font-size:17px;line-height:24px;color:#555555}
.qr{align-self:center;margin-top:6px;padding:14px;border:2px solid #111111;display:flex}.qr svg{width:204px;height:204px;display:block}
.code{display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-top:2px solid #111111;padding-top:14px;margin-top:6px}
.code span{font-size:15px;color:#555555}.code b{font-size:34px;line-height:36px;font-weight:900;letter-spacing:3px;font-variant-numeric:tabular-nums;white-space:nowrap}
.locker{margin-top:auto;display:flex;flex-direction:column;gap:4px;background:#F3F0EB;padding:16px}
.locker small{font-size:13px;font-weight:800;letter-spacing:1.5px}.locker strong{font-size:18px;line-height:24px;font-weight:800}
.locker span{font-size:15px;line-height:21px;color:#555555}.locker .note{color:#111111;border-top:2px solid #E2DED7;padding-top:8px;margin-top:6px}
a{color:#111111;font-size:15px;font-weight:800;margin-top:4px}
footer{padding:18px 24px 26px;display:flex;justify-content:center}
footer a{display:flex;align-items:center;gap:10px;margin:0;font-size:12px;font-weight:700;letter-spacing:.4px;color:#555555;text-decoration:none}
footer img{height:30px;width:auto;display:block}
</style></head><body><main>${body}<footer><a href="https://agvending.is" rel="noopener">Knúið áfram af <img src="${AG_LOGO}" alt="AG Vending"></a></footer></main></body></html>`;
}

function lockerBlock(info) {
  if (!info || !(info.name || info.address)) return '';
  const where = [info.address, info.findNote].filter(Boolean).join(', ');
  return `<div class="locker"><small>SKÁPURINN</small><strong>${esc(info.name)}</strong>` +
    (where ? `<span>${esc(where)}</span>` : '') +
    (info.accessNote ? `<span class="note">${esc(info.accessNote)}</span>` : '') +
    (info.mapUrl ? `<a href="${esc(info.mapUrl)}" rel="noopener noreferrer">Opna á korti</a>` : '') + '</div>';
}

/**
 * The page behind an SMS link: { status, html }. The link in the QR code is the same link the
 * customer opened, so the locker reads the token from it. An unknown link and a link whose
 * parcel has been forgotten look the same.
 */
async function pickupPage(token, machineOf) {
  const p = /^[a-z0-9]{12}$/i.test(String(token || '')) ? parcels.byToken(token) : null;
  if (!p || (p.state !== 'stored' && p.state !== 'collected')) {
    return { status: 404, html: shell('Hlekkur fannst ekki', '<header><i></i>AFHENDINGARSKÁPUR</header><section><h1>Hlekkurinn er ekki lengur virkur</h1><p>Þessi hlekkur á ekki við pöntun sem bíður í skáp.</p></section>') };
  }
  const m = machineOf(p.deviceCode), info = m ? lockers.publicInfo(m) : null;
  const head = `<header><i></i>PÖNTUN ${esc(p.orderNumber)}</header>`;
  if (p.state === 'collected') {
    return { status: 200, html: shell('Pöntun sótt', head + '<section><h1>Pöntunin hefur verið sótt</h1><p>Hólfið hefur þegar verið opnað með þessum kóða.</p></section>') };
  }
  const c = cfg();
  const link = `https://${c.linkBase.replace(/^https?:\/\//, '')}/p/${p.token}`;
  const svg = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
  const code = String(p.code || '');
  return { status: 200, html: shell('Pöntunin þín er tilbúin', head +
    `<section><h1>Pöntunin þín er tilbúin</h1><p>Haltu QR-kóðanum að skannanum á skápnum og hólfið opnast.</p>` +
    `<div class="qr" role="img" aria-label="QR-kóði til að sækja pöntun ${esc(p.orderNumber)}">${svg}</div>` +
    `<div class="code"><span>Eða sláðu inn kóðann</span><b>${esc(code.slice(0, 3))} ${esc(code.slice(3))}</b></div>` +
    lockerBlock(info) + '</section>') };
}

module.exports = {
  REMINDER_AFTER_HOURS, CALLBACK_PATH, messageText, send, resend, remindWaiting, signatureValid, handleReport, pickupPage, callbackUrl,
  _setTransport(fn) { transport = fn; },
};
