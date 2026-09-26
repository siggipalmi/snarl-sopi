import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressLookupQuery, buildContractPayload, buildCpiQuery, dedupeKey, describeMachines, firstOfNextMonth,
  formatKennitala, formatKr, formatLongDate, formatPhone, formatStartDate, isValidKennitala,
  parseCpiOverride, parseStartDate, pickLatestCpi, validateForm,
} from '../src/lib.js';

const NOW = new Date('2026-09-25T10:00:00Z');

test('kennitala check digit', () => {
  assert.equal(isValidKennitala('590922-0800'), true);   // AG Vending
  assert.equal(isValidKennitala('4607161010'), true);    // Icelandic Lava Show
  assert.equal(isValidKennitala('4607161020'), false);   // wrong check digit
  assert.equal(isValidKennitala('46071610'), false);
  assert.equal(formatKennitala('4607161010'), '460716-1010');
});

test('money and machine wording match the contracts already issued', () => {
  assert.equal(formatKr(55000), '55.000');
  assert.equal(formatKr(1234567), '1.234.567');
  assert.equal(describeMachines({ tvofaldur: 1, einfaldur: 0, skjar: 0 }), 'Tvöfaldur snjallsjálfsali');
  assert.equal(describeMachines({ tvofaldur: 2, einfaldur: 0, skjar: 0 }), '2 × Tvöfaldur snjallsjálfsali');
  assert.equal(
    describeMachines({ tvofaldur: 2, einfaldur: 1, skjar: 1 }),
    '2 × Tvöfaldur snjallsjálfsali, 1 × Einfaldur snjallsjálfsali og 1 × Sjálfsali með 55" snertiskjá');
});

test('dates', () => {
  assert.equal(formatStartDate('2026-10-01'), '01/10/2026');
  assert.equal(formatLongDate(NOW), '25. september 2026');
  assert.equal(firstOfNextMonth(new Date('2026-12-15T00:00:00Z')).toISOString().slice(0, 10), '2027-01-01');
  assert.equal(parseStartDate('2026-09-25', NOW), '2026-09-25');
  assert.equal(parseStartDate('2026-09-24', NOW), null);     // past
  assert.equal(parseStartDate('2026-02-30', NOW), null);     // not a date
  assert.equal(parseStartDate('2028-01-01', NOW), null);     // too far out
});

test('phone formatting', () => {
  assert.equal(formatPhone('8237777'), '823 7777');
  assert.equal(formatPhone('+354 823 7777'), '+354 823 7777');
  assert.equal(formatPhone('+44 20 7946 0958'), '+44 20 7946 0958');
});

test('validateForm catches every field', () => {
  const { errors } = validateForm({}, NOW);
  assert.deepEqual(Object.keys(errors).sort(), ['heimilisfang', 'kennitala', 'netfang', 'simi', 'taeki', 'upphaf']);

  const ok = validateForm({
    kennitala: '460716-1010', netfang: 'julius@lavashow.com', simi: '823 7777',
    tvofaldur: 1, heimilisfang: 'Fiskislóð 73, 101, Reykjavík', upphaf: '2026-10-01',
  }, NOW);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value.counts, { tvofaldur: 1, einfaldur: 0, skjar: 0 });

  assert.ok(validateForm({ tvofaldur: 11 }, NOW).errors.taeki);
  assert.ok(validateForm({ tvofaldur: 1.5 }, NOW).errors.taeki);
  assert.ok(validateForm({ tvofaldur: -1 }, NOW).errors.taeki);
});

test('contract payload fills every template placeholder', () => {
  const { value: form } = validateForm({
    kennitala: '4607161010', netfang: 'julius@lavashow.com', simi: '8237777',
    tvofaldur: 1, heimilisfang: 'Fiskislóð 73, 101, Reykjavík', upphaf: '2026-10-01',
  }, NOW);
  const company = {
    companyName: 'Icelandic Lava Show ehf.', address: 'Fiskislóð 73', postcode: '101', city: 'Reykjavík',
    managerName: 'Júlíus Ingi Jónsson', managerNationalId: '0101801234',
  };
  const claim = { radnumer_sjalfsala: '8626020714', radnumer_nayax: '0434334925283145', warnings: [] };
  const p = buildContractPayload({ id: 'skr_1', form, company, claim, cpi: { vnv: '694.6', manudur: '2026M08' }, now: NOW });

  // Every {{placeholder}} in "leigusamningur template" (read from Google Docs 2026-09-25).
  const placeholders = ['Heimilisfang_Stadfest', 'Kennitala_Framkvaemdastjora', 'Kennitala_Leigutaka',
    'Logheimili_Leigutaka', 'Nafn_Framkvaemdastjora', 'Nafn_Leigutaka', 'Netfang_Samskipti', 'Simi',
    'hid_leigda', 'leigugjald', 'manudur', 'radnumer_nayax', 'radnumer_sjalfsala', 'undirritunardagur',
    'upphaf_leigutima', 'vnv'];
  for (const k of placeholders) assert.ok(p[k], 'missing ' + k);

  assert.equal(p.Nafn_Leigutaka, 'Icelandic Lava Show ehf.');
  assert.equal(p.Kennitala_Leigutaka, '460716-1010');
  assert.equal(p.Logheimili_Leigutaka, 'Fiskislóð 73, 101 Reykjavík');
  assert.equal(p.hid_leigda, 'Tvöfaldur snjallsjálfsali');
  assert.equal(p.leigugjald, '55.000 + vsk.');
  assert.equal(p.upphaf_leigutima, '01/10/2026');
  assert.equal(p.Simi, '823 7777');
  assert.equal(p.undirritunardagur, '25. september 2026');
  assert.equal(p.skjal_titill, 'Leigusamningur-AGV-Icelandic Lava Show ehf.');
});

