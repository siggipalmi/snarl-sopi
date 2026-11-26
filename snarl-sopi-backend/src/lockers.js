'use strict';
/**
 * What a parcel locker is, beyond being a machine: where it stands and which boxes it has.
 *
 * Everything a customer is told about a locker (its name, its address, how to find it, how to
 * get in after hours) is data the operator enters, never text in the code. The first locker
 * SMS carried one site's after-hours door code in a string literal; this record is where that
 * kind of thing lives instead. It is kept on the machine, in `settings.locker`.
 *
 * This module is pure: it checks and shapes the record and knows nothing of storage or routes.
 */

const BOX_SIZES = ['small', 'middle', 'big'];
const MAX_BOXES = 128;

// Field → longest value accepted. The SMS and the pickup page both show these, so they are
// kept short enough to fit a phone screen.
const INFO_TEXT_FIELDS = {
  name: 60,        // what customers know the locker as
  address: 120,    // street and number, postcode and town
  findNote: 120,   // where it stands on the site
  accessNote: 240, // anything needed to reach it, such as an after-hours door code
  helpPhone: 20,   // shown when a code is not recognised
};

function fail(error) { return { ok: false, error }; }

function cleanText(value) {
  // One line, no control characters, outer space trimmed.
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Checks the fields of a locker's customer-facing info. Only the fields present in `input` are
 * returned, so a caller can change one without sending the rest. An empty string clears a field.
 */
function normalizeInfo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('info must be an object');
  const out = {};
  for (const [field, max] of Object.entries(INFO_TEXT_FIELDS)) {
    if (input[field] === undefined) continue;
    const text = cleanText(input[field]);
    if (text.length > max) return fail(`${field} is too long (${text.length} characters, at most ${max})`);
    if (field === 'helpPhone' && text && !/^\+?[0-9 ]{3,}$/.test(text)) return fail('helpPhone may hold digits, spaces and a leading + only');
    out[field] = text;
  }
  // The map position is optional, and it is both numbers or neither.
  const hasLat = input.lat !== undefined, hasLng = input.lng !== undefined;
  if (hasLat !== hasLng) return fail('lat and lng go together');
  if (hasLat) {
    if (input.lat === null && input.lng === null) { out.lat = null; out.lng = null; }
    else {
      const lat = Number(input.lat), lng = Number(input.lng);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return fail('lat must be a number from -90 to 90');
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return fail('lng must be a number from -180 to 180');
      out.lat = lat; out.lng = lng;
    }
  }
  const unknown = Object.keys(input).filter(k => !(k in INFO_TEXT_FIELDS) && k !== 'lat' && k !== 'lng');
  if (unknown.length) return fail(`unknown info field: ${unknown.join(', ')}`);
  return { ok: true, value: out };
}

/**
 * Checks a locker's box list: [{ n, size, board?, lock? }].
 *   n      the number printed on the door and shown to people, unique
 *   size   small | middle | big
 *   board  lock board address, from 1 (default 1)
 *   lock   lock number on that board, from 1 (default n); a board + lock pair is unique
 * Returned sorted by n. The list replaces the stored one whole: boxes are hardware, and a
 * half-updated list would point a customer at the wrong door.
 */
function normalizeBoxes(input) {
  if (!Array.isArray(input)) return fail('boxes must be a list');
  if (input.length === 0) return fail('boxes must not be empty');
  if (input.length > MAX_BOXES) return fail(`at most ${MAX_BOXES} boxes`);
  const seenN = new Set(), seenLock = new Set(), out = [];
  for (const [i, b] of input.entries()) {
    if (!b || typeof b !== 'object') return fail(`box ${i + 1} must be an object`);
    const n = Number(b.n);
    if (!Number.isInteger(n) || n < 1 || n > 999) return fail(`box ${i + 1}: n must be a whole number from 1 to 999`);
    if (!BOX_SIZES.includes(b.size)) return fail(`box ${n}: size must be one of ${BOX_SIZES.join(', ')}`);
    const board = b.board === undefined ? 1 : Number(b.board);
    const lock = b.lock === undefined ? n : Number(b.lock);
    if (!Number.isInteger(board) || board < 1 || board > 255) return fail(`box ${n}: board must be a whole number from 1 to 255`);
    if (!Number.isInteger(lock) || lock < 1 || lock > 255) return fail(`box ${n}: lock must be a whole number from 1 to 255`);
    if (seenN.has(n)) return fail(`box ${n} is listed twice`);
    const key = board + ':' + lock;
    if (seenLock.has(key)) return fail(`box ${n}: board ${board} lock ${lock} already belongs to another box`);
    seenN.add(n); seenLock.add(key);
    out.push({ n, size: b.size, board, lock });
  }
  out.sort((a, b) => a.n - b.n);
  return { ok: true, value: out };
}

/**
 * Which Twilio Messaging Service a locker's messages go out through: { messagingServiceSid }.
 * An empty string clears it. Set by AG: it decides the sender customers see.
 */
function normalizeSms(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('sms must be an object');
  const sid = cleanText(input.messagingServiceSid);
  if (sid && !/^MG[0-9a-f]{32}$/i.test(sid)) return fail('messagingServiceSid must be MG followed by 32 hex characters');
  return { ok: true, value: { messagingServiceSid: sid } };
}

// The wording of a locker's messages. {order} {locker} {code} {link} are filled in when one is
// sent. These are what a locker says until its operator writes something else.
const DEFAULT_MESSAGES = {
  first: 'Pöntunin þín {order} er tilbúin í skápnum {locker}. Kóði: {code}. QR-kóði: {link}',
  reminder: 'Áminning: Pöntunin þín {order} bíður þín enn í skápnum {locker}. Kóði: {code}. QR-kóði: {link}',
};
const MESSAGE_MAX = 320;
const MESSAGE_FIELDS = ['order', 'locker', 'code', 'link'];

