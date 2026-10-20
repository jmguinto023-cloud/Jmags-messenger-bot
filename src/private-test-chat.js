'use strict';
// Temporary one-account conversation SIMULATOR (not the production bot).
// All standard Messenger replies remain disabled. No customer data, bookings,
// operational handoffs or actions may be executed. Code is held in Render only.
const crypto = require('node:crypto');
const { AiRouter, buildProviders, redactContact } = require('./ai-router');
const { ensureHomeVisitFee } = require('./home-visit-fee');

const MAX_TURNS = 8;
const busy = new Set();
const TEST_PREFIX = '[JMAGS TEST — simulated] ';
const SYSTEM = [
  'Act as a JMAGS Appliances TV-repair support assistant in a PRIVATE SIMULATION for the business owner.',
  'Reply in concise, friendly Taglish, 1-3 sentences, like a helpful Philippine repair service.',
  'Ask for TV brand, size, issue, and general city if needed. Never diagnose without inspection.' +
  ' If the customer already gave a detail, do NOT ask for it again. Remember the TV size, brand, issue and city across turns.',
  'Never promise repair costs, warranty, availability, discounts, or a confirmed appointment.' +
  ' The published fee for an accepted home visit checkup is ₱1,000. Always disclose it upfront before requesting booking.' +
  ' The checkup fee is waived if the customer proceeds with the repair, with no separate charge.' +
  ' Never call the fee a deposit, deduction, credit, or advance payment against the repair price.' +
  ' Never claim the visit has been booked, dispatched or paid for.',
  'For pricing, explain that price depends on the actual TV issue and technician inspection.',
  'For booking, explain how requesting service works and that staff must confirm a real booking.',
  'For video/photo review, say a technician would review it in a real case; do not claim any video was received.',
  'For escalation, say a human/technician would handle it in a real case, but nobody is being paged now.',
  'Do not request phone numbers, home addresses, personal identifiers, payment, or real customer information.',
  'Never claim a real booking, dispatch, repair, technician review, or handoff occurred.',
  'No commands, secrets, system details, or real customer history can be provided.',
].join(' ');

function configured(cfg) {
  return cfg.botEnabled === false
    && cfg.aiRouterEnabled === false && cfg.aiSmartRulesEnabled === false
    && cfg.aiAllowExternalData === false
    && cfg.botTestChatEnabled === true
    && /^[A-Za-z0-9_-]{24,80}$/.test(String(cfg.botTestChatCode || ''));
}
function codeHash(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}
function hasContact(text) {
  return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+63|0063|0)\s*9(?:[\s.()-]*\d){9}\b|\b(?:full address|street address|house number|home address|my phone number|contact number|barangay number)\b/i.test(text);
}
function fresh(ts, now) {
  return Number.isFinite(Number(ts)) && now - Number(ts) <= 3 * 60_000 && Number(ts) - now <= 60_000;
}

