'use strict';
// Core logic: turns Messenger webhook events into Ivan-style replies, handoffs, or follow-ups.
const { parseHandoff } = require('./llm');
const lines = require('./messages');
const { sanitizeOutgoing, bookingFormMessage } = lines;
const { short } = require('./log');
const { psidHash } = require('./store');

// Model sometimes emits [HANDOFF: Customer ready to book] instead of the form.
function isBookingIntentHandoff(reason) {
  return /ready to book|wants to book|agreed to (the )?price|asked to (be )?schedul|gave a (date|time)|booking intent|pa-book|pa-schedule/i.test(reason || '');
}

function isFilledUp(text) {
  return /na-?fill|filled(?: it up)?|\bdone\b|submitted|tapos na|na fill/i.test(text || '');
}

function isCannedLine(text) {
  return text === lines.fallback || text === lines.holding || text === lines.holdingMedia || text === lines.holdingPerson;
}

function mediaKind(items) {
  if (!items || !items.length) return '';
  return items.some((m) => m.type === 'video') ? 'video' : 'photo';
}

function mediaNote(kind) {
  return kind ? `[Customer sent a ${kind}]` : '';
}

// Guarantee the technician acknowledgement even when the model answers with something else.
function mediaReply(text) {
  const clean = sanitizeOutgoing(text);
  if (/ipapacheck|technician|teknisyan/i.test(clean)) return clean;
  return clean ? `${lines.mediaAck}\n${clean}` : lines.mediaAck;
}

const HOUR = 3600 * 1000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function manilaParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: p.weekday.toLowerCase().slice(0, 3), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// "18:00-08:00" or "18:00-23:59,00:00-08:00". Empty = always active.
function isActiveNow(cfg, date = new Date()) {
  if (!cfg.activeHours) return true;
  const { day, minutes } = manilaParts(date, cfg.timezone);
  if (cfg.alwaysOnDays.includes(day)) return true;
  return cfg.activeHours.split(',').some((range) => {
    const m = range.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    const a = Number(m[1]) * 60 + Number(m[2]);
    const b = Number(m[3]) * 60 + Number(m[4]);
    return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b; // overnight range
  });
}

