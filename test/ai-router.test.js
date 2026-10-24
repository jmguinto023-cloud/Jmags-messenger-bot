'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AiRouter, buildProviders, redactContact, sanitizePayload } = require('../src/ai-router');

function ok(answer) {
  return { ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: answer } }] }) };
}
function failure(status) {
  return { ok: false, status, text: async () => '{"error":"invalid key"}' };
}
function cfg(other = {}) {
  return { aiAllowExternalData: true, geminiApiKey: 'test-gemini', groqApiKey: 'test-groq',
    aiProviderOrder: 'gemini,groq', ...other };
}

test('third-party providers are absent without explicit privacy opt-in', () => {
  assert.equal(buildProviders(cfg({ aiAllowExternalData: false })).length, 0);
});
test('only Gemini then Groq are allowed; no legacy provider', () => {
  assert.deepEqual(buildProviders(cfg({ aiProviderOrder: 'gemini,groq,legacy,grok,claude' }))
    .map((p) => p.name), ['gemini', 'groq']);
});
test('missing API keys are never selected', () => {
  assert.deepEqual(buildProviders(cfg({ geminiApiKey: '' })).map((p) => p.name), ['groq']);
});
test('redacts emails and Philippine mobile numbers', () => {
  const cleaned = redactContact('Contact: jo@example.com and 09171234567');
  assert.doesNotMatch(cleaned, /jo@example.com|09171234567/);
});
test('redacts all text messages including extra system context', () => {
  const payload = sanitizePayload({ messages: [{ role: 'system', content: '09171234567' },
    { role: 'user', content: 'hi 09171234567' }] }, true);
  assert.ok(payload.messages.every((m) => !m.content.includes('09171234567')));
});
test('returns Gemini answer without contacting Groq', async () => {
  const called = [];
  const router = new AiRouter({ providers: buildProviders(cfg()), fetcher: async (url) => {
    called.push(url); return ok('Gemini reply');
  } });
  assert.equal(await router.complete({ messages: [{ role: 'user', content: 'hi' }] }), 'Gemini reply');
  assert.equal(called.length, 1);
  assert.equal(router.lastProvider, 'gemini');
});
test('falls back to Groq after Gemini rate limit', async () => {
  const called = [];
  const router = new AiRouter({ providers: buildProviders(cfg()), fetcher: async (url) => {
    called.push(url);
    return url.includes('generativelanguage.googleapis.com') ? failure(429) : ok('Groq reply');
  } });
  assert.equal(await router.complete({ messages: [] }), 'Groq reply');
  assert.equal(called.length, 2);
  assert.equal(router.lastProvider, 'groq');
});
test('cooldown avoids repeated Gemini requests', async () => {
  const called = [];
  const router = new AiRouter({ providers: buildProviders(cfg()), fetcher: async (url) => {
    called.push(url); return url.includes('generativelanguage') ? failure(429) : ok('Backup');
  } });
  await router.complete({ messages: [] });
  await router.complete({ messages: [] });
  assert.equal(called.filter((x) => x.includes('generativelanguage')).length, 1);
});
test('per-request daily cap is enforced even during fallback', async () => {
  let hits = 0;
  const router = new AiRouter({ providers: buildProviders(cfg()), maxDailyCalls: 1,
    fetcher: async () => { hits++; return failure(429); } });
  await assert.rejects(router.complete({ messages: [] }), /daily request limit/);
  assert.equal(hits, 1);
});
test('negative or zero daily cap does not mean unlimited usage', () => {
  assert.equal(new AiRouter({ maxDailyCalls: 0 }).maxDailyCalls, 100);
});
test('no provider fails closed', async () => {
  await assert.rejects(new AiRouter().complete({ messages: [] }), /No approved/);
});
test('customer content is redacted before provider request', async () => {
  let body = null;
  const router = new AiRouter({ providers: buildProviders(cfg()),
    fetcher: async (url, opts) => { body = JSON.parse(opts.body); return ok('OK'); } });
  await router.complete({ messages: [{ role: 'user', content: 'call me 09171234567' }] });
  assert.doesNotMatch(JSON.stringify(body), /09171234567/);
});
test('invalid provider response triggers backup', async () => {
  const router = new AiRouter({ providers: buildProviders(cfg()), fetcher: async (url) => (
    url.includes('generativelanguage') ? ok('   ') : ok('Fallback')
  ) });
  assert.equal(await router.complete({ messages: [] }), 'Fallback');
});

test('retries both providers once after a shared outage, then fails', async () => {
  const called = [];
  let slept = 0;
  const router = new AiRouter({
    providers: buildProviders(cfg()),
    retryBackoffMs: 25,
    sleep: async (ms) => { slept += ms; },
    fetcher: async (url) => { called.push(url); return failure(429); },
  });
  await assert.rejects(router.complete({ messages: [] }), /AI providers unavailable/);
  assert.equal(called.length, 4);
  assert.equal(slept, 25);
});

test('Groq GPT-OSS uses low reasoning and enough completion tokens', async () => {
  let payload;
  const provider = buildProviders(cfg())[1];
  const router = new AiRouter({
    providers: [provider], fetcher: async (_url, opts) => {
      payload = JSON.parse(opts.body);
      return ok('Groq passed');
    },
  });
  const reply = await router.complete({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 60 });
  assert.equal(reply, 'Groq passed');
  assert.equal(payload.reasoning_effort, 'low');
  assert.ok(payload.max_completion_tokens >= 512);
  assert.equal(payload.max_tokens, undefined);
});
