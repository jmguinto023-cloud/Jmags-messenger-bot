'use strict';
// Core logic: turns Messenger webhook events into Ivan-style replies, handoffs, or follow-ups.
const crypto = require('node:crypto');
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
const { updateIntake, intakeContext, applyReplyGuard, CLOSE_LINE, isEchoOnly, nextAsk, questionTopic, QUESTIONS } = require('./intake');
const { noteEvidence, nextEvidenceAsk, nextStep, coreReady, remindsMissingProof, declinesEvidence, steerTurn, ASK_VIDEO } = require('./evidence');
const { rememberJob, shapeReply, isWait, WAIT_LINE, staffVoice, gatePassed } = require('./quote-gate');
const {
  customerBrief, withWelcome, wantsBooking, saysFormDone, formUrlFor, formMessage,
  FORM_OK, FORM_MISSING, localJobs, submissionMatches, netlifySubmissions, phoneInThread,
} = require('./customer-context');
const { optOutReason, staffEscalation, publicCommentReply, STAFF_HANDOFF_LINE } = require('./reply-rules');
const { hotLeadInfo, HOT_LEAD_WAIT_MS } = require('./ops');
const { bookingTurn } = require('./booking');
const { currentPage, routeEntry, storageKey, withPage } = require('./pages');
const { PageSwitches, pageKey } = require('./page-switches');
const { mediaReceivedNote, applyCustomerGuard, asksCheckupFee, checkupFeeReply, scriptedReply, quoteKnownTv, CHECKUP_NUDGE } = require('./estimate');
const { quickReply } = require('./quick-replies');
const { ensureHomeVisitFee, HOME_VISIT_FEE_LINE, homeVisitIntent } = require('./home-visit-fee');
const { maybeReplyToTestChallenge } = require('./messenger-test');
const { maybeHandlePrivateChat } = require('./private-test-chat');
const bookingConfirm = require('./booking-confirm');
const inquiryReminder = require('./inquiry-reminder');
const applianceOneTime = require('./appliance-one-time');
const MAIN_FIRST_INQUIRY = `Good day Mam/Sir para po masagot ng admin staff ng Jmags Appliances ang inquire nyo about sa TV nila. Maari po ba namin mahingi agad ang mga sumusunod upang mareplayan po agad kayo. 🙂

➡️ SIZE NG TV:
➡️ BRAND NG TV:
➡️ ISSUE NG TV:
➡️ REPAIRED O HINDI PA: (YES/NO)
➡️ KAILAN NASIRA?:
➡️ TAGASAAN PO SILA?:

At pinaka Importante sa lahat ay makapag send po Kayo ng VIDEO ng ACTUAL issue ng TV after mafill up ang form. 

Kailangan po namin lahat ito para mareplayan agad kayo ng mabilis dahil sa dami po ng volume ng Inquiries maraming Salamat po 🙂`;
const {
  reviewPending, reviewIsCurrent, releaseOldReview, asksBarePrice, asksForACall, varyRepeated,
  asksReviewStatus, isUnclearDuringReview, mentionsOldBooking, explicitNewUnit,
  visibleHistory, PENDING_REVIEW_STATUS, REVIEW_CLARIFY, guardStaleReply, PRICE_ASK, CALL_LINE,
} = require('./recency');

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
// Messenger click-to-message ad referrals may be attached to a customer text,
// a quick reply, or a postback. A referral alone is not a customer message.
function isAdInquiry(ev) {
  const refs = [ev?.referral, ev?.message?.referral, ev?.postback?.referral];
  return refs.some(r => r && typeof r === 'object'
    && (String(r.source || '').toUpperCase() === 'ADS' || Boolean(r.ad_id)));
}

function isAutomatedEchoText(text, extra = []) {
  const s = String(text || '');
  if (!s) return false;
  if (AUTOMATED_ECHO_RE.some((re) => re.test(s))) return true;
  return extra.some((p) => { try { return new RegExp(p, 'i').test(s); } catch { return false; } });
}

