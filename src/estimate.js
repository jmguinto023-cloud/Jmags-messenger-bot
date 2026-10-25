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
  const dark = /walang (?:display|picture|ilaw)|no (?:display|picture|visual)|black screen/i.test(t);
  if (/(?:sound|tunog)/i.test(t) && dark) return 'backlight';
  if (/may linya|\blinya\b|may lines|\blines\b|lcd modification|\bmodif/i.test(t) || /gumuguhit|flicker|bar line/i.test(t)) return 'lcd-mod';
  if (/backlight/i.test(t)) return 'backlight';
  return '';
}

const BRANDS = ['samsung', 'tcl', 'lg', 'sony', 'panasonic', 'skyworth', 'hisense', 'konka', 'haier', 'sharp', 'xiaomi', 'philips', 'devant', 'coocaa', 'astron'];

function brandLabel(name) {
  return name.length <= 3 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

function unitLabel(blob, size) {
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(blob));
  return brand ? `${brandLabel(brand)} ${size}` : `${size}"`;
}

function chatBlob(latest, thread = {}) {
  const slots = thread.slots || {};
  const users = (thread.history || []).filter((h) => h && h.role === 'user').map((h) => h.content || '').join('\n');
  return `${slots.brandSize || ''}\n${slots.problemText || ''}\n${users}\n${latest || ''}`;
}

function asksPrice(text) {
  return /magkano|presyo|how much|\bhm\b|\bprice\b/i.test(text || '');
}

function backlightQuote(label, price, possible) {
  const head = possible ? 'Possible backlight po' : 'Palit backlight';
  return `${label} po sir. ${head}, ${phpAmount(price)}. Kasama testing, 6 months warranty, at home service.`;
}

function lcdQuote(label, price) {
  return `${label} po sir. LCD modification ${phpAmount(price)}. Kasama repair, warranty, at home service.`;
}

// One price row for the model. Other sizes stay out of the request so Groq accepts it.
function priceHint(size) {
  const n = Number(size) || 0;
  if (!n) return 'No size yet. Ask brand and size. Do not invent a price.';
  if (n === 85) return '85" backlight ₱22,000 other brands, ₱28,000 Samsung, Sony, Sharp, LG, Hisense, Devant. No LCD modification price. Hand off for LCD modification.';
  const bits = [];
  if (BACKLIGHT[n]) bits.push(`backlight ${phpAmount(BACKLIGHT[n])}`);
  if (LCD_MOD[n]) bits.push(`LCD modification ${phpAmount(LCD_MOD[n])}`);
  let line = bits.length ? `${n}" ${bits.join(', ')}.` : `${n}" has no confirmed backlight or LCD modification price. Hand off.`;
  if (n === 55) line += ' 55" Samsung brand-new nasa around ₱35,000. Repair ₱8,500. About ₱26,500 less.';
  else line += ' Do not invent a brand-new price.';
  return line;
}

// A short table answer. No "Confirmed:". Do not ask the fault again once it is known.
function confirmedPriceReply(latest, thread = {}) {
  const ask = String(latest || '');
  const blob = chatBlob(ask, thread);
  const size = knownSize(blob);
  if (!size) return '';
  const fault = faultKind(blob);
  const stated = Boolean(faultKind(ask));
  if (!asksPrice(ask) && !stated) return '';
  const label = unitLabel(blob, size);
  const possible = /sound|tunog/i.test(blob) && !/\bbacklight\b/i.test(ask);
  if (fault === 'backlight') {
    if (size === 85) {
      const premium = PREMIUM_85.test(blob);
      const price = premium ? 28000 : 22000;
      const who = premium ? 'Samsung, Sony, Sharp, LG, Hisense, Devant' : 'ibang brand';
      return `${label} po sir. ${possible ? 'Possible backlight po' : 'Palit backlight'}, ${phpAmount(price)} (${who}). 6 months warranty, home service.`;
    }
    const price = BACKLIGHT[size];
    if (!price) return '';
    return backlightQuote(label, price, possible);
  }
  if (fault === 'lcd-mod') {
    if (!LCD_MOD[size]) return '85" LCD modification po, wala pang confirmed price. Si Ivan na po ang magko-confirm.\n[HANDOFF: 85 inch LCD modification has no confirmed price]';
    return lcdQuote(label, LCD_MOD[size]);
  }
  if (!asksPrice(ask)) return '';
  if (size === 85) {
    return `85" po sir. Backlight ${phpAmount(22000)} other brands, ${phpAmount(28000)} Samsung, Sony, Sharp, LG, Hisense, Devant. LCD modification, si Ivan na po.\nAno po ang sira?`;
  }
  const back = BACKLIGHT[size];
  const mod = LCD_MOD[size];
  if (!back && !mod) return '';
  const bits = [back ? `backlight ${phpAmount(back)}` : '', mod ? `LCD modification ${phpAmount(mod)}` : ''].filter(Boolean);
  return `${label} po sir. ${bits.join(', ')}.\nAno po ang sira, walang display o may linya?`;
}

