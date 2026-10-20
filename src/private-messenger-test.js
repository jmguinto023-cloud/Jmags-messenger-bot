'use strict';
// Private Messenger test lane. It never changes BOT_ENABLED or the normal bot
// workflow. Only the first PSID presenting a long, private test code can use it.
// In-memory single owner, bounded enrollment time, time-limited, capped prompts.
// No historical customer threads, operations, CRM or human handoff are accessed.

const { parseHandoff } = require('./llm');
const { sanitizeOutgoing } = require('./messages');
const { redactContact } = require('./ai-router');

const ENROLL_MS = 30 * 60 * 1000;
const SESSION_MS = 15 * 60 * 1000;
const MAX_PROMPTS = 5;

class PrivateMessengerTest {
  constructor(cfg, { now = () => Date.now(), log, graph, llm, nowText } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.log = log;
    this.graph = graph;
    this.llm = llm;
    this.nowText = nowText || (() => new Date(this.now()).toISOString());
    this.enrollDeadline = this.now() + ENROLL_MS;
    this.ownerPsid = '';
    this.expiresAt = 0;
    this.replyCount = 0;
    this.history = [];
    this.closedNoticeSent = false;
    this.queue = Promise.resolve();
  }

  enabled() {
    return this.cfg.botTestMode === true
      && this.cfg.botEnabled === false
      && this.cfg.aiRouterEnabled === true
      && this.cfg.aiAllowExternalData === true
      && this.cfg.botTestToken.length >= 24
      && Boolean(this.llm && this.llm.configured());
  }

  async handle({ psid, text, media = [], isStandby = false } = {}) {
    if (!this.enabled()) return false;
    const sender = String(psid || '');
    const input = String(text || '').trim();
    if (!sender) return false;

    // Enrollment code is intercepted *before* regular conversation storage.
    if (input === this.cfg.botTestToken) {
      if (!this.ownerPsid && this.now() < this.enrollDeadline && !isStandby) {
        this.ownerPsid = sender;
        this.expiresAt = this.now() + SESSION_MS;
        await this.graph.sendText(sender,
          'JMAGS PRIVATE AI TEST READY. Send a sample TV repair question (no personal details). ' +
          'Maximum 5 replies within 15 minutes. Customers are not included in this test.');
        this.log.info('PRIVATE_TEST_ENROLLED: one tester account; normal bot remains disabled');
      }
      return true;
    }

    if (sender !== this.ownerPsid) return false;
    if (isStandby) {
      this.log.warn('PRIVATE_TEST_STANDBY: another app owns the test conversation');
      return true;
    }

    // One queue for the sole tester. Prevents overlapped responses or >5 calls.
    const task = this.queue.then(() => this.answer(sender, input, media));
    this.queue = task.catch(() => {});
    await task;
    return true;
  }

  async answer(psid, input, media) {
    if (this.now() >= this.expiresAt || this.replyCount >= MAX_PROMPTS) {
      if (!this.closedNoticeSent) {
        this.closedNoticeSent = true;
        await this.graph.sendText(psid, 'JMAGS private AI test finished. Normal customer auto-replies are still OFF.');
      }
      return;
    }
    if (media.length || !input || input.length > 250 || redactContact(input) !== input) {
      await this.graph.sendText(psid,
        'For the private test, please send only a short text about a TV issue, without a name, phone number, email or address.');
      return;
    }

    this.replyCount++;
    this.history.push({ role: 'user', content: input, ts: this.now() });
    try {
      const raw = await this.llm.reply(this.history, {
        nowText: this.nowText(),
        intakeNote: 'Private synthetic test conversation. Do not claim any booking is confirmed. No customer details.',
        mediaStatus: '',
      });
      // Even if model emits a handoff marker, don't alert staff or change routing.
      const parsed = parseHandoff(raw);
      const message = parsed.handoff
        ? 'TEST HANDOFF FLAG DETECTED. No staff notification was sent.'
        : sanitizeOutgoing(parsed.text).slice(0, 1100);
      if (!message) throw new Error('Empty test reply');
      // A long-running model response must not bypass the test expiry.
      if (this.now() >= this.expiresAt) return;
      await this.graph.sendText(psid, message);
      this.history.push({ role: 'assistant', content: message, ts: this.now() });
      this.log.info('PRIVATE_TEST_REPLY_SENT: synthetic owner conversation only');
    } catch (_) {
      this.log.warn('PRIVATE_TEST_AI_FAILED: details suppressed');
      if (this.now() < this.expiresAt) {
        await this.graph.sendText(psid, 'JMAGS private AI test could not complete this reply. No staff was alerted.');
      }
    }
  }
}

module.exports = { PrivateMessengerTest, MAX_PROMPTS, SESSION_MS, ENROLL_MS };
