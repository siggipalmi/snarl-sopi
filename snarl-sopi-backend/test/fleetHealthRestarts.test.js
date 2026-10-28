'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { nextSelfTestRecord, selfTestIssues } = require('../src/fleetHealth');

const MIN = 60000;
const iso = ms => new Date(ms).toISOString();
const t0 = Date.parse('2026-10-28T08:00:00Z');

function run(starts) {
  let rec = null;
  starts.forEach((s, i) => { rec = nextSelfTestRecord(rec, { processStart: iso(s) }, t0 + i * 15 * MIN); });
  return rec;
}

test('one process whose computed start wobbles by milliseconds is not restarting', () => {
  const rec = run([t0, t0 + 3, t0 - 2, t0 + 7, t0 + 1, t0 - 4, t0 + 2, t0 + 5]);
  assert.deepEqual(rec.restarts, []);
  assert.deepEqual(selfTestIssues(rec, t0 + 8 * 15 * MIN, true).filter(i => i.kind === 'restarts'), []);
});

test('real restarts are counted once each', () => {
  const a = t0 + 20 * MIN, b = t0 + 50 * MIN, c = t0 + 80 * MIN;
  const rec = run([t0, t0 + 2, a, a + 4, b, b - 3, c, c + 1]);
  assert.deepEqual(rec.restarts, [a, b, c]);
  const issues = selfTestIssues(rec, t0 + 2 * 3600000, true).filter(i => i.kind === 'restarts');
  assert.equal(issues.length, 1);
  assert.match(issues[0].label, /3 times/);
});

test('stored false restarts from the old comparison collapse to one', () => {
  const prev = { processStart: iso(t0), restarts: [t0 + 1, t0 - 2, t0 + 3, t0 + 1, t0 + 4] };
  const rec = nextSelfTestRecord(prev, { processStart: iso(t0 + 2) }, t0 + 60 * MIN);
  assert.deepEqual(rec.restarts, [t0 - 2]);
  assert.deepEqual(selfTestIssues(rec, t0 + 60 * MIN, true).filter(i => i.kind === 'restarts'), []);
});
