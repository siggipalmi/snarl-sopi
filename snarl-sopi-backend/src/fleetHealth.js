/**
 * Fleet health rules (Siggi, 2026-10-19: "spot faults before my paying customers find out").
 *
 * Pure functions, so the rules can be tested without a database. Each returns issues as
 * { kind, level, label, detail? }: level 1 = needs you today (can't sell, or charges wrongly),
 * level 2 = warning (look this week). The router feeds them into Fleet → Health and the 07:45
 * morning report.
 */

const HOUR = 3600000;
const SELF_TEST_STALE_MS = 45 * 60000;        // three missed 15-minute tests
const CLOCK_SKEW_MS = 2 * 60000;
const SCALE_READ_STALE_S = 30 * 60;
const STORAGE_FREE_WARN_PCT = 15;
const RESTARTS_WARN = 2;                       // more than this in 24 h

/** Issues from the machine's latest self-test record (app 0.67.0+). */
function selfTestIssues(rec, now, online) {
  if (!rec) return [];
  const out = [];
  const ageMs = now - (rec.receivedAt || 0);
  if (online && ageMs > SELF_TEST_STALE_MS) {
    out.push({ kind: 'selftest_stale', level: 1, label: `no self-test for ${Math.round(ageMs / 60000)} min`,
               detail: 'The app is online but has stopped testing itself — it may be stuck.' });
    return out;                                   // the rest would be describing an old reading
  }
  const s = rec.scales || {};
  if (Number.isFinite(s.expected) && Number.isFinite(s.answered) && s.answered < s.expected) {
    out.push({ kind: 'scales_missing', level: 1, label: `scales: ${s.answered} of ${s.expected} answering`,
               detail: `Silent: ${(s.missing || []).join(', ') || '?'}. Items taken from a silent basket are not charged.` });
  }
  if (Array.isArray(s.faults) && s.faults.length) {
    out.push({ kind: 'scales_fault', level: 1, label: `scale fault on ${s.faults.length} basket(s)`,
               detail: `Board reports a sensor fault: ${s.faults.join(', ')}.` });
  }
  if (Number.isFinite(s.readAgeS) && s.readAgeS > SCALE_READ_STALE_S) {
    out.push({ kind: 'scales_stale', level: 1, label: `scales not read for ${Math.round(s.readAgeS / 60)} min`,
               detail: 'The idle weight read keeps failing; the next sale may be measured against old weights.' });
  }
  if (Array.isArray(s.drift) && s.drift.length) {
    out.push({ kind: 'scales_drift', level: 2, label: `empty basket drifted: ${s.drift.join(', ')}`,
               detail: 'Its zero has moved, so counts there can be off. Tare it when it is empty.' });
  }
  if (rec.autoTime === false) {
    out.push({ kind: 'auto_time_off', level: 1, label: 'automatic time is off',
               detail: 'A drifting clock fails every TLS connection and the machine loses the backend.' });
  }
  if (rec.deviceTime) {
    const skew = Date.parse(rec.deviceTime) - (rec.receivedAt || now);
    if (Number.isFinite(skew) && Math.abs(skew) > CLOCK_SKEW_MS) {
      out.push({ kind: 'clock_skew', level: 1, label: `clock off by ${Math.round(Math.abs(skew) / 60000)} min`,
                 detail: 'The tablet clock is wrong; TLS will start failing.' });
    }
  }
  if (rec.deviceOwner === false) {
    out.push({ kind: 'device_owner_lost', level: 1, label: 'not Device Owner',
               detail: 'Kiosk lockdown is off: Weimi can come back and customers can leave the app.' });
  }
  if (rec.weimiHidden && Object.values(rec.weimiHidden).some(v => v === false)) {
    const back = Object.entries(rec.weimiHidden).filter(([, v]) => v === false).map(([k]) => k);
    out.push({ kind: 'weimi_back', level: 1, label: 'Weimi app running again',
               detail: `${back.join(', ')} not hidden — it holds the serial ports (scales, card reader).` });
  }
  if (Number.isFinite(rec.storageFreePct) && rec.storageFreePct < STORAGE_FREE_WARN_PCT) {
    out.push({ kind: 'storage_low', level: 2, label: `tablet storage ${100 - rec.storageFreePct}% full`,
               detail: 'Will matter for the next app update.' });
  }
  if (rec.lowMemory === true) {
    out.push({ kind: 'memory_low', level: 2, label: 'tablet low on memory',
               detail: `${rec.memAvailMb != null ? rec.memAvailMb + ' MB free. ' : ''}Android may kill the app.` });
  }
  const restarts = (rec.restarts || []).filter(t => now - t <= 24 * HOUR);
  if (restarts.length > RESTARTS_WARN) {
    out.push({ kind: 'restarts', level: 2, label: `app restarted ${restarts.length} times in 24 h`,
               detail: `Last at ${new Date(Math.max(...restarts)).toISOString().slice(11, 16)}. Check the machine log for a crash.` });
  }
  return out;
}

