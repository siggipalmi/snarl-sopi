/**
 * Reading Payday's account statement.
 *
 * The published collection has no response example for /customers/:id/accountStatement, so the
 * parser reads field names tolerantly and must say ok:false rather than guess when it cannot
 * find what it needs — the caller falls back to the invoice-derived ledger on a false, and a
 * wrong balance on a customer's own page is worse than an approximate one.
 *
 * The first fixture is the statement from the screenshot Siggi sent on 2026-11-02, whose
 * closing balance is 154.808 kr.
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseStatement } = require('../src/payday');

// Payday's Hreyfingalisti for Bus Station — verslun ehf., as its own UI renders it.
const REAL = { rows: [
  { date: '2026-02-01', description: 'Reikningur nr. 127',            voucher: 'SR00000127', debit: 50372, credit: null,  balance: 50372 },
  { date: '2026-02-01', description: 'Kreditfært: Reikningur nr. 127', voucher: 'SR00000139', debit: null,  credit: 50173, balance: 199 },
  { date: '2026-02-16', description: 'Seðilgjald dregið af kröfu',     voucher: '0000000793', debit: null,  credit: 199,   balance: 0 },
  { date: '2026-03-01', description: 'Reikningur nr. 144',            voucher: 'SR00000144', debit: 50560, credit: null,  balance: 50560 },
  { date: '2026-04-01', description: 'Reikningur nr. 158',            voucher: 'SR00000158', debit: 51035, credit: null,  balance: 101595 },
  { date: '2026-05-01', description: 'Reikningur nr. 171',            voucher: 'SR00000171', debit: 51314, credit: null,  balance: 152909 },
  { date: '2026-05-06', description: 'Greiðsla á reikning nr. 144',   voucher: 'S000002895', debit: null,  credit: 50560, balance: 102349 },
  { date: '2026-05-06', description: 'Greiðsla á reikning nr. 158',   voucher: 'S000002896', debit: null,  credit: 51035, balance: 51314 },
  { date: '2026-06-01', description: 'Reikningur nr. 184',            voucher: 'SR00000184', debit: 51728, credit: null,  balance: 103042 },
  { date: '2026-07-01', description: 'Reikningur nr. 199',            voucher: 'SR00000199', debit: 51766, credit: null,  balance: 154808 },
] };

test('the real statement reads back at 154.808', () => {
  const r = parseStatement(REAL);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.movements.length, 10);
  assert.strictEqual(r.closingBalance, 154808, 'the figure Payday itself shows');
  assert.strictEqual(r.hadBalance, true, 'Payday carried its own running balance');
});

test('it beats the invoice-derived ledger on the same account', () => {
  // buildLedger gets 154.211 and cannot do better: the 199 kr claim fee on each of the three
  // open claims is not part of any invoice amount. The statement has it.
  const { closingBalance } = parseStatement(REAL);
  assert.strictEqual(closingBalance - 154211, 597);
  assert.strictEqual(597, 199 * 3);
});

test('newest first, because that is how the page lists movements', () => {
  const r = parseStatement(REAL);
  assert.match(r.movements[0].desc, /nr\. 199/);
  assert.match(r.movements[r.movements.length - 1].desc, /nr\. 127/);
});

test('a debit is positive and a credit is negative', () => {
  const r = parseStatement(REAL);
  const inv199 = r.movements.find(m => m.ref === 'SR00000199');
  const pay144 = r.movements.find(m => m.ref === 'S000002895');
  assert.strictEqual(inv199.amount, 51766);
  assert.strictEqual(pay144.amount, -50560);
  assert.strictEqual(inv199.kind, 'invoice');
  assert.strictEqual(pay144.kind, 'payment');
});

test('the seðilgjald survives, since losing it is the whole bug', () => {
  const r = parseStatement(REAL);
  const fee = r.movements.find(m => /Seðilgjald/.test(m.desc));
  assert.ok(fee, 'the fee row must be present');
  assert.strictEqual(fee.amount, -199);
});

// ─── Shapes we have not seen ──────────────────────────────────────────────────

test('Icelandic field names and formatted money are read', () => {
  const r = parseStatement({ rows: [
    { dags: '2026-02-01', 'lýsing': 'Reikningur', fylgiskjal: 'SR127', debet: '50.372 kr.', kredit: '', 'staða': '50.372 kr.' },
    { dags: '2026-02-02', 'lýsing': 'Greiðsla',   fylgiskjal: 'S900',  debet: '',           kredit: '372 kr.', 'staða': '50.000 kr.' },
  ] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closingBalance, 50000);
  assert.strictEqual(r.movements[r.movements.length - 1].amount, 50372);
});

test('a statement with amounts but no running balance is accumulated', () => {
  const r = parseStatement({ rows: [
    { date: '2026-03-01', description: 'Inv', amount: 1000 },
    { date: '2026-03-05', description: 'Pay', amount: -400 },
  ] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closingBalance, 600);
  assert.strictEqual(r.hadBalance, false, 'nothing to trust, so it was computed');
});

test('a bare array is accepted as well as { rows }', () => {
  const r = parseStatement([{ date: '2026-01-01', description: 'x', amount: 10 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closingBalance, 10);
});

test('an empty statement is a valid answer, not a failure', () => {
  const r = parseStatement({ rows: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closingBalance, 0);
  assert.strictEqual(r.empty, true);
});

// ─── Order, which must not be assumed ─────────────────────────────────────────

test('a newest-first statement with balances still closes at the newest balance', () => {
  // This went wrong on the live page: reading newest-first while trusting the balance column
  // took the OLDEST row's balance as the closing figure — 51.314 against a true 154.808.
  const newestFirst = { rows: REAL.rows.slice().reverse() };
  const r = parseStatement(newestFirst);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.closingBalance, 154808);
});

test('the same statement either way round gives the same balance', () => {
  const a = parseStatement(REAL).closingBalance;
  const b = parseStatement({ rows: REAL.rows.slice().reverse() }).closingBalance;
  assert.strictEqual(a, b, 'row order must not change the answer');
  assert.strictEqual(a, 154808);
});

test('rows shuffled into no order at all still sort by date', () => {
  const shuffled = { rows: [REAL.rows[4], REAL.rows[0], REAL.rows[9], REAL.rows[2],
                            REAL.rows[7], REAL.rows[1], REAL.rows[8], REAL.rows[3],
                            REAL.rows[6], REAL.rows[5]] };
  assert.strictEqual(parseStatement(shuffled).closingBalance, 154808);
});

test('a partial read is reported, so the caller can refuse it', () => {
  // One row parsable out of two: on the real account a single parsed row produced 51.766,
  // presented as Payday's own figure. The counts let the caller catch that.
  const r = parseStatement({ rows: [
    { date: '2026-07-01', description: '199', debit: 51766 },
    { date: '2026-06-01', description: '184', someUnknownKey: 51728 },
  ] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rowsSeen, 2);
  assert.strictEqual(r.rowsRead, 1, 'the caller compares this against the invoice count');
});

test('a full read reports every row', () => {
  const r = parseStatement(REAL);
  assert.strictEqual(r.rowsSeen, 10);
  assert.strictEqual(r.rowsRead, 10);
});

// ─── Refusing to guess ────────────────────────────────────────────────────────

test('rows with no recognisable amount are refused, not invented', () => {
  const r = parseStatement({ rows: [{ foo: 'bar' }, { baz: 1 }] });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no amounts/);
});

test('a response that is not a list is refused', () => {
  for (const bad of [null, undefined, {}, { error: 'nope' }, 'a string']) {
    assert.strictEqual(parseStatement(bad).ok, false, JSON.stringify(bad));
  }
});

test('rows that are not movements are skipped without failing the rest', () => {
  // An opening-balance row carries no debit or credit in the UI.
  const r = parseStatement({ rows: [
    { date: '2026-01-01', description: 'Upphafsstaða' },
    { date: '2026-02-01', description: 'Reikningur', debit: 1000, balance: 1000 },
  ] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.movements.length, 1);
  assert.strictEqual(r.closingBalance, 1000);
});
