'use strict';
// Periodic read-back of Messenger Page Inbox custom labels into Desk marks.
//
// Source-of-truth model: Messenger custom labels are authoritative for every Desk mark
// that carries a metaLabel. Staff apply or remove a label (e.g. "High Potential") in the
// Facebook Page Inbox; this loop reads those labels back each cycle and sets each thread's
// marks to match, so the Desk tab shows a filtered line-up of high-potential customers.
// The dashboard colour buttons also write the same label through graph.addLabel /
// graph.removeLabel (see bot.syncMarkLabel), so a dashboard write propagates to Messenger
// and comes back as the same mark — the two never diverge, so trusting Messenger here
// cannot flip-flop a mark a staffer just set on the dashboard.
//
// Guarded so it does NOTHING without a Page token/Meta config, so local `node --test`
// and dev never hit the network.

const { DESK_MARKS } = require('./ops');

function configured(cfg) {
  if (!cfg || cfg.labelSyncEnabled === false) return false;
  const hasToken = Boolean(cfg.pageAccessToken)
    || (Array.isArray(cfg.pages) && cfg.pages.some((p) => p && p.token));
  return hasToken;
}

// The exact Messenger label text for a mark. followUp mirrors BOOKED_LABEL so a custom
// BOOKED_LABEL stays consistent with the booking auto-hook; others use their metaLabel.
function metaLabelFor(mark, cfg) {
  if (!mark) return '';
  if (mark.id === 'followUp') return String((cfg && cfg.bookedLabel) || mark.metaLabel || '').trim();
  return String(mark.metaLabel || '').trim();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LabelSync {
  constructor({ cfg, store, graph, bot = null, log = null, now = () => Date.now() } = {}) {
    this.cfg = cfg || {};
    this.store = store;
    this.graph = graph;
    this.bot = bot;
    this.log = log;
    this.now = now;
    this.running = null;
  }

  enabled() {
    return configured(this.cfg);
  }

  intervalMs() {
    return Math.max(30000, Number(this.cfg.labelSyncIntervalMs) || 150000);
  }

  // The threads worth polling this cycle: recent/active within the lookback window, most
  // recent first, capped to bound the number of Graph calls per cycle.
  recentThreads(now = this.now()) {
    const lookbackMs = Math.max(1, Number(this.cfg.labelSyncLookbackDays) || 30) * 86400000;
    const cutoff = now - lookbackMs;
    const cap = Math.max(1, Number(this.cfg.labelSyncMaxPerCycle) || 200);
    const rows = [];
    const threads = (this.store && this.store.data && this.store.data.threads) || {};
    for (const [key, thread] of Object.entries(threads)) {
      if (!thread) continue;
      const psid = String(thread.psid || (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key) || '');
      if (!psid) continue;
      const active = Number(thread.lastUserTs || thread.lastHumanEchoAt || 0);
      if (active && active < cutoff) continue;
      rows.push({ key, thread, psid, active });
    }
    rows.sort((a, b) => (b.active || 0) - (a.active || 0));
    return rows.slice(0, cap);
  }

  // Whether a mark is currently on for a PSID, reading defensively.
  markOn(psid, markId) {
    const t = (this.store.findThread && this.store.findThread(psid)) || ((this.store.data.threads || {})[psid]);
    const marks = (t && t.marks) || {};
    return Boolean(marks[markId] && marks[markId].on === true);
  }

  async sync() {
    if (!this.enabled()) return { ok: false, reason: 'off' };
    if (this.running) return this.running;
    this.running = this.run()
      .catch((e) => {
        if (this.log) this.log.warn(`label sync failed: ${e.message}`);
        return { ok: false, reason: 'error' };
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    const now = this.now();
    const throttle = Math.max(0, Number(this.cfg.labelSyncThrottleMs) || 0);
    const rows = this.recentThreads(now);
    let scanned = 0;
    let changed = 0;
    for (const { psid } of rows) {
      try {
        const labels = await this.graph.listUserLabels(psid); // [{ id, name }] or []
        const names = new Set((labels || [])
          .map((l) => String((l && l.name) || '').trim())
          .filter(Boolean));
        for (const mark of DESK_MARKS) {
          const metaLabel = metaLabelFor(mark, this.cfg);
          if (!metaLabel) continue; // only reconcile marks backed by a Messenger label
          const present = names.has(metaLabel);
          if (present !== this.markOn(psid, mark.id)) {
            // Messenger is authoritative: set or clear the mark to match the inbox label.
            this.store.setMark(psid, mark.id, present, '', now);
            changed += 1;
          }
        }
        scanned += 1;
      } catch (e) {
        // A single thread failing must not abort the cycle.
        if (this.log) this.log.warn(`label sync thread …${String(psid).slice(-4)} failed: ${e.message}`);
      }
      if (throttle) await delay(throttle);
    }
    if (this.store && this.store.data) this.store.data.lastLabelSyncAt = new Date(now).toISOString();
    if (this.log) this.log.info(`label sync scanned=${scanned} changed=${changed} of=${rows.length}`);
    return { ok: true, scanned, changed, considered: rows.length };
  }
}

module.exports = { LabelSync, configured, metaLabelFor };
