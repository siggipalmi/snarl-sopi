// ─── customerReceipt.js ───────────────────────────────────────────────────────
// The receipt a fridge customer can ask for by email after paying.
//
// Not to be confused with receipts.js, which reads SUPPLIER receipts for cost prices.
//
// Pure: given the operator, the machine and the settled lines, build the subject, plain text and
// HTML. No storage, no sending — router.js gathers the data and hands the result to email.send, so
// this file can be checked without a database or SendGrid.
//
// Prices on the fridge are gross (VSK included), so VSK is extracted, not added:
//   vsk = gross × rate / (100 + rate), per rate, rounded to whole krónur.
// A basket mixing 11% and 24% items shows one line per rate plus the total.

const ZONE = 'Atlantic/Reykjavik';

const STRINGS = {
  is: {
    subject: (place, date) => `Kvittun — ${place}, ${date}`,
    title: 'Kvittun', receiptNo: 'Kvittun nr.', date: 'Dags.', place: 'Staður', machine: 'vél',
    paid: 'Greitt', byCard: 'með korti',
    item: 'Vara', qty: 'Magn', unit: 'Einingarverð', amount: 'Upphæð', total: 'Samtals',
    vatLine: (rate, base) => `VSK ${rate}% · innifalinn í ${base}`, vatTotal: 'VSK samtals',
    inclVat: 'Verð eru með virðisaukaskatti.',
    wrong: (email) => `Eitthvað rangt? Svaraðu þessum pósti eða skrifaðu á ${email} og tilgreindu kvittunarnúmerið.`,
    locale: 'is-IS', at: 'kl.',
  },
  en: {
    subject: (place, date) => `Receipt — ${place}, ${date}`,
    title: 'Receipt', receiptNo: 'Receipt no.', date: 'Date', place: 'Location', machine: 'machine',
    paid: 'Paid', byCard: 'by card',
    item: 'Item', qty: 'Qty', unit: 'Unit price', amount: 'Amount', total: 'Total',
    vatLine: (rate, base) => `VAT ${rate}% · included in ${base}`, vatTotal: 'VAT total',
    inclVat: 'Prices include VAT (VSK).',
    wrong: (email) => `Something wrong? Reply to this email or write to ${email}, quoting the receipt number.`,
    locale: 'en-GB', at: '',
  },
  pl: {
    subject: (place, date) => `Paragon — ${place}, ${date}`,
    title: 'Paragon', receiptNo: 'Nr paragonu', date: 'Data', place: 'Miejsce', machine: 'automat',
    paid: 'Zapłacono', byCard: 'kartą',
    item: 'Produkt', qty: 'Ilość', unit: 'Cena jedn.', amount: 'Kwota', total: 'Razem',
    vatLine: (rate, base) => `VAT ${rate}% · zawarty w ${base}`, vatTotal: 'VAT razem',
    inclVat: 'Ceny zawierają VAT.',
    wrong: (email) => `Coś się nie zgadza? Odpowiedz na tę wiadomość lub napisz na ${email}, podając numer paragonu.`,
    locale: 'pl-PL', at: '',
  },
};

function langOf(code) {
  const c = String(code || '').trim().toLowerCase();
  return STRINGS[c] ? c : 'is';
}

