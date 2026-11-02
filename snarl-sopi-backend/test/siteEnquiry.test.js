/**
 * POST /api/v1/site-enquiry — the contact form on agvending.is.
 *
 * The property that matters: the site only redirects to /takk on a 200, so a 200 must mean the
 * mail went out. A SendGrid failure has to come back as an error, or the enquiry is lost silently.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'site-enquiry-test-' + process.pid + '.db');
delete process.env.SENDGRID_API_KEY;   // email.send logs instead of sending

const email = require('../src/email');
const { routes } = require('../src/router');
const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/site-enquiry');

let ipSeq = 0;
async function post(body, ip) {
  const req = { body, headers: { 'x-forwarded-for': ip || '203.0.113.' + (++ipSeq) }, socket: {} };
  let status = 0, payload = null;
  const res = {
    writeHead(s) { status = s; },
    end(buf) { payload = JSON.parse(String(buf)); },
  };
  await route.handler(req, res);
  return { status, payload };
}

const valid = { nafn: 'Jón Jónsson', netfang: 'jon@example.is', simi: '555 1234', stadur: 'Íþróttahús', skilabod: 'Halló\nannað lína' };

function captureSend() {
  const sent = [];
  const real = email.send;
  email.send = async msg => { sent.push(msg); return { mocked: true }; };
  return { sent, restore: () => { email.send = real; } };
}

test('the route exists', () => { assert.ok(route, 'POST /api/v1/site-enquiry is in the route table'); });

test('a valid enquiry is mailed to AG Vending with the sender as reply-to', async () => {
  const cap = captureSend();
  try {
    const r = await post(valid);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(cap.sent.length, 1);
    const m = cap.sent[0];
    assert.strictEqual(m.to, 'agvending@agvending.is');
    assert.strictEqual(m.replyTo, 'jon@example.is');
    assert.match(m.subject, /Jón Jónsson \(Íþróttahús\)/);
    assert.match(m.text, /Sími:\s+555 1234/);
    assert.match(m.text, /Halló\nannað lína/, 'the message keeps its line breaks');
    assert.strictEqual(m.html, undefined, 'plain text only');
  } finally { cap.restore(); }
});

test('a filled honeypot answers 200 and sends nothing', async () => {
  const cap = captureSend();
  try {
    const r = await post({ ...valid, 'bot-field': 'x' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(cap.sent.length, 0);
  } finally { cap.restore(); }
});

test('name and a valid email are required', async () => {
  const cap = captureSend();
  try {
    assert.strictEqual((await post({ ...valid, nafn: '  ' })).status, 400);
    assert.strictEqual((await post({ ...valid, netfang: 'not-an-email' })).status, 400);
    assert.strictEqual(cap.sent.length, 0);
  } finally { cap.restore(); }
});

test('a SendGrid failure is an error, never a 200', async () => {
  const real = email.send;
  email.send = async () => { throw new Error('boom'); };
  try {
    const r = await post(valid);
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.payload.ok, false);
  } finally { email.send = real; }
});

test('one address is held to three an hour', async () => {
  const cap = captureSend();
  try {
    const ip = '198.51.100.7';
    for (let i = 0; i < 3; i++) assert.strictEqual((await post(valid, ip)).status, 200);
    assert.strictEqual((await post(valid, ip)).status, 429);
    assert.strictEqual(cap.sent.length, 3);
  } finally { cap.restore(); }
});
