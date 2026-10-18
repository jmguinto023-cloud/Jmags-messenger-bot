'use strict';
// Core logic: turns Messenger webhook events into Ivan-style replies, handoffs, or follow-ups.
const { parseHandoff } = require('./llm');
const lines = require('./messages');
const { sanitizeOutgoing, bookingFormMessage } = lines;
const { short } = require('./log');
const { psidHash } = require('./store');
const { candidateInboxUrls } = require('./inbox-link');
const { summarizeConversation } = require('./summary');
const { quietDeferUntil, videoFollowupText } = require('./video-followup');
const { updateIntake, intakeContext, applyReplyGuard, CLOSE_LINE } = require('./intake');
const { mediaReceivedNote, applyCustomerGuard, asksCheckupFee, CHECKUP_FEE_PLAIN } = require('./estimate');
const {
  reviewPending, asksReviewStatus, isUnclearDuringReview, mentionsOldBooking,
  visibleHistory, PENDING_REVIEW_STATUS, REVIEW_CLARIFY, guardStaleReply,
} = require('./recency');
const crypto = require('node:crypto');

// Model sometimes emits [HANDOFF: Customer ready to book] instead of the form.
function isBookingIntentHandoff(reason) {
  return /ready to book|wants to book|agreed to (the )?price|asked to (be )?schedul|gave a (date|time)|booking intent|pa-book|pa-schedule/i.test(reason || '');
}

function isFilledUp(text) {
  return /na-?fill|filled(?: it up)?|\bdone\b|submitted|tapos na|na fill/i.test(text || '');
}

// These stops mean we chose not to message. The generic follow-up must not send instead.
function videoFollowupHoldsGeneric(t) {
  return t.videoFollowupStopped === 'quiet hours past the 24h window'
    || t.videoFollowupStopped === 'outside 24h messaging window';
}