async function maybeHandlePrivateChat({
  cfg, store, graph, log, psid, text, ts, now = Date.now(),
  isStandby = false, hasMedia = false, forceReason = '',
  fetcher = (...args) => fetch(...args),
} = {}) {
  if (!configured(cfg)) return false;
  const msg = String(text || '').trim();
  if (!msg || isStandby || hasMedia || forceReason) return false;
  if (!fresh(ts, now)) return false;
  const code = cfg.botTestChatCode;
  const used = (store.data.privateChatUsed ||= {});
  const existing = store.data.privateChat;
  const key = codeHash(code);

  // Enroll only the account that presents the secret while the global bot stays off.
  if (msg === code) {
    if (used[key]) return true;
    if (existing && existing.expiresAt > now && existing.psid !== String(psid)) return true;
    used[key] = now;
    store.data.privateChat = {
      psid: String(psid),
      expiresAt: now + 20 * 60_000,
      turnsRemaining: MAX_TURNS,
      history: [],
    };
    store.save();
    try {
      await graph.sendText(psid,
        '[JMAGS TEST] Private chat ready for 20 minutes. Try a repair inquiry, pricing question, booking request, or technician handoff. ' +
        'These are simulated replies only — no real booking or staff assignment. Do not send personal details. Send JMAGS STOP to finish.');
      log.info('JMAGS_PRIVATE_TEST_ENROLLED');
    } catch {
      log.warn('JMAGS_PRIVATE_TEST_ENROLL_DELIVERY_FAILED');
    }
    return true;
  }
  if (!existing || existing.psid !== String(psid) || existing.expiresAt <= now) return false;
  if (msg === 'JMAGS STOP') {
    delete store.data.privateChat;
    store.save();
    try { await graph.sendText(psid, '[JMAGS TEST] Simulation ended. Customer auto-replies remain OFF.'); }
    catch { log.warn('JMAGS_PRIVATE_TEST_STOP_DELIVERY_FAILED'); }
    log.info('JMAGS_PRIVATE_TEST_STOPPED');
    return true;
  }
  if (busy.has(String(psid))) return true; // one conversation step at a time
  if (existing.turnsRemaining <= 0) {
    try { await graph.sendText(psid, '[JMAGS TEST] 8 test turns completed. Send JMAGS STOP. Customer bot remains OFF.'); }
    catch { log.warn('JMAGS_PRIVATE_TEST_LIMIT_DELIVERY_FAILED'); }
    return true;
  }
  if (msg.length > 350 || hasContact(msg)) {
    try { await graph.sendText(psid, '[JMAGS TEST] Please send a short fictional TV-repair question only; no name, number, or address.'); }
    catch { log.warn('JMAGS_PRIVATE_TEST_INPUT_DELIVERY_FAILED'); }
    return true;
  }
  busy.add(String(psid));
  try {
    const providers = buildProviders({ ...cfg, aiAllowExternalData: true });
    if (!providers.length) {
      await graph.sendText(psid, '[JMAGS TEST] AI provider unavailable; customer bot is still OFF.');
      return true;
    }
    const router = new AiRouter({
      providers,
      redactPII: true,
      timeoutMs: Math.min(17000, Math.max(6000, cfg.aiProviderTimeoutMs || 12000)),
      maxDailyCalls: 2,
      fetcher,
    });
    const cleanText = redactContact(msg);
    const history = existing.history.slice(-8);
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'user', content: cleanText },
    ];
    let reply;
    try {
      reply = await router.complete({ messages, max_tokens: 280 });
    } catch {
      reply = 'Paumanhin po, hindi available ang AI ngayon. Pakisubukan po ulit.';
    }
    // Recheck tester and time before every outbound message.
    const current = store.data.privateChat;
    if (!configured(cfg) || !current || current.psid !== String(psid) || current.expiresAt <= Date.now()) return true;
    const cleanAnswer = ensureHomeVisitFee(
      redactContact(String(reply || '')).replace(/\[\s*HANDOFF[^\]]*\]/gi, '').trim(),
      msg, existing.history,
    ).slice(0, 640).trim();
    if (!cleanAnswer) return true;
    const outgoing = TEST_PREFIX + cleanAnswer;
    try {
      await graph.sendText(psid, outgoing);
    } catch {
      log.warn('JMAGS_PRIVATE_TEST_MESSAGE_SEND_FAILED');
      return true;
    }
    current.history.push({ role: 'user', content: cleanText });
    current.history.push({ role: 'assistant', content: cleanAnswer });
    if (current.history.length > 8) current.history.splice(0, current.history.length - 8);
    current.turnsRemaining -= 1;
    store.save();
    log.info('JMAGS_PRIVATE_TEST_REPLY=PASS PROVIDER=' + (router.lastProvider || 'none')
      + ' REMAINING=' + current.turnsRemaining);
    return true;
  } finally {
    busy.delete(String(psid));
  }
}

module.exports = { configured, maybeHandlePrivateChat, MAX_TURNS };