function keywordHit(text, keywords) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return keywords.find((k) => {
    const esc = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9ñ])${esc}([^a-z0-9ñ]|$)`, 'i').test(t);
  });
}

class Bot {
  constructor({ cfg, store, graph, llm, log, push = null, now = () => Date.now() }) {
    Object.assign(this, { cfg, store, graph, llm, log, push, now });
    this.pending = new Map(); // psid -> { texts:[], timer, latestTs }
    this.chains = new Map(); // psid -> promise (keeps one reply at a time per customer)
    this.inflight = new Set();
  }

  // Entry point for a verified webhook body. Never throws.
  handleWebhook(body) {
    if (!body || body.object !== 'page') return;
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) this.safe(() => this.onEvent(ev, false));
      for (const ev of entry.standby || []) this.safe(() => this.onEvent(ev, true));
    }
  }
  safe(fn) {
    try {
      const p = fn();
      if (p && p.catch) { this.inflight.add(p); p.catch((e) => this.log.error('event error', e.message)).finally(() => this.inflight.delete(p)); }
    } catch (e) { this.log.error('event error', e.message); }
  }
  // Wait for all background work (used by tests and graceful shutdown).
  async idle() {
    for (let i = 0; i < 50; i++) {
      const timers = [...this.pending.values()].some((p) => p.timer);
      if (!this.inflight.size && !timers && !this.chains.size) return;
      await new Promise((r) => setTimeout(r, 10));
      await Promise.allSettled([...this.inflight, ...this.chains.values()]);
    }
  }

  async onEvent(ev, isStandby) {
    // Ignore delivery / read receipts and reactions.
    if (ev.delivery || ev.read || ev.reaction) return;

    // Conversation Routing notifications.
    const ctl = ev.pass_thread_control || ev.take_thread_control || ev.request_thread_control || ev.release_thread_control;
    if (ctl) return this.onThreadControl(ev);

    // Echo = a message the Page sent (by this bot, by Ivan in the inbox, or another tool).
    if (ev.message && ev.message.is_echo) return this.onEcho(ev);

    const psid = ev.sender && ev.sender.id;
    if (!psid || psid === this.cfg.pageId) return;

    let text = '';
    let forceReason = '';
    const media = [];
    if (ev.message) {
      if (this.store.seen(ev.message.mid)) return; // webhook retry
      text = ev.message.text || '';
      if (ev.message.quick_reply && ev.message.quick_reply.payload && !text) text = ev.message.quick_reply.payload;
      for (const a of ev.message.attachments || []) {
        if (a.type === 'image' && a.payload && a.payload.sticker_id) { text = text || '👍'; continue; }
        if (a.type === 'image' || a.type === 'video') {
          media.push({ type: a.type, url: (a.payload && a.payload.url) || '' });
        } else if (a.type === 'audio' || a.type === 'file') {
          forceReason = forceReason || `customer sent ${a.type}`;
        } else if (!text) text = `[customer sent a ${a.type}]`;
      }
    } else if (ev.postback) {
      text = ev.postback.title || ev.postback.payload || '';
    } else {
      return; // other event types (optins, referrals without text, etc.)
    }

    const kind = mediaKind(media);
    const note = mediaNote(kind);
    if (note) text = text ? `${text}\n${note}` : note;

    const ts = Number(ev.timestamp) || this.now();
    const logText = forceReason ? `${text ? text + ' ' : ''}[${forceReason}]` : text;
    if (!logText) return;
    this.store.addTurn(psid, 'user', logText, ts);

    if (isStandby) { this.log.info(`standby msg from ${short(psid)} (another app owns thread) – no reply`); return; }

    const t = this.store.thread(psid);
    if (media.length) {
      t.pendingMedia = [...(t.pendingMedia || []), ...media];
      t.attachmentNote = note;
      t.awaitingVideo = false;
    }
    if (t.bookingFormSent && isFilledUp(text)) {
      t.bookingDone = true;
      this.store.save();
    }
    const now = this.now();

    // Mark as done returns the thread without a handover webhook. A normal
    // (non-standby) customer message means we own it again after our own
    // pass_thread_control. Echo pauses are handled separately and stay in place.
    if (t.handedOff && t.passedByBot) {
      t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
      this.store.save();
      this.log.info(`thread back with bot for ${short(psid)} after our handoff – resuming`);
    } else if (t.handedOff && this.cfg.handoffResumeHours > 0 && now - t.handoffAt > this.cfg.handoffResumeHours * HOUR) {
      // Old handoff expired (e.g. returning customer days later).
      t.handedOff = false; t.handoffReason = ''; t.passedByBot = false;
    }
    const block = this.blockReason(psid, t, ts);
    if (block) {
      t.pendingMedia = []; t.attachmentNote = '';
      this.log.info(`no reply to ${short(psid)}: ${block}`);
      return;
    }

    if (!forceReason) {
      // "bot ka ba? / tao ka ba?" is a question about the bot – let the AI answer honestly instead.
      const askingIfBot = /\b(ka ba|bot|robot|ai|automated)\b/i.test(text);
      const kw = askingIfBot ? null : keywordHit(text, this.cfg.handoffKeywords);
      if (kw) forceReason = `asked for a person (keyword "${kw}")`;
    }
    if (forceReason) {
      this.cancelPending(psid);
      const holding = forceReason.startsWith('customer sent') ? lines.holdingMedia : lines.holdingPerson;
      return this.enqueue(psid, async () => {
        await this.flagPendingMedia(psid);
        return this.handoff(psid, forceReason, holding);
      });
    }
    this.queueText(psid, ts);
  }

  // Why the bot must stay quiet for this customer right now (or '' if it may reply).
  blockReason(psid, t, ts) {
    const now = this.now();
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) return 'not in BOT_TEST_PSIDS allowlist';
    if (t.handedOff) return `handed off to Ivan (${t.handoffReason})`;
    if (t.pausedUntil && now < t.pausedUntil) return 'paused: a human replied recently';
    if (!isActiveNow(this.cfg, new Date(now))) return 'outside BOT_ACTIVE_HOURS';
    if (now - (ts || t.lastUserTs) > this.cfg.replyWindowHours * HOUR) return 'outside 24h messaging window';
    return '';
  }

  // Short batching so 3 quick messages get 1 reply instead of 3.
  queueText(psid, ts) {
    const p = this.pending.get(psid) || { timer: null, latestTs: 0 };
    p.latestTs = Math.max(p.latestTs, ts);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      p.timer = null;
      this.pending.delete(psid);
      this.enqueue(psid, () => this.replyWithAI(psid, p.latestTs));
    }, this.cfg.batchWindowMs);
    this.pending.set(psid, p);
  }
  cancelPending(psid) {
    const p = this.pending.get(psid);
    if (p && p.timer) clearTimeout(p.timer);
    this.pending.delete(psid);
  }
  enqueue(psid, fn) {
    const prev = this.chains.get(psid) || Promise.resolve();
    const next = prev.then(fn).catch((e) => this.log.error(`reply error for ${short(psid)}:`, e.message));
    this.chains.set(psid, next);
    next.finally(() => { if (this.chains.get(psid) === next) this.chains.delete(psid); });
    return next;
  }

  nowText() {
    return new Intl.DateTimeFormat('en-PH', { timeZone: this.cfg.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(this.now()));
  }

  async flagPendingMedia(psid) {
    const t = this.store.thread(psid);
    const items = t.pendingMedia || [];
    t.pendingMedia = [];
    if (!items.length) return;
    this.store.save();
    for (const m of items) {
      this.log.warn(`video/photo for Ivan ${short(psid)} type=${m.type} url=${m.url || '(none)'}`);
    }
    const label = this.cfg.needsIvanLabel || 'Video for review';
    try {
      await this.graph.addLabel(psid, label);
    } catch (e) {
      this.log.warn('label failed (optional)', e.message);
    }
    const snippet = String((t.history || []).filter((h) => h.role === 'user').at(-1)?.content || '').slice(0, 200);
    const when = new Date(this.now()).toISOString();
    for (const m of items) {
      const type = m.type === 'image' ? 'photo' : m.type;
      this.store.addReview({
        id: `${when}:${type}:${String(psid).slice(-4)}`,
        timestamp: when,
        psidHash: psidHash(psid),
        psidLast4: String(psid).slice(-4),
        type,
        url: m.url || '',
        snippet,
      }, this.now());
      await this.alertWebhook(psid, { type, url: m.url || '' }, snippet, when);
      if (this.push) {
        try {
          await this.push.notify({
            title: type === 'video' ? 'New video to review' : 'New photo to review',
            body: `…${String(psid).slice(-4)} sent a ${type}`,
            url: '/dashboard',
          });
        } catch (e) { this.log.warn('push notify failed', e.message); }
      }
    }
  }

  async alertWebhook(psid, item, snippet, timestamp) {
    const hook = this.cfg.alertWebhookUrl;
    if (!hook) return;
    const payload = { psid, type: item.type, url: item.url, snippet, timestamp };
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      this.log.warn('alert webhook failed', e.message);
    }
  }

  async replyWithAI(psid, ts) {
    const t = this.store.thread(psid);
    const block = this.blockReason(psid, t, ts); // re-check: Ivan may have jumped in meanwhile
    if (block) {
      t.pendingMedia = []; t.attachmentNote = '';
      this.log.info(`skip reply to ${short(psid)}: ${block}`);
      return;
    }

    const hadMedia = Boolean((t.pendingMedia || []).length);
    const attachmentNote = t.attachmentNote || '';
    t.attachmentNote = '';
    await this.flagPendingMedia(psid);

    this.graph.typingOn(psid).catch((e) => this.log.warn('typing_on failed', e.message));
    let raw;
    try {
      raw = await this.llm.reply(t.history, { nowText: this.nowText(), attachmentNote });
    } catch (e) {
      if (hadMedia) {
        this.log.error(`LLM failed for media from ${short(psid)} (staying in chat):`, e.message);
        await this.send(psid, lines.mediaAck);
        this.store.thread(psid).awaitingVideo = false;
        return;
      }
      const status = Number(e.status) || 0;
      if (status >= 400 && status < 500) {
        this.log.error(`LLM config error for ${short(psid)}: HTTP ${status} (not handing off). ${e.message}`);
        return this.send(psid, lines.fallback);
      }
      this.log.error(`LLM failed for ${short(psid)}:`, e.message);
      t.fallbackCount = (t.fallbackCount || 0) + 1;
      if (t.fallbackCount >= 2) return this.handoff(psid, 'AI unavailable twice', lines.holding);
      return this.send(psid, lines.fallback);
    }
    t.fallbackCount = 0;
    const { text, handoff, reason } = parseHandoff(raw);
    if (this.blockReason(psid, t, ts)) return; // human took over while AI was thinking
    // A photo or video never passes the thread. A keyword in the caption already handed off above.
    if (hadMedia) {
      await this.send(psid, mediaReply(text));
      // The reply may mention the clip. They already sent it, so do not ask again.
      this.store.thread(psid).awaitingVideo = false;
      this.store.save();
      return;
    }
    // The schedule form must go out before any handoff. A [HANDOFF] tag on that
    // same reply used to silence the bot before the customer got the link.
    const formUrl = this.cfg.bookingFormUrl;
    const formAlreadySent = formUrl && t.history.some((h) => h.role === 'assistant' && h.content.includes(formUrl));
    if (formUrl && text.includes(formUrl)) return this.send(psid, text);
    if (handoff && formUrl && !formAlreadySent && isBookingIntentHandoff(reason)) {
      return this.send(psid, bookingFormMessage(formUrl));
    }
    if (handoff) return this.handoff(psid, reason || 'model', text || lines.holding);
    return this.send(psid, text);
  }

  async send(psid, text) {
    const clean = sanitizeOutgoing(text);
    if (!clean) { this.log.warn(`empty reply to ${short(psid)} after sanitize`); return; }
    await this.graph.sendText(psid, clean);
    const t = this.store.thread(psid);
    if (this.cfg.bookingFormUrl && clean.includes(this.cfg.bookingFormUrl)) t.bookingFormSent = true;
    if (/\bvideo\b/i.test(clean)) t.awaitingVideo = true;
    // Canned fallback/holding lines are not part of the chat the model sees,
    // or the next reply continues them ("Pasensya na po... Nandito pa po ako").
    // They are still appended to the conversation export.
    this.store.addTurn(psid, 'assistant', clean, this.now(), {
      history: !isCannedLine(clean),
      handoffReason: t.handoffReason || '',
    });
    this.log.info(`replied to ${short(psid)} (${clean.length} chars)`);
  }

  async handoff(psid, reason, holdingText) {
    const t = this.store.thread(psid);
    if (t.handedOff) return;
    t.handedOff = true; t.handoffAt = this.now(); t.handoffReason = reason; t.passedByBot = true;
    this.store.save();
    this.log.info(`HANDOFF ${short(psid)}: ${reason}`);
    try { await this.send(psid, holdingText); } catch (e) { this.log.error('holding line failed', e.message); }
    try {
      await this.graph.passThreadControl(psid, this.cfg.pageInboxAppId, `Needs Ivan: ${reason}`);
    } catch (e) { this.log.error('pass_thread_control failed', e.message); }
    if (this.cfg.needsIvanLabel) {
      this.graph.addLabel(psid, this.cfg.needsIvanLabel).catch((e) => this.log.warn('label failed (optional)', e.message));
    }
  }

  onEcho(ev) {
    const psid = ev.recipient && ev.recipient.id;
    if (!psid) return;
    const m = ev.message;
    const appId = m.app_id !== undefined && m.app_id !== null ? String(m.app_id) : '';
    if (appId && appId === this.cfg.appId) return; // our own reply
    if (appId && this.cfg.ignoreEchoAppIds.includes(appId)) return;
    if (this.store.seen(m.mid)) return;
    // A person (Ivan) or another tool replied from the Page: pause the bot here.
    const t = this.store.thread(psid);
    t.pausedUntil = this.now() + this.cfg.humanPauseHours * HOUR;
    if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
    this.cancelPending(psid);
    this.store.save();
    this.log.info(`human reply detected for ${short(psid)} (app_id ${appId || 'none'}) – bot paused ${this.cfg.humanPauseHours}h`);
  }

  onThreadControl(ev) {
    const psid = ev.sender && ev.sender.id;
    if (!psid) return;
    const ctl = ev.pass_thread_control || ev.take_thread_control || ev.release_thread_control || ev.request_thread_control;
    const newOwner = ctl && ctl.new_owner_app_id !== undefined ? String(ctl.new_owner_app_id) : '';
    const t = this.store.thread(psid);
    if (newOwner && newOwner === this.cfg.appId) {
      t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
      this.log.info(`thread control returned to bot for ${short(psid)} – auto-reply resumed`);
    } else if (newOwner) {
      t.handedOff = true; t.handoffAt = this.now(); t.handoffReason = t.handoffReason || `control moved to app ${newOwner}`;
      this.cancelPending(psid);
      this.log.info(`thread control moved to ${newOwner} for ${short(psid)} – bot silent`);
    }
    this.store.save();
  }

  // Quiet-customer follow-up. One short LLM line, then at most one more about 24h later,
  // and only while the customer's last message is still inside 23h.
  startFollowups() {
    if (this._followTimer) return;
    const tick = () => { this.checkFollowups().catch((e) => this.log.error('follow-up tick', e.message)); };
    tick();
    this._followTimer = setInterval(tick, 60 * 1000);
    this._followTimer.unref?.();
  }

  async checkFollowups() {
    if (this._followRunning) return;
    this._followRunning = true;
    try {
      const max = this.cfg.followupMax;
      if (!max || max <= 0) return;
      const afterMs = this.cfg.followupAfterMin * 60 * 1000;
      const day = 24 * HOUR;
      const windowMs = 23 * HOUR;
      const now = this.now();
      for (const [psid, t] of Object.entries(this.store.data.threads)) {
        try { await this.maybeFollowUp(psid, t, { now, max, afterMs, day, windowMs }); }
        catch (e) { this.log.error(`follow-up error for ${short(psid)}:`, e.message); }
      }
    } finally {
      this._followRunning = false;
    }
  }

  followUpSkip(psid, t, now, windowMs, { ignorePending = false } = {}) {
    if (!ignorePending && t.followupPending) return 'already sending a follow-up';
    if ((t.followupCount || 0) >= this.cfg.followupMax) return 'follow-up limit reached';
    if (t.bookingDone) return 'booking form already submitted';
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) return 'not in BOT_TEST_PSIDS allowlist';
    if (t.handedOff) return 'handed off';
    if (t.pausedUntil && now < t.pausedUntil) return 'paused for a human';
    if (now - (t.lastUserTs || 0) > windowMs) return 'outside 23h messaging window';
    const last = (t.history || [])[(t.history || []).length - 1];
    if (!last || last.role !== 'assistant') return 'customer spoke last';
    return '';
  }

  async maybeFollowUp(psid, t, { now, max, afterMs, day, windowMs }) {
    const skip = this.followUpSkip(psid, t, now, windowMs);
    if (skip) return;
    const count = t.followupCount || 0;
    if (count >= max) return;
    const last = t.history[t.history.length - 1];
    if (count === 0) {
      if (now - (last.ts || 0) < afterMs) return;
    } else if (now - (t.lastFollowupAt || 0) < day) return;
    t.followupPending = true;
    this.store.save();
    try {
      const raw = await this.llm.followUp(t.history, { nowText: this.nowText(), videoMissing: Boolean(t.awaitingVideo) });
      const { text } = parseHandoff(raw);
      if (!sanitizeOutgoing(text)) return;
      const fresh = this.store.thread(psid);
      if (this.followUpSkip(psid, fresh, this.now(), windowMs, { ignorePending: true })) return;
      await this.send(psid, text);
      fresh.followupCount = (fresh.followupCount || 0) + 1;
      fresh.lastFollowupAt = this.now();
      this.store.save();
      this.log.info(`follow-up ${fresh.followupCount} to ${short(psid)}`);
    } catch (e) {
      this.log.error(`follow-up failed for ${short(psid)}:`, e.message);
    } finally {
      this.store.thread(psid).followupPending = false;
      this.store.save();
    }
  }

  // Admin: let the bot answer this customer again.
  resume(psid) {
    const t = this.store.thread(psid);
    t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
    this.store.save();
  }
}

module.exports = { Bot, isActiveNow, keywordHit };
