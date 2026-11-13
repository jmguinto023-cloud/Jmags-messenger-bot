'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startMock } = require('./mock-meta-llm');
const { Graph } = require('../src/graph');
const { build } = require('../src/index');
const faq = require('../src/appliance-one-time');

const MAIN = '102622881557025';
const CAVITE = '1237499962773846';

test('price inquiries get a clear fixed quote-intake answer, never a made-up rate', () => {
  for (const question of [
    'Magkano ang serbisyo?',
    'Magkano po pagawa ng TV?',
    'Hm po?',
    'How much for TV repair?',
    'What is the service fee?',
    'price po?',
  ]) {
    assert.deepEqual(faq.match(question), ['price'], question);
  }
  assert.deepEqual(faq.match('Hello po'), []);
  assert.deepEqual(faq.match('Naghohome service po ba kayo?'), ['homeservice']);
  assert.match(faq.REPLIES.price, /brand/i);
  assert.match(faq.REPLIES.price, /VIDEO/i);
  assert.doesNotMatch(faq.REPLIES.price, /₱\s*\d/);
});

test('price FAQ replies even with continuous AI OFF and preserves one-time behavior', async () => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-price-faq-'));
  const secret = 'test-only-webhook';
  const app = build({
    PORT: '0', JMAGS_MAIN_PROTECTED: 'true',
    PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_MOCK_TOKEN',
    CAVITE_PAGE_ID: CAVITE, CAVITE_PAGE_ACCESS_TOKEN: '',
    APP_ID: '123123', APP_SECRET: secret, VERIFY_TOKEN: 'verify-test',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: mock.base + '/v1',
    LLM_MODEL: 'mock-model', LLM_API_KEY: 'test-key',
    DATA_DIR: dir, BOT_ENABLED: 'false',
    MAIN_FIRST_INQUIRY_ENABLED: 'false',
    APPLIANCE_ONE_TIME_REPLY_ENABLED: 'true', LOG_LEVEL: 'silent',
  });
  let seq = 0;
  const post = async (pageId, psid, message) => {
    const at = Date.now();
    const raw = JSON.stringify({ object: 'page', entry: [{
      id: pageId, time: at, messaging: [{
        sender: { id: psid }, recipient: { id: pageId }, timestamp: at,
        message: { mid: 'price.' + ++seq, text: message, referral: { source: 'ADS' } },
      }],
    }] });
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + '/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });
    await app.bot.idle();
    return res;
  };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await post(MAIN, 'customer-A', 'Magkano ang serbisyo?')).status, 200);
    assert.equal(mock.calls.messages.length, 1);
    assert.equal(mock.calls.messages[0].message.text, faq.REPLIES.price);
    assert.equal(mock.calls.llm.length, 0);
    assert.ok(app.store.data.threads['customer-A'].applianceQuickReplyAttempts.price);
    assert.equal((await post(MAIN, 'customer-A', 'Magkano po?')).status, 200);
    assert.equal(mock.calls.messages.length, 1, 'avoid repeating same scripted price answer');
    assert.equal((await post(CAVITE, 'customer-A', 'Magkano po?')).status, 200);
    assert.equal(mock.calls.messages.length, 1, 'Cavite cannot take Main Page token');
    assert.equal(app.store.data.threads[CAVITE + ':customer-A'], undefined);
  } finally {
    await app.bot.idle();
    app.server.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Meta OAuth 190 is distinguishable from server health and recovers on valid token', async () => {
  let expired = true;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (expired) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { code: 190, error_subcode: 463, message: 'Session has expired' } }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const graph = new Graph({
    pageId: MAIN,
    pageAccessToken: 'NOT_A_REAL_TOKEN',
    graphBase: 'http://127.0.0.1:' + server.address().port,
    graphVersion: 'v26.0',
    appSecret: '',
  }, {});
  try {
    await assert.rejects(graph.call('GET', MAIN + '/conversations'), e =>
      e.status === 400 && e.body?.error?.code === 190);
    assert.equal(graph.tokenHealth.get(MAIN)?.status, 'expired');
    assert.ok(graph.tokenHealth.get(MAIN)?.checkedAt);
    assert.equal(JSON.stringify(graph.tokenHealth.get(MAIN)).includes('NOT_A_REAL_TOKEN'), false);
    expired = false;
    assert.deepEqual(await graph.call('GET', MAIN + '/conversations'), { data: [] });
    assert.equal(graph.tokenHealth.get(MAIN)?.status, 'valid');
  } finally {
    server.close();
  }
});

test('health exposes expired Messenger auth without revealing access token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-token-health-'));
  const app = build({
    PORT: '0', PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'SENSITIVE_TEST_ONLY',
    JMAGS_MAIN_PROTECTED: 'true', BOT_ENABLED: 'false',
    DATA_DIR: dir, LOG_LEVEL: 'silent',
  });
  try {
    app.graph.tokenHealth.set(MAIN, { status: 'expired', checkedAt: '2026-11-13T05:00:00.000Z' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + '/health');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.messengerAuth, 'expired');
    assert.equal(body.messengerAuthCheckedAt, '2026-11-13T05:00:00.000Z');
    assert.equal(body.botEnabled, false);
    assert.equal(JSON.stringify(body).includes('SENSITIVE_TEST_ONLY'), false);
  } finally {
    app.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
