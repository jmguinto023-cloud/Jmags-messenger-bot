'use strict';
// Keep replies on the current topic. Old bookings, cancellations, and intake
// slots must not be repeated unless the customer brings that topic up.

const STALE_MS = 12 * 60 * 60 * 1000;

const PENDING_REVIEW_STATUS = 'Si Ivan na po ang nagre-review pa ng video. Ipapadala po namin ang all-in price soon. Kung urgent po, pwede kayong tumawag sa 09386369374 (Smart) o 09267229506 (Globe).';

const REVIEW_CLARIFY = 'Pakilinaw lang po. Tungkol po ba ito sa video na nire-review ni Ivan para sa all-in price?';

function reviewPending(thread) {
  return Boolean(thread && (thread.problemViaVideo || (thread.mediaNotes || []).length));
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
  PENDING_REVIEW_STATUS,
  REVIEW_CLARIFY,
  reviewPending,
  mentionsOldBooking,
  blamesCustomer,
  asksReviewStatus,
  isUnclearDuringReview,
  visibleHistory,
  recentUserBlob,
  guardStaleReply,
};
