'use strict';
// Tiny JSON-file store: one record per customer (PSID). No external database needed.
// Writes are atomic (temp file + rename) and debounced.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONV_KEEP_MS = 60 * 86400e3;

function psidHash(psid) {
  return crypto.createHash('sha256').update(String(psid)).digest('hex').slice(0, 16);
}

class Store {
  constructor(dir, { historyTurns = 20 } = {}) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.convFile = path.join(dir, 'conversations.jsonl');
    this.subsFile = path.join(dir, 'push-subscriptions.json');
    this.historyTurns = historyTurns;
    this.data = { threads: {}, seenMids: [], reviews: [] };
    this._timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.threads ||= {};
      this.data.seenMids ||= [];
      this.data.reviews ||= [];
      for (const t of Object.values(this.data.threads)) t.followupPending = false;
    } catch (e) {
      console.error('Store load failed, starting empty:', e.message);
    }
  }
  thread(psid) {
    const t = (this.data.threads[psid] ||= {
      history: [], lastUserTs: 0, handedOff: false, handoffAt: 0, handoffReason: '',
      pausedUntil: 0, fallbackCount: 0, passedByBot: false,
      followupCount: 0, lastFollowupAt: 0, followupPending: false, awaitingVideo: false,
      bookingFormSent: false, bookingDone: false, pendingMedia: [], attachmentNote: '',
      mediaNotes: [], tipsSent: false, problemViaVideo: false,
    });
    return t;
  }
  addTurn(psid, role, content, ts = Date.now(), opts = {}) {
    const t = this.thread(psid);
    if (opts.history !== false) {
      t.history.push({ role, content, ts });
      const max = this.historyTurns * 2; // a "turn" = customer + reply
      if (t.history.length > max) t.history.splice(0, t.history.length - max);
    }
    if (role === 'user') t.lastUserTs = Math.max(t.lastUserTs || 0, ts);
    this.appendConv({
      timestamp: new Date(ts).toISOString(),
      psidHash: psidHash(psid),
      psidLast4: String(psid).slice(-4),
      role,
      text: String(content ?? ''),
      handoffReason: opts.handoffReason || '',
    });
    this.save();
  }
  appendConv(entry, now = Date.now()) {
    try {
      this.rotateConversations(now);
      fs.appendFileSync(this.convFile, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      console.error('Conversation log failed:', e.message);
    }
  }
  rotateConversations(now = Date.now()) {
    if (!fs.existsSync(this.convFile)) return 0;
    const keepAfter = now - CONV_KEEP_MS;
    const kept = [];
    for (const line of fs.readFileSync(this.convFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (Date.parse(row.timestamp) >= keepAfter) kept.push(line);
      } catch { /* drop corrupt lines */ }
    }
    fs.writeFileSync(this.convFile, kept.length ? `${kept.join('\n')}\n` : '');
    return kept.length;
  }
  readConversations(sinceMs = null) {
    if (!fs.existsSync(this.convFile)) return [];
    const rows = [];
    for (const line of fs.readFileSync(this.convFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        const ts = Date.parse(row.timestamp);
        if (sinceMs == null || ts >= sinceMs) rows.push(row);
      } catch { /* skip */ }
    }
    return rows;
  }
  addReview(review, now = Date.now()) {
    this.data.reviews ||= [];
    const keepAfter = now - CONV_KEEP_MS;
    this.data.reviews = this.data.reviews.filter((r) => Date.parse(r.timestamp) >= keepAfter);
    this.data.reviews.push(review);
    if (this.data.reviews.length > 500) this.data.reviews.splice(0, this.data.reviews.length - 500);
    this.save();
  }
  markReviewed(id, now = Date.now()) {
    const row = (this.data.reviews || []).find((r) => r.id === id);
    if (!row) return false;
    row.status = 'reviewed';
    row.reviewedAt = new Date(now).toISOString();
    this.save();
    return true;
  }
  readSubscriptions() {
    try {
      if (!fs.existsSync(this.subsFile)) return [];
      const list = JSON.parse(fs.readFileSync(this.subsFile, 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  writeSubscriptions(list) {
    const tmp = `${this.subsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, this.subsFile);
  }
  addSubscription(sub) {
    const list = this.readSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
    list.push({ ...sub, savedAt: new Date().toISOString() });
    this.writeSubscriptions(list);
    return list.length;
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
module.exports = { Store, psidHash };