test('contact falls back to the typed name when the registry has no manager', () => {
  const { value: form } = validateForm({
    kennitala: '4607161010', netfang: 'a@b.is', simi: '8237777', einfaldur: 2,
    heimilisfang: 'x', upphaf: '2026-10-01', tengilidur: 'Anna Jónsdóttir',
  }, NOW);
  const p = buildContractPayload({
    id: 'x', form, company: { companyName: 'X ehf.' }, now: NOW,
    claim: { radnumer_sjalfsala: 'a\nb', radnumer_nayax: 'c\nd', warnings: ["Only 1 'Einfaldur' available, 2 requested"] },
    cpi: { vnv: '1', manudur: '2026M08' },
  });
  assert.equal(p.Nafn_Framkvaemdastjora, 'Anna Jónsdóttir');
  assert.equal(p.Kennitala_Framkvaemdastjora, '');
  assert.equal(p.leigugjald, '80.000 + vsk.');
  assert.match(p.vidvaranir, /Only 1/);
});

test('address re-check searches by street and house number, like the autocomplete does', () => {
  assert.equal(addressLookupQuery('Sefgarðar 12, 170, Seltjarnarnes'), 'Sefgarðar 12');
  assert.equal(addressLookupQuery('Fiskislóð 73, 101, Reykjavík'), 'Fiskislóð 73');
  assert.equal(addressLookupQuery('Hraun'), 'Hraun');
});

test('dedupe key ignores case and accents in the address', () => {
  const base = { kennitala: '1', counts: { tvofaldur: 1, einfaldur: 0, skjar: 0 }, upphaf: '2026-10-01' };
  assert.equal(dedupeKey({ ...base, heimilisfang: 'Fiskislóð 73' }), dedupeKey({ ...base, heimilisfang: 'fiskislod 73' }));
  assert.notEqual(dedupeKey({ ...base, heimilisfang: 'Fiskislóð 73' }), dedupeKey({ ...base, heimilisfang: 'Fiskislóð 75' }));
});

// Shaped like PxWeb v1 metadata for a CPI table: a month variable plus an index
// variable whose first value is a rate of change, so "take the first" would be wrong.
const META = {
  title: 'Vísitala neysluverðs',
  variables: [
    { code: 'Mánuður', text: 'Mánuður', values: ['2026M05', '2026M06', '2026M07', '2026M08'], valueTexts: ['2026M05', '2026M06', '2026M07', '2026M08'], time: true },
    { code: 'Vísitala', text: 'Vísitala', values: ['CPI', 'CPIxH'], valueTexts: ['Vísitala neysluverðs', 'Vísitala neysluverðs án húsnæðis'] },
    { code: 'Liður', text: 'Liður', values: ['change_M', 'index'], valueTexts: ['Mánaðarbreyting, %', 'Vísitala'] },
  ],
};

test('CPI query picks the headline index level, not a rate or a sub-index', () => {
  const { query, picks, timeCode } = buildCpiQuery(META, 3);
  assert.equal(timeCode, 'Mánuður');
  assert.equal(picks['Vísitala'].value, 'CPI');
  assert.equal(picks['Liður'].value, 'index');
  assert.deepEqual(query.query[0].selection.values, ['2026M06', '2026M07', '2026M08']);
});

test('CPI response: latest month with a real value', () => {
  const data = {
    columns: [{ code: 'Mánuður', type: 't' }, { code: 'Vísitala', type: 'd' }, { code: 'Liður', type: 'd' }, { code: 'x', type: 'c' }],
    data: [
      { key: ['2026M07', 'CPI', 'index'], values: ['691.2'] },
      { key: ['2026M08', 'CPI', 'index'], values: ['694.6'] },
      { key: ['2026M09', 'CPI', 'index'], values: ['..'] },   // not yet published
    ],
  };
  assert.deepEqual(pickLatestCpi(data, 'Mánuður'), { vnv: '694.6', manudur: '2026M08' });
});

test('CPI override', () => {
  assert.deepEqual(parseCpiOverride('694.6@2026M08'), { vnv: '694.6', manudur: '2026M08' });
  assert.deepEqual(parseCpiOverride('694,6@2026M08'), { vnv: '694.6', manudur: '2026M08' });
  assert.equal(parseCpiOverride('694.6'), null);
  assert.equal(parseCpiOverride(''), null);
});
