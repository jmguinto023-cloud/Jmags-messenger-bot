'use strict';
// One scripted nudge, about an hour after a customer's last message, when they asked about
// repairing their TV but never sent a video. No AI, no tokens, once per customer inquiry.
const { optOutReason, staffEscalation } = require('./reply-rules');

const FOLLOWUP_TEXT = 'Hello po! Interesado pa po ba kayong ipaayos ang TV ninyo? 😊 '
  + 'Pakisend lang po ng video ng problema (habang nakabukas ang TV) at ang brand at size nito, '
  + 'para ma-check ng staff namin at makapagbigay agad kami ng estimate. '
  + 'Kung naisend na po ninyo, pakidisregard na lang po itong message.';

const INTEREST = /magkano|presyo|\bprice\b|how much|\bhm\b|estimate|quote|quotation|repair|pagawa|paayos|pa-?ayos|ipaayos|ipagawa|ayusin|gawin|sira|nasira|sirang|ayaw|walang (?:ilaw|display|picture|sound|tunog|power)|patay|black ?out|blackout|bar|guhit|basag|\btv\b|television|\d{2}\s*(?:inch|in\b|")|home service|pa-?check|check-?up|schedule|\bbook/i;
const DECLINES = /\bayaw na\b|hindi na po|di na po|wag na|huwag na|\bcancel|no thanks|salamat na lang|salamat nalang|not interested|naayos na|napaayos na|nakapag ?pa ?ayos na|bumili na/i;
const MEDIA = /\[Customer sent a (?:video|photo)/i;

function cleanText(txt) {
  return String(txt || '').replace(/\[Customer sent a (?:video|photo)[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Did the customer write something that shows they want their TV repaired?
function showsRepairInterest(history) {
  const mine = (history || []).filter((h) => h && h.role === 'user').map((h) => cleanText(h.content)).filter(Boolean);
  if (!mine.length) return false;
  const blob = mine.join('\n');
  if (DECLINES.test(blob) || optOutReason(blob) || staffEscalation(blob)) return false;
  return INTEREST.test(blob);
}

function sentMedia(t, hasReview) {
  if (hasReview) return true;
  return (t.history || []).some((h) => h && h.role === 'user' && MEDIA.test(String(h.content || '')));
}

// '' when the nudge may be sent now, otherwise the reason it must not.
function skipReason(t, { now, afterMs, windowMs, hasReview }) {
  if (!t || !t.lastUserTs) return 'no customer message';
  if (t.interestFollowupAt) return 'already nudged';
  if (t.optedOut) return 'opted out';
  if (t.standby) return 'another app owns the thread';
  if (t.handedOff || t.needsStaff) return 'with staff';
  if (t.bookingDone || t.bookingFormSent || t.bookingStaffOnly || t.formDoneAt) return 'booking started';
  if (t.gateClosed) return 'closed quote gate';
  if (sentMedia(t, hasReview)) return 'video already sent';
  const quietFor = now - t.lastUserTs;
  if (quietFor < afterMs) return 'too soon';
  if (quietFor >= windowMs) return 'outside the messaging window';
  // Staff or the page already answered after the customer's last message.
  if (Number(t.lastHumanEchoAt) > t.lastUserTs) return 'staff replied';
  const history = t.history || [];
  const last = history[history.length - 1];
  if (last && last.role === 'user' && last.ts && last.ts < t.lastUserTs - 1000) return 'stale history';
  if (!showsRepairInterest(history)) return 'no repair interest shown';
  return '';
}

module.exports = { FOLLOWUP_TEXT, showsRepairInterest, skipReason, cleanText };