/**
 * Checks message wording: { first?, reminder? }. An empty string puts a message back to the
 * default. A message must carry {code}, or the customer cannot open the box with it, and may
 * use only the four known fields, so a typo like {kodi} is caught here and not on a phone.
 */
function normalizeMessages(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('messages must be an object');
  const out = {};
  for (const kind of Object.keys(input)) {
    if (!(kind in DEFAULT_MESSAGES)) return fail(`unknown message: ${kind}`);
    const text = cleanText(input[kind]);
    if (text.length > MESSAGE_MAX) return fail(`${kind} is too long (${text.length} characters, at most ${MESSAGE_MAX})`);
    if (text) {
      const unknown = (text.match(/\{[^{}]*\}/g) || []).filter(f => !MESSAGE_FIELDS.includes(f.slice(1, -1)));
      if (unknown.length) return fail(`${kind}: ${unknown[0]} is not a field. Use ${MESSAGE_FIELDS.map(f => '{' + f + '}').join(' ')}`);
      if (!text.includes('{code}')) return fail(`${kind} must contain {code}, the customer's pickup code`);
    }
    out[kind] = text;
  }
  return { ok: true, value: out };
}

/** A message with its fields filled in. An empty locker name leaves no gap behind. */
function fillMessage(template, values) {
  return String(template).replace(/\{(order|locker|code|link)\}/g, (m, k) => String(values[k] == null ? '' : values[k]))
    .replace(/\s+/g, ' ').replace(/ ([.,!?])/g, '$1').trim();
}

function boxCounts(boxes) {
  const counts = { small: 0, middle: 0, big: 0 };
  for (const b of boxes || []) if (counts[b.size] !== undefined) counts[b.size]++;
  return counts;
}

/**
 * A link that opens the locker's place in a map: its position when one is set, else its
 * address; null when there is neither.
 */
function mapUrl(info) {
  if (!info) return null;
  if (Number.isFinite(info.lat) && Number.isFinite(info.lng)) return `https://www.google.com/maps/search/?api=1&query=${info.lat},${info.lng}`;
  if (info.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(info.address)}`;
  return null;
}

/**
 * The locker record of a machine, with the machine's own name and location standing in where
 * the operator has entered nothing yet.
 */
function lockerRecord(machine) {
  const stored = (machine && machine.settings && machine.settings.locker) || {};
  const s = stored.info || {};
  const info = {
    name: s.name || (machine && machine.deviceName) || '',
    address: s.address || (machine && machine.location) || '',
    findNote: s.findNote || '',
    accessNote: s.accessNote || '',
    helpPhone: s.helpPhone || '',
    lat: Number.isFinite(s.lat) ? s.lat : null,
    lng: Number.isFinite(s.lng) ? s.lng : null,
  };
  const boxes = Array.isArray(stored.boxes) ? stored.boxes : [];
  return {
    deviceCode: machine ? machine.deviceCode : null,
    info, mapUrl: mapUrl(info),
    boxes, boxCounts: boxCounts(boxes),
    sms: { messagingServiceSid: (stored.sms && stored.sms.messagingServiceSid) || '' },
    messages: { first: (stored.messages && stored.messages.first) || DEFAULT_MESSAGES.first,
                reminder: (stored.messages && stored.messages.reminder) || DEFAULT_MESSAGES.reminder },
    messagesCustom: { first: !!(stored.messages && stored.messages.first), reminder: !!(stored.messages && stored.messages.reminder) },
    updatedAt: stored.updatedAt || null, updatedBy: stored.updatedBy || null,
  };
}

/** What a customer may be shown about a locker: no box wiring, no editor's name. */
function publicInfo(machine) {
  const r = lockerRecord(machine);
  return { name: r.info.name, address: r.info.address, findNote: r.info.findNote, accessNote: r.info.accessNote,
           helpPhone: r.info.helpPhone, mapUrl: r.mapUrl };
}

/**
 * Applies a change to a machine's stored locker record and returns the new `settings.locker`.
 * `change` is { info?, boxes?, sms? }, all already normalised. Info fields merge; the rest replace.
 */
function applyChange(machine, change, who, nowIso) {
  const stored = (machine.settings && machine.settings.locker) || {};
  const next = { info: { ...(stored.info || {}) }, boxes: Array.isArray(stored.boxes) ? stored.boxes : [] };
  if (change.info) {
    for (const [k, v] of Object.entries(change.info)) {
      if (v === '' || v === null) delete next.info[k]; else next.info[k] = v;
    }
  }
  if (change.boxes) next.boxes = change.boxes;
  if (stored.sms) next.sms = stored.sms;
  if (change.sms) next.sms = change.sms;
  if (stored.messages || change.messages) {
    next.messages = { ...(stored.messages || {}) };
    for (const [k, v] of Object.entries(change.messages || {})) { if (v) next.messages[k] = v; else delete next.messages[k]; }
  }
  next.updatedAt = nowIso;
  next.updatedBy = who || null;
  return next;
}

module.exports = { BOX_SIZES, MAX_BOXES, INFO_TEXT_FIELDS, normalizeInfo, normalizeBoxes, normalizeSms, normalizeMessages, fillMessage, DEFAULT_MESSAGES, MESSAGE_MAX, boxCounts, mapUrl,
                   lockerRecord, publicInfo, applyChange };
