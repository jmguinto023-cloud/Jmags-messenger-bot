'use strict';
// Tiny JSON-file store: one record per customer (PSID). No external database needed.
// Writes are atomic (temp file + rename) and debounced.
const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir, { historyTurns = 20 } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.historyTurns = historyTurns;
    this.data = { threads: {}, seenMids: [] };
    this._timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.threads ||= {};
      this.data.seenMids ||= [];
    } catch (e) {
      console.error('Store load failed, starting empty:', e.message);
    }
  }
  thread(psid) {
    const t = (this.data.threads[psid] ||= {
      history: [], lastUserTs: 0, handedOff: false, handoffAt: 0, handoffReason: '',
      pausedUntil: 0, fallbackCount: 0,
    });
    return t;
  }
  addTurn(psid, role, content, ts = Date.now()) {
    const t = this.thread(psid);
    t.history.push({ role, content, ts });
    const max = this.historyTurns * 2; // a "turn" = customer + reply
    if (t.history.length > max) t.history.splice(0, t.history.length - max);
    if (role === 'user') t.lastUserTs = Math.max(t.lastUserTs || 0, ts);
    this.save();
  }
  // Delete chats with no activity for `days` days (privacy: keep data only as long as needed).
  purge(days, now = Date.now()) {
    if (!days || days <= 0) return 0;
    let removed = 0;
    for (const [psid, t] of Object.entries(this.data.threads)) {
      const last = Math.max(t.lastUserTs || 0, ...(t.history || []).map((h) => h.ts || 0));
      if (now - last > days * 86400e3) { delete this.data.threads[psid]; removed++; }
    }
    if (removed) this.save();
    return removed;
  }
  // Remove one customer's data (deletion request).
  forget(psid) { delete this.data.threads[psid]; this.save(); }
  // Returns true if this message id was already processed (Meta can retry webhooks).
  seen(mid) {
    if (!mid) return false;
    if (this.data.seenMids.includes(mid)) return true;
    this.data.seenMids.push(mid);
    if (this.data.seenMids.length > 1000) this.data.seenMids.splice(0, 200);
    this.save();
    return false;
  }
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 200);
    this._timer.unref?.();
  }
  flush() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Store save failed:', e.message);
    }
  }
}
module.exports = { Store };
