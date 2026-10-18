'use strict';
// Calls any OpenAI-compatible Chat Completions API (provider chosen via env vars).
const fs = require('node:fs');

class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this._prompt = null;
    this.omitTemperature = false;
  }
  payload(messages) {
    const p = { model: this.cfg.llmModel, messages };
    // Some models reject these fields; set LLM_TEMPERATURE=off or LLM_MAX_TOKENS=0 to leave them out.
    // A 400 that mentions temperature is retried once without it, then left off for this process.
    if (this.cfg.llmTemperature !== null && !this.omitTemperature) p.temperature = this.cfg.llmTemperature;
    if (this.cfg.llmMaxTokens > 0) p.max_tokens = this.cfg.llmMaxTokens;
    return p;
  }
  configured() { return Boolean(this.cfg.llmBaseUrl && this.cfg.llmModel); }

  systemPrompt() {
    if (this._prompt === null) {
      const raw = fs.readFileSync(this.cfg.systemPromptFile, 'utf8').trim();
      const url = this.cfg.bookingFormUrl || '';
      let text = raw.replaceAll('{{BOOKING_FORM_URL}}', () => url);
      if (url && !text.includes(url)) text += `\n\nSchedule form URL: ${url}`;
      this._prompt = text;
    }
    return this._prompt;
  }

  async reply(history, { nowText, attachmentNote } = {}) {
    if (!this.configured()) throw new Error('LLM not configured (LLM_BASE_URL / LLM_MODEL missing)');
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'system', content: `Current date/time in the Philippines: ${nowText}. Reply only to the customer's latest message. If you hand off, put [HANDOFF: reason] on its own last line. Do not hand off when sending the schedule form.` },
      ...normalizeTurns(history, { attachmentNote }),
    ];
    try {
      return await this.complete(messages);
    } catch (e) {
      if (!this.shouldDropTemperature(e)) throw e;
      this.omitTemperature = true;
      return await this.complete(messages);
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
      throw err;
    }
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error('LLM returned non-JSON'); }
    const text = json?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) throw new Error('LLM returned empty reply');
    return String(text);
  }
}

// Claude (and other models) reject assistant prefill: the request must end on a user turn.
// Merge back-to-back turns of the same role, drop assistant turns that landed after the
// customer's last message (our reply, an echo, a human reply), and if they only sent an
// attachment, close with a user turn such as "[Customer sent a video]".
function normalizeTurns(history, { attachmentNote } = {}) {
  const turns = [];
  for (const h of history || []) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.content ?? '').trim();
    if (!content) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += `\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[turns.length - 1].role === 'assistant') turns.pop();
  const note = String(attachmentNote || '').trim();
  if (note) {
    const last = turns[turns.length - 1];
    if (last && last.role === 'user') {
      if (!last.content.includes(note)) last.content += `\n${note}`;
    } else turns.push({ role: 'user', content: note });
  }
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
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