const LOCATION_LINE = 'home service po kami sir, Cavite, Laguna at Batangas. saan po location nyo?';
const WARRANTY_LINE = 'May warranty po sir. Backlight at new LCD 6 months. Motherboard at power supply 5 months. Rebonding 3 months. LCD repair 3 months (32-65) o 2 months (70-85).';

function discountReply(text) {
  if (!/discount|tawad|\bpromo\b|less pa|pa[\s-]*less|ibababa|lower (?:the )?price/i.test(text || '')) return '';
  return 'Fixed po ang presyo sir. Kasama ang warranty at home service, walang hakot. Si Ivan na po ang kakausap.\n[HANDOFF: asked for a discount]';
}

function locationReply(text) {
  if (!/san po kayo|saan po kayo|saan (?:po )?(?:ang )?(?:shop|branch)|nasaan (?:po )?(?:kayo|ang shop|ang branch)|where are you|\blocated\b|location (?:nyo|niyo|ninyo)|anong address|address (?:nyo|niyo)|hanggang saan/i.test(text || '')) return '';
  return LOCATION_LINE;
}

function warrantyReply(text) {
  const t = String(text || '');
  if (!/warranty|garantiya|garanty/i.test(t)) return '';
  if (/sira ulit|nasira|backjob|walang resibo|no receipt/i.test(t)) {
    return 'Warranty po nito, si Ivan na ang titingin sir.\n[HANDOFF: warranty question]';
  }
  if (/backlight/i.test(t)) return 'Backlight po sir, 6 months warranty.';
  if (/new lcd|lcd panel/i.test(t)) return 'New LCD panel po sir, 6 months warranty.';
  if (/motherboard|\bboard\b|power supply|\bpsu\b/i.test(t) && /power|psu|supply/i.test(t)) return 'Power supply po sir, 5 months warranty.';
  if (/motherboard|\bboard\b/i.test(t)) return 'Motherboard po sir, 5 months warranty.';
  if (/rebond/i.test(t)) return 'Rebonding po sir, 3 months warranty.';
  if (/lcd repair|lcd modification|\bmodif/i.test(t)) return 'LCD repair po sir, 3 months (32-65) o 2 months (70-85).';
  if (/warranty (?:ng|sa|for)\b/i.test(t)) {
    return 'Warranty po nito, si Ivan na ang magko-confirm sir.\n[HANDOFF: warranty question]';
  }
  return WARRANTY_LINE;
}

function homeSoonReply(text) {
  const t = String(text || '');
  if (!/home\s*service/i.test(t)) return '';
  if (!/\bbukas\b|tomorrow|pwede|pede|puwede/i.test(t)) return '';
  return 'Pwede po magpa-home service sir. ₱1,000 check-up, waived pag tinuloy ang repair. Bukas hindi pa confirmed.';
}

function hesitationReply(latest, thread) {
  if (!/\bmahal\b|too expensive|low budget|pag-?iisipan|iisipin ko/i.test(latest || '')) return '';
  const blob = chatBlob(latest, thread);
  if (/\b55\b/.test(blob) && /samsung/i.test(blob)) {
    return '55 Samsung brand-new nasa around ₱35,000 po sir. Repair ₱8,500, about ₱26,500 less, may warranty at home service. Kailan po kayo free?';
  }
  return 'Repair po sir is less than brand new, may warranty at home service, walang hakot. Kailan po kayo free?';
}

function vagueRepairReply(text) {
  if (knownSize(text)) return '';
  if (!/hm po repair ng tv|repair ng tv/i.test(text || '')) return '';
  return 'Anong brand at size po ng TV sir?';
}

// Answers that must not go to the small model.
function scriptedReply(latest, thread = {}, { allowPrice = true } = {}) {
  return discountReply(latest)
    || locationReply(latest)
    || warrantyReply(latest)
    || homeSoonReply(latest)
    || (allowPrice ? (confirmedPriceReply(latest, thread) || vagueRepairReply(latest)) : '')
    || hesitationReply(latest, thread)
    || '';
}

module.exports = {
  PRICE_RANGE,
  LCD_MOD,
  BACKLIGHT,
  confirmedPriceReply,
  scriptedReply,
  priceHint,
  knownSize,
  LOCATION_LINE,
  WARRANTY_LINE,
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
