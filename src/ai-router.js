'use strict';
// JMAGS Gemini -> Groq provider failover. Enabled only by explicit Render flags.
// Never store provider keys in GitHub or log provider responses.

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1';

function buildProviders(cfg) {
  if (!cfg.aiAllowExternalData) return [];
  const known = {
    gemini: cfg.geminiApiKey ? {
      name: 'gemini', baseUrl: GEMINI_ENDPOINT,
      apiKey: cfg.geminiApiKey, model: cfg.geminiModel || 'gemini-2.5-flash-lite',
      thirdParty: true,
    } : null,
    groq: cfg.groqApiKey ? {
      name: 'groq', baseUrl: GROQ_ENDPOINT,
      apiKey: cfg.groqApiKey, model: cfg.groqModel || 'openai/gpt-oss-20b',
      thirdParty: true,
    } : null,
  };
  const order = String(cfg.aiProviderOrder || 'gemini,groq')
    .split(',').map((x) => x.trim().toLowerCase());
  return [...new Set(order)].map((key) => known[key]).filter(Boolean);
}

function redactContact(input) {
  return String(input || '')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email removed]')
    .replace(/(?:\+63|0063|0)\s*9(?:[\s.()-]*\d){9}\b/g, '[phone removed]')
    .replace(/\b(?:\d{1,5}[ -]+)?(?:block|blk|lot|house|unit|room|street|st\.|avenue|ave\.|road|rd\.)\s*[\w\d -]{1,42}\b/gi, '[street detail removed]');
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
    fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
    this.providers = providers;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 12000);
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
    for (const provider of this.providers) {
      if ((this.cooldowns.get(provider.name) || 0) > this.now()) continue;
      if (!this.quotaAvailable()) {
        const err = new Error('AI daily request limit reached');
        err.status = 429;
        throw err;
      }
      this.dailyCount++;
      try {
        const answer = await this.ask(provider, payload);
        this.lastProvider = provider.name;
        this.cooldowns.delete(provider.name);
        return answer;
      } catch (err) {
        const status = Number(err.status) || 0;
        const cooldownMs = err.billingIssue ? 3600000
          : [400, 401, 402, 403, 404].includes(status) ? 1200000
          : status === 429 ? 60000 : 30000;
        this.cooldowns.set(provider.name, this.now() + cooldownMs);
        failures.push(provider.name + ': HTTP ' + (status || 'network/timeout'));
      }
    }
    const err = new Error('AI providers unavailable (' + failures.join('; ') + ')');
    err.status = 503;
    throw err;
  }

  async ask(provider, payload) {
    const reqPayload = sanitizePayload({ ...payload, model: provider.model },
      this.redactPII && provider.thirdParty);
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = 'Bearer ' + provider.apiKey;
    const res = await this.fetcher(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(reqPayload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
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
    return answer.trim();
  }
}

module.exports = { AiRouter, buildProviders, redactContact, sanitizePayload };
