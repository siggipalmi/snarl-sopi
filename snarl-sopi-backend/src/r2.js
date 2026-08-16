'use strict';

/**
 * Cloudflare R2 image hosting (S3-compatible).
 *
 * Stores product images that the dashboard, Weimi, and the machines all fetch
 * by public URL. Configured entirely via env vars:
 *   R2_ENDPOINT          https://<account-id>.r2.cloudflarestorage.com
 *   R2_BUCKET            bucket name (e.g. snarl-sopi-products)
 *   R2_PUBLIC_URL        public base, e.g. https://pub-xxxx.r2.dev (no trailing /)
 *   R2_ACCESS_KEY_ID     R2 API token access key
 *   R2_SECRET_ACCESS_KEY R2 API token secret
 *
 * If the vars are absent the module is simply "not configured" and callers can
 * degrade gracefully — nothing throws at import time.
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

function r2Config() {
  return {
    endpoint: (process.env.R2_ENDPOINT || '').trim(),
    bucket: (process.env.R2_BUCKET || '').trim(),
    publicUrl: (process.env.R2_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
  };
}

function isConfigured() {
  const c = r2Config();
  return !!(c.endpoint && c.bucket && c.publicUrl && c.accessKeyId && c.secretAccessKey);
}

let _client = null;
function client() {
  if (_client) return _client;
  const c = r2Config();
  _client = new S3Client({
    region: 'auto',
    endpoint: c.endpoint,
    forcePathStyle: true, // R2 S3 API is path-style: <endpoint>/<bucket>/<key>
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  return _client;
}

/**
 * Upload bytes to the bucket under `key`. Returns the public URL.
 * `body` is a Buffer/Uint8Array/string; `contentType` e.g. 'image/png'.
 */
async function putObject(key, body, contentType) {
  if (!isConfigured()) throw new Error('R2 is not configured');
  const c = r2Config();
  const cleanKey = String(key).replace(/^\/+/, '');
  await client().send(new PutObjectCommand({
    Bucket: c.bucket,
    Key: cleanKey,
    Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return `${c.publicUrl}/${cleanKey}`;
}

module.exports = { isConfigured, putObject, r2Config };
