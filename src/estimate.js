'use strict';
// Preliminary ranges, the plain check-up fee, and guards for video-received chats.
const { questionTopic } = require('./intake');
const { HOME_VISIT_FEE_LINE, homeTerms } = require('./home-visit-fee');

// Low and high of each size row on the price table (before the internal distance add-on).
const PRICE_RANGE = {
  32: [2000, 4800],
  40: [3000, 10000],
  43: [3500, 12000],
  48: [4500, 14000],
  49: [4500, 15000],
  50: [4500, 15000],
  55: [5000, 18000],
  60: [6000, 25000],
  65: [8000, 27000],
  70: [9500, 38000],
  75: [10500, 40000],
  80: [11500, 43000],
  85: [11500, 46000],
};

// Owner-confirmed service rates. Never imply a waiver for shop checkups.
const SHOP_CHECKUP_PHP = 300;
const SHOP_CHECKUP_FEE_PLAIN = '₱300 po ang check-up kapag dadalhin ninyo ang TV sa JMAGS shop.';
const CHECKUP_FEE_PLAIN = '₱300 po ang check-up kung dadalhin ang TV sa shop. Kung home service naman, ₱1,000 po ang check-up; waived ito kapag itinuloy ang repair. Sa shop po ba o home service?';
const CHECKUP_NUDGE = 'Pero mas mainam pa rin po na ma-check ng technician personally ang TV para mas eksakto ang estimate. Pwede po tayong mag-request ng home-service check-up: ₱1,000 po, waived kung itutuloy ang repair.';
const SHOP_TERMS = /\b(?:shop|branch|walk[\s-]?in|drop[\s-]?off)\b|\b(?:dadalhin|dalhin|dinala|magdadala|punta)\b.{0,35}\b(?:shop|branch)\b/i;

function checkupFeeReply(latestUser, thread = {}) {
  const current = String(latestUser || '');
  // Prefer the explicitly requested option over older chat history.
  if (homeTerms(current)) return HOME_VISIT_FEE_LINE;
  if (SHOP_TERMS.test(current)) return SHOP_CHECKUP_FEE_PLAIN;
  // On an ambiguous follow-up, consider the latest explicitly selected mode.
  const recent = (thread.history || []).slice(-6).reverse().find((m) =>
    m && m.role === 'user' && (homeTerms(m.content) || SHOP_TERMS.test(m.content)));
  if (recent) return homeTerms(recent.content) ? HOME_VISIT_FEE_LINE : SHOP_CHECKUP_FEE_PLAIN;
  return CHECKUP_FEE_PLAIN;
}

function peso(n) {
  return `₱${Number(n).toLocaleString('en-US')}`;
}

function manilaClock(ts, tz = 'Asia/Manila') {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts || Date.now())).map((x) => [x.type, x.value]));
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function mediaReceivedNote(kind, ts, tz) {
  const when = manilaClock(ts, tz);
  return `[Customer sent a ${kind} at ${when} - RECEIVED, forwarded to technician Ivan for review. You cannot view it, but it WAS received.]`;
}

function asksCheckupFee(text) {
  const t = String(text || '');
  if (!/check-?\s*up|checkup|tsek-?\s*ap|tsekap/i.test(t)) return false;
  return /magkano|how much|\bhm\b|\bfee\b|presyo|price|gasto/i.test(t);
}

function asksEstimate(text) {
  if (asksCheckupFee(text)) return false;
  return /magkano|how much|estimate|presyo|quotation|\bquote\b|\bprice\b/i.test(text || '');
}

function deniesReceipt(text) {
  return /hindi (?:pa )?(?:po )?(?:namin )?(?:nakikita|nakita)|hindi po namin nakikita|was not received|wasn't received|did not receive|didn't receive|not received|hindi (?:po )?(?:namin )?natanggap|wala (?:po )?(?:kami|kaming) (?:natanggap|nakita)/i.test(text || '');
}

function asksResend(text) {
  return /ulit i-send|i-send ulit|paki-?send(?: po)? ulit|send (?:it )?again|\bresend\b|pakiulit/i.test(text || '');
}

function sizeInches(thread) {
  const blob = `${thread.slots?.brandSize || ''}`;
  const m = blob.match(/\b(32|40|43|48|49|50|55|60|65|70|75|80|85)\b/);
  return m ? m[1] : '';
}

function rangeSentence(thread) {
  const size = sizeInches(thread);
  const row = PRICE_RANGE[size];
  if (!row) return '';
  const label = thread.slots?.brandSize || `${size}"`;
  return `Karaniwang range po for ${label} ay ${peso(row[0])}–${peso(row[1])}; final price po after makita ng technician ang video.`;
}

function problemOnlyViaVideo(thread) {
  return Boolean(thread.problemViaVideo) && !thread.slots?.problemText;
}

function isPreliminaryRange(text) {
  const t = String(text || '');
  if (/check-up fee/i.test(t) && !/karaniwang range/i.test(t)) return false;
  const amounts = t.match(/₱\s?[\d,]+/g) || [];
  return amounts.length >= 2 || /karaniwang range/i.test(t);
}

function appendCheckupNudge(text, thread) {
  const clean = String(text || '').trim();
  if (!clean || /ma-check ng technician personally/i.test(clean)) return clean;
  if (!isPreliminaryRange(clean)) return clean;
  void thread;
  return `${clean}\n${CHECKUP_NUDGE}`;
}

