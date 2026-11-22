'use strict';
// Customer replies use Groq unless AI_PROVIDER_ORDER explicitly lists another provider.
// Gemini is not called when it is absent from that list. Enabled only by explicit Render flags.
// Never store provider keys in GitHub or log provider responses.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1';
const Anthropic = require('@anthropic-ai/sdk').default;

function gpt5Family(model) {
  return /^gpt-5/i.test(String(model || ''));
}

function usableKey(value) {
  const key = String(value || '').trim();
  if (!key || /^(undefined|null|none|false|changeme)$/i.test(key)) return '';
  return key;
}

function buildProviders(cfg) {
  if (!cfg.aiAllowExternalData) return [];
  const known = {
    gemini: usableKey(cfg.geminiApiKey) ? {
      name: 'gemini', baseUrl: GEMINI_ENDPOINT,
      apiKey: usableKey(cfg.geminiApiKey), model: cfg.geminiModel || 'gemini-3.1-flash-lite',
      thirdParty: true,
    } : null,
    groq: usableKey(cfg.groqApiKey) ? {
      name: 'groq', baseUrl: GROQ_ENDPOINT,
      apiKey: usableKey(cfg.groqApiKey), model: cfg.groqModel || 'openai/gpt-oss-20b',
      thirdParty: true,
    } : null,
    anthropic: usableKey(cfg.anthropicApiKey) ? {
      name: 'anthropic',
      apiKey: usableKey(cfg.anthropicApiKey), model: cfg.anthropicModel || 'claude-haiku-5-5',
      effort: cfg.anthropicEffort || 'low',
      timeoutMs: Number(cfg.anthropicTimeoutMs) || 20000,
      thirdParty: true,
    } : null,
    openai: usableKey(cfg.openaiApiKey) ? {
      name: 'openai', baseUrl: OPENAI_ENDPOINT,
      apiKey: usableKey(cfg.openaiApiKey), model: cfg.openaiModel || 'gpt-5.4-mini',
      reasoningEffort: cfg.openaiReasoningEffort || 'low',
      timeoutMs: Number(cfg.openaiTimeoutMs) || 15000,
      thirdParty: true,
    } : null,
  };
  const order = String(cfg.aiProviderOrder || 'groq')
    .split(',').map((x) => x.trim().toLowerCase());
  return [...new Set(order)].map((key) => known[key]).filter(Boolean);
}

function redactContact(input) {
  return String(input || '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email removed]')
    .replace(/(?:\+63|0063|0)\s*9(?:[\s.()-]*\d){9}\b/g, '[phone removed]')
    // Match real numbered addresses, not ordinary phrases such as "TV unit"
    // or "ang unit" in a repair discussion.
    .replace(/\b\d{1,5}\s+(?:[\w.-]+\s+){0,4}(?:street|st\.|road|rd\.|avenue|ave\.|drive|dr\.)\b/gi, '[street detail removed]')
    .replace(/\b(?:block|blk|lot|house|unit|room)\s*(?:#\s*|no\.?\s*)?\d{1,5}[a-z0-9-]*\b/gi, '[street detail removed]');
}

function sanitizePayload(payload, shouldRedact) {
  if (!shouldRedact) return payload;
  return {
    ...payload,
    messages: (payload.messages || []).map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? redactContact(m.content) : m.content,
    })),
  };
}

