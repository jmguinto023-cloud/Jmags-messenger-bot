'use strict';
// Core logic: turns Messenger webhook events into Ivan-style replies, handoffs, or follow-ups.
const { parseHandoff } = require('./llm');
const lines = require('./messages');
const { sanitizeOutgoing, capCustomerReply, replyRejected, SAFE_TEMPLATE, nonFlatscreenLine, bookingFormMessage } = lines;
const { short } = require('./log');
const { psidHash } = require('./store');
const { candidateInboxUrls } = require('./inbox-link');
const { summarizeConversation, firstCustomerSnippet, customerLabel, chatCustomerName } = require('./summary');
const { quietDeferUntil, videoFollowupText } = require('./video-followup');
const { activeNow: scheduleActiveNow, nextOpenAt } = require('./schedule');
const {
  ensureOps, noteSuggestion, jobByPsid, asksJobStatus, asksWarrantyProblem,
  inWarranty, warrantyText, jobStatusText, dailyStatusText, DELIVERY_NOTICE, matchIdentity,
  linkCustomer, extractPhone, nameGuess, ASK_BOTH, ASK_NAME, ASK_PHONE, UNSURE,
  manilaStamp,
} = require('./ops');
const { updateIntake, intakeContext, applyReplyGuard, CLOSE_LINE } = require('./intake');
const { hotLeadInfo, HOT_LEAD_WAIT_MS } = require('./ops');
const { mediaReceivedNote, applyCustomerGuard, asksCheckupFee, checkupFeeReply, scriptedReply, CHECKUP_NUDGE } = require('./estimate');
const { quickReply } = require('./quick-replies');
const { ensureHomeVisitFee, HOME_VISIT_FEE_LINE, homeVisitIntent } = require('./home-visit-fee');
const { maybeReplyToTestChallenge } = require('./messenger-test');
const { maybeHandlePrivateChat } = require('./private-test-chat');
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
    this.dashInflight = new Map(); // psid -> { text, promise } so a double-tap sends once
    this.dashRecent = new Map(); // psid -> { text, at } short repeat window after a dashboard send
    this.staffResume = new Map();
  }

  pauseMs() {
    const mins = Number(this.cfg.humanPauseMinutes);
    return (Number.isFinite(mins) && mins >= 0 ? mins : 30) * 60 * 1000;
  }

  staffGraceMs() {
    const mins = Number(this.cfg.staffGraceMinutes);
    return (Number.isFinite(mins) && mins >= 0 ? mins : 5) * 60 * 1000;
  }

  lastHumanAt(t) {
    if (!t) return 0;
    if (t.lastHumanEchoAt) return t.lastHumanEchoAt;
    if (!t.pausedUntil) return 0;
    return t.pausedUntil - this.pauseMs();
  }

  clearStaffResume(psid) {
    if (!this.staffResume) return;
    if (!psid) {
      for (const timer of this.staffResume.values()) clearTimeout(timer);
      this.staffResume.clear();
      return;
    }
    const timer = this.staffResume.get(psid);
    if (timer) clearTimeout(timer);
    this.staffResume.delete(psid);
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
    this.clearStaffResume();
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
    // Private simulation is isolated from the regular Messenger pipeline.
    // All ordinary customer replies remain disabled throughout this test.
    if (await maybeHandlePrivateChat({
      cfg: this.cfg, store: this.store, graph: this.graph, log: this.log,
      psid, text: spoken, ts, now: this.now(), isStandby,
      hasMedia: Boolean(media.length), forceReason,
    })) return;
    // Bypass the regular customer pipeline only for the exact, one-use test phrase.
    // No customer state, history, human-routing or follow-up is touched.
    if (await maybeReplyToTestChallenge({
      cfg: this.cfg, store: this.store, graph: this.graph, log: this.log,
      psid, text: spoken, ts, now: this.now(), isStandby,
      hasMedia: Boolean(media.length), forceReason,
    })) return;
    this.store.addTurn(psid, 'user', logText, ts);

    const t = this.store.thread(psid);
    t.followupFails = 0;
    t.followupNextAt = 0;
    noteSuggestion(this.store, psid);
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
      // Save every photo/video card for review whatever keeps the bot quiet (replies off,
      // outside the schedule, paused, handed off), so JMAG's Operations always gets it.
      await this.publishPendingMedia(psid, { quiet: true });
      t.pendingMedia = []; t.attachmentNote = '';
      this.log.info(`no reply to ${short(psid)}: ${block}`);
      if (block.startsWith('paused') && this.graceStillOpen(t, this.now())) this.scheduleStaffResume(psid);
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
    if (!this.scheduleOpen(now)) return 'outside BOT_SCHEDULE';
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
    const firstMessage = firstCustomerSnippet(t.history);
    const when = new Date(this.now()).toISOString();
    const summary = summarizeConversation(t.history);
    let customerName = '';
    try { customerName = await this.graph.userName(psid); } catch { customerName = ''; }
    const convo = await this.graph.findConversation(psid);
    if (!customerName && convo && convo.name) customerName = convo.name;
    if (!customerName && summary.name) customerName = summary.name;
    const shown = customerLabel(customerName, psid);
    for (const m of items) {
      const type = m.type === 'image' ? 'photo' : m.type;
      const reviewId = crypto.randomBytes(8).toString('hex');
      this.store.addReview({
        id: reviewId,
        timestamp: when,
        psid,
        psidHash: psidHash(psid),
        psidLast4: String(psid).slice(-4),
        customerName,
        firstMessage,
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
      await this.alertWebhook(psid, { type, url: m.url || '' }, snippet, when, {
        id: reviewId,
        customerName,
        firstMessage,
        summary,
        conversationLink: convo?.link || '',
        psidLast4: String(psid).slice(-4),
      });
      if (this.push) {
        try {
          await this.push.notify({
            title: type === 'video' ? 'New video to review' : 'New photo to review',
            body: `${shown} sent a ${type}`,
            url: '/dashboard',
          });
        } catch (e) { this.log.warn('push notify failed', e.message); }
      }
    }
  }

  async alertWebhook(psid, item, snippet, timestamp, extra = {}) {
    const hook = this.cfg.alertWebhookUrl;
    if (!hook) return;
    const payload = { psid, type: item.type, url: item.url, snippet, timestamp, ...extra };
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

  graceStillOpen(t, now) {
    const grace = this.staffGraceMs();
    if (!(grace > 0) || !t || !t.pausedUntil || now >= t.pausedUntil) return false;
    const last = this.lastHumanAt(t);
    return (t.lastUserTs || 0) > last && now - last < grace;
  }

  scheduleStaffResume(psid) {
    const t = this.store.thread(psid);
    const due = this.lastHumanAt(t) + this.staffGraceMs();
    const wait = Math.max(0, due - this.now());
    this.clearStaffResume(psid);
    const timer = setTimeout(() => {
      this.staffResume.delete(psid);
      this.enqueue(psid, () => this.resumeAfterGrace(psid));
    }, wait);
    timer.unref?.();
    this.staffResume.set(psid, timer);
  }

  async resumeAfterGrace(psid) {
    const t = this.store.thread(psid);
    const now = this.now();
    if (t.handedOff || t.standby || this.humanPaused(t, now)) return;
    const last = (t.history || [])[(t.history || []).length - 1];
    if (!last || last.role !== 'user') return;
    if ((t.hotCatchAt || 0) >= (t.lastUserTs || 0)) return;
    const block = this.blockReason(psid, t, t.lastUserTs || now);
    if (block) return;
    t.hotCatchAt = now;
    this.store.save();
    if (this.repliedRev.get(psid) === (this.rev.get(psid) || 0)) this.bump(psid);
    return this.replyWithAI(psid, t.lastUserTs || now);
  }

  // Pull Ivan's Page Inbox lines from the last 7 days so we do not ask again.
  async loadInboxHistory(psid) {
    let rows = [];
    try { rows = await this.graph.recentMessages(psid); } catch (e) {
      this.log.warn('inbox history failed', e.message);
      return;
    }
    if (!rows.length) return;
    const t = this.store.thread(psid);
    const have = new Set((t.history || []).map((h) => `${h.role}|${String(h.content || '').trim()}|${Math.floor((h.ts || 0) / 60000)}`));
    let added = 0;
    for (const row of rows) {
      const key = `${row.role}|${row.content}|${Math.floor(row.ts / 60000)}`;
      if (have.has(key)) continue;
      have.add(key);
      const turn = { role: row.role, content: row.content, ts: row.ts };
      if (row.via) turn.via = row.via;
      t.history.push(turn);
      added += 1;
    }
    if (!added) return;
    t.history.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const max = (this.cfg.historyTurns || 20) * 2;
    if (t.history.length > max) t.history.splice(0, t.history.length - max);
    this.store.save();
  }

  // A weak model writes formal Tagalog essays. Rewrite once, then use a short template.
  async fitModelReply(psid, raw) {
    this.forceProvider = '';
    const parsed = parseHandoff(String(raw || ''));
    if (!replyRejected(parsed.text)) return raw;
    let next = '';
    try {
      next = await this.llm.chat([
        { role: 'system', content: 'Rewrite the draft as 2 or 3 short Messenger lines, under 200 characters. Conversational Taglish with po and sir or maam. Do not restate the customer. No empathy. Do not use inyong, ninyong, iyong, nararanasan, maaari, pasensya na, naiintindihan ko, or nauunawaan. No emoji. If the draft has [HANDOFF: reason], keep that tag on its own last line. Output only the reply.' },
        { role: 'user', content: String(raw).slice(0, 800) },
      ], { priority: 'high' });
      this.log.info(`rewrote long reply for ${short(psid)}`);
    } catch (e) {
      this.log.warn('short rewrite failed', e.message);
    }
    const again = next ? parseHandoff(next) : null;
    if (again && again.text && !replyRejected(again.text)) {
      if (parsed.handoff) return `${again.text}\n[HANDOFF: ${parsed.reason || 'model'}]`;
      return again.text;
    }
    this.forceProvider = 'template';
    if (this.llm) this.llm.lastProvider = '';
    const line = SAFE_TEMPLATE;
    if (parsed.handoff) return `${line}\n[HANDOFF: ${parsed.reason || 'model'}]`;
    return line;
  }

  presentReply(text) {
    if (!text) return text;
    if (text === CLOSE_LINE) return text;
    if (this.cfg.bookingFormUrl && text.includes(this.cfg.bookingFormUrl)) return text;
    // The home-visit fee sentence is required policy. Keep it whole.
    const nudgeAt = String(text).indexOf(CHECKUP_NUDGE);
    if (nudgeAt >= 0) {
      const lead = text.slice(0, nudgeAt).trim();
      return lead ? `${lead}\n${CHECKUP_NUDGE}` : CHECKUP_NUDGE;
    }
    return capCustomerReply(text, 200);
  }

  async replyWithAI(psid, ts) {
    await this.loadInboxHistory(psid);
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
      const scopeLine = nonFlatscreenLine(latestUser);
      if (scopeLine) {
        this.repliedRev.set(psid, rev);
        await this.handoff(psid, 'CRT or non-flatscreen', scopeLine);
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }
      const scripted = scriptedReply(latestUser, t, { allowPrice: !hadMedia && !reviewPending(t) });
      if (scripted) {
        const parsed = parseHandoff(scripted);
        this.repliedRev.set(psid, rev);
        const body = this.presentReply(parsed.text) || lines.holding;
        if (parsed.handoff) await this.handoff(psid, parsed.reason || 'rules', body, { provider: 'rules' });
        else await this.send(psid, body, { provider: 'rules' });
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return;
      }
      if (asksCheckupFee(latestUser)) {
        this.repliedRev.set(psid, rev);
        const checkupAnswer = checkupFeeReply(latestUser, t);
        if (hadMedia) await this.sendMediaAck(psid, checkupAnswer, true, { armVideo: hadVideo });
        else await this.send(psid, checkupAnswer);
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

      if (await this.handleOpsTurn(psid, latestUser, { rev, hadVideo })) {
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

      // Approved zero-token FAQ replies, without overriding media review or human handoff.
      if (this.cfg.aiSmartRulesEnabled && !hadMedia && !reviewPending(t)) {
        const canned = quickReply(latestUser, this.cfg, t);
        if (canned) {
          this.repliedRev.set(psid, rev);
          if (this.blockReason(psid, t, ts)) return;
          await this.send(psid, canned);
          if ((this.rev.get(psid) || 0) !== rev) continue;
          return;
        }
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
        raw = await this.fitModelReply(psid, raw);
      } catch (e) {
        if ((this.rev.get(psid) || 0) !== rev) continue;
        return this.giveUpOnAi(psid, e, { rev, hadMedia, hadVideo });
      }
      if ((this.rev.get(psid) || 0) !== rev) {
        this.cancelPending(psid);
        this.log.info(`discarding in-flight reply for ${short(psid)}; a newer message arrived`);
        continue;
      }
      t.fallbackCount = 0;
      t.aiNeedsIvan = false;
      t.aiHoldingSent = false;
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
        await this.sendMediaAck(psid, this.presentReply(guarded), true, { armVideo: hadVideo });
      } else if (hadMedia) {
        await this.send(psid, this.presentReply(guarded), { armVideo: hadVideo });
        t.awaitingVideo = false;
      } else if (guarded === CLOSE_LINE || (t.intakeClosed && t.intakeCloseSent && guarded === CLOSE_LINE)) {
        await this.send(psid, guarded);
      } else {
        const formUrl = this.cfg.bookingFormUrl;
        const formAlreadySent = formUrl && t.history.some((h) => h.role === 'assistant' && h.content.includes(formUrl));
        if (formUrl && text.includes(formUrl)) await this.send(psid, text);
        else if (handoff && formUrl && !formAlreadySent && isBookingIntentHandoff(reason)) await this.send(psid, bookingFormMessage(formUrl));
        else if (handoff && guarded === text) await this.handoff(psid, reason || 'model', this.presentReply(text) || lines.holding);
        else await this.send(psid, this.presentReply(guarded));
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

  aiOutageReason(e) {
    const status = Number(e && e.status) || 0;
    if (status) return `AI unavailable: HTTP ${status}`;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'AI unavailable: timeout';
    return 'AI unavailable';
  }

  // The canned greeting is never the answer to an AI failure, and never goes out twice.
  async giveUpOnAi(psid, e, { rev, hadMedia, hadVideo }) {
    if (this.llm) this.llm.lastProvider = '';
    this.forceProvider = '';
    const t = this.store.thread(psid);
    const reason = this.aiOutageReason(e);
    this.log.error(`LLM outage for ${short(psid)}: ${reason}. ${e && e.message ? e.message : ''} No canned greeting.`);
    t.aiNeedsIvan = true;
    t.handoffReason = reason;
    this.repliedRev.set(psid, rev);
    this.store.save();
    if (hadMedia) {
      await this.sendMediaAck(psid, lines.mediaAck, true, { armVideo: hadVideo });
      return;
    }
    if (t.aiHoldingSent || t.handedOff) {
      if (!t.handedOff) {
        t.handedOff = true;
        t.handoffAt = this.now();
        t.passedByBot = true;
        this.stopVideoFollowup(psid, 'handed to Ivan');
        this.store.save();
        try { await this.graph.passThreadControl(psid, this.cfg.pageInboxAppId, `Needs Ivan: ${reason}`); }
        catch (err) { this.log.error('pass_thread_control failed', err.message); }
      }
      this.log.error(`LLM outage for ${short(psid)} still down; not sending another holding line`);
      return;
    }
    t.aiHoldingSent = true;
    this.store.save();
    return this.handoff(psid, reason, lines.holding);
  }

  async send(psid, text, opts = {}) {
    const thread = this.store.thread(psid);
    // Ensure the home-visit fee is disclosed on any booking path, including
    // direct booking-form sends and replies generated by models or FAQ rules.
    const withFee = opts.ops || opts.videoFollowup || opts.tips
      ? text : ensureHomeVisitFee(text, latestUserText(thread), thread.history);
    const clean = sanitizeOutgoing(withFee);
    if (!clean) { this.log.warn(`empty reply to ${short(psid)} after sanitize`); return; }
    const existing = this.store.thread(psid);
    if (clean === sanitizeOutgoing(lines.fallback)) {
      if (existing.fallbackSent) {
        this.log.warn(`suppressed repeat fallback greeting for ${short(psid)}`);
        return;
      }
      existing.fallbackSent = true;
      this.store.save();
    }
    await this.graph.sendText(psid, clean);
    const t = this.store.thread(psid);
    if (this.cfg.bookingFormUrl && clean.includes(this.cfg.bookingFormUrl)) t.bookingFormSent = true;
    if (opts.videoFollowup || opts.ops) {
      // A status, warranty, or video follow-up line is not a new request for a video.
    } else if (t.problemViaVideo || t.intakeClosed || opts.tips) t.awaitingVideo = false;
    else if (/\bvideo\b/i.test(clean)) t.awaitingVideo = true;
    // Canned fallback/holding lines are not part of the chat the model sees,
    // or the next reply continues them ("Pasensya na po... Nandito pa po ako").
    // They are still appended to the conversation export.
    const provider = opts.provider != null ? opts.provider : (this.forceProvider || (this.llm && this.llm.lastProvider) || '');
    this.forceProvider = '';
    this.store.addTurn(psid, 'assistant', clean, this.now(), {
      history: !isCannedLine(clean),
      handoffReason: t.handoffReason || '',
      provider,
    });
    this.log.info(`replied to ${short(psid)} (${clean.length} chars)${provider ? ` provider=${provider}` : ''}`);
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

  // Ivan typed this on the video dashboard. One RESPONSE send, then the same
  // pause a human inbox reply would set. The echo of our own app is ignored.
  async replyFromDashboard(reviewId, text) {
    const clean = sanitizeOutgoing(text);
    if (!clean) return { ok: false, status: 400, error: 'Walang laman.' };
    if (clean.length > 2000) return { ok: false, status: 400, error: 'Masyadong mahaba. Max 2000 characters.' };
    const row = (this.store.data.reviews || []).find((r) => r.id === reviewId);
    if (!row || !row.psid) return { ok: false, status: 404, error: 'Hindi makita ang chat.' };
    const psid = row.psid;
    const recent = this.dashRecent.get(psid);
    if (recent && recent.text === clean && this.now() - recent.at < 3000) {
      return { ok: true, status: 200, duplicate: true };
    }
    const inflight = this.dashInflight.get(psid);
    if (inflight && inflight.text === clean) return inflight.promise;
    if (inflight) return { ok: false, status: 409, error: 'Sandali lang, may pinapadala pa.' };
    const t = this.store.thread(psid);
    const last = t.lastUserTs || 0;
    if (!last || this.now() - last > this.cfg.replyWindowHours * HOUR) {
      this.log.info(`dashboard reply skipped for ${short(psid)}: outside 24h`);
      return { ok: false, status: 409, error: 'Lampas na sa 24 oras, i-reply sa Business Suite' };
    }
    const promise = this.deliverDashboardReply(psid, clean);
    this.dashInflight.set(psid, { text: clean, promise });
    try {
      return await promise;
    } finally {
      const cur = this.dashInflight.get(psid);
      if (cur && cur.promise === promise) this.dashInflight.delete(psid);
    }
  }

  async deliverDashboardReply(psid, clean) {
    const sent = await this.graph.sendPageText(psid, clean);
    const mid = sent && sent.message_id;
    if (mid) this.store.seen(mid);
    const now = this.now();
    const t = this.store.thread(psid);
    t.pausedUntil = now + this.pauseMs();
    t.lastHumanEchoAt = now;
    t.pauseSource = 'dashboard reply';
    this.clearStaffResume(psid);
    this.stopVideoFollowup(psid, 'Ivan replied from the dashboard');
    this.cancelPending(psid);
    this.store.addTurn(psid, 'assistant', clean, now, { via: 'ivan' });
    this.store.markIvanReplied(psid, now);
    this.dashRecent.set(psid, { text: clean, at: now });
    this.store.save();
    this.log.info(`dashboard reply to ${short(psid)} (${clean.length} chars) – bot paused ${this.cfg.humanPauseMinutes}m`);
    return { ok: true, status: 200 };
  }

  async handoff(psid, reason, holdingText, sendOpts = {}) {
    const t = this.store.thread(psid);
    if (t.handedOff) return;
    t.handedOff = true; t.handoffAt = this.now(); t.handoffReason = reason; t.passedByBot = true;
    this.stopVideoFollowup(psid, 'handed to Ivan');
    this.store.save();
    this.log.info(`HANDOFF ${short(psid)}: ${reason}`);
    try { await this.send(psid, holdingText, sendOpts); } catch (e) { this.log.error('holding line failed', e.message); }
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
    // Our own Send API call, including a reply Ivan typed on the dashboard.
    // That path already paused the bot and stored the line. Ignoring the echo
    // keeps it from being counted a second time.
    if (appId && appId === this.cfg.appId) return;
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
    t.pausedUntil = this.now() + this.pauseMs();
    t.lastHumanEchoAt = this.now();
    t.pauseSource = `human echo app_id=${appId || 'none'}`;
    this.clearStaffResume(psid);
    this.stopVideoFollowup(psid, 'paused for a human');
    if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now(), { via: 'ivan' });
    this.cancelPending(psid);
    this.store.save();
    this.log.info(`human reply detected for ${short(psid)} app_id=${appId || 'none'} – bot paused ${this.cfg.humanPauseMinutes}m`);
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
    if (!t || !t.pausedUntil || now >= t.pausedUntil) return false;
    const last = this.lastHumanAt(t);
    const idle = Number(this.cfg.humanIdleResumeHours) || 0;
    if (idle > 0 && last && now - last > idle * HOUR) {
      t.pausedUntil = 0; t.pauseSource = '';
      this.store.save();
      return false;
    }
    const grace = this.staffGraceMs();
    if (grace > 0 && (t.lastUserTs || 0) > last && now - last >= grace) return false;
    return true;
  }

  // Startup: clear pauses that older code set from automated echoes (template text or an
  // echo seconds after the customer). Returns the psids cleared.
  clearAutomatedPauses() {
    const cleared = [];
    const now = this.now();
    for (const [psid, t] of Object.entries(this.store.data.threads || {})) {
      if (!t.pausedUntil || now >= t.pausedUntil || t.lastHumanEchoAt) continue;
      const offsets = [...new Set([this.pauseMs(), this.cfg.humanPauseHours * HOUR].filter(Boolean))];
      const hist = t.history || [];
      let start = 0;
      for (const off of offsets) {
        const candidate = t.pausedUntil - off;
        if (hist.some((h) => h.role === 'assistant' && Math.abs(h.ts - candidate) <= 2000)) { start = candidate; break; }
      }
      if (!start) continue;
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

  // Empty BOT_SCHEDULE is always open. BOT_ENABLED is checked separately.
  scheduleOpen(now = this.now()) {
    return scheduleActiveNow({ botEnabled: true, schedule: this.cfg.schedule, timezone: this.cfg.timezone }, new Date(now));
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
    else if (!this.scheduleOpen(now)) {
      const until = nextOpenAt(this.cfg, now);
      if (!until || until <= now || until - lastUser > windowMs) {
        this.stopVideoFollowup(psid, 'outside BOT_SCHEDULE past the 24h window');
        return;
      }
      if (t.videoFollowupNotBefore !== until) {
        t.videoFollowupNotBefore = until;
        this.store.save();
        this.log.info(`video follow-up deferred for ${short(psid)} until the reply schedule`);
      }
      return;
    } else if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) skip = 'not in BOT_TEST_PSIDS allowlist';
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

    const quietUntil = String(this.cfg.schedule || '').trim() ? now : quietDeferUntil(now, tz);
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
      if (!fresh.videoReplyAt || !this.cfg.botEnabled || !this.scheduleOpen(this.now()) || fresh.handedOff || fresh.standby || this.humanPaused(fresh, this.now())) {
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
      return true;
    } catch (e) {
      this.log.error(`video follow-up failed for ${short(psid)}:`, e.message);
    } finally {
      const row = this.store.thread(psid);
      row.videoFollowupPending = false;
      this.store.save();
    }
  }

  // Job status and warranty answers. A linked chat, or a name plus phone that
  // match the same customer. Never reads another customer's job out loud.
  async handleOpsTurn(psid, latestUser, { rev, hadVideo }) {
    const ops = ensureOps(this.store);
    const job = jobByPsid(ops, psid);
    const tz = this.cfg.timezone || 'Asia/Manila';
    if (job && inWarranty(job, this.now(), tz) && asksWarrantyProblem(latestUser)) {
      this.repliedRev.set(psid, rev);
      await this.handoff(psid, 'warranty problem', warrantyText(job), { ops: true });
      return true;
    }
    if (job && asksJobStatus(latestUser)) {
      this.repliedRev.set(psid, rev);
      await this.send(psid, jobStatusText(job), { ops: true, armVideo: hadVideo });
      return true;
    }
    const thread = this.store.thread(psid);
    const answering = Boolean(thread.opsAwait) && (extractPhone(latestUser) || nameGuess(latestUser));
    if (!job && (asksJobStatus(latestUser) || answering)) {
      return this.answerUnlinkedStatus(psid, latestUser, { rev, hadVideo });
    }
    if (thread.opsAwait && !asksJobStatus(latestUser)) thread.opsAwait = '';
    return false;
  }

  async answerUnlinkedStatus(psid, latestUser, { rev, hadVideo }) {
    const thread = this.store.thread(psid);
    const users = (thread.history || []).filter((h) => h.role === 'user').map((h) => h.content || '').join('\n');
    let name = chatCustomerName(thread.history);
    if (!name && (thread.opsAwait === 'name' || thread.opsAwait === 'both')) name = nameGuess(latestUser);
    const phone = extractPhone(users) || extractPhone(latestUser);
    const ops = ensureOps(this.store);
    if (name && phone) {
      const found = matchIdentity(ops, { name, phone });
      this.repliedRev.set(psid, rev);
      thread.opsAwait = '';
      if (found.status === 'one') {
        const job = linkCustomer(this.store, psid, found.customer);
        if (job) {
          await this.send(psid, jobStatusText(job), { ops: true, armVideo: hadVideo });
          return true;
        }
      }
      await this.handoff(psid, 'job status not matched', UNSURE, { ops: true });
      return true;
    }
    this.repliedRev.set(psid, rev);
    if (phone && !name) {
      thread.opsAwait = 'name';
      await this.send(psid, ASK_NAME, { ops: true, armVideo: hadVideo });
    } else if (name && !phone) {
      thread.opsAwait = 'phone';
      await this.send(psid, ASK_PHONE, { ops: true, armVideo: hadVideo });
    } else {
      thread.opsAwait = 'both';
      await this.send(psid, ASK_BOTH, { ops: true, armVideo: hadVideo });
    }
    this.store.save();
    return true;
  }

  // One Taglish update per Under Repair job, from 8:00 Asia/Manila until 19:00, inside the 24h window.
  async maybeDailyStatus(now = this.now()) {
    if (!this.cfg.dailyStatusUpdates) return { sent: [], skipped: [] };
    const tz = this.cfg.timezone || 'Asia/Manila';
    const stamp = manilaStamp(now, tz);
    if (stamp.hour < 8 || stamp.hour >= 19) return { sent: [], skipped: [] };
    const ops = ensureOps(this.store);
    const sent = [];
    const skipped = [];
    let changed = false;
    for (const job of ops.jobs) {
      if (job.status !== 'Under Repair' || !job.psid) continue;
      if (job.lastDailyStatusDate === stamp.date) continue;
      const thread = this.store.data.threads[job.psid];
      if (thread && (thread.handedOff || this.humanPaused(thread, now))) continue;
      if (!this.cfg.botEnabled || !this.scheduleOpen(now)) continue;
      if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(job.psid)) continue;
      const last = thread && thread.lastUserTs ? thread.lastUserTs : 0;
      const outside = !last || now - last > this.cfg.replyWindowHours * HOUR;
      if (outside) {
        if (job.dailyStatusSkip !== 'window' || job.lastDailyStatusDate !== stamp.date) {
          this.log.info(`daily status skipped for ${short(job.psid)}: outside 24h`);
        }
        job.lastDailyStatusDate = stamp.date;
        job.dailyStatusSkip = 'window';
        skipped.push(job.id);
        changed = true;
        continue;
      }
      job.lastDailyStatusDate = stamp.date;
      job.dailyStatusSkip = '';
      changed = true;
      try {
        await this.send(job.psid, dailyStatusText(job), { ops: true });
        sent.push(job.id);
        this.log.info(`daily status sent to ${short(job.psid)}`);
      } catch (e) {
        job.lastDailyStatusDate = '';
        this.log.error(`daily status failed for ${short(job.psid)}:`, e.message);
      }
    }
    if (changed) this.store.save();
    return { sent, skipped };
  }

  // One delivery notice per job, only when the status just changed to For Delivery.
  async notifyForDelivery(jobId) {
    if (!this.cfg.deliveryNotifications) return { sent: false, reason: 'off' };
    const job = ensureOps(this.store).jobs.find((j) => j.id === jobId);
    if (!job || job.status !== 'For Delivery') return { sent: false, reason: 'status' };
    if (job.deliveryNotifiedAt) return { sent: false, reason: 'already' };
    if (!job.psid) return { sent: false, reason: 'unlinked' };
    const now = this.now();
    const thread = (this.store.data.threads || {})[job.psid];
    if (thread && (thread.handedOff || this.humanPaused(thread, now))) return { sent: false, reason: 'paused' };
    if (!this.cfg.botEnabled) return { sent: false, reason: 'disabled' };
    if (!this.scheduleOpen(now)) return { sent: false, reason: 'schedule' };
    if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(job.psid)) return { sent: false, reason: 'allowlist' };
    const last = thread && thread.lastUserTs ? thread.lastUserTs : 0;
    if (!last || now - last > this.cfg.replyWindowHours * HOUR) {
      this.log.info(`delivery notice skipped for ${short(job.psid)}: outside 24h`);
      return { sent: false, reason: 'window' };
    }
    job.deliveryNotifiedAt = new Date(now).toISOString();
    this.store.save();
    try {
      await this.send(job.psid, DELIVERY_NOTICE, { ops: true });
      this.log.info(`delivery notice sent to ${short(job.psid)}`);
      return { sent: true, reason: 'sent' };
    } catch (e) {
      job.deliveryNotifiedAt = '';
      this.store.save();
      this.log.error(`delivery notice failed for ${short(job.psid)}:`, e.message);
      return { sent: false, reason: 'error' };
    }
  }

  // Quiet-customer follow-up. One short LLM line, then at most one more about 24h later,
  // and only while the customer's last message is still inside 23h.
  startFollowups() {
    if (this._followTimer) return;
    const tick = () => { this.checkFollowups().catch((e) => this.log.error('follow-up tick', e.message)); };
    // Wait for the first minute. An immediate pass would message every overnight chat at once.
    this._followTimer = setInterval(tick, 60 * 1000);
    this._followTimer.unref?.();
    // Replies approved in JMAG's Operations wait at the alert webhook. Collect them once a minute.
    if (this.cfg.alertWebhookUrl && !this._relayTimer) {
      this._relayTimer = setInterval(() => { this.relayReplies().catch((e) => this.log.warn('reply relay', e.message)); }, 60 * 1000);
      this._relayTimer.unref?.();
    }
  }

  // JM or Joshua reviewed a customer's photo/video in JMAG's Operations and approved an answer.
  // The answer waits at the alert webhook (Supabase). Send each one from the Page exactly like a
  // dashboard reply (same 24h rule, same pause for Ivan), then report back whether it went out.
  async relayReplies() {
    const hook = this.cfg.alertWebhookUrl;
    if (!hook || this._relayRunning) return 0;
    this._relayRunning = true;
    let sent = 0;
    try {
      const ask = new URL(hook);
      ask.searchParams.set('op', 'replies');
      const r = await fetch(ask, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return 0;
      const list = await r.json().catch(() => []);
      for (const q of Array.isArray(list) ? list.slice(0, 10) : []) {
        if (!q || !q.id || !q.text) continue;
        let res;
        try { res = await this.replyFromDashboard(String(q.id), String(q.text)); } catch (e) {
          res = { ok: false, status: 502, error: 'Hindi naipadala. Subukan ulit.' };
        }
        if (res.ok) sent++;
        const back = new URL(hook);
        back.searchParams.set('op', 'reply-result');
        await fetch(back, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: String(q.id), ok: Boolean(res.ok), status: res.status || 0, error: res.error || '' }),
          signal: AbortSignal.timeout(8000),
        }).catch((e) => this.log.warn('reply relay result failed', e.message));
      }
      if (sent) this.log.info(`sent ${sent} reviewed reply(ies) from JMAG's Operations`);
    } catch (e) {
      this.log.warn('reply relay failed', e.message);
    } finally {
      this._relayRunning = false;
    }
    return sent;
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
      // A job-status line answers the customer. Send it before a sales catch-up
      // so the same chat does not get two bubbles in one pass.
      await this.maybeDailyStatus(now);
      let slots = 1;
      for (const [psid, t] of Object.entries(this.store.data.threads)) {
        try {
          if (slots <= 0) break;
          const sentVideo = await this.maybeVideoFollowUp(psid, t, now);
          if (sentVideo) { slots -= 1; continue; }
          if (max > 0) {
            const outcome = await this.maybeFollowUp(psid, this.store.thread(psid), { now, max, afterMs, day, windowMs });
            if (outcome === 'sent' || outcome === 'failed') slots -= 1;
          }
        } catch (e) { this.log.error(`follow-up error for ${short(psid)}:`, e.message); }
      }
    } finally {
      this._followRunning = false;
    }
  }

  followUpSkip(psid, t, now, windowMs, { ignorePending = false } = {}) {
    if (!ignorePending && t.followupPending) return 'already sending a follow-up';
    const last = (t.history || [])[(t.history || []).length - 1];
    const catching = this.shouldCatchHotLead(t, now, last);
    if (!catching && (t.followupCount || 0) >= this.cfg.followupMax) return 'follow-up limit reached';
    if (t.bookingDone) return 'booking form already submitted';
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (!this.scheduleOpen(now)) return 'outside BOT_SCHEDULE';
    if (this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid)) return 'not in BOT_TEST_PSIDS allowlist';
    if (t.intakeCloseSent || t.tipsSent) return 'intake closed, waiting on the technician';
    if (t.handedOff) return 'handed off';
    if (t.videoReplyAt) return 'video follow-up still open';
    // Giving up because 7 AM (or now) is outside Meta's window must not fall
    // through to the generic nudge, which has no quiet hours.
    if (videoFollowupHoldsGeneric(t)) return 'video follow-up closed without a send';
    if (this.humanPaused(t, now)) return 'paused for a human';
    if (t.followupNextAt && now < t.followupNextAt) return 'follow-up backing off';
    const ageMs = (this.cfg.followupMaxAgeHours || 6) * HOUR;
    if (now - (t.lastUserTs || 0) > ageMs) return 'last customer message is older than the follow-up window';
    if (now - (t.lastUserTs || 0) > windowMs) return 'outside 23h messaging window';
    if (!last || last.role !== 'assistant') {
      if (!catching) return 'customer spoke last';
    }
    return '';
  }

  shouldCatchHotLead(t, now, last) {
    if (!last || last.role !== 'user') return false;
    if ((t.hotCatchAt || 0) >= (t.lastUserTs || 0)) return false;
    const info = hotLeadInfo(t, now);
    return Boolean(info && info.unanswered);
  }

  async maybeFollowUp(psid, t, { now, max, afterMs, day, windowMs }) {
    const skip = this.followUpSkip(psid, t, now, windowMs);
    if (skip) return 'skip';
    const count = t.followupCount || 0;
    const last = t.history[t.history.length - 1];
    if (last && last.role === 'user') {
      t.followupPending = true;
      this.store.save();
      try {
        await this.resumeAfterGrace(psid);
        return 'sent';
      } finally {
        const row = this.store.thread(psid);
        row.followupPending = false;
        this.store.save();
      }
    }
    if (count >= max) return 'skip';
    const info = hotLeadInfo(t, now);
    if (count === 0) {
      const wait = info && info.warm ? HOT_LEAD_WAIT_MS : afterMs;
      if (now - (last.ts || 0) < wait) return 'skip';
    } else if (now - (t.lastFollowupAt || 0) < day) return 'skip';
    t.followupPending = true;
    this.store.save();
    try {
      const followHistory = visibleHistory(t.history, this.now(), { pendingReview: reviewPending(t) });
      const raw = await this.llm.followUp(followHistory, { nowText: this.nowText(), videoMissing: Boolean(t.awaitingVideo) });
      const { text } = parseHandoff(raw);
      const capped = this.presentReply(text);
      if (!sanitizeOutgoing(capped)) return 'skip';
      const fresh = this.store.thread(psid);
      if (this.followUpSkip(psid, fresh, this.now(), windowMs, { ignorePending: true })) return 'skip';
      await this.send(psid, capped);
      fresh.followupCount = (fresh.followupCount || 0) + 1;
      fresh.lastFollowupAt = this.now();
      fresh.followupFails = 0;
      fresh.followupNextAt = 0;
      this.store.save();
      this.log.info(`follow-up ${fresh.followupCount} to ${short(psid)}`);
      return 'sent';
    } catch (e) {
      const row = this.store.thread(psid);
      row.followupFails = (row.followupFails || 0) + 1;
      if (row.followupFails >= 2) {
        row.followupCount = (row.followupCount || 0) + 1;
        row.lastFollowupAt = this.now();
        row.followupFails = 0;
        row.followupNextAt = 0;
        this.log.error(`follow-up given up for ${short(psid)} after 2 tries: ${e.message}`);
      } else {
        const waitMin = Math.min(60, 5 * (2 ** (row.followupFails - 1)));
        row.followupNextAt = this.now() + waitMin * 60 * 1000;
        this.log.error(`follow-up failed for ${short(psid)}; next try in ${waitMin}m: ${e.message}`);
      }
      return 'failed';
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
      if (found) {
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
      if (!String(row.customerName || '').trim()) {
        const thread = this.store.data.threads[row.psid];
        const chatName = thread && summarizeConversation(thread.history).name;
        if (chatName) {
          row.customerName = chatName;
          changed = true;
        }
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