// Business Suite saved/instant replies, greetings and away messages JMAG's has set up.
const AUTOMATED_ECHO_RE = [
  /welcome sa jmag/i,
  /unit\s*\/\s*brand\s*:/i,
  /unit size\s*:/i,
  /ask ko lang po (kung ano ang brand|mga sumusunod)/i,
  /thanks for (contacting|messaging|reaching out)/i,
  /we('| a)re (currently )?away|we will get back to you|we'll get back to you/i,
];
function isAutomatedEchoText(text, extra = []) {
  const s = String(text || '');
  if (!s) return false;
  if (AUTOMATED_ECHO_RE.some((re) => re.test(s))) return true;
  return extra.some((p) => { try { return new RegExp(p, 'i').test(s); } catch { return false; } });
}

function isCannedLine(text) {
  return text === lines.fallback || text === lines.holding || text === lines.holdingMedia || text === lines.holdingPerson;
}

function latestUserText(thread) {
  const users = (thread.history || []).filter((h) => h.role === 'user');
  return users.length ? users[users.length - 1].content : '';
}

function mediaStatus(thread) {
  const notes = thread.mediaNotes || [];
  if (!notes.length) return '';
  return `${notes.slice(-5).join(' ')} NEVER say a video or photo was not received. NEVER ask the customer to send it again.`;
}

function mediaKind(items) {
  if (!items || !items.length) return '';
  return items.some((m) => m.type === 'video') ? 'video' : 'photo';
}

function mediaNote(kind, ts, tz) {
  return kind ? mediaReceivedNote(kind, ts, tz) : '';
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
    this.rev = new Map(); // bumps when a new customer message should be included in the reply
    this.repliedRev = new Map(); // last revision we already answered
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
          media.push({ type: a.type, url: (a.payload && a.payload.url) || '', mid: (ev.message && ev.message.mid) || '' });
        } else if (a.type === 'audio' || a.type === 'file') {
          forceReason = forceReason || `customer sent ${a.type}`;
        } else if (!text) text = `[customer sent a ${a.type}]`;
      }
    } else if (ev.postback) {
      text = ev.postback.title || ev.postback.payload || '';
    } else {
      return; // other event types (optins, referrals without text, etc.)
    }

    const spoken = text;
    const ts = Number(ev.timestamp) || this.now();
    const kind = mediaKind(media);
    const note = mediaNote(kind, ts, this.cfg.timezone);
    if (note) text = text ? `${text}\n${note}` : note;
    const logText = forceReason ? `${text ? text + ' ' : ''}[${forceReason}]` : text;
    if (!logText) return;
    this.store.addTurn(psid, 'user', logText, ts);

    const t = this.store.thread(psid);
    // A new customer message ends a closed video follow-up, so a later silence
    // can use the normal quiet-customer nudge again.
    if (t.videoFollowupStopped && !(t.videoReplyAt && ts > t.videoReplyAt)) {
      t.videoFollowupStopped = '';
      this.store.save();
    }
    if (t.videoReplyAt && ts > t.videoReplyAt) this.stopVideoFollowup(psid, 'customer replied');
    if (note) {
      t.mediaNotes = t.mediaNotes || [];
      t.mediaNotes.push(note);
      if (t.mediaNotes.length > 8) t.mediaNotes.splice(0, t.mediaNotes.length - 8);
      t.problemViaVideo = true;
      t.awaitingVideo = false;
    }
    if (media.length) {
      t.pendingMedia = [...(t.pendingMedia || []), ...media];
      t.attachmentNote = note;
      t.awaitingVideo = false;
    }
    if (isStandby) {
      t.standby = true;
      this.stopVideoFollowup(psid, 'standby, another app owns the thread');
      await this.publishPendingMedia(psid, { quiet: true });
      return this.onStandby(psid, t);
    }
    t.standby = false;
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
      if (/paused:|handed off/i.test(block)) await this.publishPendingMedia(psid, { quiet: true });
      t.pendingMedia = []; t.attachmentNote = '';
      this.log.info(`no reply to ${short(psid)}: ${block}`);
      return;
    }

    if (!forceReason) {
      // "bot ka ba? / tao ka ba?" is a question about the bot – let the AI answer honestly instead.
      const askingIfBot = /\b(ka ba|bot|robot|ai|automated)\b/i.test(spoken);
      const kw = askingIfBot ? null : keywordHit(spoken, this.cfg.handoffKeywords);
      if (kw) forceReason = `asked for a person (keyword "${kw}")`;
    }
    if (forceReason) {
      this.bump(psid); // drop an in-flight AI reply; this handoff is the one response
      this.cancelPending(psid);
      const holding = forceReason.startsWith('customer sent') ? lines.holdingMedia : lines.holdingPerson;
      return this.enqueue(psid, async () => {
        await this.flagPendingMedia(psid);
        return this.handoff(psid, forceReason, holding);
      });
    }
    // Text and attachments share one debounce. A later attachment resets the timer
    // instead of starting its own reply.
    this.bump(psid);
    this.queueText(psid, ts);
  }

  bump(psid) {
    const n = (this.rev.get(psid) || 0) + 1;
    this.rev.set(psid, n);
    return n;
  }

  async onStandby(psid, t) {
    const age = this.now() - (t.handoffAt || 0);
    const stale = this.cfg.handoffResumeHours > 0 && t.handoffAt && age > this.cfg.handoffResumeHours * HOUR;
    // A fresh handoff stays with the Page Inbox. Otherwise try to take the thread back.
    if (!t.handedOff || stale) {
      try {
        await this.graph.takeThreadControl(psid, 'Customer message while standby');
        this.log.info(`take_thread_control ok for ${short(psid)}`);
      } catch (e) {
        this.log.warn(`take_thread_control failed for ${short(psid)} (routing may be off, #27 is ok): ${e.message}`);
      }
    }
    this.log.info(`standby msg from ${short(psid)} (another app owns thread) – no reply`);
  }

  // Why the bot must stay quiet for this customer right now (or '' if it may reply).
  blockReason(psid, t, ts) {
    const now = this.now();
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) return 'not in BOT_TEST_PSIDS allowlist';
    if (t.handedOff) return `handed off to Ivan (${t.handoffReason})`;
    if (this.humanPaused(t, now)) return 'paused: a human replied recently';
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
    return this.publishPendingMedia(psid, { quiet: false });
  }

  // Save photo/video cards and push, including when the bot must stay silent.
  // The same message mid is stored once.
  async publishPendingMedia(psid, { quiet = false } = {}) {
    const t = this.store.thread(psid);
    const queued = t.pendingMedia || [];
    t.pendingMedia = [];
    if (!queued.length) return;
    const seenMid = new Set((this.store.data.reviews || []).map((r) => r.mid).filter(Boolean));
    const items = queued.filter((m) => !m.mid || !seenMid.has(m.mid));
    this.store.save();
    if (!items.length) return;
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
    const summary = summarizeConversation(t.history);
    let customerName = '';
    try { customerName = await this.graph.userName(psid); } catch { customerName = ''; }
    const convo = await this.graph.findConversation(psid);
    if (!customerName && convo && convo.name) customerName = convo.name;
    for (const m of items) {
      const type = m.type === 'image' ? 'photo' : m.type;
      this.store.addReview({
        id: crypto.randomBytes(8).toString('hex'),
        timestamp: when,
        psid,
        psidHash: psidHash(psid),
        psidLast4: String(psid).slice(-4),
        customerName,
        summary,
        status: 'new',
        type,
        url: m.url || '',
        snippet,
        conversationId: convo?.id || '',
        conversationLink: convo?.link || '',
        conversationUpdatedTime: convo?.updatedTime || '',
        mid: m.mid || '',
        ...(quiet ? { quietNote: 'bot not replying, standby/paused' } : {}),
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
    for (let attempt = 0; attempt < 4; attempt++) {
      const rev = this.rev.get(psid) || 0;
      if (this.repliedRev.get(psid) === rev) return; // a newer pass already covered these messages
      const t = this.store.thread(psid);
      const block = this.blockReason(psid, t, ts); // re-check: Ivan may have jumped in meanwhile
      if (block) {
        t.pendingMedia = []; t.attachmentNote = '';
        this.log.info(`skip reply to ${short(psid)}: ${block}`);
        return;
      }
      updateIntake(t, '', Boolean((t.pendingMedia || []).length) || t.problemViaVideo);

      const hadMedia = Boolean((t.pendingMedia || []).length);
      const hadVideo = (t.pendingMedia || []).some((m) => m.type === 'video');
      const attachmentNote = t.attachmentNote || '';
      t.attachmentNote = '';
      await this.flagPendingMedia(psid);
      if ((this.rev.get(psid) || 0) !== rev) {
        this.cancelPending(psid);
        this.log.info(`newer message from ${short(psid)} before reply, combining`);
        continue;
      }

      const latestUser = latestUserText(t);
      if (asksCheckupFee(latestUser)) {
        this.repliedRev.set(psid, rev);
        if (hadMedia) await this.sendMediaAck(psid, CHECKUP_FEE_PLAIN, true, { armVideo: hadVideo });
        else await this.send(psid, CHECKUP_FEE_PLAIN);
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }

      if (t.intakeClosed && !t.intakeCloseSent) {
        t.intakeCloseSent = true;
        t.lastAskedTopic = '';
        t.awaitingVideo = false;
        if (hadMedia) t.lastMediaAckAt = this.now();
        this.repliedRev.set(psid, rev);
        await this.send(psid, CLOSE_LINE, { armVideo: hadVideo });
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }

      if (reviewPending(t) && asksReviewStatus(latestUser)) {
        this.repliedRev.set(psid, rev);
        await this.send(psid, PENDING_REVIEW_STATUS, { armVideo: hadVideo });
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }
      if (reviewPending(t) && isUnclearDuringReview(latestUser)) {
        this.repliedRev.set(psid, rev);
        await this.send(psid, REVIEW_CLARIFY, { armVideo: hadVideo });
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }

      this.graph.typingOn(psid).catch((e) => this.log.warn('typing_on failed', e.message));
      let raw;
      const modelHistory = visibleHistory(t.history, this.now(), {
        keepOldTopic: mentionsOldBooking(latestUser),
        pendingReview: reviewPending(t),
      });
      try {
        raw = await this.llm.reply(modelHistory, {
          nowText: this.nowText(),
          attachmentNote,
          intakeNote: intakeContext(t),
          mediaStatus: mediaStatus(t),
        });
      } catch (e) {
        if ((this.rev.get(psid) || 0) !== rev) continue;
        if (hadMedia) {
          this.log.error(`LLM failed for media from ${short(psid)} (staying in chat):`, e.message);
          this.repliedRev.set(psid, rev);
          await this.sendMediaAck(psid, lines.mediaAck, hadMedia, { armVideo: hadVideo });
          return;
        }
        const status = Number(e.status) || 0;
        if (status >= 400 && status < 500) {
          this.log.error(`LLM config error for ${short(psid)}: HTTP ${status} (not handing off). ${e.message}`);
          this.repliedRev.set(psid, rev);
          return this.send(psid, lines.fallback);
        }
        this.log.error(`LLM failed for ${short(psid)}:`, e.message);
        t.fallbackCount = (t.fallbackCount || 0) + 1;
        this.repliedRev.set(psid, rev);
        if (t.fallbackCount >= 2) return this.handoff(psid, 'AI unavailable twice', lines.holding);
        return this.send(psid, lines.fallback);
      }
      if ((this.rev.get(psid) || 0) !== rev) {
        this.cancelPending(psid);
        this.log.info(`discarding in-flight reply for ${short(psid)}; a newer message arrived`);
        continue;
      }
      t.fallbackCount = 0;
      const { text, handoff, reason } = parseHandoff(raw);
      if (this.blockReason(psid, t, ts)) return; // human took over while AI was thinking
      const guarded = guardStaleReply(
        t,
        applyCustomerGuard(t, applyReplyGuard(t, text), latestUserText(t)),
        latestUserText(t),
      );
      this.repliedRev.set(psid, rev);
      // A photo or video never passes the thread. A keyword in the caption already handed off above.
      if (hadMedia && !t.intakeCloseSent) {
        await this.sendMediaAck(psid, guarded, true, { armVideo: hadVideo });
      } else if (hadMedia) {
        await this.send(psid, guarded, { armVideo: hadVideo });
        t.awaitingVideo = false;
      } else if (guarded === CLOSE_LINE || (t.intakeClosed && t.intakeCloseSent && guarded === CLOSE_LINE)) {
        await this.send(psid, guarded);
      } else {
        const formUrl = this.cfg.bookingFormUrl;
        const formAlreadySent = formUrl && t.history.some((h) => h.role === 'assistant' && h.content.includes(formUrl));
        if (formUrl && text.includes(formUrl)) await this.send(psid, text);
        else if (handoff && formUrl && !formAlreadySent && isBookingIntentHandoff(reason)) await this.send(psid, bookingFormMessage(formUrl));
        else if (handoff && guarded === text) await this.handoff(psid, reason || 'model', text || lines.holding);
        else await this.send(psid, guarded);
      }
      if ((this.rev.get(psid) || 0) !== rev) continue;
      return;
    }
  }

  // One technician acknowledgement per short burst of attachments, not one per file.
  async sendMediaAck(psid, text, hadMedia, opts = {}) {
    const t = this.store.thread(psid);
    const windowMs = Math.max(this.cfg.batchWindowMs || 0, 60 * 1000);
    const recent = t.lastMediaAckAt && this.now() - t.lastMediaAckAt < windowMs;
    const body = recent ? sanitizeOutgoing(text) : mediaReply(text);
    if (hadMedia && !recent) t.lastMediaAckAt = this.now();
    t.awaitingVideo = false;
    await this.send(psid, body || lines.mediaAck, opts);
    t.awaitingVideo = false;
  }

  async send(psid, text, opts = {}) {
    const clean = sanitizeOutgoing(text);
    if (!clean) { this.log.warn(`empty reply to ${short(psid)} after sanitize`); return; }
    await this.graph.sendText(psid, clean);
    const t = this.store.thread(psid);
    if (this.cfg.bookingFormUrl && clean.includes(this.cfg.bookingFormUrl)) t.bookingFormSent = true;
    if (opts.videoFollowup) {
      // This nudge talks about the video they already sent. It is not a request for another one.
    } else if (t.problemViaVideo || t.intakeClosed || opts.tips) t.awaitingVideo = false;
    else if (/\bvideo\b/i.test(clean)) t.awaitingVideo = true;
    // Canned fallback/holding lines are not part of the chat the model sees,
    // or the next reply continues them ("Pasensya na po... Nandito pa po ako").
    // They are still appended to the conversation export.
    this.store.addTurn(psid, 'assistant', clean, this.now(), {
      history: !isCannedLine(clean),
      handoffReason: t.handoffReason || '',
    });
    this.log.info(`replied to ${short(psid)} (${clean.length} chars)`);
    if (opts.armVideo) this.armVideoFollowup(psid);
    if (!opts.tips && clean === sanitizeOutgoing(CLOSE_LINE)) await this.sendTipsOnce(psid);
  }

  async sendTipsOnce(psid) {
    const t = this.store.thread(psid);
    if (t.tipsSent) return;
    const tips = sanitizeOutgoing(this.cfg.tipsMessage || '');
    if (!tips) return;
    t.tipsSent = true;
    t.awaitingVideo = false;
    this.store.save();
    await this.send(psid, tips, { tips: true });
  }

  async handoff(psid, reason, holdingText) {
    const t = this.store.thread(psid);
    if (t.handedOff) return;
    t.handedOff = true; t.handoffAt = this.now(); t.handoffReason = reason; t.passedByBot = true;
    this.stopVideoFollowup(psid, 'handed to Ivan');
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
    const t = this.store.thread(psid);
    const at = Number(ev.timestamp) || this.now();
    // Meta's own inbox automation, not a person typing in Page Inbox.
    if (appId && (this.cfg.pageAiAppIds || []).includes(appId)) {
      if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
      this.store.save();
      this.log.info(`page AI echo for ${short(psid)} app_id=${appId} – not pausing`);
      return;
    }
    // Saved reply / instant reply / greeting / away message / Meta AI from the Page Inbox app.
    const auto = this.automatedEchoReason(t, m, at);
    if (auto) {
      t.lastAutoEchoAt = at;
      if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
      this.store.save();
      this.log.info(`automated echo for ${short(psid)} app_id=${appId || 'none'} (${auto}) – not pausing`);
      return;
    }
    // A person (Ivan) replied from the Page: pause the bot here.
    t.pausedUntil = this.now() + this.cfg.humanPauseHours * HOUR;
    t.lastHumanEchoAt = this.now();
    t.pauseSource = `human echo app_id=${appId || 'none'}`;
    this.stopVideoFollowup(psid, 'paused for a human');
    if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
    this.cancelPending(psid);
    this.store.save();
    this.log.info(`human reply detected for ${short(psid)} app_id=${appId || 'none'} – bot paused ${this.cfg.humanPauseHours}h`);
  }

  // Why a Page echo is an automation rather than Ivan typing ('' = treat as human).
  automatedEchoReason(t, m, at) {
    if (isAutomatedEchoText(m.text, this.cfg.automatedEchoPatterns)) return 'automated template text';
    const win = this.cfg.automatedEchoWindowMs;
    if (win > 0 && t.lastUserTs && at >= t.lastUserTs && at - t.lastUserTs <= win) return `sent ${Math.round((at - t.lastUserTs) / 1000)}s after the customer`;
    if (win > 0 && t.lastAutoEchoAt && at >= t.lastAutoEchoAt && at - t.lastAutoEchoAt <= win) return 'follows an automated echo';
    return '';
  }

  // Human pause still in force? Ends early when Ivan has gone quiet (HUMAN_IDLE_RESUME_HOURS).
  humanPaused(t, now = this.now()) {
    if (!t.pausedUntil || now >= t.pausedUntil) return false;
    const idle = this.cfg.humanIdleResumeHours;
    if (idle > 0) {
      const last = t.lastHumanEchoAt || (t.pausedUntil - this.cfg.humanPauseHours * HOUR);
      if (now - last > idle * HOUR) {
        t.pausedUntil = 0; t.pauseSource = '';
        this.store.save();
        return false;
      }
    }
    return true;
  }

  // Startup: clear pauses that older code set from automated echoes (template text or an
  // echo seconds after the customer). Returns the psids cleared.
  clearAutomatedPauses() {
    const cleared = [];
    const now = this.now();
    for (const [psid, t] of Object.entries(this.store.data.threads || {})) {
      if (!t.pausedUntil || now >= t.pausedUntil || t.lastHumanEchoAt) continue;
      const start = t.pausedUntil - this.cfg.humanPauseHours * HOUR;
      const hist = t.history || [];
      const trigger = hist.filter((h) => h.role === 'assistant' && Math.abs(h.ts - start) <= 2000);
      if (!trigger.length) continue;
      const users = hist.filter((h) => h.role === 'user' && h.ts <= start);
      const lastUser = users.length ? users[users.length - 1].ts : 0;
      const win = this.cfg.automatedEchoWindowMs;
      const auto = trigger.every((h) => isAutomatedEchoText(h.content, this.cfg.automatedEchoPatterns)
        || (win > 0 && lastUser && start - lastUser <= win));
      if (!auto) continue;
      t.pausedUntil = 0; t.pauseSource = '';
      cleared.push(psid);
      this.log.info(`cleared automated-echo pause for ${short(psid)}`);
    }
    if (cleared.length) this.store.save();
    return cleared;
  }

  // Admin: threads the bot is currently silent in.
  pausedThreads() {
    const now = this.now();
    return Object.entries(this.store.data.threads || {})
      .filter(([, t]) => t.handedOff || (t.pausedUntil && now < t.pausedUntil))
      .map(([psid, t]) => ({
        psid, last4: String(psid).slice(-4), handedOff: Boolean(t.handedOff), handoffReason: t.handoffReason || '',
        pausedUntil: t.pausedUntil ? new Date(t.pausedUntil).toISOString() : '', pauseSource: t.pauseSource || '',
      }));
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
      this.stopVideoFollowup(psid, 'handed to Ivan');
      this.cancelPending(psid);
      this.log.info(`thread control moved to ${newOwner} for ${short(psid)} – bot silent`);
    }
    this.store.save();
  }

  videoFollowupMax() {
    return this.cfg.videoFollowup2Minutes > 0 ? 2 : 1;
  }

  videoFollowupDueAt(t) {
    const count = t.videoFollowupCount || 0;
    const first = (t.videoReplyAt || 0) + this.cfg.videoFollowupMinutes * 60 * 1000;
    const due = count === 0
      ? first
      : (t.videoFollowupAt || t.videoReplyAt || 0) + this.cfg.videoFollowup2Minutes * 60 * 1000;
    return t.videoFollowupNotBefore > due ? t.videoFollowupNotBefore : due;
  }

  armVideoFollowup(psid) {
    const t = this.store.thread(psid);
    if (t.handedOff || t.standby) return;
    t.videoReplyAt = this.now();
    t.videoFollowupCount = 0;
    t.videoFollowupAt = 0;
    t.videoFollowupStopped = '';
    t.videoFollowupNotBefore = 0;
    this.store.save();
    this.log.info(`video follow-up scheduled for ${short(psid)} in ${this.cfg.videoFollowupMinutes}m`);
  }

  stopVideoFollowup(psid, reason) {
    const t = this.store.thread(psid);
    if (!t.videoReplyAt) return;
    t.videoReplyAt = 0;
    t.videoFollowupStopped = reason;
    this.store.save();
    this.log.info(`video follow-up skipped for ${short(psid)}: ${reason}`);
  }

  async maybeVideoFollowUp(psid, t, now) {
    if (!t.videoReplyAt) return;
    if ((t.videoFollowupCount || 0) >= this.videoFollowupMax()) return;
    if (t.videoFollowupPending) return;
    if (now < this.videoFollowupDueAt(t)) return;

    const windowMs = this.cfg.replyWindowHours * HOUR;
    const lastUser = t.lastUserTs || 0;
    const tz = this.cfg.timezone || 'Asia/Manila';
    let skip = '';
    if (!this.cfg.botEnabled) skip = 'BOT_ENABLED is off';
    else if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) skip = 'not in BOT_TEST_PSIDS allowlist';
    else if (t.handedOff) skip = 'handed to Ivan';
    else if (t.standby) skip = 'standby, another app owns the thread';
    else if (this.humanPaused(t, now)) skip = 'paused for a human';
    else if (lastUser > t.videoReplyAt) skip = 'customer replied';
    else if (!lastUser || now - lastUser > windowMs) skip = 'outside 24h messaging window';
    else {
      const last = (t.history || [])[(t.history || []).length - 1];
      if (!last || last.role !== 'assistant') skip = 'customer spoke last';
    }
    if (skip) {
      this.stopVideoFollowup(psid, skip);
      return;
    }

    const quietUntil = quietDeferUntil(now, tz);
    if (quietUntil > now) {
      if (quietUntil - lastUser > windowMs) {
        this.stopVideoFollowup(psid, 'quiet hours past the 24h window');
        return;
      }
      if (t.videoFollowupNotBefore !== quietUntil) {
        t.videoFollowupNotBefore = quietUntil;
        this.store.save();
        this.log.info(`video follow-up deferred for ${short(psid)} until 07:00 Asia/Manila`);
      }
      return;
    }

    t.videoFollowupPending = true;
    this.store.save();
    try {
      const fresh = this.store.thread(psid);
      if (!fresh.videoReplyAt || !this.cfg.botEnabled || fresh.handedOff || fresh.standby || this.humanPaused(fresh, this.now())) {
        this.log.info(`video follow-up skipped for ${short(psid)}: state changed`);
        return;
      }
      if ((fresh.lastUserTs || 0) > fresh.videoReplyAt) {
        this.stopVideoFollowup(psid, 'customer replied');
        return;
      }
      const second = (fresh.videoFollowupCount || 0) >= 1;
      await this.send(psid, videoFollowupText(fresh, { second }), { videoFollowup: true });
      fresh.videoFollowupCount = (fresh.videoFollowupCount || 0) + 1;
      fresh.videoFollowupAt = this.now();
      fresh.videoFollowupNotBefore = 0;
      this.store.save();
      this.log.info(`video follow-up ${fresh.videoFollowupCount} sent to ${short(psid)}`);
    } catch (e) {
      this.log.error(`video follow-up failed for ${short(psid)}:`, e.message);
    } finally {
      const row = this.store.thread(psid);
      row.videoFollowupPending = false;
      this.store.save();
    }
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
      const afterMs = this.cfg.followupAfterMin * 60 * 1000;
      const day = 24 * HOUR;
      const windowMs = 23 * HOUR;
      const now = this.now();
      for (const [psid, t] of Object.entries(this.store.data.threads)) {
        try {
          await this.maybeVideoFollowUp(psid, t, now);
          if (max > 0) await this.maybeFollowUp(psid, this.store.thread(psid), { now, max, afterMs, day, windowMs });
        } catch (e) { this.log.error(`follow-up error for ${short(psid)}:`, e.message); }
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
    if (t.intakeCloseSent || t.tipsSent) return 'intake closed, waiting on the technician';
    if (t.handedOff) return 'handed off';
    if (t.videoReplyAt) return 'video follow-up still open';
    // Giving up because 7 AM (or now) is outside Meta's window must not fall
    // through to the generic nudge, which has no quiet hours.
    if (videoFollowupHoldsGeneric(t)) return 'video follow-up closed without a send';
    if (this.humanPaused(t, now)) return 'paused for a human';
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
      const followHistory = visibleHistory(t.history, this.now(), { pendingReview: reviewPending(t) });
      const raw = await this.llm.followUp(followHistory, { nowText: this.nowText(), videoMissing: Boolean(t.awaitingVideo) });
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

  // Fill conversation id/link for reviews saved before a lookup succeeded.
  async hydrateReviewConversations() {
    const rows = this.store.data.reviews || [];
    let changed = false;
    for (const row of rows) {
      if (!row || !row.psid) continue;
      const needsId = !row.conversationId;
      const needsName = !String(row.customerName || '').trim();
      if (!needsId && !needsName) continue;
      const found = await this.graph.findConversation(row.psid);
      if (!found) continue;
      if (needsId && found.id) {
        row.conversationId = found.id;
        row.conversationLink = found.link || '';
        row.conversationUpdatedTime = found.updatedTime || '';
        changed = true;
      }
      if (needsName && found.name) {
        row.customerName = found.name;
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  // Admin: every id and candidate inbox URL for one PSID. Does not change the thread.
  async inboxCandidates(psid) {
    const key = String(psid || '').trim();
    const pageId = this.cfg.pageId || '';
    let profileName = '';
    let conversation = null;
    let business = null;
    const errors = [];
    try {
      profileName = await this.graph.userName(key);
    } catch (e) {
      errors.push(e.message);
    }
    const found = await this.graph.findConversation(key);
    if (found) {
      conversation = {
        id: found.id,
        link: found.link,
        updatedTime: found.updatedTime,
        name: found.name || '',
        participants: found.participants || [],
      };
    }
    try {
      business = await this.graph.pageBusiness();
    } catch (e) {
      errors.push(e.message);
    }
    const built = candidateInboxUrls({
      pageId,
      businessId: business && business.id,
      psid: key,
      conversationId: conversation && conversation.id,
      link: conversation && conversation.link,
      participants: conversation && conversation.participants,
    });
    return {
      psid: key,
      pageId,
      businessId: (business && business.id) || '',
      businessName: (business && business.name) || '',
      profileName: profileName || (conversation && conversation.name) || '',
      conversation,
      ids: built.ids,
      urls: built.urls,
      errors,
      note: 'The dashboard button opens the inbox list. Try these URLs on a logged-in desktop. The thread-number selected_item_id is the one that redirected to "Sorry, this content isn\'t available right now".',
    };
  }

  // Admin and Meta deletion: drop queued work, then every stored record for this PSID.
  forgetCustomer(psid) {
    const key = String(psid || '');
    this.cancelPending(key);
    this.rev.delete(key);
    this.repliedRev.delete(key);
    this.chains.delete(key);
    return this.store.forget(key);
  }

  // Admin: let the bot answer this customer again.
  resume(psid) {
    const t = this.store.thread(psid);
    t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
    this.store.save();
  }
}

module.exports = { Bot, isActiveNow, keywordHit, isAutomatedEchoText };
