/**
 * Invoice delivery settings, and the one rule that cannot be bypassed.
 *
 * Siggi's rule, 2026-11-02: "you can have either email or e-invoice or both on. But never have
 * both off." An operator with both switched off would simply never receive an invoice and
 * could later say so with a straight face.
 *
 * The rule lives in a pure function so it is enforced on the server for every caller, not by a
 * disabled checkbox that a direct API call walks straight past.
 */

const test = require('node:test');
const assert = require('node:assert');
const { nextDeliverySettings, applyDeliveryChange } = require('../src/payday');

const on = { email: 'bokhald@dæmi.is', sendEmail: true, sendElectronicInvoices: false };
const eInvOnly = { email: '', sendEmail: false, sendElectronicInvoices: true };
const both = { email: 'bokhald@dæmi.is', sendEmail: true, sendElectronicInvoices: true };

test('turning the last delivery route off is refused', () => {
  // Email is the only one on; switching it off would leave nothing.
  const r = nextDeliverySettings(on, { sendEmail: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'delivery_required');
});

test('turning e-invoicing off is refused when it is the only one on', () => {
  const r = nextDeliverySettings(eInvOnly, { sendElectronicInvoices: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'delivery_required');
});

test('switching both off in a single call is refused too', () => {
  // The obvious way round a rule enforced one field at a time.
  const r = nextDeliverySettings(both, { sendEmail: false, sendElectronicInvoices: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'delivery_required');
});

test('either one alone is fine', () => {
  assert.strictEqual(nextDeliverySettings(both, { sendEmail: false }).ok, true);
  assert.strictEqual(nextDeliverySettings(both, { sendElectronicInvoices: false }).ok, true);
});

test('both on is fine', () => {
  const r = nextDeliverySettings(eInvOnly, { sendEmail: true, email: 'a@b.is' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next.sendEmail, true);
  assert.strictEqual(r.next.sendElectronicInvoices, true);
});

test('switching email on while switching e-invoice off keeps one route open', () => {
  const r = nextDeliverySettings(eInvOnly,
    { sendEmail: true, email: 'a@b.is', sendElectronicInvoices: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next.sendEmail, true);
});

// ─── The address ──────────────────────────────────────────────────────────────

test('email cannot be switched on with nowhere to send it', () => {
  const r = nextDeliverySettings({ email: '', sendEmail: false, sendElectronicInvoices: true },
    { sendEmail: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'email_required');
});

test('an address that is not an address is refused', () => {
  for (const bad of ['not-an-email', 'a@b', '@b.is', 'a@.is', 'a b@c.is']) {
    const r = nextDeliverySettings(both, { email: bad });
    assert.strictEqual(r.ok, false, bad);
    assert.strictEqual(r.error, 'email_invalid', bad);
  }
});

test('the address is trimmed', () => {
  const r = nextDeliverySettings(both, { email: '  nytt@daemi.is  ' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next.email, 'nytt@daemi.is');
});

test('clearing the address is refused while email delivery is on', () => {
  const r = nextDeliverySettings(both, { email: '' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'email_required');
});

test('clearing the address is allowed once e-invoicing carries it', () => {
  const r = nextDeliverySettings(both, { email: '', sendEmail: false });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next.sendElectronicInvoices, true);
});

// ─── Only what was asked for ──────────────────────────────────────────────────

test('a field that is not in the patch is left exactly as it was', () => {
  const r = nextDeliverySettings(both, { email: 'nytt@daemi.is' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next.sendEmail, true);
  assert.strictEqual(r.next.sendElectronicInvoices, true);
  assert.deepStrictEqual(r.changed, { email: true, sendEmail: false, sendElectronicInvoices: false });
});

test('an empty patch changes nothing and is allowed', () => {
  const r = nextDeliverySettings(both, {});
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.changed, { email: false, sendEmail: false, sendElectronicInvoices: false });
});

test('what changed is reported, so only those fields are written to Payday', () => {
  // The two settings live on different Payday objects; writing one that did not change would
  // mean rewriting a recurring invoice for nothing.
  const r = nextDeliverySettings(eInvOnly, { sendEmail: true, email: 'a@b.is' });
  assert.strictEqual(r.changed.sendEmail, true);
  assert.strictEqual(r.changed.sendElectronicInvoices, false);
});

test('a missing current state is treated as everything off, and so refuses', () => {
  for (const cur of [null, undefined, {}]) {
    assert.strictEqual(nextDeliverySettings(cur, {}).ok, false);
    assert.strictEqual(nextDeliverySettings(cur, {}).error, 'delivery_required');
  }
});

test('truthy junk does not switch a route on', () => {
  // The patch comes off an HTTP body, so the values are whatever was sent.
  const r = nextDeliverySettings(both, { sendEmail: 0, sendElectronicInvoices: '' });
  assert.strictEqual(r.ok, false, 'both coerce to off, which is refused');
  assert.strictEqual(r.error, 'delivery_required');
});

// ─── Write order ──────────────────────────────────────────────────────────────
//
// Payday checks at toggle time whether the recipient can receive electronic invoices, so
// enabling sendElectronicInvoices is the call that can be refused. If that refusal landed after
// the email had been switched off, the operator would be left with no delivery at all — the
// exact outcome the never-both-off rule exists to prevent, arrived at by a different road.

function recorder() {
  const calls = [];
  return {
    calls,
    writeCustomer: async (patch) => { calls.push(['customer', patch]); },
    writeRecurring: async (on) => { calls.push(['recurring', on]); },
  };
}

test('the customer is written before the recurring invoice', async () => {
  const r = recorder();
  await applyDeliveryChange({
    next: { email: 'a@b.is', sendEmail: false, sendElectronicInvoices: true },
    changed: { email: false, sendEmail: true, sendElectronicInvoices: true },
    ...r,
  });
  assert.deepStrictEqual(r.calls.map(c => c[0]), ['customer', 'recurring']);
});

test('a refused e-invoice toggle leaves the email alone', async () => {
  // The case that matters: switching e-invoice on and email off in one go, and Payday says the
  // recipient cannot receive electronic invoices.
  const r = recorder();
  const refuse = async () => { throw new Error('Payday PUT /customers/x → HTTP 400: not capable'); };
  await assert.rejects(() => applyDeliveryChange({
    next: { email: 'a@b.is', sendEmail: false, sendElectronicInvoices: true },
    changed: { email: false, sendEmail: true, sendElectronicInvoices: true },
    writeCustomer: refuse, writeRecurring: r.writeRecurring,
  }), /not capable/);
  assert.deepStrictEqual(r.calls, [], 'the email must still be on afterwards');
});

test('nothing is written when nothing changed', async () => {
  const r = recorder();
  const wrote = await applyDeliveryChange({
    next: { email: 'a@b.is', sendEmail: true, sendElectronicInvoices: true },
    changed: { email: false, sendEmail: false, sendElectronicInvoices: false },
    ...r,
  });
  assert.deepStrictEqual(r.calls, []);
  assert.deepStrictEqual(wrote, { customer: false, recurring: false });
});

test('an email-only change never touches the recurring invoice', async () => {
  // Rewriting a customer's monthly billing to change an address would be gratuitous risk.
  const r = recorder();
  await applyDeliveryChange({
    next: { email: 'nytt@daemi.is', sendEmail: true, sendElectronicInvoices: true },
    changed: { email: true, sendEmail: false, sendElectronicInvoices: false },
    ...r,
  });
  assert.deepStrictEqual(r.calls, [['customer', { email: 'nytt@daemi.is' }]]);
});

test('switching email off alone never touches the customer', async () => {
  const r = recorder();
  await applyDeliveryChange({
    next: { email: 'a@b.is', sendEmail: false, sendElectronicInvoices: true },
    changed: { email: false, sendEmail: true, sendElectronicInvoices: false },
    ...r,
  });
  assert.deepStrictEqual(r.calls, [['recurring', false]]);
});

test('only the fields that changed go in the customer patch', async () => {
  const r = recorder();
  await applyDeliveryChange({
    next: { email: 'a@b.is', sendEmail: true, sendElectronicInvoices: true },
    changed: { email: false, sendEmail: false, sendElectronicInvoices: true },
    ...r,
  });
  assert.deepStrictEqual(r.calls, [['customer', { sendElectronicInvoices: true }]],
    'the address is not resent when it did not change');
});
