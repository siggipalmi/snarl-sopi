'use strict';
/**
 * Alerts about the account itself, so that a compromise is something you hear about rather than
 * something you find out about later.
 *
 * Three events, all raised only for ag_admin accounts:
 *
 *   new_device_signin    a sign-in from a device this account has not been seen on before
 *   recovery_code_used   a recovery code was spent instead of the app
 *   two_factor_disabled  the second factor was turned off
 *
 * Why ag_admin only. An alert carries a machine, not a person, and the audience is decided by
 * type (alertAudience.js) rather than per user. So an alert about one operator's sign-in would
 * land in AG's dashboard, where nobody can act on it, and never in front of the person whose
 * account it was — noise in one place and silence in the other. Until alerts can be addressed to
 * a user, the only account these say anything useful about is the one that can read every
 * operator's data.
 *
 * What counts as a device is the coarse label the sign-in paths already derive from the user
 * agent, such as "Mac · Safari". That is the honest limit of this: a second Mac running Safari
 * looks like the first one. It catches a sign-in from a different kind of machine, which is the
 * common shape of someone else using a stolen password, and it does not pretend to fingerprint.
 */

const storage = require('./storage');

/** dd/mm/yyyy and HH:MM, as read in Iceland. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

function raise(type, severity, title, detail, params) {
  try {
    storage.insertAlert({
      // Unique per event: these are a log of things that happened, not a condition that is
      // either true or false, so a new one must never replace the last.
      id: 'alert_' + type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      type, severity, title, detail,
      deviceCode: null, resolved: 0, resolvedAt: null,
      createdAt: new Date().toISOString(),
      params,
    });
  } catch (e) {
    // An alert that cannot be written must never be the reason a sign-in fails.
    console.warn('[authAlerts] could not raise ' + type + ':', e.message);
  }
}

/**
 * Record the device a sign-in came from, and raise an alert the first time an ag_admin account
 * is seen on a new one. Always called, so the known-device list stays current for every role.
 */
function noteSignIn(user, label, ip) {
  if (!user) return;
  const seen = storage.noteSignInDevice(user.id, label);
  if (seen.known) return;
  // The first device on an account is the person setting it up, not an intrusion.
  if (seen.firstEver) return;
  if (user.role !== 'ag_admin') return;

  const { date, time } = stamp();
  raise('new_device_signin', 'warning',
    'Sign-in from a new device',
    `${user.email} signed in from ${label} (${ip}) on ${date} at ${time}. `
    + 'If this was not you, change the password and sign out everywhere else.',
    { who: user.email, device: label, ip, date, time });
}

/** A recovery code was used instead of the app: the phone is gone, or someone else is in. */
function noteRecoveryCodeUsed(user, label, ip, codesLeft) {
  if (!user || user.role !== 'ag_admin') return;
  const { date, time } = stamp();
  raise('recovery_code_used', 'warning',
    'A recovery code was used to sign in',
    `${user.email} signed in with a recovery code from ${label} (${ip}) on ${date} at ${time}. `
    + `${codesLeft} code(s) left. If this was not you, change the password and sign out `
    + 'everywhere else.',
    { who: user.email, device: label, ip, date, time, left: String(codesLeft) });
}

/** Turning the second factor off is the first thing someone would do with a stolen session. */
function noteTwoFactorDisabled(user, label, ip) {
  if (!user || user.role !== 'ag_admin') return;
  const { date, time } = stamp();
  raise('two_factor_disabled', 'critical',
    'Two-factor authentication was turned off',
    `${user.email} turned two-factor off from ${label} (${ip}) on ${date} at ${time}. `
    + 'If this was not you, the account is compromised: change the password, sign out '
    + 'everywhere else and turn it back on.',
    { who: user.email, device: label, ip, date, time });
}

module.exports = { noteSignIn, noteRecoveryCodeUsed, noteTwoFactorDisabled };