function reviewStatus(thread) {
  const range = rangeSentence(thread);
  const base = 'Si Ivan na po ang nagre-review ng video at magme-message po kami ng all-in price soon.';
  return range ? `${base} ${range}` : base;
}

function estimateReply(thread) {
  return rangeSentence(thread)
    || 'Para mabigyan po kayo ng range, anong brand at size po ng TV? Si Ivan na po ang nagre-review ng video.';
}

function mediaWasReceived(thread) {
  return Boolean(thread.problemViaVideo || (thread.mediaNotes || []).length);
}

// Rewrite model text that denies a received video, re-asks a video-only problem, or skips the check-up nudge.
function applyCustomerGuard(thread, text, latestUser) {
  if (asksCheckupFee(latestUser)) return checkupFeeReply(latestUser, thread);
  let out = String(text || '').trim();
  const received = mediaWasReceived(thread);
  if (received && (deniesReceipt(out) || asksResend(out))) {
    out = reviewStatus(thread);
  } else if (received && problemOnlyViaVideo(thread) && asksEstimate(latestUser)) {
    if (questionTopic(out) === 'problem' || !isPreliminaryRange(out)) out = estimateReply(thread);
  }
  return appendCheckupNudge(out, thread);
}

const LCD_MOD = { 32: 2500, 40: 4500, 43: 5000, 50: 6500, 55: 8500, 60: 9500, 65: 9500, 70: 12500, 75: 14000 };
const BACKLIGHT = { 32: 2500, 40: 4000, 43: 4500, 50: 5500, 55: 8500, 60: 9000, 65: 9500, 70: 12000, 75: 16000 };
const PREMIUM_85 = /samsung|sony|sharp|\blg\b|hisense|devant/i;

function phpAmount(n) {
  return `₱${Number(n).toLocaleString('en-US')}`;
}

function knownSize(text) {
  const m = String(text || '').match(/\b(32|40|43|48|49|50|55|60|65|70|75|80|85)\b/);
  return m ? Number(m[1]) : 0;
}

function faultKind(text) {
  const t = String(text || '');
  if (/backlight|walang display|no display|black screen|walang ilaw|no visual/i.test(t)) return 'backlight';
  if (/lcd modification|modif|gumuguhit|flicker|bar line|\blines\b/i.test(t)) return 'lcd-mod';
  return '';
}

// A short confirmed-table answer when they ask the price and the size is already known.
// Fault unknown: one check question plus the two confirmed repair prices. No emoji.
function confirmedPriceReply(latest, thread = {}) {
  const ask = String(latest || '');
  if (!/magkano|presyo|how much|\bhm\b|\bprice\b/i.test(ask)) return '';
  const slots = thread.slots || {};
  const prior = (thread.history || []).slice(0, -1).map((h) => h.content || '').join('\n');
  const blob = `${slots.brandSize || ''}\n${slots.problemText || ''}\n${prior}\n${ask}`;
  const size = knownSize(blob);
  if (!size) return '';
  const label = slots.brandSize || `${size}"`;
  const fault = faultKind(blob);
  if (fault === 'backlight') {
    if (size === 85) {
      const premium = PREMIUM_85.test(blob);
      const price = premium ? 28000 : 22000;
      const who = premium ? 'Samsung, Sony, Sharp, LG, Hisense, o Devant' : 'ibang brand';
      return `${label} po, palit backlight: ${phpAmount(price)} (${who}). Kasama ang testing, 6 months warranty, at home service sa package.\nKailan po sila free?`;
    }
    const price = BACKLIGHT[size];
    if (!price) return '';
    return `${label} po, palit backlight: ${phpAmount(price)}. Kasama ang LED strips, testing, 6 months warranty, at home service sa package.\nKailan po sila free?`;
  }
  if (fault === 'lcd-mod') {
    if (!LCD_MOD[size]) return '85" LCD modification po, wala pang confirmed price. Si Ivan na po ang magko-confirm.\n[HANDOFF: 85 inch LCD modification has no confirmed price]';
    return `${label} po, LCD modification: ${phpAmount(LCD_MOD[size])}. Kasama ang repair, testing, warranty, at home service sa package.\nKailan po sila free?`;
  }
  if (size === 85) {
    return `85" po. Backlight ${phpAmount(22000)} sa ibang brand, ${phpAmount(28000)} kung Samsung, Sony, Sharp, LG, Hisense, o Devant. LCD modification, si Ivan na po.\nAno po ang sira?`;
  }
  const back = BACKLIGHT[size];
  const mod = LCD_MOD[size];
  if (!back && !mod) return '';
  const bits = [back ? `backlight ${phpAmount(back)}` : '', mod ? `LCD modification ${phpAmount(mod)}` : ''].filter(Boolean);
  return `${label} po. Confirmed: ${bits.join(', ')}.\nAno po ang sira, walang display o may lines?`;
}

module.exports = {
  PRICE_RANGE,
  LCD_MOD,
  BACKLIGHT,
  confirmedPriceReply,
  CHECKUP_FEE_PLAIN,
  SHOP_CHECKUP_PHP,
  SHOP_CHECKUP_FEE_PLAIN,
  checkupFeeReply,
  CHECKUP_NUDGE,
  mediaReceivedNote,
  asksCheckupFee,
  applyCustomerGuard,
  rangeSentence,
  appendCheckupNudge,
};
