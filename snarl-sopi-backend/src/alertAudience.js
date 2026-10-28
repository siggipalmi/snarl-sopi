'use strict';
/**
 * Who is an alert for?
 *
 * Until now an alert went to anyone who could see the machine it named, and
 * only alerts with no machine at all were AG-only. That is a split by SUBJECT,
 * not by AUDIENCE, so every internal per-machine alert — wireless debugging,
 * app rollback, machine-key trouble — landed in operators' dashboards. One of
 * them rang us about an adb_wifi alert (Siggi, 2026-10-28).
 *
 * Three tiers:
 *   operator        anyone who can see the machine. Things that stop it selling
 *                   or put product at risk, and that they can act on.
 *   operator_admin  the account's own admin, not its restockers: money and
 *                   account setup.
 *   ag              us. Provisioning, app rollout, wiring, our own plumbing.
 *
 * A type that is not listed is AG-only. New alert types get added all the
 * time and an unclassified one must not leak by omission — the default has to
 * be the quiet end.
 */
const OPERATOR = 'operator';
const OPERATOR_ADMIN = 'operator_admin';
const AG = 'ag';

const AUDIENCE = {
  // Stops them selling, or puts product at risk. Theirs.
  offline:                 OPERATOR,
  door_left_open:          OPERATOR,
  payment_link_down:       OPERATOR,
  fridge_cooling_fault:    OPERATOR,
  fridge_expired_product:  OPERATOR,
  complaint_cluster:       OPERATOR,
  fridge_complaint_cluster:OPERATOR,

  // Money and account setup: the operator's admin, not whoever is restocking.
  settlement_mismatch:         OPERATOR_ADMIN,
  operator_no_complaint_email: OPERATOR_ADMIN,

  // Ours. Nothing an operator can do about any of it.
  invalid_machine_key:   AG,
  device_owner_cleared:  AG,
  app_revert:            AG,
  unsupported_command:   AG,
  payment_decimal_place: AG,
  undecodable_aisles:    AG,
  email_delivery_failing:AG,
  // Five wrong PINs in a row. It already emails AG admins and nobody else, and
  // reads "someone may be guessing" — a security signal for us, not a job for
  // the operator. One line to move if that turns out to be wrong in practice.
  admin_pin_lockout:     AG,
};

function audienceFor(type) {
  return AUDIENCE[String(type || '')] || AG;
}

/**
 * Does this user get to see this alert? Machine access is checked separately
 * by the caller; this is only about audience.
 */
function visibleTo(user, alert) {
  const role = (user && user.role) || '';
  if (role === 'ag_admin') return true;
  const aud = audienceFor(alert && alert.type);
  if (aud === AG) return false;
  if (aud === OPERATOR_ADMIN) return role === 'operator_admin';
  return true;
}

module.exports = { AUDIENCE, OPERATOR, OPERATOR_ADMIN, AG, audienceFor, visibleTo };
