/**
 * Daily database backup to R2 (security review, 2026-10-22: "6) Yes").
 *
 * Once a day after 03:15 UTC: an online copy of the SQLite file, gzipped, encrypted with
 * AES-256-GCM, uploaded as db/YYYY-MM-DD.sqlite.gz.enc. The file holds password hashes, machine
 * keys and every operator's sales, so:
 *   - it never goes to the product-image bucket, which is public (R2_PUBLIC_URL);
 *   - it is encrypted before it leaves the server, so a leaked bucket or token is not a leaked DB.
 *
 * Env:
 *   BACKUP_BUCKET  a private R2 bucket (no public access), reachable with the R2_* credentials
 *   BACKUP_KEY     64 hex chars. Keep a copy outside Railway (password manager): without it the
 *                  backups cannot be opened, and a backup is for the day Railway is gone.
 * Old copies are removed by a lifecycle rule on the bucket, not here.
 *
 * File format: "SSBK1" | 12-byte IV | ciphertext | 16-byte GCM tag. scripts/restore-backup.js reverses it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('SSBK1');

function backupConfig() {
  const bucket = (process.env.BACKUP_BUCKET || '').trim();
  const keyHex = (process.env.BACKUP_KEY || '').trim();
  const imageBucket = (process.env.R2_BUCKET || '').trim();
  const problems = [];
  if (!bucket) problems.push('BACKUP_BUCKET is not set');
  else if (bucket === imageBucket) problems.push('BACKUP_BUCKET is the public image bucket; use a private one');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) problems.push('BACKUP_KEY must be 64 hex characters');
  for (const v of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    if (!(process.env[v] || '').trim()) problems.push(v + ' is not set');
  }
  return { bucket, key: problems.length ? null : Buffer.from(keyHex, 'hex'), problems };
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}

function decrypt(file, key) {
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a snarl-sopi backup');
  const iv = file.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = file.subarray(file.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(file.subarray(MAGIC.length + 12, file.length - 16)), d.final()]);
}

/** Copy, compress, encrypt and upload. Resolves to { key, bytes, rawBytes }; throws on any failure. */
async function runBackup(storage, now = Date.now()) {
  const cfg = backupConfig();
  if (cfg.problems.length) throw new Error(cfg.problems.join('; '));
  const tmp = path.join(os.tmpdir(), `snarl-backup-${process.pid}-${now}.sqlite`);
  try {
    await storage.backupTo(tmp);
    const raw = fs.readFileSync(tmp);
    const enc = encrypt(zlib.gzipSync(raw, { level: 9 }), cfg.key);
    const objKey = `db/${new Date(now).toISOString().slice(0, 10)}.sqlite.gz.enc`;
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'auto', endpoint: process.env.R2_ENDPOINT.trim(), forcePathStyle: true,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID.trim(), secretAccessKey: process.env.R2_SECRET_ACCESS_KEY.trim() },
    });
    await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: objKey, Body: enc, ContentType: 'application/octet-stream' }));
    return { key: objKey, bytes: enc.length, rawBytes: raw.length };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

module.exports = { backupConfig, runBackup, encrypt, decrypt };
