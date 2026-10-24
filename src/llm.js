'use strict';
// Calls any OpenAI-compatible Chat Completions API (provider chosen via env vars).
const fs = require('node:fs');
const path = require('node:path');
const { LlmGate, retryDelayMs } = require('./llm-gate');
const { AiRouter, buildProviders } = require('./ai-router');
const { behaviorBaseline, behaviorContext } = require('./behavior-bank');

const RETRIES = 3;
const RETRY_BUDGET_MS = 90_000;

class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this._prompt = null;
    this.omitTemperature = false;
    this.errors = 0;
    this.lastError = '';
    this.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    this.gate = new LlmGate({
      rpm: cfg.llmMaxRpm,
      sleep: (ms) => this.sleep(ms),
    });
    this.router = cfg.aiRouterEnabled
      ? new AiRouter({
        providers: buildProviders(cfg),
        timeoutMs: cfg.aiProviderTimeoutMs,
        maxDailyCalls: cfg.aiMaxDailyCalls,
        redactPII: cfg.aiRedactPII,
      }) : null;
  }

  noteError(e) {
    this.errors += 1;
    this.lastError = String((e && e.message) || e || 'LLM error').replace(/\s+/g, ' ').slice(0, 300);
  }
  payload(messages) {
    const p = { model: this.cfg.llmModel, messages };
    // Some models reject these fields; set LLM_TEMPERATURE=off or LLM_MAX_TOKENS=0 to leave them out.
    // A 400 that mentions temperature is retried once without it, then left off for this process.
    if (this.cfg.llmTemperature !== null && !this.omitTemperature) p.temperature = this.cfg.llmTemperature;
    if (this.cfg.llmMaxTokens > 0) p.max_tokens = this.cfg.llmMaxTokens;
    return p;
  }
  configured() { return this.router ? this.router.providers.length > 0 : Boolean(this.cfg.llmBaseUrl && this.cfg.llmModel); }

  systemPrompt() {
    if (this._prompt === null) {
      const raw = fs.readFileSync(this.cfg.systemPromptFile, 'utf8').trim();
      const url = this.cfg.bookingFormUrl || '';
      let text = raw.replaceAll('{{BOOKING_FORM_URL}}', () => url);
      if (url && !text.includes(url)) text += `\n\nSchedule form URL: ${url}`;
      const refFile = this.cfg.brandNewReferenceFile || path.join(__dirname, '..', 'prompts', 'brand-new-reference.md');
      text += `\n\n${fs.readFileSync(refFile, 'utf8').trim()}`;
      this._prompt = text + '\n\n## JMAGS Behavior Bank (approved customer-service behavior, no new prices)\n' + behaviorBaseline();
    }
    return this._prompt;
  }

  async reply(history, { nowText, attachmentNote, intakeNote, mediaStatus } = {}) {
    if (!this.configured()) throw new Error('LLM not configured (LLM_BASE_URL / LLM_MODEL missing)');
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'system', content: `Current date/time in the Philippines: ${nowText}. Reply only to the customer's latest message. If you hand off, put [HANDOFF: reason] on its own last line. Do not hand off when sending the schedule form. ${intakeNote || ''} ${mediaStatus || ''}`.trim() },
      { role: 'system', content: behaviorContext([...history].reverse().find(h => h.role === 'user')?.content || '') },
      ...normalizeTurns(history, { attachmentNote }),
    ];
    return this.chat(messages, { priority: 'high' });
  }

  async followUp(history, { nowText, videoMissing } = {}) {
    if (!this.configured()) throw new Error('LLM not configured (LLM_BASE_URL / LLM_MODEL missing)');
    const turns = normalizeTurns(history, { keepTrailingAssistant: true });
    const nudge = videoMissing
      ? '[No reply yet. They still have not sent the video.]'
      : '[No reply yet]';
    if (!turns.length || turns[turns.length - 1].role !== 'user') turns.push({ role: 'user', content: nudge });
    else if (!turns[turns.length - 1].content.includes('[No reply yet]')) turns[turns.length - 1].content += `\n${nudge}`;
    const extra = videoMissing
      ? ' They were asked for a video and have not sent it. Remind them to send the video.'
      : '';
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'system', content: `Current date/time in the Philippines: ${nowText}. Write ONE short human Taglish follow-up. The customer has not answered. If they already gave a size, brand, or issue, or asked the price or a schedule, this is the one gentle follow-up for that lead: 2-4 short lines, no repeated greeting, ask when they are free. Urgency like limited slots this week. No discount, promo, tawad, or lower price. Use a brand-new comparison only from a CONFIRMED row. Do not output [HANDOFF].${extra}` },
      ...turns,
    ];
    return this.chat(messages, { priority: 'low' });
  }

  async chat(messages, { priority = 'high' } = {}) {
    if (this.router) {
      try {
        const answer = await this.gate.schedule(() => this.router.complete(this.payload(messages)), { priority });
        this.lastProvider = this.router.lastProvider || '';
        return answer;
      } catch (e) {
        this.noteError(e);
        throw e;
      }
    }
    const started = Date.now();
    let last;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        return await this.once(messages, priority);
      } catch (e) {
        last = e;
        this.noteError(e);
        if (attempt === RETRIES - 1) break;
        const remain = RETRY_BUDGET_MS - (Date.now() - started);
        if (remain < 250) break;
        await this.sleep(Math.min(retryDelayMs(e, attempt), remain));
      }
    }
    throw last;
  }

  async once(messages, priority) {
    try {
      this.lastProvider = this.cfg.llmModel || 'llm';
      return await this.gate.schedule(() => this.complete(messages), { priority });
    } catch (e) {
      if (!this.shouldDropTemperature(e)) throw e;
      this.omitTemperature = true;
      this.lastProvider = this.cfg.llmModel || 'llm';
      return await this.gate.schedule(() => this.complete(messages), { priority });
    }
  }

  shouldDropTemperature(e) {
    return e.status === 400
      && !this.omitTemperature
      && this.cfg.llmTemperature !== null
      && /temperature/i.test(`${e.message || ''}\n${e.body || ''}`);
  }

  async complete(messages) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.cfg.llmApiKey) headers.Authorization = `Bearer ${this.cfg.llmApiKey}`;
    const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.payload(messages)),
      signal: AbortSignal.timeout(this.cfg.llmTimeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 200)}`);
      err.status = res.status;
      err.body = raw;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('LLM returned non-JSON'); }
    const text = json?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) throw new Error('LLM returned empty reply');
    return String(text);
  }
}

// Some chat models reject assistant prefill: the request must end on a user turn.
// Merge back-to-back turns of the same role, drop assistant turns that landed after the
// customer's last message (our reply, an echo, a human reply), and if they only sent an
// attachment, close with a user turn such as "[Customer sent a video]".
function normalizeTurns(history, { attachmentNote, keepTrailingAssistant } = {}) {
  const turns = [];
  for (const h of history || []) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.content ?? '').trim();
    if (!content) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += `\n${content}`;
    else turns.push({ role, content });
  }
  if (!keepTrailingAssistant) {
    while (turns.length && turns[turns.length - 1].role === 'assistant') turns.pop();
  }
  const note = String(attachmentNote || '').trim();
  if (note) {
    const last = turns[turns.length - 1];
    if (last && last.role === 'user') {
      if (!last.content.includes(note)) last.content += `\n${note}`;
    } else turns.push({ role: 'user', content: note });
  }
  if (!keepTrailingAssistant && (!turns.length || turns[turns.length - 1].role !== 'user')) {
    turns.push({ role: 'user', content: note || '[Customer sent a message]' });
  }
  return turns;
}

// Pull out the hidden [HANDOFF: reason] marker and return clean text.
function parseHandoff(raw) {
  const re = /\[\s*HANDOFF\s*:?\s*([^\]]*)\]/gi;
  let reason = null;
  let m;
  while ((m = re.exec(raw))) reason = (m[1] || '').trim() || 'model';
  const text = raw.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, handoff: reason !== null, reason: reason || '' };
}
module.exports = { LLM, parseHandoff, normalizeTurns };
