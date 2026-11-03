/**
 * The daily accounting export: what a day adds up to, the journal entry it becomes, which days
 * the scheduler touches, and the sealed credentials. Everything here runs without Payday.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'accounting-test-' + process.pid + '.db');
process.env.ACCOUNTING_ENC_KEY = 'x'.repeat(40);

const accounting = require('../src/accounting');
const { buildJournal } = require('../src/accountingPayday');
const { summarize, dueDays, seal, open } = accounting._test;

const row = (tradeNo, cents, vatRate, extra = {}) => ({ tradeNo, deviceCode: 'M1', goodsId: 'g' + vatRate, name: 'P' + vatRate, payAmount: cents, vatRate, ...extra });

test('a day sums per VAT rate, in whole krónur', () => {
  const s = summarize('2026-11-01', [row('a', 35000, 11), row('a', 25000, 11), row('b', 49900, 24)]);
  assert.deepStrictEqual(s.byRate, { '11': 600, '24': 499 });
  assert.strictEqual(s.grossKr, 1099);
  assert.strictEqual(s.orders, 2);
  assert.strictEqual(s.units, 3);
  assert.deepStrictEqual(s.unknownVat, []);
});

test('a product with no VAT rate is reported, never folded into 11%', () => {
  const s = summarize('2026-11-01', [row('a', 35000, 11), row('b', 20000, null, { goodsId: 'x', name: 'Kókómjólk' })]);
  assert.deepStrictEqual(s.byRate, { '11': 350, '24': 0 });
  assert.strictEqual(s.unknownVat.length, 1);
  assert.strictEqual(s.unknownVat[0].name, 'Kókómjólk');
  assert.strictEqual(s.grossKr, 550);
});

test('the journal credits sales gross with the VAT type and debits the clearing account', () => {
  const j = buildJournal({ summary: { day: '2026-11-01', byRate: { '11': 600, '24': 499 } },
    accounts: { clearing: 'C', sales11: 'S11', sales24: 'S24' }, status: undefined, reference: 'SNARL-op-2026-11-01' });
  assert.strictEqual(j.status, 'DRAFT');                       // a bookkeeper posts it unless told otherwise
  assert.strictEqual(j.date, '2026-11-01');
  assert.ok(j.description.length <= 100);
  assert.ok(j.description.includes('SNARL-op-2026-11-01'));
  assert.deepStrictEqual(j.lines, [
    { amount: -600, vatPercentType: 'ReducedVAT', ledgerAccountId: 'S11' },
    { amount: -499, vatPercentType: 'StandardVAT', ledgerAccountId: 'S24' },
    { amount: 1099, ledgerAccountId: 'C' },
  ]);
  assert.strictEqual(j.lines.reduce((s, l) => s + l.amount, 0), 0);
});

test('a rate with no sales gets no line; a negative correction flips signs', () => {
  const accounts = { clearing: 'C', sales11: 'S11', sales24: 'S24' };
  const one = buildJournal({ summary: { day: 'd', byRate: { '11': 350, '24': 0 } }, accounts, reference: 'r' });
  assert.strictEqual(one.lines.length, 2);
  const back = buildJournal({ summary: { day: 'd', byRate: { '11': -350, '24': 0 } }, accounts, reference: 'r-L1', label: 'Leiðrétting sölu' });
  assert.deepStrictEqual(back.lines, [
    { amount: 350, vatPercentType: 'ReducedVAT', ledgerAccountId: 'S11' },
    { amount: -350, ledgerAccountId: 'C' },
  ]);
});

test('the scheduler touches only unsent, held and failing days, from the start date, never a sent one', () => {
  const cfg = { enabled: true, provider: 'payday', startDate: '2026-10-30' };
  const now = Date.parse('2026-11-03T07:00:00Z');
  const longAgo = now - 2 * 3600 * 1000;
  const rows = {
    '2026-10-30': { status: 'sent' },
    '2026-10-31': { status: 'uncertain', lastAttemptAt: longAgo },
    '2026-11-01': { status: 'failed', attempts: 2, lastAttemptAt: longAgo },
  };
  assert.deepStrictEqual(dueDays(cfg, rows, '2026-11-03', now), ['2026-11-01', '2026-11-02']);
  // Before the start date nothing, however far the catch-up window reaches.
  assert.deepStrictEqual(dueDays({ ...cfg, startDate: '2026-11-03' }, {}, '2026-11-03', now), []);
  // Switched off: nothing.
  assert.deepStrictEqual(dueDays({ ...cfg, enabled: false }, {}, '2026-11-03', now), []);
  // A failure is retried hourly, and given up on after six tries.
  assert.deepStrictEqual(dueDays(cfg, { ...rows, '2026-11-01': { status: 'failed', attempts: 6, lastAttemptAt: longAgo } }, '2026-11-03', now), ['2026-11-02']);
  assert.deepStrictEqual(dueDays(cfg, { ...rows, '2026-11-01': { status: 'failed', attempts: 1, lastAttemptAt: now - 60000 } }, '2026-11-03', now), ['2026-11-02']);
});

test('credentials round-trip sealed, and a tampered or foreign value opens to nothing', () => {
  const s = seal({ clientId: 'id', clientSecret: 'secret' });
  assert.ok(!s.includes('secret'));
  assert.deepStrictEqual(open(s), { clientId: 'id', clientSecret: 'secret' });
  const bad = s.slice(0, -4) + (s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.strictEqual(open(bad), null);
  assert.strictEqual(open('plain'), null);
});

test('settings: the secret never comes back, and switching on needs accounts and a login', () => {
  const op = 'op_test';
  let r = accounting.saveConnection(op, { provider: 'payday', clientId: 'cid-1234', clientSecret: 'very-secret' }, { by: 'u', isAg: false });
  assert.strictEqual(r.ok, true);
  assert.ok(!JSON.stringify(r.view).includes('very-secret'));
  assert.strictEqual(r.view.credentials.clientIdHint, '…1234');

  r = accounting.saveConnection(op, { enabled: true }, { by: 'u', isAg: false });
  assert.strictEqual(r.error, 'accounts_incomplete');
  r = accounting.saveConnection(op, { accounts: { clearing: 'A', sales11: 'A', sales24: 'B' }, enabled: true }, { by: 'u', isAg: false });
  assert.strictEqual(r.error, 'accounts_overlap');
  r = accounting.saveConnection(op, { accounts: { clearing: 'C', sales11: 'S', sales24: 'S' }, enabled: true }, { by: 'u', isAg: false });
  assert.strictEqual(r.ok, true);
  assert.ok(r.view.config.startDate, 'switching on sets a start date rather than backfilling');

  // Only AG may point an operator at the test environment or Railway's test login.
  assert.strictEqual(accounting.saveConnection(op, { credentialSource: 'railway-test' }, { by: 'u', isAg: false }).error, 'ag_only');
  // Another system drops the login and switches the send off.
  assert.strictEqual(accounting.saveConnection(op, { provider: 'dk' }, { by: 'u', isAg: false }).error, 'provider_not_available');
});

// ─── Sending, against a stand-in for Payday ──────────────────────────────────

test('send, re-send and the cases that must not double the books', async () => {
  const storage = require('../src/storage');
  const paydayLedger = require('../src/accountingPayday');
  const db = storage.db;
  const op = 'op_send';
  const day = '2026-10-20';
  const t0 = Date.parse(day + 'T12:00:00Z');
  db.prepare(`INSERT OR IGNORE INTO operators (id, name, createdAt) VALUES (?, 'Send test', '2026-01-01')`).run(op);
  db.prepare(`INSERT OR IGNORE INTO machines (deviceCode, deviceName, operatorId, configVersion, createdAt, updatedAt)
    VALUES ('SEND1', 'Vél', ?, '1', '2026-01-01', '2026-01-01')`).run(op);
  db.prepare(`INSERT OR REPLACE INTO products (goodsId, name, vatRate, createdAt, updatedAt) VALUES ('p11', 'Samloka', 11, 0, 0)`).run();
  db.prepare(`INSERT OR REPLACE INTO products (goodsId, name, vatRate, createdAt, updatedAt) VALUES ('pnone', 'Nýtt', NULL, 0, 0)`).run();
  const sale = (tradeNo, goodsId, cents, shipped = 1) => db.prepare(`INSERT OR REPLACE INTO order_items
    (tradeNo, lineIndex, deviceCode, goodsId, productName, payAmount, shipmentStatus, createTime) VALUES (?, 0, 'SEND1', ?, '', ?, ?, ?)`)
    .run(tradeNo, goodsId, cents, shipped, t0);

  // Stand-in Payday: records what it was asked, and can be told to misbehave.
  const calls = [];
  let mode = 'ok';
  paydayLedger.client = () => ({
    environment: 'test',
    async createJournal(entry) {
      calls.push(['create', entry]);
      if (mode === 'timeout') throw new Error('Payday request timed out');           // no HTTP status
      if (mode === 'refuse') { const e = new Error('HTTP 400'); e.status = 400; throw e; }
      return { id: 'je-' + calls.length };
    },
    async deleteJournal(id) {
      calls.push(['delete', id]);
      if (mode === 'posted') { const e = new Error('HTTP 400: posted'); e.status = 400; throw e; }
      return null;
    },
  });

  let r = accounting.saveConnection(op, { provider: 'payday', clientId: 'id', clientSecret: 's',
    accounts: { clearing: 'C', sales11: 'S11', sales24: 'S24' }, enabled: true, startDate: day }, { by: 'u' });
  assert.strictEqual(r.ok, true);

  sale('t1', 'p11', 35000);
  sale('t2', 'p11', 99900, 0);                                   // not dispensed: not a sale
  let out = await accounting.sendDay(op, day, { by: 'u' });
  assert.strictEqual(out.outcome, 'sent');
  assert.deepStrictEqual(calls.pop()[1].lines.map(l => l.amount), [-350, 350]);
  assert.strictEqual((await accounting.sendDay(op, day, { by: 'u' })).outcome, 'unchanged');

  // A late sale: the draft is replaced with the new figures.
  sale('t3', 'p11', 15000);
  assert.strictEqual(accounting.history(op)[0].drift, 150);
  out = await accounting.sendDay(op, day, { by: 'u' });
  assert.strictEqual(out.outcome, 'replaced');
  assert.deepStrictEqual(calls.slice(-2).map(c => c[0]), ['delete', 'create']);
  assert.strictEqual(accounting.history(op)[0].drift, 0);

  // Another one after the bookkeeper posted it: only the difference is booked.
  sale('t4', 'p11', 10000);
  mode = 'posted';
  out = await accounting.sendDay(op, day, { by: 'u' });
  assert.strictEqual(out.outcome, 'corrected');
  const corr = calls.pop()[1];
  assert.deepStrictEqual(corr.lines.map(l => l.amount), [-100, 100]);
  assert.ok(corr.description.includes('-L1'));
  assert.strictEqual(accounting.history(op)[0].grossKr, 600);

  // A product with no VAT rate holds an unsent day.
  const day2 = '2026-10-21';
  db.prepare(`INSERT OR REPLACE INTO order_items (tradeNo, lineIndex, deviceCode, goodsId, productName, payAmount, shipmentStatus, createTime)
    VALUES ('u1', 0, 'SEND1', 'pnone', '', 20000, 1, ?)`).run(Date.parse(day2 + 'T09:00:00Z'));
  mode = 'ok';
  const before = calls.length;
  assert.strictEqual((await accounting.sendDay(op, day2, { by: 'u' })).outcome, 'held');
  assert.strictEqual(calls.length, before, 'nothing went to Payday');

  // A send that times out is uncertain, and is not repeated without someone saying so.
  db.prepare(`UPDATE products SET vatRate = 24 WHERE goodsId = 'pnone'`).run();
  mode = 'timeout';
  assert.strictEqual((await accounting.sendDay(op, day2, { by: 'scheduled' })).outcome, 'uncertain');
  mode = 'ok';
  assert.strictEqual((await accounting.sendDay(op, day2, { by: 'scheduled' })).outcome, 'refused');
  assert.strictEqual((await accounting.sendDay(op, day2, { by: 'u', force: true })).outcome, 'sent');

  // A refusal from Payday is a plain failure, safe to retry.
  const day3 = '2026-10-22';
  db.prepare(`INSERT OR REPLACE INTO order_items (tradeNo, lineIndex, deviceCode, goodsId, productName, payAmount, shipmentStatus, createTime)
    VALUES ('v1', 0, 'SEND1', 'p11', '', 5000, 1, ?)`).run(Date.parse(day3 + 'T09:00:00Z'));
  mode = 'refuse';
  assert.strictEqual((await accounting.sendDay(op, day3, { by: 'scheduled' })).outcome, 'failed');
  mode = 'ok';
  assert.strictEqual((await accounting.sendDay(op, day3, { by: 'scheduled' })).outcome, 'sent');

  // Today is never sent: it is not over.
  assert.strictEqual((await accounting.sendDay(op, new Date().toISOString().slice(0, 10), { by: 'u' })).outcome, 'refused');
});
