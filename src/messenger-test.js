'use strict';
// One-shot Messenger proof of delivery, entirely separate from normal customer replies.
// Only a long, exact, operator-chosen challenge triggers this when the bot is OFF.
// Do not log the challenge, PSID, API credentials or provider output.
const crypto = require('node:crypto');
const { AiRouter, buildProviders } = require('./ai-router');

const busy = new Set();
const SYNTHETIC_MESSAGES = Object.freeze([
  { role: 'system', content: 'This is a private technical test for JMAGS Appliances. Do not discuss customers or business policies.' },
  { role: 'user', content: 'Say exactly "Hello po, JMAGS Hybrid AI test successful!" with no other text.' },
]);

function eligible(cfg) {
  return cfg.botEnabled === false &&
    cfg.aiRouterEnabled === false &&
    cfg.aiAllowExternalData === false &&
    cfg.aiSmartRulesEnabled === false &&
    String(cfg.botTestChallenge || '').length >= 24 &&
    /^[A-Za-z0-9_-]+$/.test(String(cfg.botTestChallenge || ''));
}

async function maybeReplyToTestChallenge({
  cfg, store, graph, log, psid, text, ts, now = Date.now(),
  isStandby = false, hasMedia = false, forceReason = '',
  fetcher = (...args) => fetch(...args),
} = {}) {
  if (!eligible(cfg) || String(text || '').trim() !== cfg.botTestChallenge) return false;
  // Exact challenge on standby is not ours to answer; never steal another app's thread.
  if (isStandby || hasMedia || forceReason || !Number.isFinite(Number(ts)) ||
    now - Number(ts) > 15 * 60000 || Number(ts) - now > 2 * 60000) {
    log.info('JMAGS_TEST_IGNORED: invalid freshness or non-primary conversation');
    return true;
  }

  const key = crypto.createHash('sha256').update(cfg.botTestChallenge).digest('hex');
  store.data.messengerTestUsed ||= {};
  if (store.data.messengerTestUsed[key] || busy.has(key)) {
    log.info('JMAGS_TEST_IGNORED: one-shot challenge already handled');
    return true;
  }
  busy.add(key);
  try {
    // The only data sent to Gemini/Groq is the hardcoded message above.
    // Never provide the incoming challenge text, sender PSID, or chat history.
    const providers = buildProviders({ ...cfg, aiAllowExternalData: true });
    let providerName = 'none';
    let modelOk = false;
    if (providers.length) {
      const router = new AiRouter({
        providers, timeoutMs: Math.min(18000, Math.max(5000, cfg.aiProviderTimeoutMs || 12000)),
        maxDailyCalls: 2, redactPII: true, fetcher,
      });
      try {
        const answer = await router.complete({ messages: SYNTHETIC_MESSAGES, max_tokens: 512 });
        modelOk = Boolean(answer && String(answer).trim());
        providerName = router.lastProvider || 'none';
      } catch {
        log.warn('JMAGS_TEST_AI_FAILED: no provider reply; details suppressed');
      }
    }
    const proof = modelOk
      ? 'JMAGS Hybrid AI Messenger test: SUCCESS. Gemini/Groq AI and Meta delivery connected. Customer auto-replies remain OFF.'
      : 'JMAGS Messenger delivery test: RECEIVED. AI connection needs review. Customer auto-replies remain OFF.';
    try {
      await graph.sendText(psid, proof);
    } catch {
      log.warn('JMAGS_TEST_DELIVERY_FAILED: Meta rejected test send; details suppressed');
      return true;
    }
    store.data.messengerTestUsed[key] = { at: now, aiPassed: modelOk };
    store.save();
    log.info('JMAGS_TEST_DELIVERY=PASS AI=' + (modelOk ? 'PASS' : 'FAIL') +
      ' PROVIDER=' + providerName);
    return true;
  } finally {
    busy.delete(key);
  }
}

module.exports = { eligible, maybeReplyToTestChallenge, SYNTHETIC_MESSAGES };