function kr(n, L) {
  // Grouping per language (3.650 / 3,650 / 3650), always whole krónur.
  return new Intl.NumberFormat(L.locale, { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';
}

function formatKennitala(kt) {
  const d = String(kt || '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 6)}-${d.slice(6)}` : String(kt || '');
}

function formatWhen(ms, L) {
  const d = new Date(ms);
  // English spells the month: 02/10/2026 reads as 10 February to an American visitor.
  const month = L.locale === 'en-GB' ? 'short' : 'numeric';
  const date = new Intl.DateTimeFormat(L.locale, { timeZone: ZONE, day: 'numeric', month, year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return L.at ? `${date} ${L.at} ${time}` : `${date}, ${time}`;
}

/**
 * VSK per rate. Lines whose product has no rate on file are left out of the breakdown rather than
 * guessed at — a wrong VSK figure on a customer receipt is worse than a missing one — and reported
 * in `unknownRateLines` so the caller can log it.
 */
function vatBreakdown(lines) {
  const byRate = new Map();
  let unknownRateLines = 0;
  for (const l of lines) {
    const rate = Number(l.vatRate);
    if (rate !== 11 && rate !== 24) { unknownRateLines++; continue; }
    byRate.set(rate, (byRate.get(rate) || 0) + (Number(l.lineIsk) || 0));
  }
  const rates = [...byRate.keys()].sort((a, b) => a - b).map(rate => {
    const gross = byRate.get(rate);
    return { rate, grossIsk: gross, vatIsk: Math.round(gross * rate / (100 + rate)) };
  });
  return { rates, totalVatIsk: rates.reduce((s, r) => s + r.vatIsk, 0), unknownRateLines };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param {object} r
 *   operator: { name, kennitala, email, phone, logoUrl }
 *   place:    machine label shown to the customer (e.g. "Nordic Hostel")
 *   deviceCode, orderId, closedAtMs, totalIsk, language ('is' | 'en' | 'pl')
 *   lines:    [{ name, quantity, unitIsk, lineIsk, vatRate }]
 */
function buildCustomerReceipt(r) {
  const lang = langOf(r.language);
  const L = STRINGS[lang];
  const op = r.operator || {};
  const when = formatWhen(r.closedAtMs || Date.now(), L);
  const vat = vatBreakdown(r.lines || []);
  const contactLine = [op.email, op.phone].filter(Boolean).join(' · ');
  const placeLine = `${r.place || r.deviceCode} (${L.machine} ${r.deviceCode})`;
  const subject = L.subject(r.place || r.deviceCode, when);

  // ── Plain text ──
  const text = [
    op.name,
    `kt. ${formatKennitala(op.kennitala)}`,
    contactLine,
    '',
    L.title.toUpperCase(),
    `${L.receiptNo} ${r.orderId}`,
    `${L.date} ${when}`,
    `${L.place} ${placeLine}`,
    `${L.paid} ${L.byCard}`,
    '',
    ...(r.lines || []).map(l => `${l.quantity} × ${l.name} @ ${kr(l.unitIsk, L)} = ${kr(l.lineIsk, L)}`),
    '',
    `${L.total}: ${kr(r.totalIsk, L)}`,
    ...vat.rates.map(v => `${L.vatLine(v.rate, kr(v.grossIsk, L))}: ${kr(v.vatIsk, L)}`),
    vat.rates.length ? `${L.vatTotal}: ${kr(vat.totalVatIsk, L)}` : null,
    '',
    L.inclVat,
    op.email ? L.wrong(op.email) : null,
  ].filter(x => x !== null).join('\n');

  // ── HTML (inline styles only; mail clients ignore <style>) ──
  const font = "font-family:Helvetica,Arial,sans-serif;";
  const muted = 'color:#8A8275;';
  const num = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;';
  const cell = 'padding:8px 0;border-bottom:1px solid #E8E2D8;';
  // Only an absolute https logo: data: URIs and relative paths are blocked or broken in most clients.
  const logo = /^https:\/\//i.test(op.logoUrl || '')
    ? `<img src="${esc(op.logoUrl)}" alt="${esc(op.name)}" style="max-width:96px;max-height:64px;display:block">`
    : '';
  const rows = (r.lines || []).map(l => `
      <tr>
        <td style="${cell}">${esc(l.name)}</td>
        <td style="${cell}${num}">${esc(l.quantity)}</td>
        <td style="${cell}${num}">${esc(kr(l.unitIsk, L))}</td>
        <td style="${cell}${num}">${esc(kr(l.lineIsk, L))}</td>
      </tr>`).join('');
  const vatRows = vat.rates.map(v => `
        <tr><td style="padding:3px 0;${muted}">${esc(L.vatLine(v.rate, kr(v.grossIsk, L)))}</td>
            <td style="padding:3px 0;${muted}${num}">${esc(kr(v.vatIsk, L))}</td></tr>`).join('');
  const vatBlock = vat.rates.length ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;background:#F8F5F0;border-radius:8px;padding:10px 14px;font-size:13px">
        ${vatRows}
        <tr><td style="padding:6px 0 0;border-top:1px solid #E8E2D8;font-weight:600">${esc(L.vatTotal)}</td>
            <td style="padding:6px 0 0;border-top:1px solid #E8E2D8;font-weight:600;${num}">${esc(kr(vat.totalVatIsk, L))}</td></tr>
      </table>` : '';

  const html = `<!doctype html>
<html lang="${lang}"><body style="margin:0;padding:24px;background:#FAF7F2;${font}color:#1A1A1A">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #E8E2D8;border-radius:10px">
    <tr><td style="padding:28px 32px 32px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #E8E2D8;padding-bottom:16px">
        <tr>
          <td style="font-size:13px;line-height:1.55;${muted}">
            <div style="font-size:16px;font-weight:600;color:#1A1A1A">${esc(op.name)}</div>
            kt. ${esc(formatKennitala(op.kennitala))}<br>${esc(contactLine)}
          </td>
          <td style="text-align:right;vertical-align:top">${logo}</td>
        </tr>
      </table>
      <div style="font-family:Georgia,serif;font-style:italic;font-size:28px;margin:22px 0 8px">${esc(L.title)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;margin-bottom:18px">
        <tr><td style="${muted}padding-right:18px">${esc(L.receiptNo)}</td><td>${esc(r.orderId)}</td></tr>
        <tr><td style="${muted}padding-right:18px">${esc(L.date)}</td><td>${esc(when)}</td></tr>
        <tr><td style="${muted}padding-right:18px">${esc(L.place)}</td><td>${esc(placeLine)}</td></tr>
        <tr><td style="${muted}padding-right:18px">${esc(L.paid)}</td><td>${esc(L.byCard)}</td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        <tr>
          <td style="${muted}font-size:12px;padding:6px 0;border-bottom:1px solid #E8E2D8">${esc(L.item)}</td>
          <td style="${muted}font-size:12px;padding:6px 0;border-bottom:1px solid #E8E2D8;${num}">${esc(L.qty)}</td>
          <td style="${muted}font-size:12px;padding:6px 0;border-bottom:1px solid #E8E2D8;${num}">${esc(L.unit)}</td>
          <td style="${muted}font-size:12px;padding:6px 0;border-bottom:1px solid #E8E2D8;${num}">${esc(L.amount)}</td>
        </tr>
        ${rows}
        <tr>
          <td colspan="3" style="padding-top:14px;font-weight:600;font-size:16px">${esc(L.total)}</td>
          <td style="padding-top:14px;font-weight:600;font-size:16px;${num}">${esc(kr(r.totalIsk, L))}</td>
        </tr>
      </table>
      ${vatBlock}
      <div style="margin-top:22px;font-size:12px;line-height:1.6;${muted}">
        ${esc(L.inclVat)}${op.email ? '<br>' + esc(L.wrong(op.email)) : ''}
      </div>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html, language: lang, vat };
}

module.exports = { buildCustomerReceipt, vatBreakdown, formatKennitala, langOf };
