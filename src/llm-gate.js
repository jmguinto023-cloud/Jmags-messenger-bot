'use strict';
// Space out LLM calls and read provider retry hints (Retry-After, Gemini retryDelay).

function parseDelayMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const seconds = text.match(/^(\d+(?:\.\d+)?)s$/i);
  if (seconds) return Number(seconds[1]) * 1000;
  const when = Date.parse(text);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return null;
}

function bodyDelayMs(err) {
  let json;
  try { json = JSON.parse(err && err.body ? err.body : ''); } catch { return null; }
  const details = (json && json.error && json.error.details) || (json && json.details) || [];
  for (const row of details) {
    if (row && row.retryDelay != null) return parseDelayMs(row.retryDelay);
  }
  if (json && json.error && json.error.retryDelay != null) return parseDelayMs(json.error.retryDelay);
  return null;
}

// Hint from the provider, otherwise a short exponential wait. Capped so one call cannot sleep for an hour.
function retryDelayMs(err, attempt) {
  const hinted = parseDelayMs(err && err.retryAfter) ?? bodyDelayMs(err);
  if (hinted != null && Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted, 60_000);
  return Math.min(2000 * (2 ** attempt), 30_000);
}

class LlmGate {
  constructor({ rpm = 15, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs = 20000 } = {}) {
    const rate = Number(rpm);
    this.minGap = rate > 0 ? 60000 / rate : 0;
    this.maxWaitMs = Math.max(0, Number(maxWaitMs) || 0);
    this.now = now;
    this.sleep = sleep;
    this.high = [];
    this.low = [];
    this.nextAt = 0;
    this.running = false;
  }

  schedule(fn, { priority = 'high' } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject };
      (priority === 'low' ? this.low : this.high).push(job);
      this.pump();
    });
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.high.length || this.low.length) {
        const job = this.high.shift() || this.low.shift();
        let wait = this.nextAt - this.now();
        // Queue a backed-up call, but do not hold the customer past 20s and do not drop it.
        if (this.maxWaitMs > 0 && wait > this.maxWaitMs) wait = this.maxWaitMs;
        if (wait > 0) await this.sleep(wait);
        this.nextAt = this.now() + this.minGap;
        try {
          job.resolve(await job.fn());
        } catch (e) {
          job.reject(e);
        }
      }
    } finally {
      this.running = false;
      if (this.high.length || this.low.length) this.pump();
    }
  }
}

module.exports = { LlmGate, retryDelayMs, parseDelayMs };