class AiRouter {
  constructor({ providers = [], timeoutMs = 12000, maxDailyCalls = 100, redactPII = true,
    fetcher = (...args) => fetch(...args), now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retryBackoffMs = 400,
    rateLimitBackoffMs = 1500 } = {}) {
    this.providers = providers;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 12000);
    this.sleep = sleep;
    this.retryBackoffMs = Math.max(0, Number(retryBackoffMs) || 0);
    this.rateLimitBackoffMs = Math.max(0, Number(rateLimitBackoffMs) || 0);
    // Zero/invalid values must not silently disable the quota.
    this.maxDailyCalls = Math.max(1, Number(maxDailyCalls) || 100);
    this.redactPII = redactPII;
    this.fetcher = fetcher;
    this.now = now;
    this.cooldowns = new Map();
    this.dailyBucket = '';
    this.dailyCount = 0;
    this.lastProvider = '';
  }

  quotaAvailable() {
    const bucket = new Date(this.now()).toISOString().slice(0, 10);
    if (bucket !== this.dailyBucket) {
      this.dailyBucket = bucket;
      this.dailyCount = 0;
    }
    return this.dailyCount < this.maxDailyCalls;
  }

  async complete(payload) {
    if (!this.providers.length) {
      const err = new Error('No approved AI providers configured');
      err.status = 503;
      throw err;
    }
    const failures = [];
    this.lastFailures = failures;
    const triedThisCall = new Set();
    for (let round = 0; round < 2; round++) {
      let retryable = false;
      let rateLimited = false;
      for (const provider of this.providers) {
        const cooling = (this.cooldowns.get(provider.name) || 0) > this.now();
        if (cooling && !triedThisCall.has(provider.name)) {
          const why = this.lastErrorBy && this.lastErrorBy[provider.name];
          if (!failures.some((f) => f.startsWith(provider.name + ':'))) {
            failures.push(`${provider.name}: resting after an error${why ? ` (${why})` : ''}`);
          }
          continue;
        }
        if (!this.quotaAvailable()) {
          const err = new Error('AI daily request limit reached');
          err.status = 429;
          throw err;
        }
        this.dailyCount++;
        try {
          const answer = await this.ask(provider, payload);
          this.lastProvider = provider.name;
          this.lastModel = provider.model || '';
          this.cooldowns.delete(provider.name);
          return answer;
        } catch (err) {
          const status = Number(err.status) || 0;
          const cooldownMs = err.billingIssue ? 3600000
            : [400, 401, 402, 403, 404].includes(status) ? 1200000
            : status === 429 ? 60000 : 30000;
          this.cooldowns.set(provider.name, this.now() + cooldownMs);
          triedThisCall.add(provider.name);
          if (!status || status === 429 || status >= 500) retryable = true;
          if (status === 429) rateLimited = true;
          const line = 'HTTP ' + (status || 'network/timeout')
            + (err.detail ? ` ${String(err.detail).replace(/\s+/g, ' ').slice(0, 160)}` : '');
          this.lastErrorBy = this.lastErrorBy || {};
          this.lastErrorBy[provider.name] = line;
          failures.push(`${provider.name}: ${line}`);
        }
      }
      if (round === 0 && retryable) {
        const wait = rateLimited
          ? Math.max(this.retryBackoffMs, this.rateLimitBackoffMs)
          : this.retryBackoffMs;
        await this.sleep(wait);
        continue;
      }
      // Every provider was on cooldown, so nobody was called. Wait for the soonest
      // cooldown, at most 20s, then try them. Do not fail with an empty provider list.
      if (round === 0 && triedThisCall.size === 0) {
        const waits = this.providers
          .map((provider) => (this.cooldowns.get(provider.name) || 0) - this.now())
          .filter((ms) => ms > 0);
        const wait = Math.min(20000, waits.length ? Math.min(...waits) : 0);
        if (wait > 0) await this.sleep(wait);
        for (const provider of this.providers) this.cooldowns.delete(provider.name);
        continue;
      }
      break;
    }
    const err = new Error('AI providers unavailable (' + failures.join('; ') + ')');
    err.status = 503;
    throw err;
  }

  async ask(provider, payload) {
    // A provider with a large context (OpenAI) gets the full orientation in richContent.
    // Others (Groq) get the compact prompt; the full one is too big for them (HTTP 413).
    // richContent is fixed shop text (it holds the shop's own phone numbers), so it is put in
    // after redaction. Customer turns are still redacted.
    const useRich = provider.name === 'openai' || provider.name === 'anthropic';
    const original = payload.messages || [];
    const clean = sanitizePayload({ ...payload, messages: original.map(({ richContent, ...m }) => m), model: provider.model },
      this.redactPII && provider.thirdParty);
    const reqPayload = { ...clean, messages: clean.messages.map((m, i) => (
      useRich && original[i] && original[i].richContent ? { ...m, content: original[i].richContent } : m)) };
    if (provider.name === 'anthropic') return this.askAnthropic(provider, reqPayload);
    // Groq uses max_tokens. reasoning_effort is an OpenAI GPT-5 field and is not sent.
    if (provider.name === 'groq') {
      if (!reqPayload.max_tokens && reqPayload.max_completion_tokens) {
        reqPayload.max_tokens = reqPayload.max_completion_tokens;
      }
      delete reqPayload.max_completion_tokens;
      delete reqPayload.reasoning_effort;
    }
    // GPT-5 rejects max_tokens and temperature. reasoning_effort is required.
    if (provider.name === 'openai' && gpt5Family(provider.model)) {
      const budget = Number(reqPayload.max_completion_tokens) || Number(reqPayload.max_tokens) || 400;
      reqPayload.max_completion_tokens = budget;
      reqPayload.reasoning_effort = provider.reasoningEffort || 'low';
      delete reqPayload.max_tokens;
      delete reqPayload.temperature;
    }
    // Every reply shares the same cached instruction block; one cache key routes them to the same cache.
    // If the API ever rejects the field, it is dropped for this process and the call is retried once.
    if (provider.name === 'openai' && useRich && !this.noPromptCacheKey) reqPayload.prompt_cache_key = 'jmags-orientation';
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    const timeoutMs = Math.max(1000, Number(provider.timeoutMs) || this.timeoutMs);
    const send = () => this.fetcher(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(reqPayload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let res = await send();
    let raw = await res.text();
    if (!res.ok && res.status === 400 && reqPayload.prompt_cache_key && /prompt_cache_key/i.test(raw)) {
      this.noPromptCacheKey = true;
      delete reqPayload.prompt_cache_key;
      res = await send();
      raw = await res.text();
    }
    if (!res.ok) {
      const err = new Error(provider.name + ' API HTTP ' + res.status);
      err.status = res.status;
      err.billingIssue = /credit balance|billing|insufficient credit/i.test(raw);
      throw err;
    }
    let json;
    try { json = JSON.parse(raw); } catch {
      throw new Error(provider.name + ' returned invalid JSON');
    }
    const answer = json && json.choices && json.choices[0]
      && json.choices[0].message && json.choices[0].message.content;
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new Error(provider.name + ' returned an empty response');
    }
    // Token use for the cost log: input, cached input, output (reasoning is part of output).
    const u = (json && json.usage) || {};
    this.lastUsage = {
      input: Number(u.prompt_tokens) || 0,
      cached: Number(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      output: Number(u.completion_tokens) || 0,
      reasoning: Number(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
    };
    return answer.trim();
  }
}

// Claude through the official SDK. The JMAG orientation (first system message) is cached; per-turn notes follow it.
// Thinking stays adaptive at low effort. A refusal or an empty answer throws, so the next provider answers.
AiRouter.prototype.askAnthropic = async function askAnthropic(provider, payload) {
  if (!provider.client) {
    provider.client = new Anthropic({
      apiKey: provider.apiKey,
      maxRetries: 0,
      timeout: Math.max(1000, Number(provider.timeoutMs) || this.timeoutMs),
      fetch: (...args) => this.fetcher(...args),
    });
  }
  const systemTexts = [];
  const turns = [];
  for (const m of payload.messages || []) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role === 'system') { if (text.trim()) systemTexts.push(text); continue; }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length) turns.push({ role: 'user', content: '[Customer sent a message]' });
  const system = systemTexts.length
    ? [{ type: 'text', text: systemTexts[0], cache_control: { type: 'ephemeral' } },
      ...(systemTexts.length > 1 ? [{ type: 'text', text: systemTexts.slice(1).join('\n\n') }] : [])]
    : undefined;
  let res;
  try {
    res = await provider.client.messages.create({
      model: provider.model,
      max_tokens: 2048,
      ...(system ? { system } : {}),
      messages: turns,
      output_config: { effort: provider.effort || 'low' },
    });
  } catch (e) {
    const err = new Error(`anthropic API HTTP ${e && e.status ? e.status : 'error'}`);
    err.status = (e && e.status) || 0;
    // Anthropic's own reason (bad key, no credit, unknown model). Never contains the key.
    err.detail = String((e && e.error && e.error.error && e.error.error.message) || (e && e.message) || '').slice(0, 200);
    err.billingIssue = /credit balance|billing|insufficient/i.test(String((e && e.message) || ''));
    throw err;
  }
  if (res.stop_reason === 'refusal') {
    const err = new Error('anthropic declined the request');
    err.status = 422;
    err.detail = 'refusal';
    throw err;
  }
  const answer = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!answer) throw new Error('anthropic returned an empty response');
  const u = res.usage || {};
  const read = Number(u.cache_read_input_tokens) || 0;
  const write = Number(u.cache_creation_input_tokens) || 0;
  this.lastUsage = {
    input: (Number(u.input_tokens) || 0) + read + write,
    cached: read,
    output: Number(u.output_tokens) || 0,
    reasoning: 0,
  };
  return answer;
};

module.exports = { AiRouter, buildProviders, redactContact, sanitizePayload, gpt5Family };
