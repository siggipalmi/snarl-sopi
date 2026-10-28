#!/usr/bin/env node
'use strict';
/**
 * How much of the dashboard can actually be translated?
 *
 * The dictionary having a key proves nothing on its own — a key nobody reads
 * is not coverage, and for 30 placeholders and 5 titles nothing read them at
 * all until applyI18n learned about attributes. This counts the strings a
 * user can see and how many of them go through t().
 *
 *   node tools/i18n-audit.js            summary
 *   node tools/i18n-audit.js --list     every untranslated string, with a line number
 *   node tools/i18n-audit.js --missing  keys the Icelandic dictionary has not got
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(FILE, 'utf8');
const lineOf = idx => src.slice(0, idx).split('\n').length;
const HAS_LETTERS = /[A-Za-zÁÉÍÓÚÝÐÞÆÖáéíóúýðþæö]{2,}/;

// ── the declarative markup ────────────────────────────────────────────────
const body = src.split('</head>')[1] || '';
const bodyStart = src.length - body.length;
let markup = body;
for (const tag of ['script', 'style']) {
  markup = markup.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g'), m => ' '.repeat(m.length));
}

const untagged = [];
for (const m of markup.matchAll(/<([a-z0-9-]+)([^>]*)>([^<>]{2,})</gi)) {
  const [, , attrs, text] = m;
  const t = text.trim();
  if (!HAS_LETTERS.test(t) || t.startsWith('&')) continue;
  if (/\bdata-i18n=/.test(attrs)) continue;
  untagged.push({ line: lineOf(bodyStart + m.index), text: t.slice(0, 70) });
}

const attrMisses = [];
for (const [attr, dataAttr] of [['placeholder', 'data-i18n-placeholder'], ['title', 'data-i18n-title']]) {
  for (const m of markup.matchAll(new RegExp(`<[a-z0-9-]+([^>]*\\s${attr}="([^"]{2,})"[^>]*)>`, 'gi'))) {
    if (new RegExp(dataAttr).test(m[1])) continue;
    if (!HAS_LETTERS.test(m[2])) continue;
    attrMisses.push({ line: lineOf(bodyStart + m.index), attr, text: m[2].slice(0, 70) });
  }
}

// ── the dictionary ────────────────────────────────────────────────────────
const dictBlock = (src.match(/const I18N = \{[\s\S]*?\n\};/) || [''])[0];
const enBlock = (dictBlock.match(/\ben\s*:\s*\{[\s\S]*?\n\s*\},/) || [''])[0];
const isBlock = (dictBlock.match(/\bis\s*:\s*\{[\s\S]*?\n\s*\},?/) || [''])[0];
const keysIn = b => new Set([...b.matchAll(/'([a-zA-Z0-9._]+)'\s*:/g)].map(m => m[1]));
const enKeys = keysIn(enBlock), isKeys = keysIn(isBlock);
const missingIs = [...enKeys].filter(k => !isKeys.has(k));

// keys referenced but never defined — these render as the raw key
const used = new Set([...src.matchAll(/\bt\('([a-zA-Z0-9._]+)'\)/g)].map(m => m[1]));
for (const m of src.matchAll(/data-i18n(?:-[a-z]+)?="([a-zA-Z0-9._]+)"/g)) used.add(m[1]);
const undefinedKeys = [...used].filter(k => !enKeys.has(k));

const tagged = (src.match(/data-i18n(?:-[a-z]+)?="/g) || []).length;
const visible = untagged.length + tagged;
const pct = visible ? Math.round((tagged / visible) * 100) : 0;

const arg = process.argv[2];
if (arg === '--list') {
  for (const u of untagged) console.log(`  ${String(u.line).padStart(6)}  ${u.text}`);
  for (const a of attrMisses) console.log(`  ${String(a.line).padStart(6)}  [${a.attr}] ${a.text}`);
} else if (arg === '--missing') {
  for (const k of missingIs) console.log('  ' + k);
} else {
  console.log('dashboard i18n');
  console.log('  translatable markup strings :', visible);
  console.log('  going through t()           :', tagged, `(${pct}%)`);
  console.log('  still hardcoded             :', untagged.length);
  console.log('  untranslatable attributes   :', attrMisses.length);
  console.log('  dictionary keys (en / is)   :', enKeys.size, '/', isKeys.size);
  console.log('  keys with no Icelandic      :', missingIs.length);
  console.log('  keys used but never defined :', undefinedKeys.length,
              undefinedKeys.length ? '→ ' + undefinedKeys.slice(0, 5).join(', ') : '');
  console.log('\n  --list for the strings, --missing for the keys');
}
process.exitCode = undefinedKeys.length ? 1 : 0;