function isCannedLine(text) {
  return [lines.fallback, lines.holding, lines.holdingMedia, lines.holdingPerson].some((line) => text === line || text === staffVoice(line));
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
  if (/ipapacheck/i.test(clean)) return clean;
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
  constructor({ cfg, store, graph, llm, log, push = null, now = () => Date.now(), switches = null }) {
    Object.assign(this, { cfg, store, graph, llm, log, push, now });
    this.switches = switches || new PageSwitches(cfg, { now: () => this.now(), log: this.log });
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

  // In-memory maps use the same key as the store, so two Pages cannot share a debounce.
  slot(psid) {
    return storageKey(psid, currentPage());
  }

  pageForThread(thread, key) {
    const pages = this.cfg.pages || [];
    const primary = pages.find((p) => p.primary) || null;
    if (thread && thread.pageId) {
      const hit = pages.find((p) => p.id === thread.pageId);
      if (hit) return hit;
    }
    if (key && String(key).includes(':')) {
      const id = String(key).slice(0, String(key).indexOf(':'));
      const hit = pages.find((p) => p.id === id);
      if (hit) return hit;
    }
    return primary;
  }

  pageForReview(row) {
    const pages = this.cfg.pages || [];
    if (row && row.pageId) {
      const hit = pages.find((p) => p.id === row.pageId);
      if (hit) return hit;
    }
    if (row && row.threadKey) return this.pageForThread(null, row.threadKey);
    return pages.find((p) => p.primary) || null;
  }

  locateThread(psid) {
    const id = String(psid || '');
    const threads = this.store.data.threads || {};
    const here = currentPage();
    if (here) {
      const key = storageKey(id, here);
      if (threads[key]) return { key, thread: threads[key], page: here };
    }
    if (threads[id]) return { key: id, thread: threads[id], page: this.pageForThread(threads[id], id) };
    for (const [key, thread] of Object.entries(threads)) {
      if (thread && String(thread.psid || '') === id) return { key, thread, page: this.pageForThread(thread, key) };
    }
    return { key: id, thread: null, page: (this.cfg.pages || []).find((p) => p.primary) || null };
  }

  clearStaffResume(psid) {
    if (!this.staffResume) return;
    if (!psid) {
      for (const timer of this.staffResume.values()) clearTimeout(timer);
      this.staffResume.clear();
      return;
    }
    const slot = this.slot(psid);
    const timer = this.staffResume.get(slot);
    if (timer) clearTimeout(timer);
    this.staffResume.delete(slot);
  }

  // Entry point for a verified webhook body. Never throws.
  handleWebhook(body) {
    if (!body || body.object !== 'page') return;
    for (const entry of body.entry || []) {
      const page = routeEntry(this.cfg, entry && entry.id);
      const entryId = entry && entry.id ? String(entry.id) : '';
      if (!page) {
        this.log.info(`ignored webhook entry ${entryId || '?'}: unknown page`);
        continue;
      }
      if (!page.token) {
        this.log.info(`ignored webhook entry ${page.id}: no page access token`);
        continue;
      }
      withPage(page, () => {
        for (const ev of entry.messaging || []) this.safe(() => this.onEvent(ev, false));
        for (const ev of entry.standby || []) this.safe(() => this.onEvent(ev, true));
        for (const change of entry.changes || []) this.safe(() => this.onFeedChange(change));
      });
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
    const pageIds = new Set((this.cfg.pages || []).map((p) => p.id).filter(Boolean));
    if (this.cfg.pageId) pageIds.add(String(this.cfg.pageId));
    if (!psid || pageIds.has(String(psid))) return;

    // An m.me?ref=BK_ tap is not proof this person submitted the form. Leave it on
    // the normal path so a Page switch that is off keeps every non-submitter silent.

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
    // Owner-only, explicit, one-time live Messenger test for an existing thread.
    // It is independent of first-customer detection and of the ordinary bot.
    // The PSID is kept in Render, never embedded in repository code.
    const ownerWelcomeTest = this.cfg.mainFirstInquiryEnabled && !this.cfg.botEnabled
      && this.cfg.mainWelcomeTestPsid && String(psid) === this.cfg.mainWelcomeTestPsid
      && currentPage()?.primary && !isStandby && ev.message?.mid
      && !media.length && !forceReason
      && this.now() - ts < this.cfg.replyWindowHours * HOUR
      && ts - this.now() < 120000;
    const ownerCommand = spoken.trim().toUpperCase();
    if (ownerWelcomeTest && (ownerCommand === 'JMAGS TEST WELCOME' || ownerCommand === 'JMAGS TEST REMINDER')) {
      const own = this.store.thread(psid);
      if (own.optedOut) return;
      const welcome = ownerCommand === 'JMAGS TEST WELCOME';
      if (welcome && !own.ownerWelcomeTestAttempt) {
        own.ownerWelcomeTestAttempt = String(ev.message.mid);
        this.store.flushNow(); // never duplicate a possibly accepted Send API call
        try {
          await this.graph.sendText(psid, MAIN_FIRST_INQUIRY);
          own.ownerWelcomeTestSentAt = this.now();
          this.store.addTurn(psid, 'assistant', MAIN_FIRST_INQUIRY, own.ownerWelcomeTestSentAt,
            { provider: 'main-owner-test-welcome', history: false });
          this.log.info('Main Branch owner welcome test sent');
        } catch (err) {
          this.log.warn(`Main Branch owner welcome test send failed (HTTP ${Number(err.status) || 'network'})`);
        }
      } else if (!welcome && own.ownerWelcomeTestSentAt && !own.ownerWelcomeTestReminderAttempt) {
        own.ownerWelcomeTestReminderAttempt = String(ev.message.mid);
        this.store.flushNow();
        try {
          await this.graph.sendText(psid, inquiryReminder.REMINDER);
          this.store.addTurn(psid, 'assistant', inquiryReminder.REMINDER, this.now(),
            { provider: 'main-owner-test-reminder', history: false });
          this.log.info('Main Branch owner reminder test sent');
        } catch (err) {
          this.log.warn(`Main Branch owner reminder test send failed (HTTP ${Number(err.status) || 'network'})`);
        }
      }
      return; // no ordinary customer AI, booking, or follow-up is touched
    }
    const t = this.store.thread(psid);
    const applianceTypes = this.cfg.applianceOneTimeReplyEnabled && ev.message?.mid
      && !media.length && !forceReason ? applianceOneTime.match(spoken) : [];
    const adInquiry = isAdInquiry(ev);
    // A click-to-Messenger ad can arrive as a first postback instead of text.
    // Never send on a referral-only event: a customer must actually interact.
    const adPostback = adInquiry && !!ev.postback && !ev.message;
    const firstInquiryMid = ev.message?.mid || (adPostback ? `ad-postback:${ts}` : '');
    const page = currentPage();
    const fixedIntakeEnabled = !!(page && ((page.primary && this.cfg.mainFirstInquiryEnabled)
      || (page.key === 'cavite' && this.cfg.caviteFirstInquiryEnabled)));
    const returnGap = (page?.key === 'cavite'
      ? this.cfg.caviteReturnInquiryDays : this.cfg.mainReturnInquiryDays) * 86400e3;
    const lastCustomerTs = Number(t.lastUserTs) || 0;
    const lastWelcomeTs = Math.max(Number(t.firstInquirySentAt) || 0, Number(t.returnInquiryAttemptAt) || 0);
    const dormantReturn = lastCustomerTs > 0 && ts - lastCustomerTs >= returnGap
      && (!lastWelcomeTs || ts - lastWelcomeTs >= returnGap);
    const firstInquiry = fixedIntakeEnabled
      // A past customer can receive a fresh intake after a genuine idle period.
      // A Page-authored automatic welcome is not a customer inquiry.
      && firstInquiryMid && !isStandby
      && ((!lastCustomerTs && !t.firstInquiryAttempt) || dormantReturn);
    this.store.addTurn(psid, 'user', logText, ts);
    if (optOutReason(spoken)) {
      t.optedOut = true;
      this.cancelPending(psid);
      this.stopVideoFollowup(psid, 'opted out');
      this.store.save();
      this.log.info(`opt-out from ${short(psid)}: no further messages`);
      return;
    }
    t.followupFails = 0;
    t.followupNextAt = 0;
    if (applianceTypes.length) {
      // This path is deliberately independent of BOT_ENABLED and Page bot_switches.
      // It does not start the continuous LLM, TV intake, booking or reminders.
      t.applianceQuickReplyMutedAt = ts;
      this.cancelPending(psid);
      this.bump(psid); // invalidate any earlier conversational reply in flight
      // A recent Page Inbox/staff reply can create a 30-minute human pause,
      // but the owner explicitly wants these fixed FAQ answers even mid-chat.
      // Still honor explicit handoff, booking control, opt-out and Meta's window.
      const skip = isStandby ? 'standby'
        : t.optedOut ? 'opted out'
        : t.gateClosed ? 'quote-gate closed'
        // Booking staff-only suppresses the conversational bot, but must NOT
        // suppress a separately-approved one-time fixed FAQ answer. Never clear
        // the booking flag or reactivate the continuous chatbot.
        : t.handedOff ? 'explicit staff handoff'
        : this.cfg.testPsids.length && !this.cfg.testPsids.includes(psid) ? 'test allowlist'
        : this.now() - ts >= this.cfg.replyWindowHours * HOUR ? 'outside Messenger reply window'
        : ts - this.now() >= 120000 ? 'future message timestamp' : '';
      const allowed = !skip;
      if (skip) this.log.info(`appliance one-time skipped for ${short(psid)} on ${page?.key || 'page'}: ${skip}`);
      if (allowed) {
        const already = t.applianceQuickReplyAttempts ||= {};
        const fresh = applianceTypes.filter(type => !already[type]);
        if (!fresh.length) {
          this.log.info(`appliance one-time skipped for ${short(psid)} on ${page?.key || 'page'}: already attempted category ${applianceTypes.join(',')}`);
        }
        if (fresh.length) {
          for (const type of fresh) already[type] = String(ev.message.mid);
          this.store.flushNow(); // at-most-once even if Meta's send response is uncertain
          try {
            const answer = applianceOneTime.response(fresh);
            await this.graph.sendText(psid, answer);
            this.store.addTurn(psid, 'assistant', answer, this.now(), {
              provider: 'appliance-one-time', history: false,
            });
            this.log.info(`appliance one-time reply sent on ${page?.key || 'page'} for ${short(psid)}: ${fresh.join(',')}`);
          } catch (err) {
            this.log.warn(`appliance one-time reply failed (HTTP ${Number(err.status) || 'network'})`);
          }
        }
      }
      this.store.save();
      return;
    }
    if (firstInquiry) this.safe(() => this.greetFirstInquiry(psid, t, firstInquiryMid, ts,
      { adInquiry, adPostback, previousCustomerTs: lastCustomerTs }));

    // Existing chats may never have received our fixed welcome, especially when
    // this bot was enabled after their first inquiry. A fresh TV repair request
    // can arm ONE video reminder without turning on the conversational AI.
    // No reply on the initial request: wait for the next customer message.
    if (fixedIntakeEnabled && !firstInquiry && !t.firstInquirySentAt
        && ev.message?.mid && !forceReason && !isStandby) {
      const videoReceived = media.some(item => item.type === 'video')
        || /(?:nasend|sinend|pinadala|uploaded|sent)\\s+(?:ko\\s+)?(?:na\\s+)?(?:ang\\s+)?video/i.test(spoken);
      if (videoReceived) t.returningTvVideoReceived = true;
      const tvRepairRequest = /\\b(?:tv|television)\\b/i.test(spoken)
        && /\\b(?:sira|nasira|sirang|repair|paayos|pagawa|issue|problem|blanco|walang|ayaw)\\b/i.test(spoken);
      const startedAt = Number(t.returningTvVideoStartedAt) || 0;
      const attemptedAt = Number(t.returningTvVideoReminderAttemptAt) || 0;
      const eligible = !attemptedAt || ts - attemptedAt >= returnGap;
      if (tvRepairRequest && eligible && (!startedAt || ts - startedAt >= returnGap)) {
        t.returningTvVideoStartedAt = ts;
        t.returningTvVideoReceived = false;
        t.returningTvVideoLatestMid = '';
        this.store.save();
        this.log.info(`existing TV inquiry reminder armed for ${short(psid)} on ${page?.key || 'page'}`);
      } else if (startedAt && eligible && ts > startedAt
          && ts - startedAt < this.cfg.replyWindowHours * HOUR
          && !t.returningTvVideoReceived && !ev.message.attachments?.length) {
        t.returningTvVideoLatestMid = ev.message.mid;
        this.safe(() => this.remindReturningTvInquiry(psid, t, ev.message.mid, ts));
      }
    }
    if (fixedIntakeEnabled && t.firstInquirySentAt
        && !t.firstInquiryReminderAttempt && ev.message?.mid && !t.firstInquiryComplete) {
      t.firstInquiryComplete = inquiryReminder.recordEvidence(t,
        t.returnInquiryStartedAt ? t.history.filter(h => h.ts >= t.returnInquiryStartedAt) : t.history);
      // The newest incoming event owns the debounce, including media and staff-only threads.
      t.firstInquiryLatestMid = ev.message.mid;
      // A customer may answer a staff diagnostic question after providing the form
      // details. On their second post-welcome message, remind once if the actual
      // issue video is still missing, even when the text contains new TV details.
      const postWelcomeReplies = t.history.filter(h =>
        h.role === 'user' && Number(h.ts) > Number(t.firstInquirySentAt)).length;
      if (!isStandby && !t.firstInquiryComplete && ts > t.firstInquirySentAt
          && !ev.message.attachments?.length
          && (inquiryReminder.plainFollowup(spoken) || postWelcomeReplies >= 2)) {
        this.safe(() => this.remindFirstInquiry(psid, t, ev.message.mid, ts));
      }
    }
    if (t.awaitingAgree && !media.length && bookingConfirm.isAgree(spoken)) {
      await this.onBookingAgree(psid, t, ts, isStandby);
      return;
    }
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
      t.bookingDoneAt = ts;
      this.store.save();
    }
    const now = this.now();

    // Mark as done returns the thread without a handover webhook. A normal
    // (non-standby) customer message means we own it again after our own
    // pass_thread_control. Echo pauses are handled separately and stay in place.
    if (explicitNewUnit(spoken)) {
      t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
    }
    if (t.handedOff && t.passedByBot && !t.gateClosed) {
      t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
      this.store.save();
      this.log.info(`thread back with bot for ${short(psid)} after our handoff – resuming`);
    } else if (!t.gateClosed && t.handedOff && this.cfg.handoffResumeHours > 0 && now - t.handoffAt > this.cfg.handoffResumeHours * HOUR) {
      // Old handoff expired (e.g. returning customer days later).
      t.handedOff = false; t.handoffReason = ''; t.passedByBot = false;
    }
    const block = this.blockReason(psid, t, ts) || await this.pageSwitchReason(psid);
    if (block) {
      // Save every photo/video card for review whatever keeps the bot quiet (replies off,
      // outside the schedule, paused, handed off), so JMAG's Operations always gets it.
      await this.publishPendingMedia(psid, { quiet: true });
      t.pendingMedia = []; t.attachmentNote = '';
      this.log.info(`no reply to ${short(psid)}: ${block}`);
      if (block.startsWith('paused') && this.graceStillOpen(t, this.now())) this.scheduleStaffResume(psid);
      return;
    }

    const escalate = staffEscalation(spoken);
    if (!forceReason && escalate) {
      t.needsStaff = true;
      this.store.save();
      this.bump(psid);
      this.cancelPending(psid);
      return this.enqueue(psid, async () => {
        await this.flagPendingMedia(psid);
        return this.handoff(psid, escalate, STAFF_HANDOFF_LINE);
      });
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
    const slot = this.slot(psid);
    const n = (this.rev.get(slot) || 0) + 1;
    this.rev.set(slot, n);
    return n;
  }

  // A public Page comment. Never ask for a phone number or a full address here.
  async onFeedChange(change) {
    if (!change || change.field !== 'feed') return;
    const value = change.value || {};
    if (value.item !== 'comment' || value.verb !== 'add') return;
    const commentId = String(value.comment_id || '');
    const text = String(value.message || '').trim();
    const fromId = value.from && value.from.id ? String(value.from.id) : '';
    const page = currentPage();
    if (!commentId || !text || !fromId) return;
    if (page && fromId === String(page.id)) return;
    if (this.store.seen(commentId)) return;
    const t = this.store.thread(fromId);
    this.store.addTurn(fromId, 'user', text, this.now());
    if (optOutReason(text)) {
      t.optedOut = true;
      this.store.save();
      this.log.info(`opt-out on a public comment from ${short(fromId)}: no reply`);
      return;
    }
    const block = this.blockReason(fromId, t, this.now()) || await this.pageSwitchReason(fromId);
    if (block) {
      this.log.info(`no comment reply to ${short(fromId)}: ${block}`);
      return;
    }
    const reason = staffEscalation(text);
    if (reason) {
      t.needsStaff = true;
      t.handedOff = true;
      t.handoffAt = this.now();
      t.handoffReason = reason;
      t.passedByBot = true;
      this.store.save();
      this.log.info(`HANDOFF comment ${short(fromId)}: ${reason}`);
      if (this.cfg.needsIvanLabel) {
        try { await this.graph.addLabel(fromId, this.cfg.needsIvanLabel); }
        catch (e) { this.log.warn('label failed (optional)', e.message); }
      }
    }
    const reply = publicCommentReply(text);
    try {
      await this.graph.replyToComment(commentId, reply);
      this.store.addTurn(fromId, 'assistant', reply, this.now());
    } catch (e) {
      this.log.error('comment reply failed', e.message);
    }
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

  // Separate from conversational AI. The branch can enable this single fixed reply
  // while the ordinary reply and follow-up switches remain off.
  async greetFirstInquiry(psid, t, mid, ts, {
    adInquiry = false, adPostback = false, previousCustomerTs = 0,
  } = {}) {
    const page = currentPage();
    const branch = page?.key === 'cavite' ? 'Cavite' : 'Main Branch';
    const returnGap = (page?.key === 'cavite'
      ? this.cfg.caviteReturnInquiryDays : this.cfg.mainReturnInquiryDays) * 86400e3;
    const oldHandoff = t.handoffAt && ts - Number(t.handoffAt) >= returnGap;
    const oldBooking = t.bookingConfirmedAt && ts - Number(t.bookingConfirmedAt) >= returnGap;
    // Expired handoffs/old bookings must not permanently exclude customers.
    // Still respect an active staff conversation, opt-out, standby and closed gate.
    const held = () => Number(t.applianceQuickReplyMutedAt) >= ts
      || t.optedOut || t.standby
      || (t.handedOff && !oldHandoff) || (t.bookingStaffOnly && !oldBooking)
      || t.gateClosed || this.humanPaused(t) || this.now() - ts >= this.cfg.replyWindowHours * HOUR;
    if (held()) return;
    try {
      // Let Facebook's own immediate welcome appear first; keep the JMAGS
      // request separate, as a second welcome/intake message.
      // Ad-triggered threads can appear in Meta's inbox later than ordinary
      // chats. Retry reading history longer, but never retry an attempted send.
      const delays = adInquiry ? [1600, 1400, 3000, 6000, 10000] : [1600, 1400, 3000];
      for (const delay of delays) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (held()) return;
        let status;
        try {
          status = await this.graph.firstInquiryStatus(psid, mid, {
            adPostback, returningAfterMs: returnGap, currentTs: ts,
          });
        } catch (err) {
          const code = Number(err.status) || 0;
          // Transient Meta/API failures can recover without risking a duplicate
          // because no Send API call has been attempted yet.
          if (code && code < 500 && code !== 429) {
            this.log.warn(`${branch} first-inquiry history denied (HTTP ${code})`);
            return;
          }
          this.log.warn(`${branch} first-inquiry history retry (HTTP ${code || 'network'}, ${String(err.name || 'Error').slice(0, 40)})`);
          continue;
        }
        if (status === 'existing') return;
        if (status !== 'first' && status !== 'returning') continue;
        const returning = status === 'returning';
        if (held()) return;
        if (!returning && t.firstInquiryAttempt) return;
        if (returning && ((t.returnInquiryAttemptAt && ts - t.returnInquiryAttemptAt < returnGap)
          || (t.firstInquirySentAt && ts - t.firstInquirySentAt < returnGap))) return;
        // Commit each attempt before sending; uncertain Meta sends are not retried.
        if (returning) t.returnInquiryAttemptAt = ts;
        else t.firstInquiryAttempt = mid;
        this.store.flushNow();
        await this.graph.sendText(psid, MAIN_FIRST_INQUIRY);
        t.firstInquirySentAt = this.now();
        if (returning) {
          t.returnInquiryStartedAt = ts;
          t.firstInquiryReminderAttempt = null;
          t.firstInquiryFacts = {};
          t.firstInquiryLatestMid = '';
        }
        const currentHistory = returning ? t.history.filter(h => h.ts >= ts) : t.history;
        t.firstInquiryComplete = inquiryReminder.recordEvidence(t, currentHistory);
        this.store.addTurn(psid, 'assistant', MAIN_FIRST_INQUIRY, t.firstInquirySentAt, {
          provider: returning ? 'main-returning-inquiry' : 'main-first-inquiry', history: false,
        });
        this.log.info(returning
          ? (adInquiry ? `${branch} returning ad inquiry greeting sent` : `${branch} returning inquiry greeting sent`)
          : (adInquiry ? `${branch} ad first-inquiry greeting sent` : `${branch} first-inquiry greeting sent`));
        return;
      }
      this.log.warn(adInquiry
        ? `${branch} ad first-inquiry greeting skipped: inbox history unavailable`
        : `${branch} first-inquiry greeting skipped: inbox history unavailable`);
    } catch (err) {
      this.log.warn(`${branch} first-inquiry greeting could not be verified or sent (HTTP ${err.status || 'unknown'})`);
    }
  }

  // Independent of the continuous chatbot. A customer must actively reply to
  // the fresh TV inquiry; do not send unsolicited messages to old conversations.
  async remindReturningTvInquiry(psid, t, mid, ts) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    const page = currentPage();
    const startedAt = Number(t.returningTvVideoStartedAt) || 0;
    const blocked = t.returningTvVideoLatestMid !== mid
      || t.returningTvVideoReminderAttemptAt || t.returningTvVideoReceived
      || !startedAt || t.firstInquirySentAt || t.optedOut || t.standby
      || t.handedOff || t.bookingStaffOnly || t.bookingDone || t.gateClosed
      || t.bookingFormSent || Number(t.applianceQuickReplyMutedAt) >= ts
      || this.now() - ts >= this.cfg.replyWindowHours * HOUR;
    if (blocked) {
      this.log.info(`existing TV reminder skipped for ${short(psid)} on ${page?.key || 'page'}`);
      return;
    }
    // No automatic retry after an ambiguous Meta send: at most once per inquiry.
    t.returningTvVideoReminderAttemptAt = this.now();
    this.store.flushNow();
    try {
      await this.graph.sendText(psid, inquiryReminder.REMINDER);
      this.store.addTurn(psid, 'assistant', inquiryReminder.REMINDER, this.now(),
        { provider: 'existing-tv-video-reminder', history: false });
      this.log.info(`existing TV inquiry reminder sent on ${page?.key || 'page'} for ${short(psid)}`);
    } catch (err) {
      this.log.warn(`existing TV reminder send failed on ${page?.key || 'page'} (HTTP ${Number(err.status) || 'network'})`);
    }
  }

  async remindFirstInquiry(psid, t, mid, ts) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    // A booking/form from a past conversation must not permanently suppress
    // this session's one-time reminder; current bookings still take priority.
    const start = Number(t.returnInquiryStartedAt) || 0;
    const formCurrent = t.bookingFormSent && (!start || Number(t.formSentAt) >= start);
    const bookingCurrent = t.bookingDone && (!start || Number(t.bookingDoneAt) >= start);
    const bookingStaffCurrent = t.bookingStaffOnly && (!start || Number(t.bookingConfirmedAt) >= start);
    const handoffCurrent = t.handedOff && (!start || Number(t.handoffAt) >= start);
    if (Number(t.applianceQuickReplyMutedAt) >= ts
        || t.firstInquiryLatestMid !== mid || t.firstInquiryReminderAttempt || t.firstInquiryComplete
        || t.optedOut || t.standby || handoffCurrent || bookingStaffCurrent || bookingCurrent
        // This fixed one-time reminder is separate from the conversational bot.
        // Staff clarifications must not suppress it; handoff and booking still do.
        || formCurrent || t.gateClosed
        || this.now() - ts >= this.cfg.replyWindowHours * HOUR) return;
    t.firstInquiryReminderAttempt = mid;
    this.store.flushNow();
    await this.graph.sendText(psid, inquiryReminder.REMINDER);
    this.store.addTurn(psid, 'assistant', inquiryReminder.REMINDER, this.now(), { provider: 'main-first-inquiry-reminder', history: false });
    this.log.info(`${currentPage()?.key === 'cavite' ? 'Cavite' : 'Main Branch'} first-inquiry reminder sent`);
  }

  // '' when this Page's ops switch is on. Unreadable is off (fail closed).
  // BOT_ENABLED and BOT_TEST_PSIDS are applied first, in blockReason.
  async pageSwitchReason(psid) {
    let page = currentPage();
    if (!page && psid) page = this.locateThread(psid).page;
    if (!page) page = (this.cfg.pages || []).find((p) => p.primary) || null;
    try {
      const state = await this.switches.stateFor(page);
      if (!state.ok) return state.error ? `page switch unread (${state.error})` : 'page switch unread';
      if (!state.enabled) return `page switch is off (${state.key})`;
      return '';
    } catch {
      return 'page switch unread';
    }
  }

  // Why the bot must stay quiet for this customer right now (or '' if it may reply).
  blockReason(psid, t, ts) {
    const now = this.now();
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (t && t.optedOut) return 'opted out';
    // Booking silence is per chat. Copying a link, the form, the confirm, and AGREE
    // do not turn the bot on, and nothing here clears it. A later inbound stays quiet
    // while BOT_ENABLED is on or off until staff explicitly clear bookingStaffOnly.
    if (t && t.bookingStaffOnly) return 'booking handed to staff';
    if (t && t.gateClosed) return 'quote-gate handoff';
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
    const page = currentPage();
    const slot = this.slot(psid);
    const p = this.pending.get(slot) || { timer: null, latestTs: 0 };
    p.latestTs = Math.max(p.latestTs, ts);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      p.timer = null;
      this.pending.delete(slot);
      withPage(page, () => this.enqueue(psid, () => this.replyWithAI(psid, p.latestTs)));
    }, this.cfg.batchWindowMs);
    this.pending.set(slot, p);
  }
  cancelPending(psid) {
    const slot = this.slot(psid);
    const p = this.pending.get(slot);
    if (p && p.timer) clearTimeout(p.timer);
    this.pending.delete(slot);
  }
  enqueue(psid, fn) {
    const slot = this.slot(psid);
    const prev = this.chains.get(slot) || Promise.resolve();
    const next = prev.then(fn).catch((e) => this.log.error(`reply error for ${short(psid)}:`, e.message));
    this.chains.set(slot, next);
    next.finally(() => { if (this.chains.get(slot) === next) this.chains.delete(slot); });
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
      const page = currentPage();
      this.store.addReview({
        id: reviewId,
        timestamp: when,
        psid,
        pageId: (page && page.id) || this.cfg.pageId || '',
        threadKey: storageKey(psid, page),
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
    const page = currentPage();
    const slot = this.slot(psid);
    const t = this.store.thread(psid);
    const due = this.lastHumanAt(t) + this.staffGraceMs();
    const wait = Math.max(0, due - this.now());
    this.clearStaffResume(psid);
    const timer = setTimeout(() => {
      this.staffResume.delete(slot);
      withPage(page, () => this.enqueue(psid, () => this.resumeAfterGrace(psid)));
    }, wait);
    timer.unref?.();
    this.staffResume.set(slot, timer);
  }

  async resumeAfterGrace(psid) {
    const t = this.store.thread(psid);
    const now = this.now();
    if (t.handedOff || t.standby || this.humanPaused(t, now)) return;
    const last = (t.history || [])[(t.history || []).length - 1];
    if (!last || last.role !== 'user') return;
    if ((t.hotCatchAt || 0) >= (t.lastUserTs || 0)) return;
    const block = this.blockReason(psid, t, t.lastUserTs || now) || await this.pageSwitchReason(psid);
    if (block) return;
    t.hotCatchAt = now;
    this.store.save();
    if (this.repliedRev.get(this.slot(psid)) === (this.rev.get(this.slot(psid)) || 0)) this.bump(psid);
    return this.replyWithAI(psid, t.lastUserTs || now);
  }

  // Pull Ivan's Page Inbox lines from the last 7 days so we do not ask again.
  async loadInboxHistory(psid) {
    let rows = [];
    try { rows = await this.graph.recentMessages(psid, { limit: 100, withinMs: 90 * 86400e3 }); } catch (e) {
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
    const max = Math.max((this.cfg.historyTurns || 20) * 2, 100);
    if (t.history.length > max) t.history.splice(0, t.history.length - max);
    const newestStaff = [...t.history].reverse().find((h) => h && h.via === 'ivan' && h.ts);
    const quietMs = (Number(this.cfg.humanPauseHours) || 12) * HOUR;
    if (newestStaff && this.now() - newestStaff.ts < quietMs && t.pauseSource !== 'dashboard reply') {
      t.lastHumanEchoAt = Math.max(t.lastHumanEchoAt || 0, newestStaff.ts);
      t.pausedUntil = Math.max(t.pausedUntil || 0, newestStaff.ts + quietMs);
      t.pauseSource = 'staff inbox history';
    }
    this.store.save();
  }

  // A reply that only repeats known facts is thrown out. One rewrite, then the next question.
  async ensureNotEcho(psid, text, thread) {
    if (!isEchoOnly(text, thread)) return text;
    const ask = nextAsk(thread) || quoteKnownTv(thread);
    if (ask) {
      thread.lastAskedTopic = questionTopic(ask);
      this.log.info(`echo reply dropped for ${short(psid)}`);
      return ask;
    }
    let retry = '';
    try {
      retry = await this.llm.chat([
        { role: 'system', content: 'The draft only repeats the customer. Do not mention their brand, age, city, or "wala pa". Ask when they are free, or one missing fact.' },
        { role: 'user', content: String(text || '').slice(0, 400) },
      ], { priority: 'high' });
    } catch (e) {
      this.log.warn('echo rewrite failed', e.message);
    }
    const clean = parseHandoff(String(retry || '')).text;
    if (clean && !isEchoOnly(clean, thread)) return clean;
    this.log.info(`echo reply dropped for ${short(psid)}`);
    return 'Kailan po sila free?';
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
      const rev = this.rev.get(this.slot(psid)) || 0;
      if (this.repliedRev.get(this.slot(psid)) === rev) return; // a newer pass already covered these messages
      const t = this.store.thread(psid);
      const block = this.blockReason(psid, t, ts) || await this.pageSwitchReason(psid); // re-check: Ivan may have jumped in meanwhile
      if (block) {
        t.pendingMedia = []; t.attachmentNote = '';
        this.log.info(`skip reply to ${short(psid)}: ${block}`);
        return;
      }
      const latestSoFar = latestUserText(t);
      if (releaseOldReview(t, latestSoFar, this.now())) this.stopVideoFollowup(psid, 'old video review expired');
      updateIntake(t, '', Boolean((t.pendingMedia || []).length) || t.problemViaVideo);
      noteEvidence(t, {
        hadMedia: Boolean((t.pendingMedia || []).length),
        text: latestSoFar,
      });
      rememberJob(t);
      const brief = await customerBrief(this.store, t, psid, {
        url: this.cfg.supabaseUrl,
        key: this.cfg.supabaseServiceRoleKey,
        fetchImpl: this.fetchImpl,
      });
      t.customerContext = brief.text;
      t.returning = brief.returning;
      if (t.waiting && isWait(latestSoFar)) {
        this.repliedRev.set(this.slot(psid), rev);
        return;
      }
      if (isWait(latestSoFar)) {
        t.waiting = true;
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, WAIT_LINE, { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      t.waiting = false;
      if (t.bookingFormSent && saysFormDone(latestSoFar)) {
        t.formDoneAt = t.formDoneAt || this.now();
        const reported = await this.reportFormStatus(psid, t);
        this.repliedRev.set(this.slot(psid), rev);
        if (reported) return;
      }
      if (gatePassed(t) && wantsBooking(latestSoFar) && !t.bookingFormSent) {
        const link = formUrlFor(this.cfg.bookingFormUrl, t, psid);
        t.bookingFormSent = true;
        t.formSentAt = this.now();
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, formMessage(link), { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      const hadMedia = Boolean((t.pendingMedia || []).length);
      const hadVideo = (t.pendingMedia || []).some((m) => m.type === 'video');
      const attachmentNote = t.attachmentNote || '';
      t.attachmentNote = '';
      await this.flagPendingMedia(psid);
      if ((this.rev.get(this.slot(psid)) || 0) !== rev) {
        this.cancelPending(psid);
        this.log.info(`newer message from ${short(psid)} before reply, combining`);
        continue;
      }

      const latestUser = latestUserText(t);
      const scopeLine = nonFlatscreenLine(latestUser);
      if (scopeLine) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.handoff(psid, 'CRT or non-flatscreen', scopeLine);
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      if (this.cfg.bookingAgentEnabled && !hadMedia) {
        const page = currentPage();
        const bookingCfg = page && page.defaultBranch ? { ...this.cfg, defaultBranch: page.defaultBranch } : this.cfg;
        const booked = await bookingTurn(t, latestUser, {
          cfg: bookingCfg, now: this.now(), log: this.log, psidTag: short(psid), fetchImpl: this.fetchImpl,
        });
        if (booked) {
          this.repliedRev.set(this.slot(psid), rev);
          this.store.save();
          await this.send(psid, booked.text, { provider: 'booking', ops: true });
          if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
          return;
        }
      }
      if (!reviewIsCurrent(t, this.now()) && asksForACall(latestUser)) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, CALL_LINE, { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      if (!reviewIsCurrent(t, this.now()) && /\bpwde kayo\b|\bpwede kayo\b/i.test(latestUser)) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, varyRepeated(t, 'Sige po. Para sa schedule, ilang inches po ang TV?'), { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      if (!reviewIsCurrent(t, this.now()) && asksBarePrice(latestUser) && !quoteKnownTv(t)) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, varyRepeated(t, PRICE_ASK), { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      const scripted = scriptedReply(latestUser, t, { allowPrice: !hadMedia && !reviewPending(t) });
      if (scripted) {
        const parsed = parseHandoff(scripted);
        this.repliedRev.set(this.slot(psid), rev);
        const body = this.presentReply(parsed.text) || lines.holding;
        if (parsed.handoff) await this.handoff(psid, parsed.reason || 'rules', body, { provider: 'rules' });
        else await this.send(psid, body, { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      if (asksCheckupFee(latestUser)) {
        this.repliedRev.set(this.slot(psid), rev);
        const checkupAnswer = checkupFeeReply(latestUser, t);
        if (hadMedia) await this.sendMediaAck(psid, checkupAnswer, true, { armVideo: hadVideo });
        else await this.send(psid, checkupAnswer);
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      if (t.intakeClosed && !t.intakeCloseSent) {
        t.intakeCloseSent = true;
        t.lastAskedTopic = '';
        t.awaitingVideo = false;
        if (hadMedia) t.lastMediaAckAt = this.now();
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, CLOSE_LINE, { armVideo: hadVideo });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      const priced = !hadMedia && !reviewPending(t) && !t.problemViaVideo ? quoteKnownTv(t) : '';
      if (priced) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, priced, { provider: 'rules' });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      if (await this.handleOpsTurn(psid, latestUser, { rev, hadVideo })) {
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      if (reviewPending(t) && asksReviewStatus(latestUser)) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, PENDING_REVIEW_STATUS, { armVideo: hadVideo });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }
      if (reviewPending(t) && isUnclearDuringReview(latestUser)) {
        this.repliedRev.set(this.slot(psid), rev);
        await this.send(psid, REVIEW_CLARIFY, { armVideo: hadVideo });
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return;
      }

      // Approved zero-token FAQ replies, without overriding media review or human handoff.
      if (this.cfg.aiSmartRulesEnabled && !hadMedia && !reviewPending(t)) {
        const canned = quickReply(latestUser, this.cfg, t);
        if (canned) {
          this.repliedRev.set(this.slot(psid), rev);
          if (this.blockReason(psid, t, ts)) return;
          await this.send(psid, canned);
          if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
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
          intakeNote: [intakeContext(t), t.customerContext].filter(Boolean).join(' '),
          mediaStatus: mediaStatus(t),
        });
        raw = await this.fitModelReply(psid, raw);
      } catch (e) {
        if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
        return this.giveUpOnAi(psid, e, { rev, hadMedia, hadVideo });
      }
      if ((this.rev.get(this.slot(psid)) || 0) !== rev) {
        this.cancelPending(psid);
        this.log.info(`discarding in-flight reply for ${short(psid)}; a newer message arrived`);
        continue;
      }
      t.fallbackCount = 0;
      t.aiNeedsIvan = false;
      t.aiHoldingSent = false;
      const { text, handoff, reason } = parseHandoff(raw);
      if (this.blockReason(psid, t, ts)) return; // human took over while AI was thinking
      let guarded = guardStaleReply(
        t,
        applyCustomerGuard(t, applyReplyGuard(t, text), latestUserText(t)),
        latestUserText(t),
      );
      if (!handoff) guarded = await this.ensureNotEcho(psid, guarded, t);
      this.repliedRev.set(this.slot(psid), rev);
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
        else if (handoff && guarded === text) {
          const steered = steerTurn(t, text || lines.holding, latestUser);
          if (steered && steered !== text && (nextEvidenceAsk(t) || remindsMissingProof(latestUser))) await this.send(psid, steered, { provider: 'rules' });
          else {
            t.gateClosed = true;
            await this.handoff(psid, reason || 'model', this.presentReply(text) || lines.holding);
          }
        }
        else await this.send(psid, this.presentReply(steerTurn(t, guarded, latestUser)));
      }
      if ((this.rev.get(this.slot(psid)) || 0) !== rev) continue;
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
    this.repliedRev.set(this.slot(psid), rev);
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
    const handed = this.store.findThread(psid);
    if (handed && handed.bookingStaffOnly) {
      this.log.info(`no auto reply to ${short(psid)}: booking handed to staff`);
      return false;
    }
    const switched = await this.pageSwitchReason(psid);
    if (switched) {
      this.log.info(`no reply to ${short(psid)}: ${switched}`);
      return false;
    }
    const thread = this.store.thread(psid);
    // Ensure the home-visit fee is disclosed on any booking path, including
    // direct booking-form sends and replies generated by models or FAQ rules.
    const withFee = opts.ops || opts.videoFollowup || opts.tips
      ? text : ensureHomeVisitFee(text, latestUserText(thread), thread.history);
    let clean = varyRepeated(thread, sanitizeOutgoing(withFee));
    if (!opts.skipGate && !opts.ops && !opts.tips && !opts.videoFollowup) {
      rememberJob(thread);
      const shaped = shapeReply(thread, clean, latestUserText(thread));
      if (shaped.handoff) {
        thread.gateClosed = true;
        if (!thread.handedOff) {
          await this.handoff(psid, shaped.reason || 'rules', shaped.text, { ...opts, skipGate: true });
          return true;
        }
        clean = shaped.text;
      } else clean = shaped.text;
    }
    if (thread.returning && !opts.ops && !opts.tips && !opts.videoFollowup) clean = withWelcome(thread, clean);
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
    const outgoing = bookingConfirm.personalizeFormUrls(this.cfg, clean, psid, pageKey(currentPage()) || 'sanpablo');
    await this.graph.sendText(psid, outgoing);
    if (bookingConfirm.textHasFormLink(outgoing, this.cfg) && !bookingConfirm.isPersonalFormLinkText(outgoing)) {
      this.noteStaffFormLink(psid, 'bot');
    }
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
    return true;
  }

  // One booking-type confirmation. Does not look at BOT_ENABLED or the Page on/off
  // switch: the customer just submitted the form, and staff still need the reply
  // AGREE even while auto-replies are off. After a successful send this chat stays
  // quiet (bookingStaffOnly) so staff take over. Nothing is sent outside 24h.
  async sendBookingConfirm(psid, opts = {}) {
    const page = opts.page || currentPage() || this.locateThread(psid).page || (this.cfg.pages || []).find((p) => p.primary) || null;
    if (page && currentPage() !== page) return withPage(page, () => this.sendBookingConfirm(psid, { ...opts, page }));
    if (!this.cfg.bookingConfirmEnabled) return { sent: false, reason: 'booking confirm disabled' };
    const wait = bookingConfirm.normalizeWait(opts.wait);
    if (!wait) return { sent: false, reason: 'missing yes/no answer' };
    if (!page || !page.token) {
      const reason = 'no page token';
      const skipId = opts.submissionId ? `sub:${opts.submissionId}` : `notoken:${psid}`;
      if (bookingConfirm.firstSkip(this.store, skipId, reason, this.now())) {
        await this.flagBookingStaff(psid, null, { ...opts, wait, reason, page: pageKey(page) });
      }
      return { sent: false, reason };
    }
    const name = bookingConfirm.cleanName(opts.name);
    const date = bookingConfirm.prettyBookingDate(opts.date);
    const now = this.now();
    const pageName = pageKey(page) || 'sanpablo';
    const keys = bookingConfirm.deliveryKeys({
      psid, page: pageName, wait, name, date,
      submissionId: opts.submissionId || '',
      bookingId: opts.bookingId || '',
    });
    const held = bookingConfirm.deliveryHold(this.store, keys, now);
    if (held.action === 'stop') {
      this.log.info(`booking confirm not sent to ${short(psid)}: ${held.reason}`);
      return { sent: false, reason: held.reason, duplicate: true };
    }

    const existing = this.store.findThread(psid);
    const last = (existing && existing.lastUserTs) || 0;
    const inWindow = Boolean(opts.openedNow) || (last > 0 && now - last <= this.cfg.replyWindowHours * HOUR);
    if (!inWindow) {
      bookingConfirm.markSkipped(this.store, keys.durable, 'outside 24h window', now);
      if (!held.outsideNotified) {
        await this.flagBookingStaff(psid, existing, { name, wait, date, reason: 'outside 24h window', page: pageName });
      }
      this.log.warn(`booking confirm not sent to ${short(psid)}: outside 24h window`);
      return { sent: false, reason: 'outside 24h window' };
    }

    bookingConfirm.markPending(this.store, keys, now);
    const text = bookingConfirm.confirmText(name, wait, date);
    try {
      await this.graph.sendText(psid, text);
    } catch (e) {
      const outside = bookingConfirm.outsideWindowError(e);
      const retry = !outside && (!e.status || e.status >= 500);
      if (retry) {
        bookingConfirm.releasePending(this.store, keys);
        this.log.warn(`booking confirm to ${short(psid)} failed`, e.message);
        return { sent: false, reason: 'send failed', retry: true };
      }
      const reason = outside ? 'outside 24h window' : 'messenger rejected the send';
      bookingConfirm.markSkipped(this.store, keys.durable, reason, now);
      bookingConfirm.releasePending(this.store, { durable: [], soft: keys.soft });
      if (outside ? !held.outsideNotified : true) {
        await this.flagBookingStaff(psid, this.store.findThread(psid), { name, wait, date, reason, page: pageName });
      }
      this.log.warn(`booking confirm to ${short(psid)} not sent: ${reason}`);
      return { sent: false, reason };
    }

    bookingConfirm.markSent(this.store, keys, now, { psid: String(psid) });
    this.cancelPending(psid);
    this.bump(psid);
    this.stopVideoFollowup(psid, 'booking confirmation sent');
    const t = this.store.thread(psid);
    Object.assign(t, {
      bookingDone: true,
      bookingFormSent: true,
      bookingStaffOnly: true,
      formConfirmed: true,
      bookingWait: wait,
      bookingPriority: wait === 'no',
      bookingName: name || t.bookingName || '',
      bookingDate: date,
      bookingPage: pageName,
      bookingId: opts.bookingId || t.bookingId || '',
      bookingSubmissionId: opts.submissionId || t.bookingSubmissionId || '',
      bookingSource: opts.source || 'form',
      bookingConfirmSentAt: now,
      awaitingAgree: true,
      bookingConfirmed: false,
      bookingConfirmedAt: 0,
      followupNextAt: 0,
      bookingNeedsStaff: false,
      bookingNeedsStaffReason: '',
    });
    this.store.addTurn(psid, 'assistant', text, now, { history: true, handoffReason: '', provider: 'booking-form' });
    this.store.flushNow();
    this.log.info(`booking confirm sent to ${short(psid)} wait=${wait} via ${opts.source || 'form'} page=${pageName}`);
    await this.notifyStaff(
      wait === 'no' ? 'New PRIORITY booking' : 'New booking (willing to wait)',
      `${t.bookingName || 'Customer'} filled the form. Waiting for AGREE.`,
    );
    return { sent: true, wait };
  }

  // Netlify form-notification webhook. Authenticated, then one Messenger send.
  async ingestNetlifyBooking(raw, headers = {}, queryKey = '') {
    const auth = bookingConfirm.authorizeNetlify(this.cfg, {
      raw,
      signature: headers['x-webhook-signature'] || headers['X-Webhook-Signature'] || '',
      authorization: headers.authorization || headers.Authorization || '',
      webhookSecret: headers['x-webhook-secret'] || headers['X-Webhook-Secret'] || '',
      queryKey,
    });
    if (!auth.ok) {
      this.log.warn(`booking webhook rejected: ${auth.error}`);
      return { status: auth.status, body: { ok: false, error: auth.error } };
    }
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    let payload = {};
    try { payload = JSON.parse(text || '{}'); } catch {
      payload = Object.fromEntries(new URLSearchParams(text));
    }
    const sub = bookingConfirm.parseNetlifySubmission(payload);
    const fieldNames = Object.keys((payload && payload.data) || payload || {}).filter((key) => !/bot-field|password|token|ref|psid/i.test(key));
    this.log.info(`booking webhook fields ${fieldNames.sort().join(',') || 'none'} ${bookingConfirm.identityFieldSummary(sub)}`);
    if (!sub.submissionId) {
      sub.submissionId = crypto.createHash('sha256').update(Buffer.isBuffer(raw) ? raw : Buffer.from(text)).digest('hex').slice(0, 32);
    }
    if (sub.formName && sub.formName !== 'booking') {
      return { status: 200, body: { ok: true, sent: false, reason: 'ignored form' } };
    }
    const kind = bookingConfirm.bookingKind(sub);
    if (!kind) {
      const fresh = bookingConfirm.firstSkip(this.store, `sub:${sub.submissionId}`, 'missing yes/no answer', this.now());
      if (fresh) await this.flagBookingStaff('', null, { name: sub.name, reason: 'missing yes/no answer', mobileLast4: bookingConfirm.mobileLast4(sub.mobile) });
      return { status: 200, body: { ok: true, sent: false, reason: 'missing yes/no answer' } };
    }
    const who = await this.resolveBookingCustomer(sub);
    const fields = bookingConfirm.identityFieldSummary(sub);
    if (who.via === 'token' || who.via === 'ref') {
      this.log.info(`booking webhook identity token=ok ${pageKey(who.page)} ${short(who.psid)}`);
    } else if (who.via === 'browser-confirm') {
      this.log.info(`booking webhook identity token=absent matched browser confirm ${pageKey(who.page)} ${short(who.psid)}`);
    } else if (sub.token) {
      this.log.info(`booking webhook identity token=rejected ${who.error || 'bad messenger token'}`);
    } else {
      this.log.info(`booking webhook identity ${fields}`);
    }
    if (who.hold) {
      this.rememberBookingNotice(sub, kind, who.staffReason);
      this.armPairTimer();
      this.log.info(`booking notice held ${fields} date=${sub.date ? 'present' : 'absent'} waiting for identity`);
      return { status: 200, body: { ok: true, sent: false, reason: 'waiting for messenger identity' } };
    }
    if (who.error) {
      const fresh = bookingConfirm.firstSkip(this.store, `sub:${sub.submissionId}`, who.error, this.now());
      if (fresh) {
        await this.flagBookingStaff('', null, {
          name: sub.name, wait: kind, date: sub.date, reason: who.error,
          mobileLast4: bookingConfirm.mobileLast4(sub.mobile),
        });
      }
      this.log.warn(`booking webhook not sent: ${who.error}`);
      return { status: 200, body: { ok: true, sent: false, reason: who.error } };
    }
    const result = await this.sendBookingConfirm(who.psid, {
      page: who.page,
      name: sub.name,
      wait: kind,
      date: sub.date,
      bookingId: sub.bookingId || who.bookingId || '',
      submissionId: sub.submissionId,
      source: who.via === 'staff-link' ? 'staff-link' : (who.via === 'browser-confirm' ? 'browser-confirm' : 'netlify'),
    });
    if (!result.sent) this.log.info(`booking confirm not sent after match: ${result.reason || 'not sent'} ${short(who.psid)}`);
    else this.clearBookingPairs({ name: sub.name, bookingId: sub.bookingId || who.bookingId, psid: who.psid });
    if (result.sent && who.entryIds) this.consumeFormLinks(who.entryIds, sub.submissionId);
    if (result.retry) return { status: 502, body: { ok: false, sent: false, reason: result.reason || 'send failed' } };
    return { status: 200, body: { ok: true, sent: Boolean(result.sent), reason: result.reason || '' } };
  }

  // Signed token or ref first. Otherwise only a chat that was sent the form link.
  async resolveBookingCustomer(sub) {
    const ident = bookingConfirm.identityFrom(this.cfg, sub);
    if (ident.error) return { error: ident.error };
    if (!ident.psid) {
      const pending = this.takePendingFormConfirm(sub);
      if (pending) {
        const page = bookingConfirm.pageRecord(this.cfg, pending.page);
        if (page) return { psid: pending.psid, page, via: 'browser-confirm', bookingId: pending.bookingId || '' };
      }
      if (this.cfg.bookingStaffLinkMatch) {
        const picked = await this.matchStaffFormLink(sub);
        if (picked.match) {
          const page = bookingConfirm.pageRecord(this.cfg, picked.match.pageKey);
          if (page) return { psid: picked.match.psid, page, via: 'staff-link', entryIds: picked.match.entryIds || [] };
        }
        return { hold: true, staffReason: picked.reason || 'no messenger identity' };
      }
      return { hold: true, staffReason: 'no messenger identity' };
    }
    if (ident.page) {
      const page = bookingConfirm.pageRecord(this.cfg, ident.page);
      if (!page) return { error: 'no page token' };
      return { psid: ident.psid, page, via: ident.via };
    }
    const hits = this.threadsForPsid(ident.psid);
    if (hits.length !== 1 || !hits[0].page) return { error: hits.length > 1 ? 'ambiguous messenger thread' : 'no messenger identity' };
    return { psid: ident.psid, page: hits[0].page, via: ident.via };
  }

  pairWindowMs() {
    return bookingConfirm.PAIR_WINDOW_MS;
  }

  bookingHold() {
    const bag = this.store.data.bookingHolds ||= { notices: [], idents: [] };
    bag.notices ||= [];
    bag.idents ||= [];
    return bag;
  }

  freshHoldRows(rows) {
    const now = this.now();
    return (rows || []).filter((row) => row && now - row.at <= this.pairWindowMs());
  }

  pageNameForPsid(psid) {
    const hits = this.threadsForPsid(psid);
    if (hits.length === 1) return pageKey(hits[0].page);
    const links = Object.values(this.store.data.shortLinks || {}).filter((row) => row && String(row.psid) === String(psid));
    links.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return (links[0] && links[0].page) || 'sanpablo';
  }

  holdNamesMatch(a, b) {
    const left = bookingConfirm.cleanName(a).toLowerCase();
    const right = bookingConfirm.cleanName(b).toLowerCase();
    return Boolean(left) && left === right;
  }

  holdWaitsMatch(a, b) {
    if (!a || !b) return true;
    return a === b;
  }

  identMatchesNotice(ident, notice) {
    if (!this.holdWaitsMatch(ident.wait, notice.wait)) return false;
    if (ident.bookingId && notice.bookingId) return ident.bookingId === notice.bookingId;
    if (this.holdNamesMatch(ident.name, notice.name)) return true;
    const phone = bookingConfirm.normalizeMobile(notice.mobile);
    if (!phone) return false;
    const page = bookingConfirm.pageRecord(this.cfg, ident.page);
    if (!page) return false;
    let hit = false;
    withPage(page, () => {
      const thread = this.store.findThread(ident.psid) || {};
      const typed = (thread.history || []).filter((row) => row && row.role === 'user').map((row) => row.content || '').join('\n');
      hit = bookingConfirm.phonesInText(typed).includes(phone);
    });
    return hit;
  }

  takeOne(rows, pred) {
    const hits = rows.filter(pred);
    if (hits.length !== 1) return null;
    return hits[0];
  }

  rememberBookingNotice(sub, kind, staffReason) {
    const bag = this.bookingHold();
    bag.notices = this.freshHoldRows(bag.notices);
    bag.notices.push({
      submissionId: sub.submissionId || '',
      bookingId: sub.bookingId || '',
      name: bookingConfirm.cleanName(sub.name),
      mobile: bookingConfirm.normalizeMobile(sub.mobile),
      date: sub.date || '',
      wait: kind,
      staffReason: staffReason || '',
      at: this.now(),
    });
    bag.notices = bag.notices.slice(-200);
    this.store.flushNow();
  }

  rememberBookingIdent({ psid, name, wait, bookingId }) {
    const bag = this.bookingHold();
    bag.idents = this.freshHoldRows(bag.idents);
    bag.idents.push({
      psid: String(psid),
      page: this.pageNameForPsid(psid),
      name: bookingConfirm.cleanName(name),
      wait: bookingConfirm.normalizeWait(wait) || '',
      bookingId: String(bookingId || '').slice(0, 80),
      at: this.now(),
    });
    bag.idents = bag.idents.slice(-200);
    this.store.flushNow();
  }

  takePendingFormConfirm(sub) {
    const bag = this.bookingHold();
    bag.idents = this.freshHoldRows(bag.idents);
    const notice = {
      name: sub && sub.name,
      bookingId: sub && sub.bookingId,
      mobile: sub && sub.mobile,
      wait: bookingConfirm.bookingKind(sub) || (sub && sub.wait) || '',
    };
    const hit = this.takeOne(bag.idents, (ident) => this.identMatchesNotice(ident, notice));
    if (!hit) {
      this.store.flushNow();
      return null;
    }
    bag.idents = bag.idents.filter((row) => row !== hit);
    this.store.flushNow();
    return hit;
  }

  takeMatchingNotice({ name, bookingId, wait }) {
    const bag = this.bookingHold();
    bag.notices = this.freshHoldRows(bag.notices);
    const ident = { name, bookingId, wait, page: '', psid: '' };
    const hit = this.takeOne(bag.notices, (notice) => this.identMatchesNotice(ident, notice));
    if (!hit) {
      this.store.flushNow();
      return null;
    }
    bag.notices = bag.notices.filter((row) => row !== hit);
    this.store.flushNow();
    return hit;
  }

  clearBookingPairs({ name, bookingId, psid } = {}) {
    const bag = this.bookingHold();
    bag.idents = bag.idents.filter((row) => {
      if (psid && row.psid === String(psid)) return false;
      if (bookingId && row.bookingId && row.bookingId === bookingId) return false;
      if (name && this.holdNamesMatch(row.name, name)) return false;
      return true;
    });
    bag.notices = bag.notices.filter((row) => {
      if (bookingId && row.bookingId && row.bookingId === bookingId) return false;
      if (name && this.holdNamesMatch(row.name, name)) return false;
      return true;
    });
    this.store.flushNow();
  }

  armPairTimer() {
    if (this.pairTimer) clearTimeout(this.pairTimer);
    const bag = this.bookingHold();
    const rows = [...bag.notices, ...bag.idents];
    if (!rows.length) {
      this.pairTimer = null;
      return;
    }
    const due = Math.min(...rows.map((row) => row.at + this.pairWindowMs()));
    const wait = Math.max(0, due - this.now());
    this.pairTimer = setTimeout(() => {
      this.pairTimer = null;
      this.flushBookingPairs().catch((e) => this.log.error('booking pair flush failed', e.message));
    }, wait);
    if (this.pairTimer.unref) this.pairTimer.unref();
  }

  async receiveBrowserConfirm({ psid, name, wait, date, bookingId }) {
    const page = bookingConfirm.pageRecord(this.cfg, this.pageNameForPsid(psid));
    const notice = this.takeMatchingNotice({ name, bookingId, wait });
    const when = date || (notice && notice.date) || '';
    if (when || !notice) {
      if (when) {
        const result = await this.sendBookingConfirm(psid, {
          page, name, wait, date: when,
          bookingId: bookingId || (notice && notice.bookingId) || '',
          submissionId: (notice && notice.submissionId) || '',
          source: notice ? 'paired' : 'form',
        });
        if (result.sent) this.clearBookingPairs({ name, bookingId, psid });
        else this.log.info(`booking confirm not sent after match: ${result.reason || 'not sent'} ${short(psid)}`);
        if (notice) this.log.info(`booking browser confirm ${short(psid)} paired with notice`);
        return result;
      }
    }
    if (notice && !when) {
      const result = await this.sendBookingConfirm(psid, {
        page, name, wait, date: '',
        bookingId: bookingId || notice.bookingId || '',
        submissionId: notice.submissionId || '',
        source: 'paired',
      });
      this.log.info(`booking browser confirm ${short(psid)} paired with notice date=absent: ${result.sent ? 'sent' : (result.reason || 'not sent')}`);
      if (result.sent) this.clearBookingPairs({ name, bookingId, psid });
      return result;
    }
    this.rememberBookingIdent({ psid, name, wait, bookingId });
    this.armPairTimer();
    this.log.info(`booking browser confirm ${short(psid)} ref=ok date=absent waiting for form notification`);
    return { sent: false, reason: 'waiting for form date' };
  }

  async flushBookingPairs() {
    const bag = this.bookingHold();
    const now = this.now();
    const window = this.pairWindowMs();
    const expiredIdents = bag.idents.filter((row) => now - row.at >= window);
    const expiredNotices = bag.notices.filter((row) => now - row.at >= window);
    bag.idents = bag.idents.filter((row) => now - row.at < window);
    bag.notices = bag.notices.filter((row) => now - row.at < window);
    this.store.flushNow();
    const results = [];
    for (const ident of expiredIdents) {
      const page = bookingConfirm.pageRecord(this.cfg, ident.page);
      this.log.info(`booking pair window ended ${short(ident.psid)} date=absent, sending without date`);
      const result = await this.sendBookingConfirm(ident.psid, {
        page, name: ident.name, wait: ident.wait, date: '',
        bookingId: ident.bookingId || '', source: 'browser-confirm',
      });
      if (!result.sent) this.log.info(`booking confirm not sent after match: ${result.reason || 'not sent'} ${short(ident.psid)}`);
      results.push(result);
    }
    for (const notice of expiredNotices) {
      const sub = {
        name: notice.name, mobile: notice.mobile, date: notice.date,
        willingToWait: notice.wait, bookingId: notice.bookingId, submissionId: notice.submissionId,
      };
      let sent = false;
      let reason = notice.staffReason || 'no messenger identity';
      if (this.cfg.bookingStaffLinkMatch) {
        const picked = await this.matchStaffFormLink(sub);
        if (picked.match) {
          const page = bookingConfirm.pageRecord(this.cfg, picked.match.pageKey);
          const result = await this.sendBookingConfirm(picked.match.psid, {
            page, name: notice.name, wait: notice.wait, date: notice.date,
            bookingId: notice.bookingId, submissionId: notice.submissionId, source: 'staff-link',
          });
          sent = Boolean(result.sent);
          reason = result.reason || '';
          if (sent && picked.match.entryIds) this.consumeFormLinks(picked.match.entryIds, notice.submissionId);
          if (!sent) this.log.info(`booking confirm not sent after match: ${reason || 'not sent'} ${short(picked.match.psid)}`);
          results.push(result);
          continue;
        }
        reason = picked.reason || reason;
      }
      const fresh = bookingConfirm.firstSkip(this.store, `sub:${notice.submissionId}`, reason, now);
      if (fresh) {
        await this.flagBookingStaff('', null, {
          name: notice.name, wait: notice.wait, date: notice.date, reason,
          mobileLast4: bookingConfirm.mobileLast4(notice.mobile),
        });
      }
      this.log.warn(`booking webhook not sent: ${reason}`);
      results.push({ sent, reason });
    }
    if (bag.notices.length || bag.idents.length) this.armPairTimer();
    return results;
  }

  noteStaffFormLink(psid, source) {
    const page = currentPage() || (this.cfg.pages || []).find((p) => p.primary) || null;
    const pageName = pageKey(page);
    if (!psid || (pageName !== 'sanpablo' && pageName !== 'cavite')) return null;
    const now = this.now();
    const list = this.store.data.formLinkSends ||= [];
    const keepAfter = now - Math.max(30, (this.cfg.bookingStaffLinkDays || 7) * 2) * 86400e3;
    const kept = list.filter((row) => row && row.sentAt >= keepAfter);
    list.length = 0;
    list.push(...kept);
    const row = {
      id: crypto.randomBytes(8).toString('hex'),
      psid: String(psid),
      pageId: (page && page.id) || '',
      pageKey: pageName,
      sentAt: now,
      source: source || 'staff',
      consumedAt: 0,
      submissionId: '',
    };
    list.push(row);
    if (list.length > 2000) list.splice(0, list.length - 2000);
    this.store.flushNow();
    this.log.info(`staff form link recorded ${pageName} ${short(psid)}`);
    if ((source || 'staff') === 'staff') return this.sendPersonalFormLink(psid, page, pageName);
    return row;
  }

  // One signed link after staff paste the plain URL. Not a chatbot reply: it ignores
  // BOT_ENABLED and does not turn anything on. Our own message is not a staff link.
  async sendPersonalFormLink(psid, page, pageName) {
    if (!this.cfg.bookingAutoPersonalLink) {
      this.log.info(`personal form link skipped ${pageName} ${short(psid)}: BOOKING_AUTO_PERSONAL_LINK is off`);
      return;
    }
    const thread = this.store.thread(psid);
    const now = this.now();
    const last = thread.lastUserTs || 0;
    const windowMs = (Number(this.cfg.replyWindowHours) || 23.5) * HOUR;
    if (!(last > 0 && now - last <= windowMs)) {
      this.log.info(`personal form link skipped ${pageName} ${short(psid)}: outside 24h window`);
      return;
    }
    if (thread.personalLinkSentAt && now - thread.personalLinkSentAt < 10 * 60 * 1000) {
      this.log.info(`personal form link skipped ${pageName} ${short(psid)}: sent within 10 minutes`);
      return;
    }
    const link = this.cfg.bookingShortLink ? this.shortBookingLink(psid, pageName) : bookingConfirm.bookingFormLink(this.cfg, psid, pageName);
    if (!link) {
      this.log.info(`personal form link skipped ${pageName} ${short(psid)}: could not sign link`);
      return;
    }
    try {
      await this.graph.sendText(psid, bookingConfirm.personalFormLinkText(link));
    } catch (e) {
      this.log.info(`personal form link skipped ${pageName} ${short(psid)}: ${e.message}`);
      return;
    }
    thread.personalLinkSentAt = now;
    this.store.flushNow();
    this.log.info(`personal form link sent ${pageName} ${short(psid)}`);
  }

  // Optional. BOOKING_SHORT_LINK sends /b/<code>. Old codes still open when it is off.
  shortBookingLink(psid, pageName) {
    const full = bookingConfirm.bookingFormLink(this.cfg, psid, pageName);
    if (!full) return '';
    let target;
    try { target = new URL(full); } catch { return full; }
    const code = this.store.saveShortLink({
      psid,
      page: pageName,
      token: target.searchParams.get('token') || '',
      ref: target.searchParams.get('ref') || '',
    }, this.now(), bookingConfirm.SHORT_LINK_MS);
    const base = String(this.cfg.publicBaseUrl || '').replace(/\/$/, '');
    return `${base}/b/${code}`;
  }

  consumeFormLinks(ids, submissionId) {
    const want = new Set(ids || []);
    for (const row of this.store.data.formLinkSends || []) {
      if (row && want.has(row.id) && !row.consumedAt) {
        row.consumedAt = this.now();
        row.submissionId = String(submissionId || '').slice(0, 80);
      }
    }
    this.store.flushNow();
  }

  async chatFacts(psid, page) {
    return withPage(page, async () => {
      const thread = this.store.findThread(psid) || {};
      const history = thread.history || [];
      const blob = history.map((h) => (h && h.content) || '').join('\n');
      const typed = history.filter((h) => h && h.role === 'user').map((h) => h.content || '').join('\n');
      const phones = bookingConfirm.phonesInText(typed);
      const names = [];
      if (thread.profileName) names.push(thread.profileName);
      if (thread.bookingName) names.push(thread.bookingName);
      for (const review of this.store.data.reviews || []) {
        if (!review || String(review.psid) !== String(psid)) continue;
        if (page && page.id && review.pageId && review.pageId !== page.id) continue;
        if (review.customerName) names.push(review.customerName);
      }
      const said = blob.match(/(?:ako si|pangalan ko(?: po)?(?: ay| si)?|my name is)\s+([A-Za-zÑñ][A-Za-zÑñ .' -]{1,40})/i);
      if (said) names.push(said[1]);
      if (!names.length && this.graph && this.graph.userName) {
        const got = await this.graph.userName(psid);
        if (got && thread.history) {
          thread.profileName = got;
          names.push(got);
          this.store.save();
        }
      }
      return { phones, names };
    });
  }

  async matchStaffFormLink(sub) {
    const days = Number(this.cfg.bookingStaffLinkDays) || 7;
    const cutoff = this.now() - days * 86400e3;
    const pageFilter = bookingConfirm.normalizePageKey(sub && sub.page);
    const open = (this.store.data.formLinkSends || []).filter((row) => row && !row.consumedAt && row.sentAt >= cutoff
      && (!pageFilter || row.pageKey === pageFilter));
    const groups = new Map();
    for (const row of open) {
      const key = `${row.pageKey}:${row.psid}`;
      const group = groups.get(key) || { psid: row.psid, pageKey: row.pageKey, entryIds: [] };
      group.entryIds.push(row.id);
      groups.set(key, group);
    }
    const candidates = [];
    for (const group of groups.values()) {
      const page = bookingConfirm.pageRecord(this.cfg, group.pageKey);
      if (!page) continue;
      const facts = await this.chatFacts(group.psid, page);
      const label = bookingConfirm.cleanName((facts.names || [])[0] || '');
      candidates.push({ ...group, phones: facts.phones, names: facts.names, label });
    }
    const picked = bookingConfirm.pickStaffLink(candidates, sub);
    if (!(picked.decisions || []).length) {
      this.log.info('booking staff-link: no open form-link sends in the window');
    } else {
      for (const row of picked.decisions) {
        this.log.info(`booking staff-link ${row.pageKey} ${short(row.last4)} ${row.why}`);
      }
    }
    return picked;
  }

  threadsForPsid(psid) {
    const id = String(psid || '');
    const hits = [];
    for (const [key, thread] of Object.entries(this.store.data.threads || {})) {
      if (!thread) continue;
      const raw = thread.psid
        ? String(thread.psid)
        : (String(key).includes(':') ? String(key).slice(String(key).indexOf(':') + 1) : String(key));
      if (raw !== id) continue;
      const page = this.pageForThread(thread, key);
      if (page) hits.push({ key, thread, page });
    }
    return hits;
  }

  async flagBookingStaff(psid, thread, info = {}) {
    const reason = String(info.reason || '');
    const name = bookingConfirm.cleanName(info.name);
    if (thread) {
      thread.bookingNeedsStaff = true;
      thread.bookingNeedsStaffReason = reason;
      if (name) thread.bookingName = name;
      if (info.wait) thread.bookingWait = info.wait;
      if (info.date) thread.bookingDate = bookingConfirm.prettyBookingDate(info.date);
      if (info.page) thread.bookingPage = info.page;
    } else {
      const alerts = this.store.data.bookingAlerts ||= [];
      alerts.push({
        at: this.now(),
        reason,
        name,
        mobileLast4: info.mobileLast4 || '',
        page: info.page || '',
      });
      if (alerts.length > 200) alerts.splice(0, alerts.length - 200);
    }
    this.store.flushNow();
    const who = name || 'Customer';
    await this.notifyStaff('Booking needs staff', `${who}: ${reason}. No Messenger confirm was sent.`);
  }

  async onBookingAgree(psid, t, ts, isStandby) {
    t.awaitingAgree = false;
    t.bookingConfirmed = true;
    t.bookingConfirmedAt = ts || this.now();
    // The ack is the last automatic line. This does not turn BOT_ENABLED or a Page switch on.
    t.bookingStaffOnly = true;
    this.store.save();
    this.log.info(`booking AGREE from ${short(psid)} wait=${t.bookingWait}`);
    if (!isStandby) {
      const ack = bookingConfirm.agreeAckText(t.bookingWait);
      try {
        await this.graph.sendText(psid, ack);
        this.store.addTurn(psid, 'assistant', ack, this.now(), { history: true, handoffReason: '', provider: 'booking-form' });
      } catch (e) { this.log.warn(`booking AGREE ack to ${short(psid)} failed`, e.message); }
    }
    await this.notifyStaff(
      t.bookingPriority ? 'PRIORITY booking confirmed' : 'Booking confirmed',
      `${t.bookingName || 'Customer'} replied AGREE.`,
    );
  }

  async notifyStaff(title, body) {
    if (!this.push) return;
    try { await this.push.notify({ title, body, url: '/dashboard' }); } catch (e) { this.log.warn('push notify failed', e.message); }
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
    const row = (this.store.data.reviews || []).find((r) => r.id === reviewId);
    const page = row ? this.pageForReview(row) : null;
    if (page && currentPage() !== page) return withPage(page, () => this.replyFromDashboard(reviewId, text));
    if (row && row.pageId && page && !page.token) {
      return { ok: false, status: 409, error: 'Walang token para sa Page na ito.' };
    }
    const clean = sanitizeOutgoing(text);
    if (!clean) return { ok: false, status: 400, error: 'Walang laman.' };
    if (clean.length > 2000) return { ok: false, status: 400, error: 'Masyadong mahaba. Max 2000 characters.' };
    if (!row || !row.psid) return { ok: false, status: 404, error: 'Hindi makita ang chat.' };
    const psid = row.psid;
    const recent = this.dashRecent.get(this.slot(psid));
    if (recent && recent.text === clean && this.now() - recent.at < 3000) {
      return { ok: true, status: 200, duplicate: true };
    }
    const inflight = this.dashInflight.get(this.slot(psid));
    if (inflight && inflight.text === clean) return inflight.promise;
    if (inflight) return { ok: false, status: 409, error: 'Sandali lang, may pinapadala pa.' };
    const t = this.store.thread(psid);
    const last = t.lastUserTs || 0;
    if (!last || this.now() - last > this.cfg.replyWindowHours * HOUR) {
      this.log.info(`dashboard reply skipped for ${short(psid)}: outside 24h`);
      return { ok: false, status: 409, error: 'Lampas na sa 24 oras, i-reply sa Business Suite' };
    }
    const promise = this.deliverDashboardReply(psid, clean);
    this.dashInflight.set(this.slot(psid), { text: clean, promise });
    try {
      return await promise;
    } finally {
      const cur = this.dashInflight.get(this.slot(psid));
      if (cur && cur.promise === promise) this.dashInflight.delete(this.slot(psid));
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
    const page = currentPage();
    this.store.markIvanReplied(psid, now, page && page.id);
    this.dashRecent.set(this.slot(psid), { text: clean, at: now });
    this.store.save();
    this.log.info(`dashboard reply to ${short(psid)} (${clean.length} chars) – bot paused ${this.cfg.humanPauseMinutes}m`);
    return { ok: true, status: 200 };
  }

  async handoff(psid, reason, holdingText, sendOpts = {}) {
    const switched = await this.pageSwitchReason(psid);
    if (switched) {
      this.log.info(`no handoff for ${short(psid)}: ${switched}`);
      return;
    }
    const t = this.store.thread(psid);
    if (t.handedOff) return;
    t.handedOff = true; t.handoffAt = this.now(); t.handoffReason = reason; t.passedByBot = true;
    if (/warranty|backjob/i.test(String(reason || ''))) t.gateClosed = true;
    this.stopVideoFollowup(psid, 'handed to Ivan');
    this.store.save();
    this.log.info(`HANDOFF ${short(psid)}: ${reason}`);
    try { await this.send(psid, holdingText, sendOpts); } catch (e) { this.log.error('holding line failed', e.message); }
    try {
      await this.graph.passThreadControl(psid, this.cfg.pageInboxAppId, `Needs Ivan: ${reason}`);
    } catch (e) { this.log.error('pass_thread_control failed', e.message); }
    if (this.cfg.needsIvanLabel) {
      try { await this.graph.addLabel(psid, this.cfg.needsIvanLabel); }
      catch (e) { this.log.warn('label failed (optional)', e.message); }
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
    // Staff pasted the plain form link. Remember the chat. Do not edit their message.
    // Our signed follow-up also contains the host; that echo is not another staff link.
    let follow = null;
    if (bookingConfirm.textIsStaffFormSignal(m.text, this.cfg)) {
      follow = this.noteStaffFormLink(psid, 'staff');
    }
    const t = this.store.thread(psid);
    const at = Number(ev.timestamp) || this.now();
    // Meta's own inbox automation, not a person typing in Page Inbox.
    if (appId && (this.cfg.pageAiAppIds || []).includes(appId)) {
      if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
      this.store.save();
      this.log.info(`page AI echo for ${short(psid)} app_id=${appId} – not pausing`);
      return follow;
    }
    // Saved reply / instant reply / greeting / away message / Meta AI from the Page Inbox app.
    const auto = this.automatedEchoReason(t, m, at);
    if (auto) {
      t.lastAutoEchoAt = at;
      if (m.text) this.store.addTurn(psid, 'assistant', m.text, this.now());
      this.store.save();
      this.log.info(`automated echo for ${short(psid)} app_id=${appId || 'none'} (${auto}) – not pausing`);
      return follow;
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
    return follow;
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
    // A staff inbox line keeps the thread quiet for the full 12h window.
    if (t.pauseSource === 'staff inbox history') return true;
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
      .map(([key, t]) => {
        const psid = (t && t.psid) || key;
        return {
          psid, pageId: (t && t.pageId) || this.cfg.pageId || '', last4: String(psid).slice(-4),
          handedOff: Boolean(t.handedOff), handoffReason: t.handoffReason || '',
          pausedUntil: t.pausedUntil ? new Date(t.pausedUntil).toISOString() : '', pauseSource: t.pauseSource || '',
        };
      });
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
    if (t.bookingStaffOnly) {
      if (t.videoReplyAt) this.stopVideoFollowup(psid, 'booking handed to staff');
      return;
    }
    if (!t.videoReplyAt) return;
    if ((t.videoFollowupCount || 0) >= this.videoFollowupMax()) return;
    if (t.videoFollowupPending) return;
    if (now < this.videoFollowupDueAt(t)) return;

    const windowMs = this.cfg.replyWindowHours * HOUR;
    const lastUser = t.lastUserTs || 0;
    const tz = this.cfg.timezone || 'Asia/Manila';
    let skip = '';
    if (!this.cfg.botEnabled) skip = 'BOT_ENABLED is off';
    else if (t.optedOut) skip = 'opted out';
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
    const switched = await this.pageSwitchReason(psid);
    if (switched) {
      this.log.info(`video follow-up skipped for ${short(psid)}: ${switched}`);
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
      const sent = await this.send(psid, videoFollowupText(fresh, { second }), { videoFollowup: true });
      if (sent === false) return;
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
      this.repliedRev.set(this.slot(psid), rev);
      await this.handoff(psid, 'warranty problem', warrantyText(job), { ops: true });
      return true;
    }
    if (job && asksJobStatus(latestUser)) {
      this.repliedRev.set(this.slot(psid), rev);
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
      this.repliedRev.set(this.slot(psid), rev);
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
    this.repliedRev.set(this.slot(psid), rev);
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
      const located = this.locateThread(job.psid);
      const thread = located.thread;
      if (thread && (thread.handedOff || thread.optedOut || this.humanPaused(thread, now))) continue;
      if (!located.page || !located.page.token) continue;
      const switched = await withPage(located.page, () => this.pageSwitchReason(job.psid));
      if (switched) {
        this.log.info(`daily status skipped for ${short(job.psid)}: ${switched}`);
        continue;
      }
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
        await withPage(located.page, () => this.send(job.psid, dailyStatusText(job), { ops: true }));
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
    const located = this.locateThread(job.psid);
    const thread = located.thread;
    if (thread && (thread.handedOff || thread.optedOut || this.humanPaused(thread, now))) return { sent: false, reason: 'paused' };
    if (!located.page || !located.page.token) return { sent: false, reason: 'page' };
    const switched = await withPage(located.page, () => this.pageSwitchReason(job.psid));
    if (switched) return { sent: false, reason: 'switch' };
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
      await withPage(located.page, () => this.send(job.psid, DELIVERY_NOTICE, { ops: true }));
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

  async formLanded(psid, thread) {
    const phone = phoneInThread(thread);
    const name = (thread.slots && thread.slots.customerName) || '';
    const query = { psid, phone, name };
    if (localJobs(this.store, query).length) return true;
    const remote = await netlifySubmissions({
      token: this.cfg.netlifyApiToken,
      formId: this.cfg.netlifyFormId,
      fetchImpl: this.fetchImpl,
    });
    return remote.some((row) => submissionMatches(row, query));
  }

  // One confirmation if the form arrived, or one nudge if it did not. Never a second nudge.
  async reportFormStatus(psid, thread) {
    if (!thread.bookingFormSent || thread.formConfirmed || thread.formMissNotified) return false;
    if (thread.bookingStaffOnly || thread.bookingConfirmSentAt) return false;
    const found = await this.formLanded(psid, thread);
    if (found) {
      thread.formConfirmed = true;
      this.store.save();
      await this.send(psid, FORM_OK, { provider: 'rules', skipGate: true });
      return true;
    }
    thread.formMissNotified = true;
    thread.needsStaff = true;
    this.store.save();
    await this.send(psid, FORM_MISSING, { provider: 'rules', skipGate: true });
    return true;
  }

  async maybeFormChecks(now) {
    const wait = 45 * 60 * 1000;
    for (const [key, thread] of Object.entries(this.store.data.threads || {})) {
      if (!thread || !thread.formDoneAt || thread.formConfirmed || thread.formMissNotified) continue;
      if (now - thread.formDoneAt < wait) continue;
      const psid = thread.psid || key;
      try { await this.reportFormStatus(psid, thread); } catch (e) { this.log.warn('form check failed', e.message); }
    }
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
      await this.maybeFormChecks(now);
      let slots = 1;
      for (const [key, t] of Object.entries(this.store.data.threads)) {
        const page = this.pageForThread(t, key);
        if (!page || !page.token) continue;
        const psid = (t && t.psid) || (page && !page.primary && String(key).startsWith(`${page.id}:`)
          ? String(key).slice(page.id.length + 1)
          : key);
        try {
          if (slots <= 0) break;
          const outcome = await withPage(page, async () => {
            const sentVideo = await this.maybeVideoFollowUp(psid, this.store.thread(psid), now);
            if (sentVideo) return 'video';
            if (max > 0) return this.maybeFollowUp(psid, this.store.thread(psid), { now, max, afterMs, day, windowMs });
            return 'skip';
          });
          if (outcome === 'video' || outcome === 'sent' || outcome === 'failed') slots -= 1;
        } catch (e) { this.log.error(`follow-up error for ${short(psid)}:`, e.message); }
      }
    } finally {
      this._followRunning = false;
    }
  }

  followUpSkip(psid, t, now, windowMs, { ignorePending = false } = {}) {
    if (!ignorePending && t.followupPending) return 'already sending a follow-up';
    if (t.applianceQuickReplyMutedAt && t.applianceQuickReplyMutedAt >= (t.lastUserTs || 0)) return 'one-time appliance reply: no AI follow-up';
    const last = (t.history || [])[(t.history || []).length - 1];
    const catching = this.shouldCatchHotLead(t, now, last);
    if (!catching && (t.followupCount || 0) >= this.cfg.followupMax) return 'follow-up limit reached';
    if (t.bookingStaffOnly) return 'booking handed to staff';
    if (t.bookingDone) return 'booking form already submitted';
    if (!this.cfg.botEnabled) return 'BOT_ENABLED is off';
    if (t.optedOut) return 'opted out';
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
    if (await this.pageSwitchReason(psid)) return 'skip';
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
      if (await this.pageSwitchReason(psid)) return 'skip';
      const sent = await this.send(psid, capped);
      if (sent === false) return 'skip';
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
      const page = this.pageForReview(row);
      const found = await withPage(page, () => this.graph.findConversation(row.psid));
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
        const thread = (row.threadKey && this.store.data.threads[row.threadKey]) || this.store.data.threads[row.psid];
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
    const slots = new Set([key]);
    for (const page of this.cfg.pages || []) {
      if (page && page.id && !page.primary) slots.add(`${page.id}:${key}`);
    }
    for (const slot of slots) {
      const pending = this.pending.get(slot);
      if (pending && pending.timer) clearTimeout(pending.timer);
      this.pending.delete(slot);
      const timer = this.staffResume && this.staffResume.get(slot);
      if (timer) clearTimeout(timer);
      if (this.staffResume) this.staffResume.delete(slot);
      this.rev.delete(slot);
      this.repliedRev.delete(slot);
      this.chains.delete(slot);
      this.dashInflight.delete(slot);
      this.dashRecent.delete(slot);
    }
    return this.store.forget(key);
  }

  // Admin: let the bot answer this customer again.
  resume(psid) {
    const id = String(psid || '');
    const threads = this.store.data.threads || {};
    const keys = Object.keys(threads).filter((k) => k === id || (threads[k] && String(threads[k].psid || '') === id));
    if (!keys.length) keys.push(id);
    for (const key of keys) {
      const t = threads[key] || this.store.thread(id);
      t.handedOff = false; t.pausedUntil = 0; t.handoffReason = ''; t.passedByBot = false;
    }
    this.store.save();
  }
}

module.exports = { Bot, isActiveNow, keywordHit, isAutomatedEchoText };
