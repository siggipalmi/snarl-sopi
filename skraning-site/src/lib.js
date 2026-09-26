// Pure logic for the skraning Worker: no fetch, no env, no D1. Everything here is
// unit-tested in test/lib.test.js, so the contract fields a customer gets do not
// depend on anything that can time out.

// ─── Machine catalogue ────────────────────────────────────────────────────────
// `key` is the form field and the /leases/claim body field. `label` is what the
// contract says under "Hið leigða". Prices match agvending.is/#verd (kr/month, ex VAT).
export const MACHINES = [
  { key: 'tvofaldur', label: 'Tvöfaldur snjallsjálfsali',  short: 'Tvöfaldur snjallsjálfsali með kæli', price: 55000 },
  { key: 'einfaldur', label: 'Einfaldur snjallsjálfsali',  short: 'Einfaldur snjallsjálfsali með kæli', price: 40000 },
  { key: 'skjar',     label: 'Sjálfsali með 55" snertiskjá', short: 'Sjálfsali með 55" snertiskjá',     price: 40000 },
];

export const MAX_PER_TYPE = 10;

const MONTHS_IS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí',
  'ágúst', 'september', 'október', 'nóvember', 'desember'];

// ─── Kennitala ────────────────────────────────────────────────────────────────
export function normalizeKennitala(value) {
  return String(value || '').replace(/\D/g, '');
}

// Þjóðskrá check digit: weights 3,2,7,6,5,4,3,2 over the first eight digits,
// the ninth digit is 11 - (sum mod 11), where 11 means 0 and 10 is never issued.
export function isValidKennitala(value) {
  const kt = normalizeKennitala(value);
  if (!/^\d{10}$/.test(kt)) return false;
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(kt[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(kt[8]);
}

export function formatKennitala(value) {
  const kt = normalizeKennitala(value);
  return kt.length === 10 ? kt.slice(0, 6) + '-' + kt.slice(6) : kt;
}

// ─── Contact fields ───────────────────────────────────────────────────────────
export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

export function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '');
}

export function isValidPhone(value) {
  const digits = normalizePhone(value).replace(/^\+/, '');
  return digits.length >= 7 && digits.length <= 15;
}

// Icelandic numbers read best as "823 7777"; anything else is left as typed.
export function formatPhone(value) {
  const p = normalizePhone(value);
  if (/^\d{7}$/.test(p)) return p.slice(0, 3) + ' ' + p.slice(3);
  if (/^(\+354|00354)\d{7}$/.test(p)) {
    const local = p.slice(-7);
    return '+354 ' + local.slice(0, 3) + ' ' + local.slice(3);
  }
  return String(value || '').trim();
}