/**
 * No sales for much longer than usual. [saleTimes]: ms timestamps of sales in the last 28 days.
 * With enough history (7+ days, 20+ sales) the expected number of sales over the silent stretch is
 * summed from this machine's own sales per hour of day (Iceland is UTC); 4 expected and none made
 * is about a 1-in-55 chance by luck — fine for a flag that is shown, not emailed on its own. Without enough history: 8 daytime hours (08–22) silent.
 * A machine that has never sold is not selling yet, not broken.
 */
function silenceIssue(saleTimes, now) {
  if (!saleTimes || !saleTimes.length) return null;
  const last = Math.max(...saleTimes);
  const silentH = (now - last) / HOUR;
  if (silentH < 2) return null;
  const first = Math.min(...saleTimes);
  const days = Math.min(28, Math.max(1, (now - first) / (24 * HOUR)));
  const fmtH = h => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + ' h';
  if (days >= 7 && saleTimes.length >= 20) {
    const counts = new Array(24).fill(0);
    for (const t of saleTimes) counts[new Date(t).getUTCHours()] += 1;
    const perHour = counts.map(c => c / days);
    let summed = 0;                               // counts first, one division: no 3.9999 for 4
    for (let t = last + HOUR; t <= now; t += HOUR) summed += counts[new Date(t).getUTCHours()];
    const expected = summed / days;
    if (expected < 4) return null;
    const nowRate = perHour[new Date(now).getUTCHours()];
    return { kind: 'no_sales', level: 1, label: `no sales for ${fmtH(silentH)}`,
             detail: `About ${Math.round(expected)} sales would be usual over that time` +
               (nowRate > 0 ? ` (usually one every ${fmtH(1 / nowRate)} at this hour)` : '') +
               '. Check the screen, the card reader and the door.' };
  }
  let dayHours = 0;
  for (let t = last + HOUR; t <= now; t += HOUR) { const h = new Date(t).getUTCHours(); if (h >= 8 && h < 22) dayHours++; }
  if (dayHours < 8) return null;
  return { kind: 'no_sales', level: 1, label: `no sales for ${fmtH(silentH)}`,
           detail: `${dayHours} daytime hours without a sale (too little history yet for this machine's own pattern).` };
}

/** Three or more failed purchases in a row (newest first), within 12 h, with no sale since. */
function failedPurchasesIssue(recent, now) {
  let n = 0;
  for (const r of recent || []) {
    if (now - r.at > 12 * HOUR) break;
    if (r.outcome === 'declined' || r.outcome === 'sensor_fault') n++;
    else if (r.outcome === 'charged') break;
  }
  if (n < 3) return null;
  return { kind: 'failed_purchases', level: 1, label: `${n} failed purchases in a row`,
           detail: 'Cards declined or the scales faulted on every attempt since the last sale.' };
}

/** Fold one self-test report into the stored record, keeping a 24 h list of app restarts. */
function nextSelfTestRecord(prev, report, now) {
  const restarts = ((prev && prev.restarts) || []).filter(t => now - t <= 24 * HOUR);
  const started = Date.parse(report.processStart);
  if (prev && prev.processStart && report.processStart && prev.processStart !== report.processStart && Number.isFinite(started)) {
    restarts.push(started);
  }
  const pick = (v, ok) => (ok(v) ? v : null);
  return {
    receivedAt: now,
    app: pick(report.app, v => typeof v === 'string'),
    deviceTime: pick(report.deviceTime, v => typeof v === 'string'),
    processStart: pick(report.processStart, v => typeof v === 'string'),
    restarts: restarts.slice(-20),
    scales: report.scales && typeof report.scales === 'object' ? {
      expected: Number(report.scales.expected), answered: Number(report.scales.answered),
      missing: (report.scales.missing || []).slice(0, 40).map(String),
      faults: (report.scales.faults || []).slice(0, 40).map(String),
      drift: (report.scales.drift || []).slice(0, 40).map(String),
      readAgeS: report.scales.readAgeS == null ? null : Number(report.scales.readAgeS),
    } : null,
    autoTime: pick(report.autoTime, v => typeof v === 'boolean'),
    deviceOwner: pick(report.deviceOwner, v => typeof v === 'boolean'),
    weimiHidden: report.weimiHidden && typeof report.weimiHidden === 'object' ? report.weimiHidden : null,
    storageFreePct: pick(report.storageFreePct, Number.isFinite),
    memAvailMb: pick(report.memAvailMb, Number.isFinite),
    lowMemory: pick(report.lowMemory, v => typeof v === 'boolean'),
    payment: report.payment && typeof report.payment === 'object' ? report.payment : null,
  };
}

module.exports = { selfTestIssues, silenceIssue, failedPurchasesIssue, nextSelfTestRecord, SELF_TEST_STALE_MS };
