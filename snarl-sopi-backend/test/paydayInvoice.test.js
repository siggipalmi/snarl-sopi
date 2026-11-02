/**
 * The invoice list and the ledger must agree about what is owed.
 *
 * They did not. buildLedger skipped cancelled invoices; the list was never told an invoice had
 * been cancelled, because _normInvoice dropped cancelledDate, so it showed those rows as
 * "overdue". An operator saw an outstanding balance of one figure and a column of overdue rows
 * adding up to a larger one — and a credit note, a negative amount, marked overdue as well.
 *
 * Both now read invoiceState(). These tests pin the cases that were wrong on screen.
 */

const test = require('node:test');
const assert = require('node:assert');
const payday = require('../src/payday');

const { invoiceState, invoiceIsLive, buildLedger } = payday;

const inv = (o) => Object.assign({
  id: 'i1', number: 1, invoiceDate: '2026-02-01', dueDate: '2026-02-15',
  finalDueDate: '2026-02-28', amountIncludingVat: 50173, status: 'UNPAID',
}, o);

test('an open invoice is open, and counts as owed', () => {
  assert.strictEqual(invoiceState(inv()), 'open');
  assert.strictEqual(invoiceIsLive(inv()), true);
});

test('a paid invoice is paid, by date or by status', () => {
  assert.strictEqual(invoiceState(inv({ paidDate: '2026-02-10' })), 'paid');
  assert.strictEqual(invoiceState(inv({ status: 'PAID' })), 'paid');
  assert.strictEqual(invoiceIsLive(inv({ status: 'PAID' })), false);
});

test('a cancelled invoice is cancelled however long ago it was due', () => {
  // This is the case that showed as "overdue" on screen.
  assert.strictEqual(invoiceState(inv({ cancelledDate: '2026-02-03' })), 'cancelled');
  assert.strictEqual(invoiceState(inv({ status: 'CANCELLED' })), 'cancelled');
  assert.strictEqual(invoiceIsLive(inv({ cancelledDate: '2026-02-03' })), false);
});

test('a credited or refunded invoice is not owed', () => {
  assert.strictEqual(invoiceState(inv({ creditDate: '2026-02-04' })), 'credited');
  assert.strictEqual(invoiceState(inv({ status: 'CREDITED' })), 'credited');
  assert.strictEqual(invoiceState(inv({ refundDate: '2026-02-04' })), 'credited');
  assert.strictEqual(invoiceState(inv({ status: 'REFUNDED' })), 'credited');
});

test('a negative amount is a credit note, never something overdue', () => {
  // Invoice #139 on screen: kr. -50.173, tagged "overdue".
  assert.strictEqual(invoiceState(inv({ amountIncludingVat: -50173 })), 'credited');
  assert.strictEqual(invoiceIsLive(inv({ amountIncludingVat: -50173 })), false);
});

test('cancelled wins over paid, so a withdrawn invoice is never shown as settled', () => {
  assert.strictEqual(invoiceState(inv({ cancelledDate: '2026-02-03', paidDate: '2026-02-02' })),
    'cancelled');
});

test('a missing or empty invoice does not throw', () => {
  for (const bad of [null, undefined, {}, { status: null }]) {
    assert.strictEqual(typeof invoiceState(bad), 'string');
  }
});

// ─── The ledger ───────────────────────────────────────────────────────────────

test('the ledger leaves cancelled invoices out of the balance', () => {
  const moves = buildLedger([
    inv({ id: 'a', number: 1, amountIncludingVat: 51567 }),
    inv({ id: 'b', number: 2, amountIncludingVat: 51529, cancelledDate: '2026-03-01' }),
  ]);
  assert.strictEqual(moves[0].balance, 51567, 'only the live invoice counts');
  assert.ok(!moves.some(m => m.ref === 2), 'the cancelled one contributes no movement');
});

test('an invoice and its credit note net to zero', () => {
  // The February pair from the screenshot: #127 at +50.173 and #139 at -50.173.
  const moves = buildLedger([
    inv({ id: 'c127', number: 127, invoiceDate: '2026-02-01', amountIncludingVat: 50173 }),
    inv({ id: 'c139', number: 139, invoiceDate: '2026-02-02', amountIncludingVat: -50173 }),
  ]);
  assert.strictEqual(moves[0].balance, 0, 'a credit note cancels the invoice exactly');
});

test('a credit note is dropped only when it cancels an invoice that was dropped', () => {
  // Checked against Payday's own ledger. The invoice it cancels is already gone as cancelled,
  // so counting the credit as well subtracts the same money twice — 50.173 kr on the real
  // account. They are paired by magnitude, Payday giving no link between the two documents.
  const paired = buildLedger([
    inv({ number: 127, amountIncludingVat: 50173, status: 'CANCELLED', cancelledDate: '2026-02-01' }),
    inv({ number: 139, amountIncludingVat: -50173 }),
  ]);
  assert.strictEqual(paired.length, 0, 'both documents drop out together');

  // With no cancelled invoice to pair against, the credit is a real credit on the account.
  const lone = buildLedger([inv({ number: 9, amountIncludingVat: -50173 })]);
  assert.strictEqual(lone.length, 1, 'it still counts');
  assert.strictEqual(lone[0].balance, -50173);

  // Two cancellations, two credit notes: each absorbs one, and nothing is left over.
  const two = buildLedger([
    inv({ number: 1, amountIncludingVat: 1000, status: 'CANCELLED', cancelledDate: '2026-01-01' }),
    inv({ number: 2, amountIncludingVat: 1000, status: 'CANCELLED', cancelledDate: '2026-01-01' }),
    inv({ number: 3, amountIncludingVat: -1000 }),
    inv({ number: 4, amountIncludingVat: -1000 }),
  ]);
  assert.strictEqual(two.length, 0);

  // One cancellation but two credit notes: only one is absorbed, the other is a real credit.
  const spare = buildLedger([
    inv({ number: 1, amountIncludingVat: 1000, status: 'CANCELLED', cancelledDate: '2026-01-01' }),
    inv({ number: 3, amountIncludingVat: -1000 }),
    inv({ number: 4, amountIncludingVat: -1000 }),
  ]);
  assert.strictEqual(spare[0].balance, -1000, 'the spare credit still counts');
});

