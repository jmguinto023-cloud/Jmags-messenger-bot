'use strict';
// Keep replies on the current topic. Old bookings, cancellations, and intake
// slots must not be repeated unless the customer brings that topic up.

const { remindsMissingProof } = require('./evidence');
const STALE_MS = 12 * 60 * 60 * 1000;

const REVIEW_MS = 24 * 60 * 60 * 1000;
const PENDING_REVIEW_STATUS = 'Ang technician po namin ang nagre-review pa ng video. Ipapadala po namin ang all-in price soon.';
const REVIEW_CLARIFY = 'Pakilinaw lang po. Tungkol po ba ito sa video na nire-review ng staff po namin para sa all-in price?';
const PRICE_ASK = "Depende po sa size at sira, ma'am/sir. Ilang inches po?";
const PRICE_ASK_AGAIN = "Depende po sa size at sira, ma'am/sir. Ilang inches po at anong brand?";
const CALL_LINE = 'Pwede po kayong tumawag sa 09386369374 (Smart) o 09267229506 (Globe).';

function reviewPending(thread) {
  return Boolean(thread && (thread.problemViaVideo || (thread.mediaNotes || []).length));
}

function explicitNewUnit(text) {
  return /\bpanibago\b|\bibang tv\b|\banother tv\b|\bbagong (?:tv|unit)\b|\bnew tv\b/i.test(String(text || ''));
}

function asksBarePrice(text) {
  const t = String(text || '');
  if (/check-?\s*up|checkup|tsek-?\s*ap|tsekap/i.test(t)) return false;
  if (/\b(inch|pulgada|samsung|lg|tcl|sony|devant|astron|backlight|linya|lines|display)\b/i.test(t)) return false;
  return /\bpagawa\b|\bipapagawa\b/i.test(t);
}

function asksForACall(text) {
  return /\btumawag\b|\btawagan\b|\bnumero\b|\bphone\b|\bcontact number\b|anong number|paano (?:po )?(?:kami )?(?:tatawag|tumawag)/i.test(String(text || ''));
}

