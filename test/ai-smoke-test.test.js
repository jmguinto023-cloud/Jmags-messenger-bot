'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runProviderSmokeTest, permitted, safeStatus } = require('../src/ai-smoke-test');

const BASE = Object.freeze({
  botEnabled: false, aiRouterEnabled: false, aiSmartRulesEnabled: false,
  aiAllowExternalData: false, aiProviderTimeoutMs: 12000,
  geminiApiKey: 'fake_key_1', groqApiKey: 'fake_key_2',
  geminiModel: 'gemini-2.5-flash-lite', groqModel: 'openai/gpt-oss-20b',
  aiProviderOrder: 'gemini,groq',
});
const ENV = { AI_SMOKE_TEST_ON_STARTUP: 'true' };
function logger() {
  const messages = [];
  return { messages, info: (m) => messages.push(m), warn: (m) => messages.push(m) };
}
function ok() {
  return { ok: true, status: 200, text: async () =>
    JSON.stringify({ choices: [{ message: { content: 'Hello po' } }] }) };
}
test('smoke test requires all live-customer settings disabled', () => {
  assert.equal(permitted(BASE, ENV), true);
  for (const key of ['botEnabled', 'aiRouterEnabled', 'aiSmartRulesEnabled', 'aiAllowExternalData']) {
    assert.equal(permitted({ ...BASE, [key]: true }, ENV), false);
  }
  assert.equal(permitted(BASE, {}), false);
});
test('smoke skips completely if bot is enabled', async () => {
  let called = 0;
  const log = logger();
  const result = await runProviderSmokeTest({
    cfg: { ...BASE, botEnabled: true }, env: ENV, log,
    fetcher: async () => { called++; throw new Error('should not call'); },
  });
  assert.equal(result.skipped, true);
  assert.equal(called, 0);
});
test('smoke sends synthetic-only messages to Gemini and Groq', async () => {
  const urls = [], payloads = [];
  const log = logger();
  const result = await runProviderSmokeTest({ cfg: BASE, env: ENV, log,
    fetcher: async (url, opts) => {
      urls.push(url); payloads.push(JSON.parse(opts.body)); return ok();
    },
  });
  assert.deepEqual(result.results, { gemini: 'PASS', groq: 'PASS' });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /generativelanguage/);
  assert.match(urls[1], /api.groq.com/);
  assert.ok(payloads.every((p) => p.messages.every((m) => !/phone|address|customer data/i.test(m.content))));
  assert.ok(log.messages.some((m) => m.includes('AI_SMOKE_COMPLETED')));
});
test('missing keys are reported without sending calls', async () => {
  const log = logger();
  const result = await runProviderSmokeTest({
    cfg: { ...BASE, geminiApiKey: '', groqApiKey: '' }, env: ENV, log,
    fetcher: () => { throw new Error('unexpected call'); },
  });
  assert.deepEqual(result.results, { gemini: 'MISSING_KEY', groq: 'MISSING_KEY' });
});
test('error details and keys never leak to logs', async () => {
  const log = logger();
  const secret = BASE.geminiApiKey;
  const result = await runProviderSmokeTest({
    cfg: BASE, env: ENV, log,
    fetcher: async () => ({
      ok: false, status: 401, text: async () => 'unauthorized ' + secret,
    }),
  });
  assert.deepEqual(result.results, { gemini: 'AUTH_FAILED', groq: 'AUTH_FAILED' });
  assert.doesNotMatch(log.messages.join(' '), /fake_key|unauthorized/);
});
test('no API error body or raw message returned', () => {
  assert.equal(safeStatus({ status: 429, message: 'secret' }), 'RATE_LIMITED');
  assert.equal(safeStatus(new Error('my secret')), 'NETWORK_TIMEOUT_OR_INVALID_RESPONSE');
});
