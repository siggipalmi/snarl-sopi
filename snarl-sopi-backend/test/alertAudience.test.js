'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { audienceFor, visibleTo, AUDIENCE, OPERATOR, OPERATOR_ADMIN, AG } = require('../src/alertAudience');

const agAdmin   = { role: 'ag_admin' };
const opAdmin   = { role: 'operator_admin' };
const restocker = { role: 'operator_restocker' };
const manager   = { role: 'operator_manager' };
const a = type => ({ type, deviceCode: '62100001' });

test('an unclassified type is AG-only — new alerts must not leak by omission', () => {
  assert.equal(audienceFor('something_invented_next_year'), AG);
  assert.equal(visibleTo(opAdmin, a('something_invented_next_year')), false);
  assert.equal(visibleTo(restocker, a('something_invented_next_year')), false);
  assert.equal(visibleTo(agAdmin, a('something_invented_next_year')), true);
});

test('a missing or empty type is AG-only', () => {
  for (const t of [undefined, null, '']) {
    assert.equal(audienceFor(t), AG);
    assert.equal(visibleTo(opAdmin, { type: t }), false);
  }
});

test('AG sees every classified type', () => {
  for (const type of Object.keys(AUDIENCE)) assert.equal(visibleTo(agAdmin, a(type)), true, type);
});

test('operator types reach every operator role', () => {
  for (const [type, aud] of Object.entries(AUDIENCE)) {
    if (aud !== OPERATOR) continue;
    for (const u of [opAdmin, manager, restocker]) assert.equal(visibleTo(u, a(type)), true, `${type} / ${u.role}`);
  }
});

test('operator_admin types stop at the operator admin', () => {
  for (const [type, aud] of Object.entries(AUDIENCE)) {
    if (aud !== OPERATOR_ADMIN) continue;
    assert.equal(visibleTo(opAdmin, a(type)), true, type);
    assert.equal(visibleTo(manager, a(type)), false, type);
    assert.equal(visibleTo(restocker, a(type)), false, type);
  }
});

test('AG types reach nobody else', () => {
  for (const [type, aud] of Object.entries(AUDIENCE)) {
    if (aud !== AG) continue;
    for (const u of [opAdmin, manager, restocker]) assert.equal(visibleTo(u, a(type)), false, `${type} / ${u.role}`);
  }
});

test('the alert an operator actually rang about is AG-only', () => {
  // adb_wifi is a command, not an alert type, so it surfaces as unsupported_command
  // or as a per-machine internal alert. Either way it must not reach an operator.
  assert.equal(visibleTo(opAdmin, a('unsupported_command')), false);
  assert.equal(visibleTo(opAdmin, a('device_owner_cleared')), false);
  assert.equal(visibleTo(opAdmin, a('app_revert')), false);
});

test('a signed-out or roleless user gets nothing but operator-tier at most', () => {
  assert.equal(visibleTo(undefined, a('invalid_machine_key')), false);
  assert.equal(visibleTo({}, a('settlement_mismatch')), false);
});