// ─── Money ────────────────────────────────────────────────────────────────────
export function formatKr(amount) {
  return String(Math.round(Number(amount) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function parseCounts(input) {
  const counts = {};
  for (const m of MACHINES) {
    const raw = input && input[m.key];
    const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
    counts[m.key] = Number.isInteger(n) ? n : NaN;
  }
  return counts;
}

export function monthlyTotal(counts) {
  return MACHINES.reduce((sum, m) => sum + (counts[m.key] || 0) * m.price, 0);
}

// "Tvöfaldur snjallsjálfsali" for one unit (matches every contract so far);
// "2 × Tvöfaldur snjallsjálfsali og 1 × Einfaldur snjallsjálfsali" for more.
export function describeMachines(counts) {
  const parts = MACHINES.filter(m => counts[m.key] > 0).map(m => ({ n: counts[m.key], label: m.label }));
  const total = parts.reduce((s, p) => s + p.n, 0);
  if (total === 1) return parts[0].label;
  const items = parts.map(p => `${p.n} × ${p.label}`);
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(', ') + ' og ' + items[items.length - 1];
}

// ─── Dates (Iceland is UTC all year, so UTC getters are local time) ──────────
export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function firstOfNextMonth(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// "01/10/2026" — the format the contracts already use for Upphaf leigutíma.
export function formatStartDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// "25. september 2026"
export function formatLongDate(d) {
  return `${d.getUTCDate()}. ${MONTHS_IS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function parseStartDate(value, now) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || isoDate(d) !== s) return null;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const limit = new Date(today.getTime() + 366 * 86400000);
  if (d < today || d > limit) return null;
  return s;
}

// ─── Form validation ──────────────────────────────────────────────────────────
// Returns { errors: {field: message}, value: normalized form } — company and
// address are verified against their registries in the Worker, not here.
export function validateForm(body, now) {
  const errors = {};
  const b = body || {};

  const kennitala = normalizeKennitala(b.kennitala);
  if (!isValidKennitala(kennitala)) errors.kennitala = 'Kennitala er ekki gild.';

  const netfang = String(b.netfang || '').trim();
  if (!isValidEmail(netfang)) errors.netfang = 'Netfang er ekki gilt.';

  const simi = String(b.simi || '').trim();
  if (!isValidPhone(simi)) errors.simi = 'Símanúmer er ekki gilt.';

  const counts = parseCounts(b);
  const bad = MACHINES.some(m => !Number.isInteger(counts[m.key]) || counts[m.key] < 0 || counts[m.key] > MAX_PER_TYPE);
  const total = MACHINES.reduce((s, m) => s + (counts[m.key] || 0), 0);
  if (bad) errors.taeki = 'Fjöldi tækja er ekki gildur.';
  else if (total < 1) errors.taeki = 'Veldu að minnsta kosti eitt tæki.';

  const heimilisfang = String(b.heimilisfang || '').trim();
  if (!heimilisfang) errors.heimilisfang = 'Veldu staðsetningu úr listanum.';

  const upphaf = parseStartDate(b.upphaf, now);
  if (!upphaf) errors.upphaf = 'Veldu upphafsdag frá og með deginum í dag.';

  const tengilidur = String(b.tengilidur || '').trim().slice(0, 120);
  const athugasemdir = String(b.athugasemdir || '').trim().slice(0, 2000);

  return {
    errors,
    value: { kennitala, netfang, simi, counts, heimilisfang, upphaf, tengilidur, athugasemdir },
  };
}

// The address proxy matches "street house" (or a prefix of it), not the formatted
// "Sefgarðar 12, 170, Seltjarnarnes" it returns, so re-verifying a chosen address
// has to search by the part before the first comma and then match `full` exactly.
export function addressLookupQuery(full) {
  return String(full || '').split(',')[0].trim();
}

// ─── Company registry (skattur-company-lookup Worker response) ───────────────
export function registeredAddress(company) {
  const zipCity = [company.postcode, company.city].filter(Boolean).join(' ');
  return [company.address, zipCity].filter(Boolean).join(', ');
}

// ─── Consumer price index (Hagstofa PxWeb) ────────────────────────────────────
const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/æ/g, 'ae');

function isTimeVariable(v) {
  return v.time === true || /manudur|month|timi|tima/.test(fold(v.code + ' ' + v.text)) ||
    (Array.isArray(v.values) && v.values.length > 0 && v.values.every(x => /^\d{4}M\d{2}$/.test(x)));
}

// Score a value label for "the index level of the headline CPI". Rates of change,
// sub-indices and CPI-without-housing lose; the plain index wins.
function scoreCpiLabel(text) {
  const t = fold(text);
  let s = 0;
  if (/visitala neysluverds$/.test(t.trim())) s += 50;
  if (t.includes('neysluverd')) s += 20;
  if (t.includes('verdtrygg')) s += 10;
  if (t.includes('visitala') || t.includes('index') || t.includes('stig')) s += 5;
  if (/breyting|hlutfall|%|arsbreyt|manadarbreyt|change|rate/.test(t)) s -= 100;
  if (/an husnaedis|an husn|without|an |undirvisit/.test(t)) s -= 40;
  return s;
}

// From PxWeb metadata, pick the selection for the latest few months of the
// headline index. Returns { query, picks, timeCode } or throws.
export function buildCpiQuery(meta, monthsBack = 4) {
  const vars = (meta && meta.variables) || [];
  const timeVar = vars.find(isTimeVariable);
  if (!timeVar) throw new Error('CPI table has no month variable');
  const months = timeVar.values.slice(-monthsBack);
  const picks = {};
  const query = [{ code: timeVar.code, selection: { filter: 'item', values: months } }];
  for (const v of vars) {
    if (v === timeVar) continue;
    let best = 0;
    let bestScore = -Infinity;
    (v.valueTexts || v.values).forEach((label, i) => {
      const sc = scoreCpiLabel(label);
      if (sc > bestScore) { bestScore = sc; best = i; }
    });
    picks[v.code] = { value: v.values[best], text: (v.valueTexts || v.values)[best] };
    query.push({ code: v.code, selection: { filter: 'item', values: [v.values[best]] } });
  }
  return { query: { query, response: { format: 'json' } }, picks, timeCode: timeVar.code };
}

// From the PxWeb data response, the latest month with a plausible index level.
export function pickLatestCpi(data, timeCode) {
  const cols = (data && data.columns) || [];
  const timeIdx = cols.findIndex(c => c.code === timeCode || c.type === 't');
  if (timeIdx < 0) throw new Error('CPI response has no month column');
  const rows = ((data && data.data) || [])
    .map(r => ({ month: r.key[timeIdx], value: Number(String(r.values[0]).replace(',', '.')) }))
    .filter(r => /^\d{4}M\d{2}$/.test(r.month) && Number.isFinite(r.value) && r.value > 100 && r.value < 10000)
    .sort((a, b) => (a.month < b.month ? -1 : 1));
  if (!rows.length) throw new Error('CPI response has no usable value');
  const latest = rows[rows.length - 1];
  return { vnv: String(latest.value), manudur: latest.month };
}

// CPI_OVERRIDE secret, "694.6@2026M08" — a manual escape hatch if Hagstofa is down.
export function parseCpiOverride(value) {
  const m = String(value || '').trim().match(/^(\d{3,4}(?:[.,]\d+)?)@(\d{4}M\d{2})$/);
  return m ? { vnv: m[1].replace(',', '.'), manudur: m[2] } : null;
}

// ─── Contract payload ─────────────────────────────────────────────────────────
// Keys named like {{placeholders}} in "leigusamningur template" map 1:1 in the Zap.
export function buildContractPayload({ id, form, company, claim, cpi, now }) {
  const counts = form.counts;
  const managerName = company.managerName || form.tengilidur;
  const total = monthlyTotal(counts);
  return {
    // Template placeholders
    Nafn_Leigutaka: company.companyName,
    Kennitala_Leigutaka: formatKennitala(form.kennitala),
    Logheimili_Leigutaka: registeredAddress(company),
    Nafn_Framkvaemdastjora: managerName,
    Kennitala_Framkvaemdastjora: company.managerNationalId ? formatKennitala(company.managerNationalId) : '',
    Netfang_Samskipti: form.netfang,
    Simi: formatPhone(form.simi),
    hid_leigda: describeMachines(counts),
    radnumer_sjalfsala: claim.radnumer_sjalfsala || '',
    radnumer_nayax: claim.radnumer_nayax || '',
    leigugjald: formatKr(total) + ' + vsk.',
    upphaf_leigutima: formatStartDate(form.upphaf),
    vnv: cpi.vnv,
    manudur: cpi.manudur,
    Heimilisfang_Stadfest: form.heimilisfang,
    undirritunardagur: formatLongDate(now),

    // Everything else a later Zap step might want
    skjal_titill: `Leigusamningur-AGV-${company.companyName}`,
    skraning_id: id,
    kennitala: form.kennitala,
    netfang: form.netfang,
    fjoldi_tvofaldur: counts.tvofaldur,
    fjoldi_einfaldur: counts.einfaldur,
    fjoldi_skjar: counts.skjar,
    leigugjald_kr: total,
    upphaf_iso: form.upphaf,
    athugasemdir: form.athugasemdir,
    vidvaranir: (claim.warnings || []).join('\n'),
    skrad: now.toISOString(),
  };
}

// Same company, same place, same machines, same start → the same registration.
export function dedupeKey(form) {
  return [form.kennitala, fold(form.heimilisfang), MACHINES.map(m => form.counts[m.key]).join('-'), form.upphaf].join('|');
}

// Retry schedule for the background pipeline: 1, 2, 5, 10, 20, 40, 60, 60 minutes.
export const MAX_ATTEMPTS = 8;
export function backoffMinutes(attempt) {
  return [1, 2, 5, 10, 20, 40, 60, 60][Math.min(attempt, 7)];
}
