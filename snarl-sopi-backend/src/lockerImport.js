'use strict';
/**
 * Taking over a locker that is already in use (6.145.0).
 *
 * A locker run by its maker's system has parcels in it, and their customers hold pickup codes
 * that system sent. When the locker moves to this backend those parcels come along: each is
 * recorded as stored in its box, with the code the customer already has, and nothing is sent.
 *
 * This file reads the previous system's export (MINNO's "table" download: CSV text whatever
 * the file is called). src/parcels.js does the recording.
 */
const parcels = require('./parcels');

const MAX_ROWS = 500;

/** RFC-4180-ish: quoted fields, doubled quotes, CR/LF. Returns rows of strings. */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

const COLUMNS = { orderNumber: 'parcel number', box: 'box no.', storedAt: 'delivery time', phone: 'receiver phone', code: 'pickup code', device: 'device id', status: 'status' };

/** "2026-11-26 10:20:47.687", on a clock that is Iceland's (UTC): epoch ms, or null. */
function parseTime(value) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(value || ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, sec || 0);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * MINNO names a box by its site, a group letter, the lock's number in two digits and one more
 * digit: "A0109002B211" is group B, lock 21. Group A is lock board 1, B is board 2.
 */
function parseBox(value) {
  const m = /([A-Z])(\d{2})\d$/.exec(String(value || '').trim().toUpperCase());
  return m ? { board: m[1].charCodeAt(0) - 64, lock: Number(m[2]), label: m[1] + m[2] } : null;
}

/**
 * The export as rows for parcels.importStored: [{ line, box:{board,lock}, label, orderNumber,
 * phone, code, storedAt }]. A file that is not this export is refused whole.
 */
function readMinnoExport(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { ok: false, status: 400, code: 'bad_file', error: 'The file has no parcels in it.' };
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const at = {};
  for (const [key, name] of Object.entries(COLUMNS)) at[key] = head.indexOf(name);
  const missing = ['orderNumber', 'box', 'storedAt', 'phone', 'code'].filter(k => at[k] < 0).map(k => COLUMNS[k]);
  if (missing.length) return { ok: false, status: 400, code: 'bad_file', error: 'This is not the parcel list as MINNO exports it. Missing columns: ' + missing.join(', ') + '.' };
  if (rows.length - 1 > MAX_ROWS) return { ok: false, status: 400, code: 'bad_file', error: `At most ${MAX_ROWS} parcels at a time.` };
  const cell = (r, k) => (at[k] < 0 ? '' : String(r[at[k]] == null ? '' : r[at[k]]).trim());
  // The export ends with a line of totals: no box, no order, no code. It is not a parcel.
  const isParcel = (r) => ['orderNumber', 'box', 'phone', 'code'].some(k => cell(r, k) !== '');
  const body = rows.slice(1).map((r, i) => ({ r, line: i + 2 })).filter(x => isParcel(x.r));
  if (!body.length) return { ok: false, status: 400, code: 'bad_file', error: 'The file has no parcels in it.' };
  return { ok: true, rows: body.map(({ r, line }) => {
    const box = parseBox(cell(r, 'box'));
    return { line, box: box && { board: box.board, lock: box.lock }, label: box ? box.label : cell(r, 'box').slice(-6),
             orderNumber: cell(r, 'orderNumber'), phone: cell(r, 'phone'), code: cell(r, 'code'), storedAt: parseTime(cell(r, 'storedAt')),
             device: cell(r, 'device'), status: cell(r, 'status') };
  }) };
}

/**
 * Checks an export against a locker and, unless `dryRun`, records its parcels. All or nothing:
 * one row that cannot be taken and none are. The answer lists every row with its box and order
 * number and what is wrong with it, never the phone number or the code.
 */
function importMinnoExport(machine, text, actor, { dryRun } = {}, now = Date.now()) {
  const read = readMinnoExport(text);
  if (!read.ok) return read;
  // An export from another locker would put parcels behind the wrong doors.
  const others = [...new Set(read.rows.map(r => r.device).filter(d => d && d.toUpperCase() !== String(machine.deviceCode).toUpperCase()))];
  const collected = read.rows.filter(r => r.status && !/not-?\s*collected/i.test(r.status)).length;
  const r = parcels.importStored(machine, read.rows, actor, { dryRun, source: 'MINNO' }, now);
  if (r.ok) { r.otherDevices = others; r.notStoredStatus = collected; }
  return r;
}

module.exports = { parseCsv, parseBox, parseTime, readMinnoExport, importMinnoExport, MAX_ROWS };
