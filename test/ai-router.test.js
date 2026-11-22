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
test('default order is Groq only; Gemini runs only when the order lists it', () => {
  const both = { aiAllowExternalData: true, geminiApiKey: 'test-gemini', groqApiKey: 'test-groq' };
  assert.deepEqual(buildProviders(both).map((p) => p.name), ['groq']);
  assert.deepEqual(buildProviders({ ...both, aiProviderOrder: 'gemini' }).map((p) => p.name), ['gemini']);
  assert.deepEqual(buildProviders({ ...both, aiProviderOrder: 'groq,gemini' }).map((p) => p.name), ['groq', 'gemini']);
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

test('a full cooldown waits at most 20s and then tries a provider', async () => {
  const called = [];
  let slept = 0;
  let now = 1_000_000;
  const router = new AiRouter({
    providers: buildProviders(cfg()),
    now: () => now,
    sleep: async (ms) => { slept += ms; now += ms; },
    fetcher: async (url) => { called.push(url); return ok('after wait'); },
  });
  router.cooldowns.set('gemini', now + 60_000);
  router.cooldowns.set('groq', now + 45_000);
  assert.equal(await router.complete({ messages: [] }), 'after wait');
  assert.equal(slept, 20000);
  assert.equal(called.length, 1);
  assert.equal(router.lastProvider, 'gemini');
});

test('retries both providers once after a shared outage, then fails', async () => {
  const called = [];
  let slept = 0;
  const router = new AiRouter({
    providers: buildProviders(cfg()),
    retryBackoffMs: 25,
    rateLimitBackoffMs: 25,
    sleep: async (ms) => { slept += ms; },
    fetcher: async (url) => { called.push(url); return failure(429); },
  });
  await assert.rejects(router.complete({ messages: [] }), /AI providers unavailable/);
  assert.equal(called.length, 4);
  assert.equal(slept, 25);
});

test('a 429 tries the next provider before the rate-limit wait', async () => {
  const called = [];
  let slept = 0;
  const router = new AiRouter({
    providers: buildProviders({
      aiAllowExternalData: true, openaiApiKey: 'oa', groqApiKey: 'g',
      aiProviderOrder: 'openai,groq', openaiModel: 'gpt-5.4-mini',
    }),
    sleep: async (ms) => { slept += ms; },
    fetcher: async (url) => {
      called.push(url);
      return url.includes('api.openai.com') ? failure(429) : ok('groq ok');
    },
  });
  assert.equal(await router.complete({ messages: [] }), 'groq ok');
  assert.deepEqual(called.map((url) => url.includes('api.openai.com') ? 'openai' : 'groq'), ['openai', 'groq']);
  assert.equal(slept, 0);
});

test('Groq 429 waits 1500ms before the one retry', async () => {
  let slept = 0;
  let calls = 0;
  const router = new AiRouter({
    providers: buildProviders({ aiAllowExternalData: true, groqApiKey: 'g' }),
    sleep: async (ms) => { slept += ms; },
    fetcher: async () => { calls += 1; return failure(429); },
  });
  await assert.rejects(router.complete({ messages: [] }), /AI providers unavailable/);
  assert.equal(calls, 2);
  assert.equal(slept, 1500);
});

test('OpenAI is selected only when the order and key are set', () => {
  const both = {
    aiAllowExternalData: true, openaiApiKey: 'oa', groqApiKey: 'g',
    aiProviderOrder: 'openai,groq', openaiModel: 'gpt-5.4-mini', openaiReasoningEffort: 'low',
    openaiTimeoutMs: 15000,
  };
  assert.deepEqual(buildProviders(both).map((p) => p.name), ['openai', 'groq']);
  assert.equal(buildProviders(both)[0].timeoutMs, 15000);
  assert.equal(buildProviders({ ...both, openaiApiKey: '' }).map((p) => p.name).includes('openai'), false);
  assert.deepEqual(buildProviders({ aiAllowExternalData: true, groqApiKey: 'g' }).map((p) => p.name), ['groq']);
});

test('GPT-5 requests use max_completion_tokens, reasoning_effort, and no temperature', async () => {
  let payload;
  let signal;
  const provider = buildProviders({
    aiAllowExternalData: true, openaiApiKey: 'oa', aiProviderOrder: 'openai',
    openaiModel: 'gpt-5.4-mini', openaiReasoningEffort: 'low', openaiTimeoutMs: 15000,
  })[0];
  const router = new AiRouter({
    providers: [provider],
    fetcher: async (_url, opts) => {
      payload = JSON.parse(opts.body);
      signal = opts.signal;
      return ok('OpenAI passed');
    },
  });
  const reply = await router.complete({
    messages: [{ role: 'user', content: 'hello' }], max_tokens: 120, temperature: 0.4,
  });
  assert.equal(reply, 'OpenAI passed');
  assert.equal(payload.model, 'gpt-5.4-mini');
  assert.equal(payload.max_completion_tokens, 120);
  assert.equal(payload.max_tokens, undefined);
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.reasoning_effort, 'low');
  assert.ok(signal);
  assert.equal(router.lastProvider, 'openai');
  assert.equal(router.lastModel, 'gpt-5.4-mini');
});

test('OpenAI 5xx falls back to Groq', async () => {
  const called = [];
  const router = new AiRouter({
    providers: buildProviders({
      aiAllowExternalData: true, openaiApiKey: 'oa', groqApiKey: 'g',
      aiProviderOrder: 'openai,groq',
    }),
    retryBackoffMs: 0,
    sleep: async () => {},
    fetcher: async (url) => {
      called.push(url);
      return url.includes('api.openai.com') ? failure(503) : ok('Groq backup');
    },
  });
  assert.equal(await router.complete({ messages: [{ role: 'user', content: 'hi' }] }), 'Groq backup');
  assert.equal(called.some((url) => url.includes('api.openai.com')), true);
  assert.equal(called.some((url) => url.includes('api.groq.com')), true);
  assert.equal(router.lastProvider, 'groq');
});

test('a blank OpenAI key is skipped and Groq uses max_tokens without reasoning_effort', async () => {
  const called = [];
  let payload;
  const providers = buildProviders({
    aiAllowExternalData: true, openaiApiKey: '   ', groqApiKey: 'g',
    aiProviderOrder: 'openai,groq', groqModel: 'openai/gpt-oss-20b',
  });
  assert.deepEqual(providers.map((p) => p.name), ['groq']);
  const router = new AiRouter({
    providers, fetcher: async (url, opts) => {
      called.push(url);
      payload = JSON.parse(opts.body);
      return ok('Groq passed');
    },
  });
  const reply = await router.complete({
    messages: [{ role: 'user', content: 'Sony 65 inches' }],
    max_tokens: 400, temperature: 0.4, reasoning_effort: 'low',
  });
  assert.equal(reply, 'Groq passed');
  assert.equal(called.some((url) => url.includes('api.openai.com')), false);
  assert.equal(called.some((url) => url.includes('api.groq.com')), true);
  assert.equal(payload.max_tokens, 400);
  assert.equal(payload.max_completion_tokens, undefined);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(router.lastProvider, 'groq');
});

test('OpenAI gets the full JMAG orientation, Groq gets the compact prompt, richContent is never sent', async () => {
  const { LLM } = require('../src/llm');
  const llm = new LLM({ systemPromptFile: require('node:path').join(__dirname, '..', 'prompts', 'system-prompt.md'), llmMaxRpm: 0 });
  const history = [{ role: 'user', content: 'samsung 55 walang display' }];
  const rich = llm.richPrompt(history);
  assert.match(rich, /JMAG's Appliances orientation/);
  assert.match(rich, /## 1\. Voice/);
  assert.match(rich, /Sound like a real JMAG's staff member/);
  assert.match(rich, /JMAGS CUSTOMER-BEHAVIOR BANK/);
  assert.ok(rich.indexOf('CURRENT RULES') > rich.indexOf('## 1. Voice'), 'current rules come last and win');
  assert.match(rich, /THE QUOTE GATE/);

  const bodies = {};
  const router = new AiRouter({
    providers: buildProviders({ aiAllowExternalData: true, openaiApiKey: 'oa', groqApiKey: 'g', aiProviderOrder: 'openai,groq' }),
    retryBackoffMs: 0, rateLimitBackoffMs: 0,
    fetcher: async (url, opts) => {
      const name = url.includes('api.openai.com') ? 'openai' : 'groq';
      bodies[name] = JSON.parse(opts.body);
      return name === 'openai' ? failure(500) : ok('groq ok');
    },
  });
  const payload = { messages: [{ role: 'system', content: 'COMPACT', richContent: 'FULL ORIENTATION 09386369374' }, { role: 'user', content: 'hi 09171234567' }] };
  assert.equal(await router.complete(payload), 'groq ok');
  assert.equal(bodies.openai.messages[0].content, 'FULL ORIENTATION 09386369374');
  assert.doesNotMatch(bodies.openai.messages[1].content, /09171234567/);
  assert.equal(bodies.groq.messages[0].content, 'COMPACT');
  for (const b of Object.values(bodies)) assert.equal(JSON.stringify(b).includes('richContent'), false);
});

test('the OpenAI orientation stays slim, and token use is read from the response', async () => {
  const { LLM, estimateTokens } = require('../src/llm');
  const llm = new LLM({ systemPromptFile: require('node:path').join(__dirname, '..', 'prompts', 'system-prompt.md'), llmMaxRpm: 0 });
  const rich = llm.richPrompt([{ role: 'user', content: 'samsung 55 walang display' }]);
  assert.ok(estimateTokens(rich) < 9000, `orientation is ${estimateTokens(rich)} tokens`);
  assert.match(rich, /## 1\. Voice/);
  assert.match(rich, /## 1b\. Short examples/);
  assert.doesNotMatch(rich, /## 5\. Price table/);
  const router = new AiRouter({
    providers: buildProviders({ aiAllowExternalData: true, openaiApiKey: 'oa', aiProviderOrder: 'openai' }),
    fetcher: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      choices: [{ message: { content: 'OK po' } }],
      usage: { prompt_tokens: 8100, prompt_tokens_details: { cached_tokens: 7900 }, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 64 } },
    }) }),
  });
  assert.equal(await router.complete({ messages: [{ role: 'user', content: 'hi' }] }), 'OK po');
  assert.deepEqual(router.lastUsage, { input: 8100, cached: 7900, output: 120, reasoning: 64 });
});

test('Claude Haiku answers first with the JMAG orientation cached, and OpenAI takes over on an error or a refusal', async () => {
  const cfgBoth = { aiAllowExternalData: true, anthropicApiKey: 'ak', openaiApiKey: 'oa', aiProviderOrder: 'anthropic,openai' };
  assert.deepEqual(buildProviders(cfgBoth).map((p) => p.name), ['anthropic', 'openai']);
  assert.equal(buildProviders(cfgBoth)[0].model, 'claude-haiku-5-5');
  const claudeReply = (body) => new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: body.stop || 'end_turn',
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: body.text || '' }],
    usage: { input_tokens: 300, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 90 },
  }), { status: body.status || 200, headers: { 'content-type': 'application/json' } });
  let claudeBody;
  let mode = 'ok';
  const calls = [];
  const router = new AiRouter({
    providers: buildProviders(cfgBoth), retryBackoffMs: 0, rateLimitBackoffMs: 0,
    fetcher: async (url, opts) => {
      const u = String(url);
      if (u.includes('api.anthropic.com')) {
        calls.push('anthropic');
        claudeBody = JSON.parse(opts.body);
        if (mode === 'error') return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
        if (mode === 'refusal') return claudeReply({ text: '', stop: 'refusal' });
        return claudeReply({ text: 'Possible backlight po, 55" Samsung ₱8,500.' });
      }
      calls.push('openai');
      return ok('openai backup po');
    },
  });
  const payload = { temperature: 0.4, max_tokens: 400, messages: [
    { role: 'system', content: 'COMPACT', richContent: 'FULL JMAG ORIENTATION 09386369374' },
    { role: 'system', content: 'Per-turn note' },
    { role: 'assistant', content: 'Hello po' },
    { role: 'user', content: 'samsung 55 walang display 09171234567' },
  ] };
  assert.equal(await router.complete(payload), 'Possible backlight po, 55" Samsung ₱8,500.');
  assert.equal(claudeBody.model, 'claude-haiku-5-5');
  assert.equal(claudeBody.system[0].text, 'FULL JMAG ORIENTATION 09386369374');
  assert.deepEqual(claudeBody.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(claudeBody.system[1].text, 'Per-turn note');
  assert.equal(claudeBody.temperature, undefined, 'temperature is not sent');
  assert.deepEqual(claudeBody.output_config, { effort: 'low' });
  assert.equal(claudeBody.messages[0].role, 'user', 'the conversation starts with the customer');
  assert.doesNotMatch(claudeBody.messages[0].content, /09171234567/, 'customer numbers are redacted');
  assert.deepEqual(router.lastUsage, { input: 8300, cached: 8000, output: 90, reasoning: 0 });
  assert.equal(router.lastProvider, 'anthropic');

  for (const m of ['error', 'refusal']) {
    mode = m;
    router.cooldowns.clear();
    calls.length = 0;
    assert.equal(await router.complete(payload), 'openai backup po', m);
    assert.deepEqual(calls, ['anthropic', 'openai'], m);
  }
});
