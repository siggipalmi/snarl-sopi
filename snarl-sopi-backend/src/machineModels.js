'use strict';
/**
 * What kind of machine is this, and which app does it run?
 *
 * This used to be one expression, in two places: anything whose model does not
 * start with "GR-" is a coil machine. That is fine for a machine whose model is
 * set correctly and wrong in the one case that matters — a machine with a blank
 * or unrecognised model was silently a coil machine, and would be offered the
 * coil APK. Siggi nearly published across the two lines (2026-10-28); this is
 * the other half of that mistake, the half the publish guard cannot catch.
 *
 * Unknown now means unknown. A machine we cannot identify is offered no update
 * at all rather than a guess, and the fleet page can show you which ones need
 * a model set.
 *
 * Every machine in the fleet is GR-* or VM-*, so nothing in service changes.
 *
 * Geometry (how many cabinets, how many baskets) stays in db.js fridgeSpec().
 * Both read the same GR- prefix, so they agree by construction; this module
 * owns the question "which app line", which fridgeSpec was never about.
 */

const KNOWN = {
  'GR-WM22Z680':  { kind: 'fridge', app: 'fridge', is: 'Snjallkælir — einfaldur', en: 'Smart fridge — single cabinet' },
  'GR-WM22Z1260': { kind: 'fridge', app: 'fridge', is: 'Snjallkælir — tvöfaldur', en: 'Smart fridge — double cabinet' },
  'VM-WM55DL':    { kind: 'coil',   app: 'coil',   is: 'Sjálfsali 55"',           en: 'Vending machine 55"' },
};

// A model we have not catalogued but whose family is unmistakable still gets
// its app line — a new GR- fridge should not stop updating because nobody
// added it here yet. It is reported as known:false so the fleet page can ask
// for it to be catalogued.
const FAMILY = [
  { test: /^GR-/i, kind: 'fridge', app: 'fridge' },
  { test: /^VM-/i, kind: 'coil',   app: 'coil' },
];

const UNKNOWN = Object.freeze({ kind: 'unknown', app: null, known: false, catalogued: false });

function modelInfo(model) {
  const m = String(model == null ? '' : model).trim();
  const k = KNOWN[m];
  if (k) return { model: m, kind: k.kind, app: k.app, label: k.is, labelEn: k.en, known: true, catalogued: true };
  for (const f of FAMILY) {
    if (f.test.test(m)) return { model: m, kind: f.kind, app: f.app, label: m, labelEn: m, known: true, catalogued: false };
  }
  return { ...UNKNOWN, model: m, label: m || '(ekki skráð)', labelEn: m || '(not set)' };
}

/** The app line a machine should be offered, or null if we cannot tell. */
function appLineFor(model) { return modelInfo(model).app; }

/** True when we cannot say what this machine is. */
function isUnknownModel(model) { return modelInfo(model).kind === 'unknown'; }

module.exports = { KNOWN, modelInfo, appLineFor, isUnknownModel };
