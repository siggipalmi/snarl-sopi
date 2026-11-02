/**
 * POST /api/v1/demo-request — the demo form on agvending.is/kerfid. Same contract as site-enquiry:
 * the site redirects to /takk on 200, so a 200 must mean the mail went out.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'demo-request-test-' + process.pid + '.db');
delete process.env.SENDGRID_API_KEY;

const email = require('../src/email');
const { routes } = require('../src/router');
const route = routes.find(r => r.method === 'POST' && r.pattern === '/api/v1/demo-request');

let ipSeq = 0;
async function post(body) {
  const req = { body, headers: { 'x-forwarded-for': '192.0.2.' + (++ipSeq) }, socket: {} };
  let status = 0;
  await route.handler(req, { writeHead(s) { status = s; }, end() {} });
  return status;
}
const valid = { name: 'Anna', email: 'anna@example.is', company: 'Íþróttafélag', phone: '', machines: '2 kælar', note: '' };

test('a demo request is mailed with the sender as reply-to', async () => {
  const sent = []; const real = email.send;
  email.send = async m => { sent.push(m); return { mocked: true }; };
  try {
    assert.strictEqual(await post(valid), 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].replyTo, 'anna@example.is');
    assert.match(sent[0].text, /Machines: 2 kælar/);
  } finally { email.send = real; }
});

test('a SendGrid failure is an error, never a 200', async () => {
  const real = email.send;
  email.send = async () => { throw new Error('boom'); };
  try { assert.strictEqual(await post(valid), 502); } finally { email.send = real; }
});

test('a filled honeypot answers 200 and sends nothing', async () => {
  const sent = []; const real = email.send;
  email.send = async m => { sent.push(m); return {}; };
  try {
    assert.strictEqual(await post({ ...valid, botField: 'x' }), 200);
    assert.strictEqual(sent.length, 0);
  } finally { email.send = real; }
});
