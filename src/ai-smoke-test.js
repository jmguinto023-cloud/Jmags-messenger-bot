'use strict';
// Synthetic-only provider connectivity test. Customer replies and external-data
// routing MUST remain disabled; never log keys, raw errors or model responses.
const { AiRouter, buildProviders } = require('./ai-router');

const PROBE_MESSAGES = Object.freeze([
  { role: 'system', content: 'You are testing a technical connection, not helping a customer.' },
  { role: 'user', content: 'Reply with one short greeting. This is synthetic test data only.' },
]);

function safeStatus(error) {
  const code = Number(error && error.status);
  // Only classify known error shapes; never output the raw message or key.
  const msg = String((error && error.message) || '');
  if (/returned an empty response/.test(msg)) return 'EMPTY_RESPONSE';
  if (/returned invalid JSON/.test(msg)) return 'INVALID_JSON';
  if (error && /Timeout|Abort/.test(String(error.name || ''))) return 'TIMEOUT';
  if (code === 400) return 'BAD_REQUEST';
  if (code === 401 || code === 403) return 'AUTH_FAILED';
  if (code === 402) return 'BILLING_REQUIRED';
  if (code === 404) return 'MODEL_OR_ENDPOINT_UNAVAILABLE';
  if (code === 429) return 'RATE_LIMITED';
  if (code >= 500 && code <= 599) return 'PROVIDER_ERROR';
  return 'NETWORK_TIMEOUT_OR_INVALID_RESPONSE';
}

function permitted(cfg, env) {
  return env.AI_SMOKE_TEST_ON_STARTUP === 'true'
    && cfg.botEnabled === false
    && cfg.aiRouterEnabled === false
    && cfg.aiAllowExternalData === false
    && cfg.aiSmartRulesEnabled === false;
}

async function runProviderSmokeTest({ cfg, env = process.env, log,
  fetcher = (...args) => fetch(...args) }) {
  if (!permitted(cfg, env)) {
    log.warn('AI_SMOKE_SKIPPED: safe test mode is not enabled');
    return { skipped: true };
  }

  // Explicit test-data-only override for provider construction.
  // Does not change customer routing, privacy gates or any saved environment.
  const providers = buildProviders({ ...cfg, aiAllowExternalData: true });
  const found = new Map(providers.map((p) => [p.name, p]));
  const results = {};
  for (const name of ['gemini', 'groq']) {
    const provider = found.get(name);
    if (!provider) {
      results[name] = 'MISSING_KEY';
      log.warn('AI_SMOKE_' + name.toUpperCase() + '=MISSING_KEY');
      continue;
    }
    try {
      const router = new AiRouter({
        providers: [provider],
        maxDailyCalls: 1,
        timeoutMs: Math.min(20000, Math.max(5000, Number(cfg.aiProviderTimeoutMs) || 12000)),
        redactPII: true,
        fetcher,
      });
      await router.ask(provider, { messages: PROBE_MESSAGES, max_tokens: 512 });
      results[name] = 'PASS';
      log.info('AI_SMOKE_' + name.toUpperCase() + '=PASS');
    } catch (error) {
      results[name] = safeStatus(error);
      log.warn('AI_SMOKE_' + name.toUpperCase() + '=' + results[name]);
    }
  }
  log.info('AI_SMOKE_COMPLETED: synthetic data only; customer bot disabled');
  return { skipped: false, results };
}

module.exports = { runProviderSmokeTest, permitted, safeStatus };
