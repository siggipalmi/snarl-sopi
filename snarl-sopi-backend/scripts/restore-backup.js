#!/usr/bin/env node
/**
 * Open a backup made by src/backup.js:
 *   node scripts/restore-backup.js 2026-10-22.sqlite.gz.enc restored.sqlite
 * Asks for BACKUP_KEY without echoing it, so it stays out of shell history.
 */
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { decrypt } = require('../src/backup');

const [src, dest] = process.argv.slice(2);
if (!src || !dest) { console.error('usage: node scripts/restore-backup.js <backup.enc> <out.sqlite>'); process.exit(2); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl._writeToOutput = () => {};
process.stdout.write('BACKUP_KEY (hidden): ');
rl.question('', keyHex => {
  rl.close(); process.stdout.write('\n');
  keyHex = keyHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) { console.error('That is not a 64-character hex key.'); process.exit(1); }
  try {
    const out = zlib.gunzipSync(decrypt(fs.readFileSync(src), Buffer.from(keyHex, 'hex')));
    fs.writeFileSync(dest, out);
    console.log(`Wrote ${dest} (${(out.length / 1048576).toFixed(1)} MB).`);
  } catch (e) {
    console.error('Could not open it: ' + (/auth|unable/i.test(e.message) ? 'wrong key, or the file is damaged.' : e.message));
    process.exit(1);
  }
});