test('a paid invoice leaves nothing outstanding', () => {
  const moves = buildLedger([
    inv({ number: 158, amountIncludingVat: 50836, paidDate: '2026-04-10', status: 'PAID' }),
  ]);
  assert.strictEqual(moves[0].balance, 0);
  assert.deepStrictEqual(moves.map(m => m.kind).sort(), ['invoice', 'payment']);
});

test('the balance equals the sum of everything still owed', () => {
  // The whole point: whatever the list shows as owed must add up to the balance.
  const rows = [
    inv({ number: 199, invoiceDate: '2026-07-01', amountIncludingVat: 51567 }),
    inv({ number: 184, invoiceDate: '2026-06-01', amountIncludingVat: 51529 }),
    inv({ number: 171, invoiceDate: '2026-05-01', amountIncludingVat: 51115, cancelledDate: '2026-05-09' }),
    inv({ number: 158, invoiceDate: '2026-04-01', amountIncludingVat: 50836, status: 'PAID', paidDate: '2026-04-09' }),
    inv({ number: 127, invoiceDate: '2026-02-01', amountIncludingVat: 50173 }),
    inv({ number: 139, invoiceDate: '2026-02-02', amountIncludingVat: -50173 }),
  ];
  const moves = buildLedger(rows);

  // What is owed is the open invoices LESS any credit note sitting against the account. A
  // credit note is not "live" — it is not a demand for payment and must never show as overdue
  // — but it does reduce the balance, which is why the two ideas are counted separately here.
  const owed = rows
    .filter(r => invoiceIsLive(r) || (invoiceState(r) === 'credited' && r.amountIncludingVat < 0))
    .reduce((t, r) => t + r.amountIncludingVat, 0);

  assert.strictEqual(moves[0].balance, owed,
    'the ledger balance and the live invoices must be the same number');
  // 199 and 184 are open; 171 is cancelled; 158 is paid; 127 and 139 cancel each other out.
  assert.strictEqual(owed, 51567 + 51529);
});

test('a credit note is never an unpaid invoice', () => {
  const rows = [
    inv({ number: 1, amountIncludingVat: 30000 }),
    inv({ number: 2, amountIncludingVat: 20000 }),
    inv({ number: 3, amountIncludingVat: -5000 }),
  ];
  assert.strictEqual(rows.filter(invoiceIsLive).length, 2);
  // Nothing was cancelled here, so the credit note is a real credit on the account and comes
  // off the balance. The count and the balance are different numbers on purpose: the count is
  // how many invoices await payment, the balance is what is owed net of credits.
  assert.strictEqual(buildLedger(rows)[0].balance, 45000);
});

test('the real account from 2026-11-02 reconciles with Payday, bar the claim fee', () => {
  // Every figure here is read off Payday's own Hreyfingalisti for this customer.
  const rows = [
    inv({ number: 199, invoiceDate: '2026-07-01', amountIncludingVat: 51567 }),
    inv({ number: 184, invoiceDate: '2026-06-01', amountIncludingVat: 51529 }),
    inv({ number: 171, invoiceDate: '2026-05-01', amountIncludingVat: 51115 }),
    inv({ number: 158, invoiceDate: '2026-04-01', amountIncludingVat: 50836, status: 'PAID', paidDate: '2026-05-06' }),
    inv({ number: 144, invoiceDate: '2026-03-01', amountIncludingVat: 50361, status: 'PAID', paidDate: '2026-05-06' }),
    inv({ number: 139, invoiceDate: '2026-02-02', amountIncludingVat: -50173, status: 'CREDITED', creditDate: '2026-02-01' }),
    inv({ number: 127, invoiceDate: '2026-02-01', amountIncludingVat: 50173, status: 'CANCELLED', cancelledDate: '2026-02-01' }),
  ];
  const balance = buildLedger(rows)[0].balance;

  // Before the fix this came out at 104.038: the credit note was subtracted although the
  // invoice it cancelled had already been dropped.
  assert.strictEqual(balance, 154211, 'the three open invoices, nothing else');
  assert.notStrictEqual(balance, 104038, 'the double-counted credit note is gone');

  // Payday's closing balance is 154.808. The 597 left over is the 199 kr seðilgjald on each of
  // the three open claims, which is not part of amountIncludingVat and cannot be recovered from
  // invoice data. Asserted so that nobody later "fixes" this number by inventing a fee.
  const PAYDAY_CLOSING = 154808, CLAIM_FEE = 199, OPEN_CLAIMS = 3;
  assert.strictEqual(PAYDAY_CLOSING - balance, CLAIM_FEE * OPEN_CLAIMS);
});
