/**
 * Shared response helpers and simple validation.
 */

function json(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function ok(res, data, meta = {}) {
  json(res, 200, { ok: true, ...meta, data });
}

function created(res, data) {
  json(res, 201, { ok: true, data });
}

function notFound(res, message = 'Not found') {
  json(res, 404, { ok: false, error: message });
}

function badRequest(res, message = 'Bad request', detail = null) {
  json(res, 400, { ok: false, error: message, ...(detail && { detail }) });
}

function serverError(res, err) {
  console.error('[ERROR]', err);
  json(res, 500, { ok: false, error: 'Internal server error' });
}

// ─── Simple validation ────────────────────────────────────────────────────────

/**
 * Validate a MachineSettings update body.
 * Returns { valid, errors }.
 */
function validateSettings(body) {
  const errors = [];
  const validLanguages = ['Icelandic', 'English', 'Polish'];

  if (body.operatorName !== undefined && typeof body.operatorName !== 'string')
    errors.push('operatorName must be a string');
  if (body.supportEmail !== undefined && typeof body.supportEmail !== 'string')
    errors.push('supportEmail must be a string');
  if (body.idleTimeoutSeconds !== undefined && (typeof body.idleTimeoutSeconds !== 'number' || body.idleTimeoutSeconds < 10))
    errors.push('idleTimeoutSeconds must be a number ≥ 10');
  if (body.ledBrightness !== undefined && (typeof body.ledBrightness !== 'number' || body.ledBrightness < 0 || body.ledBrightness > 10))
    errors.push('ledBrightness must be 0–10');
  if (body.defaultLanguage !== undefined && !validLanguages.includes(body.defaultLanguage))
    errors.push(`defaultLanguage must be one of: ${validLanguages.join(', ')}`);
  if (body.availableLanguages !== undefined) {
    if (!Array.isArray(body.availableLanguages))
      errors.push('availableLanguages must be an array');
    else if (!body.availableLanguages.every(l => validLanguages.includes(l)))
      errors.push(`availableLanguages values must be in: ${validLanguages.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a featured products array.
 * Each item must be { goodsId: string, tag: string }.
 */
function validateFeatured(body) {
  if (!Array.isArray(body)) return { valid: false, errors: ['Body must be an array of featured products'] };
  const errors = [];
  body.forEach((item, i) => {
    if (typeof item.goodsId !== 'string' || !item.goodsId.trim())
      errors.push(`[${i}] goodsId must be a non-empty string`);
    if (typeof item.tag !== 'string' || !item.tag.trim())
      errors.push(`[${i}] tag must be a non-empty string`);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a product override update.
 */
function validateProductOverride(body) {
  const errors = [];
  const boolFields = ['hidden', 'hideWhenEmpty', 'featured'];
  boolFields.forEach(f => {
    if (body[f] !== undefined && typeof body[f] !== 'boolean')
      errors.push(`${f} must be a boolean`);
  });
  if (body.displayOrder !== undefined && typeof body.displayOrder !== 'number')
    errors.push('displayOrder must be a number');
  return { valid: errors.length === 0, errors };
}

module.exports = { json, ok, created, notFound, badRequest, serverError, validateSettings, validateFeatured, validateProductOverride };