function mediaClock(thread) {
  let ts = Number(thread && thread.lastMediaAckAt) || 0;
  for (const h of (thread && thread.history) || []) {
    const content = String((h && h.content) || '');
    if (/\[Customer sent a (?:video|photo)/i.test(content) || /nasend ko na ang vide/i.test(content)) {
      ts = Math.max(ts, Number(h.ts) || 0);
    }
  }
  return ts;
}

// A video from yesterday is not the job they are asking about now.
function reviewIsCurrent(thread, now = Date.now()) {
  if (!reviewPending(thread)) return false;
  const at = mediaClock(thread) || Number(thread.lastUserTs) || 0;
  if (!at) return false;
  return now - at < REVIEW_MS;
}

function releaseOldReview(thread, latestText, now = Date.now()) {
  if (!thread) return false;
  // A correction that the video or model was never seen is the same job.
  if (remindsMissingProof(latestText)) return false;
  const pending = reviewPending(thread) || thread.intakeClosed;
  if (!pending) return false;
  const newJob = explicitNewUnit(latestText);
  if (reviewIsCurrent(thread, now) && !newJob) return false;
  thread.problemViaVideo = false;
  thread.intakeClosed = false;
  thread.intakeCloseSent = false;
  thread.mediaNotes = [];
  thread.awaitingVideo = false;
  thread.videoReplyAt = 0;
  thread.intakeEpoch = now;
  if (newJob && thread.slots) {
    thread.slots.brand = '';
    thread.slots.size = '';
    thread.slots.symptom = '';
    thread.slots.brandSize = '';
    thread.slots.problemOrVideo = false;
    thread.slots.problemText = '';
    thread.slots.age = '';
    thread.slots.location = '';
    thread.slots.repairedElsewhere = '';
  }
  return true;
}

function sameText(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A second identical price question gets the explanation, not a copy of the first bubble.
function varyRepeated(thread, text) {
  const last = [...((thread && thread.history) || [])].reverse().find((h) => h && h.role === 'assistant' && h.content);
  if (!last || !sameText(last.content, text)) return text;
  if (sameText(text, PRICE_ASK) || /para mabigyan po kayo ng range/i.test(text)) return PRICE_ASK_AGAIN;
  if (sameText(text, PRICE_ASK_AGAIN)) return 'Anong brand po ng TV?';
  return text;
}

function mentionsOldBooking(text) {
  return /cancel|kansel|kinancel|nag-?cancel|huwag muna|reschedul|i-?resched|yung booking|booking niyo|naka-?book|appointment/i.test(String(text || ''));
}

function blamesCustomer(text) {
  return /kayo po mismo|mismo nagsabi|nagsabi po kayo|sinabi niyo|kayo ang nagsabi|ikaw ang nagsabi/i.test(String(text || ''));
}

function isSlotFact(text) {
  return /\b\d+\s*(?:taon|years?|yrs?)\b|\b(?:32|40|43|48|49|50|55|60|65|70|75|80|85)\s*(?:inch|pulgada|")|\b(?:samsung|sony|lg|tcl|panasonic|sharp|devan)\b|taga[-\s]|san pablo|bi[nñ]an|cabuyao|laguna|cavite|manila|general trias/i.test(String(text || ''));
}

function isOldFact(text) {
  return mentionsOldBooking(text) || isSlotFact(text);
}

// Short status checks while a video is waiting on Ivan. The longer
// "Ok na ba yung video nareview na?" stays on the existing review-status path.
function asksReviewStatus(text) {
  const t = String(text || '').trim().replace(/[?!.]+$/g, '').trim();
  if (!t || mentionsOldBooking(t)) return false;
  if (/^(ok(?:ay)? na ba|kamusta(?: na)?(?: po)?|wala pa ba(?: po)?|update(?: po)? na ba)$/i.test(t)) return true;
  return /^ano na\b/i.test(t) && t.length <= 24;
}

function isUnclearDuringReview(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return false;
  if (asksReviewStatus(t) || mentionsOldBooking(t)) return false;
  if (/\b(salamat|opo|sige|oo|hindi|hello|hi|magkano|presyo|price|check-?\s*up|taon|inch|taga|video|photo|larawan|brand|size|lugar|address)\b/i.test(t)) return false;
  return /^(saan|alin|anong|ano|pano|paano|huh|ha)\b/i.test(t);
}

function topicAnchorTs(history) {
  let mediaTs = 0;
  let newerInquiry = 0;
  for (const h of history || []) {
    const ts = Number(h.ts) || 0;
    if (!ts) continue;
    if (/\[Customer sent a (?:video|photo)/i.test(h.content || '')) mediaTs = Math.max(mediaTs, ts);
    if (h.role === 'user' && mediaTs && ts > mediaTs && /\b(ibang tv|another tv|panibagong|bagong sira)\b/i.test(h.content || '')) {
      newerInquiry = ts;
    }
  }
  return Math.max(mediaTs, newerInquiry);
}

function visibleHistory(history, now, { keepOldTopic = false, pendingReview = false } = {}) {
  const rows = history || [];
  if (keepOldTopic) return rows.slice();
  const anchor = topicAnchorTs(rows);
  const ageCutoff = (Number(now) || Date.now()) - STALE_MS;
  return rows.filter((h, i) => {
    const latestUser = h.role === 'user' && i === rows.length - 1;
    if (latestUser) return true;
    // A video review must not be answered from an older cancellation, even one
    // the Page automation just repeated.
    if (pendingReview && mentionsOldBooking(h.content)) return false;
    const ts = Number(h.ts) || 0;
    if (!ts) return true;
    const beforeTopic = Boolean(anchor && ts < anchor);
    const old = ts < ageCutoff;
    // Hide booking, cancel, and slot facts from before this video or older than
    // 12 hours. Other lines in the same exchange stay, including a caption that
    // arrived a moment before the attachment.
    if ((beforeTopic || old) && isOldFact(h.content)) return false;
    return true;
  });
}

function recentUserBlob(thread, now = Date.now()) {
  const rows = visibleHistory(thread && thread.history, now, { pendingReview: reviewPending(thread) });
  return rows.filter((h) => h.role === 'user').map((h) => h.content).join('\n');
}

function guardStaleReply(thread, text, latestUser) {
  let out = String(text || '').trim();
  const pending = reviewPending(thread);
  const askedOld = mentionsOldBooking(latestUser);
  if (blamesCustomer(out)) {
    out = out.split(/(?<=[.!?])\s+/).filter((part) => !blamesCustomer(part)).join(' ').trim();
  }
  if (!askedOld && mentionsOldBooking(out)) {
    if (pending) out = PENDING_REVIEW_STATUS;
    else out = out.split(/(?<=[.!?])\s+/).filter((part) => !mentionsOldBooking(part)).join(' ').trim();
  }
  if (!out) out = pending ? PENDING_REVIEW_STATUS : 'Sige po. Paano po kami makakatulong sa inyo ngayon?';
  return out;
}

module.exports = {
  STALE_MS,
  REVIEW_MS,
  PENDING_REVIEW_STATUS,
  REVIEW_CLARIFY,
  PRICE_ASK,
  PRICE_ASK_AGAIN,
  CALL_LINE,
  reviewPending,
  reviewIsCurrent,
  releaseOldReview,
  explicitNewUnit,
  asksBarePrice,
  asksForACall,
  varyRepeated,
  mentionsOldBooking,
  blamesCustomer,
  asksReviewStatus,
  isUnclearDuringReview,
  visibleHistory,
  recentUserBlob,
  guardStaleReply,
};
