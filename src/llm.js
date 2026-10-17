'use strict';
// Calls any OpenAI-compatible Chat Completions API (provider chosen via env vars).
const fs = require('node:fs');

class LLM {
  constructor(cfg) {
    this.cfg = cfg;
    this._prompt = null;
  }
  systemPrompt() {
    if (this._prompt === null) this._prompt = fs.readFileSync(this.cfg.systemPromptFile, 'utf8').trim();
    return this._prompt;
  }
  payload(messages) {
    const p = { model: this.cfg.llmModel, messages };
    // Some models reject these fields; set LLM_TEMPERATURE=off or LLM_MAX_TOKENS=0 to leave them out.
    if (this.cfg.llmTemperature !== null) p.temperature = this.cfg.llmTemperature;
    if (this.cfg.llmMaxTokens > 0) p.max_tokens = this.cfg.llmMaxTokens;
    return p;
  }
  configured() { return Boolean(this.cfg.llmBaseUrl && this.cfg.llmModel); }

  async reply(history, { nowText } = {}) {
    if (!this.configured()) throw new Error('LLM not configured (LLM_BASE_URL / LLM_MODEL missing)');
    const messages = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'system', content: `Current date/time in the Philippines: ${nowText}. Reply only to the customer's latest message. If you hand off, put [HANDOFF: reason] on its own last line.` },
      ...history.map((h) => ({ role: h.role, content: h.content })),
    ];
    const headers = { 'Content-Type': 'application/json' };
    if (this.cfg.llmApiKey) headers.Authorization = `Bearer ${this.cfg.llmApiKey}`;
    const res = await fetch(`${this.cfg.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(this.payload(messages)),
      signal: AbortSignal.timeout(this.cfg.llmTimeoutMs),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) throw new Error('LLM returned empty reply');
    return String(text);
  }
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
module.exports = { LLM, parseHandoff };
