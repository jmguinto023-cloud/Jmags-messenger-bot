'use strict';
// Jm's quote gate (8 Nov 2026). These checks override earlier reply rules.
const fs = require('node:fs');
const path = require('node:path');
const { summarizeConversation } = require('./summary');
const {
  asksCheckupFee, checkupFeeReply, HOME_CHECKUP_FEE_ANSWER, SHOP_CHECKUP_FEE_PLAIN, CHECKUP_FEE_PLAIN,
  scriptedReply, listEstimate, knownSize, listKind,
} = require('./estimate');
const { SAFE_TEMPLATE } = require('./messages');
const PRICE_TABLE = require('../knowledge/prices.json');

const RULES_PATH = path.join(__dirname, '..', 'prompts', 'rules.md');

const MAGKANO_LINE = 'Para po masiguro namin ang tamang presyo, kailangan po muna namin makita ang video at model number. Hindi po kami nagbibigay ng presyo na hindi pa nakikita ang unit.';
const WAIT_LINE = 'Sige po, hintayin po namin. Thank you po.';
const WARRANTY_ONLY = 'May warranty po ang repair namin. I-ko-confirm lang po ng staff namin ang exact coverage para sa unit ninyo.';
const HANDOFF_LINE = 'I-che-check lang po ng staff namin ito at mag-me-message po sila sa inyo shortly.';
// Cracked LCD: staff prices that fault only. The chat stays open for the next question.
const CRACKED_PRICE_LINE = 'I-che-check po ng staff namin ang presyo ng basag na screen.';
const SCHEDULE_HOLD = 'I-che-check lang po namin ang schedule, babalikan po namin kayo agad.';
const VIDEO_ACK = 'Staff na po namin ang magrereview ng photo or video na sinend nyo, pa hintay na lang po salamat po 🙂';
const ASK_VIDEO = 'Pwede po pa-send ng video ng TV habang naka-on?';
const ASK_SIZE = 'Ilang inches po ang TV?';
const ASK_BRAND = 'Anong brand po ng TV?';
const ASK_MODEL = 'Ano po ang model number sa sticker sa likod?';
const ASK_CITY = 'Pwede po malaman kung taga-saan po sila?';
const ASK_BARANGAY = 'Anong barangay po?';
const ASK_REPAIRED = 'Na-repair na po ba ito sa ibang shop?';
const NEED_VIDEO_LINE = 'Depende po sa sira na makikita sa video.';
const NEED_FACTS_LINE = 'Depende po sa size, sira, at maikling video.';

const CITIES = ['quezon city', 'san pablo', 'general trias', 'santa rosa', 'sta rosa', 'sto tomas', 'cavite city', 'las pinas', 'las piñas', 'biñan', 'binan', 'cabuyao', 'calamba', 'dasmariñas', 'dasmarinas', 'paranaque', 'parañaque', 'muntinlupa', 'valenzuela', 'caloocan', 'mandaluyong', 'marikina', 'manila', 'makati', 'taguig', 'pasig', 'pasay', 'imus', 'bacoor', 'silang', 'carmona', 'tanauan', 'malvar', 'lipa', 'san pedro'];
const PROVINCES = ['laguna', 'cavite', 'batangas'];

function rulesText() {
  return fs.readFileSync(RULES_PATH, 'utf8');
}

function slots(thread) {
  if (!thread.slots) thread.slots = {};
  return thread.slots;
}

function grabModel(text) {
  const t = String(text || '');
  const named = t.match(/\b(?:model|modelo)\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i);
  if (named) return named[1];
  const code = t.match(/\b((?:UA|UN|QN|QA|QE|UE|LH|LC|OLED)\d{2}[A-Z0-9-]{2,})\b/);
  return code ? code[1] : '';
}

function grabBarangay(text) {
  const m = String(text || '').match(/\b(?:brgy|barangay)\.?\s+([A-Za-zÑñ][A-Za-zÑñ0-9 .'-]{1,40})/i);
  if (!m) return '';
  return m[1].replace(/\b(city|laguna|cavite|batangas|po|sir)\b.*$/i, '').trim();
}

function grabCity(text) {
  const t = String(text || '').toLowerCase();
  const city = CITIES.find((name) => t.includes(name));
  if (city) return city;
  const province = PROVINCES.find((name) => new RegExp(`\\b${name}\\b`).test(t));
  return province || '';
}

function repairedAnswer(text) {
  const t = String(text || '');
  if (!/ibang shop|another shop|na-?repair|naayos/i.test(t)) return '';
  if (/wala|hindi|di pa|not yet|never|wala pa/i.test(t)) return 'no';
  if (/\b(oo|yes|opo)\b|na-?repair na|naayos na/i.test(t)) return 'yes';
  return '';
}

function isCracked(text) {
  return /basag|cracked|smashed|broken lcd|durog na lcd/i.test(String(text || ''));
}

// Panel-price handoff flags staff for that fault. It must not close the thread.
function isPanelPriceHandoff(reason) {
  return /panel(?:\s|-)?damage|cracked lcd|cracked|basag|broken lcd/i.test(String(reason || ''));
}

function isMagkano(text) {
  return /\bmagkano\b|\bhow much\b|\bpresyo\b|\bprice\b/i.test(String(text || ''));
}

function isWait(text) {
  const t = String(text || '').trim();
  if (!t || /ibang shop|another shop/i.test(t)) return false;
  return /^(?:teka|sandali|hintay|ipapadala ko pa|hahanapin ko pa)\b/i.test(t)
    || /^wala pa(?!\s+ba\b)/i.test(t)
    || /\b(?:teka muna|sandali lang|hintay(?:in)? lang|ipapadala ko pa|hahanapin ko pa)\b/i.test(t);
}

function isScheduleTalk(text) {
  return /kailan po (?:kayo|sila) free|ma-assign|schedule form|booking form|anong araw|umaga o hapon/i.test(String(text || ''));
}

function isRepairQuote(text) {
  const t = String(text || '');
  if (/₱\s?[\d,]/.test(t)) {
    if (/check-?\s*up|checkup/i.test(t) && !/backlight|lcd modification|power supply|motherboard/i.test(t)) return false;
    return true;
  }
  return /possible backlight|palit backlight/i.test(t);
}

function rememberJob(thread) {
  const s = slots(thread);
  const epoch = Number(thread && thread.intakeEpoch) || 0;
  const users = (thread.history || []).filter((h) => {
    if (!h || h.role !== 'user' || !h.content) return false;
    const ts = Number(h.ts) || 0;
    if (epoch && ts && ts < epoch) return false;
    return true;
  }).map((h) => h.content || '');
  const blob = users.join('\n');
  const latestMsg = users[users.length - 1] || '';
  const summary = summarizeConversation([{ content: blob }]);
  if (summary.brand) s.brand = s.brand || summary.brand;
  const latestSize = knownSize(latestMsg);
  if (latestSize) s.size = `${latestSize}"`;
  else if (summary.size) s.size = s.size || summary.size;
  const model = grabModel(blob);
  if (model) s.model = s.model || model;
  const city = grabCity(blob);
  if (city) s.city = s.city || city;
  const barangay = grabBarangay(blob);
  if (barangay) s.barangay = s.barangay || barangay;
  const repaired = repairedAnswer(blob);
  if (repaired) s.repairedElsewhere = repaired;
  if (/\[Customer sent a (?:video|photo)/i.test(blob) || thread.problemViaVideo || (thread.mediaNotes || []).length) {
    thread.videoReceived = true;
  }
  const latestFault = listKind(latestMsg);
  if (latestFault === 'replace' || isCracked(latestMsg)) s.symptom = 'cracked';
  else if (latestFault === 'mod') s.symptom = 'lines';
  else if (latestFault === 'backlight') s.symptom = 'backlight';
  else if (isCracked(blob) && !s.symptom) s.symptom = 'cracked';
  else if (/nawala|walang (?:display|picture|ilaw)|no display|black screen|backlight|lines|linya|ayaw mag-?on|flicker|blink|kislap|kumikislap/i.test(blob) && !s.symptom) {
    s.symptom = 'screen';
  }
  return s;
}

function gatePassed(thread) {
  const s = (thread && thread.slots) || {};
  if (s.symptom === 'cracked' || isCracked(s.problemText)) return false;
  return Boolean(
    thread && thread.videoReceived && thread.videoReviewed
    && s.size && s.brand && s.model
    && s.barangay && s.city
    && s.repairedElsewhere === 'no',
  );
}

function nextAsk(thread) {
  const s = (thread && thread.slots) || {};
  if (s.symptom === 'cracked') return '';
  if (!thread.videoReceived) return ASK_VIDEO;
  if (!s.size) return ASK_SIZE;
  if (!s.brand) return ASK_BRAND;
  if (!s.model) return ASK_MODEL;
  if (!s.city) return ASK_CITY;
  if (!s.barangay) return ASK_BARANGAY;
  if (s.repairedElsewhere !== 'no' && s.repairedElsewhere !== 'yes') return ASK_REPAIRED;
  if (!thread.videoReviewed) return VIDEO_ACK;
  return '';
}

function staffVoice(text) {
  return String(text || '')
    .replace(/\btechnicians?\b(\s+po namin)?/gi, 'staff po namin')
    .replace(/\bIvan\b/g, 'staff')
    .replace(/\bauto-reply assistant po ako[^.]*/gi, 'staff po namin')
    .replace(/\b(?:ako po ay|i am) (?:a |ang )?(?:bot|ai)\b/gi, 'staff po namin')
    .replace(/\bbot ako\b/gi, 'staff po namin');
}

function stripWarrantyLength(text) {
  if (text === WARRANTY_ONLY) return text;
  return String(text || '')
    .replace(/,?\s*\d+\s*months?\s*warranty/gi, '')
    .replace(/\b\d+\s*months?\b/gi, '')
    .replace(/\b\d+\s*buwan\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
}

function isPreparedPriceAnswer(text) {
  const s = String(text || '').trim();
  const leads = [HOME_CHECKUP_FEE_ANSWER, SHOP_CHECKUP_FEE_PLAIN, CHECKUP_FEE_PLAIN, NEED_VIDEO_LINE, NEED_FACTS_LINE];
  return leads.some((lead) => s === lead || s.startsWith(lead));
}

function sizeAndSymptomKnown(thread) {
  const s = (thread && thread.slots) || {};
  return Boolean(s.size && s.symptom && s.symptom !== 'cracked');
}

// One missing quote-gate question after the answer, unless the answer already asks something.
function withOneAsk(lead, thread) {
  const body = String(lead || '').trim();
  if (/\?/.test(body)) return body;
  const ask = nextAsk(thread);
  if (!ask || body.includes(ask)) return body;
  return body ? `${body} ${ask}` : ask;
}

function flexiblePriceReply(thread, latest) {
  if (asksCheckupFee(latest)) return withOneAsk(checkupFeeReply(latest, thread), thread);
  const lead = sizeAndSymptomKnown(thread) ? NEED_VIDEO_LINE : NEED_FACTS_LINE;
  return withOneAsk(lead, thread);
}

function capWords(text) {
  const canonical = [MAGKANO_LINE, WAIT_LINE, WARRANTY_ONLY, HANDOFF_LINE, CRACKED_PRICE_LINE, SCHEDULE_HOLD, VIDEO_ACK, ASK_VIDEO, ASK_SIZE, ASK_BRAND, ASK_MODEL, ASK_CITY, ASK_BARANGAY, ASK_REPAIRED];
  let s = String(text || '');
  if (/Para mabigyan po namin kayo agad ng presyo/.test(s)) return s.trim();
  if (isPreparedPriceAnswer(s)) return s.trim();
  if (canonical.includes(s.trim())) return s;
  if (/^Nasa ₱/i.test(s) || /final po after makita ng staff/i.test(s)) return s.trim();
  // A booking-form message is sent whole. The word cap must not drop the link.
  if (/schedule form|booking form/i.test(s) && /https?:\/\//i.test(s)) return s.trim();
  const emoji = /\p{Extended_Pictographic}/gu;
  const icons = s.match(emoji) || [];
  if (icons.length > 1) {
    let kept = false;
    s = s.replace(emoji, (mark) => {
      if (kept) return '';
      kept = true;
      return mark;
    });
  }
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length > 22) s = words.slice(0, 20).join(' ');
  if (icons[0] && !/\p{Extended_Pictographic}/u.test(s)) s = `${s} ${icons[0]}`;
  return s.trim();
}

function bannedPart(text) {
  return /power supply|mainboard|motherboard/i.test(String(text || ''));
}

function allowedPesos() {
  const set = new Set([300, 1000]);
  for (const key of ['backlight', 'lcdMod', 'lcdReplace']) {
    for (const n of Object.values((PRICE_TABLE && PRICE_TABLE[key]) || {})) {
      if (Number(n) >= 100) set.add(Math.round(Number(n)));
    }
  }
  const check = (PRICE_TABLE && PRICE_TABLE.checkup) || {};
  if (Number(check.home) >= 100) set.add(Math.round(Number(check.home)));
  if (Number(check.shop) >= 100) set.add(Math.round(Number(check.shop)));
  return set;
}
const ALLOWED_PESOS = allowedPesos();

function pesoValue(raw) {
  return Number(String(raw || '').replace(/[^\d]/g, ''));
}

function hasRepairPeso(text) {
  const re = /₱\s?(\d{1,3}(?:,\d{3})+|\d+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = pesoValue(m[1]);
    if (n !== 300 && n !== 1000) return true;
  }
  return false;
}

// A cracked screen plus a different question (size, no-display, warranty, location).
function otherThanCrack(latest) {
  if (!isCracked(latest)) return false;
  // A size next to "basag" is still the cracked panel. A different fault is a second question.
  return /no display|walang (?:display|ilaw|picture)|backlight|\blinya\b|\blines\b|warranty|check-?\s*up|\blocated\b|\bsaan po\b/i.test(String(latest || ''));
}

function stripDayTime(text) {
  return String(text || '')
    .replace(/\b(?:kailan|anong oras|anong araw|what time)\b[^?.!\n]{0,48}\b(?:free|available|bukas|pumunta|punta|sila|kayo)\b[^?.!\n]*/gi, '')
    .replace(/\b(?:bukas|mamaya|mamayang)\b[^?.!\n]{0,24}/gi, '')
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|lunes|martes|miyerkules|huwebes|biyernes|sabado|linggo)\b(?:\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/gi, '')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

function stripUnknownPesos(text, allowRepair) {
  return String(text || '').replace(/₱\s?(\d{1,3}(?:,\d{3})+|\d+)/g, (full, raw) => {
    const n = pesoValue(raw);
    if (!ALLOWED_PESOS.has(n)) return '';
    if (!allowRepair && n !== 300 && n !== 1000) return '';
    return full;
  }).replace(/\s{2,}/g, ' ').trim();
}

function reasksKnown(text, thread) {
  const s = (thread && thread.slots) || {};
  const t = String(text || '');
  if (s.size && /ilang inches|anong size|size po ng tv/i.test(t)) return true;
  if (s.brand && /anong brand/i.test(t)) return true;
  if (s.symptom && /ano po ang sira|anong sira|ano pong sira/i.test(t)) return true;
  return false;
}

function stripPersonNames(text) {
  return String(text || '').replace(/\b(?:si|ni|kay)\s+(?!samsung\b|sony\b|lg\b|tcl\b|sharp\b|hisense\b|devant\b|xiaomi\b|philips\b|haier\b|konka\b|skyworth\b|coocaa\b|astron\b|panasonic\b)[A-Za-z][a-z]{2,}\b/g, 'staff po namin');
}

function isSafeTemplate(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const leads = [NEED_FACTS_LINE, NEED_VIDEO_LINE, HOME_CHECKUP_FEE_ANSWER, CHECKUP_FEE_PLAIN, SHOP_CHECKUP_FEE_PLAIN, ASK_VIDEO, 'Pwede po pa-send ng video', 'Anong brand at size po ng TV sir?', 'Depende po sa sira sir', 'Pwede po sir. ₱1,000', 'Fixed price na po', 'Fixed po ang presyo', 'Para sa ', 'Nasa ₱', CRACKED_PRICE_LINE, WARRANTY_ONLY, HANDOFF_LINE, WAIT_LINE, SCHEDULE_HOLD];
  return leads.some((lead) => t === lead || t.startsWith(lead));
}

function coversScript(cleaned, scripted) {
  const body = String(scripted || '').replace(/\[+\s*HANDOFF\s*:?\s*[^\]]*\]+/gi, '').trim();
  if (!body) return true;
  const needle = body.slice(0, 24).toLowerCase();
  if (String(cleaned || '').toLowerCase().includes(needle)) return true;
  // Asking for the video is a valid answer when the saved script is a repair price.
  if (/video|depende po sa/i.test(cleaned) && /₱/.test(body)) return true;
  return false;
}

function sameWords(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Light cleanup. fallback means the draft broke a hard rule and the old template should be used.
function guardCustomerReply(thread, text, latest) {
  const original = String(text || '');
  const passed = gatePassed(thread);
  let reason = '';
  let handoff = false;
  if (/\[\[?\s*HANDOFF/i.test(original)) {
    const found = original.match(/\[+\s*HANDOFF\s*:?\s*([^\]]*)\]+/i);
    reason = ((found && found[1]) || '').trim() || 'model';
    handoff = true;
  }
  let body = stripPersonNames(staffVoice(stripWarrantyLength(original.replace(/\[+\s*HANDOFF\s*:?\s*[^\]]*\]+/gi, ''))));
  body = stripDayTime(body);
  body = stripUnknownPesos(body, passed);
  if (bannedPart(body)) body = body.replace(/power supply|mainboard|motherboard/gi, 'reprogramming');
  body = body.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/\.{2,}/g, '.').trim();
  const scripted = scriptedReply(latest, thread, { allowPrice: !(thread && (thread.problemViaVideo || (thread.mediaNotes || []).length)) });
  const thin = !body || (body.length < 12 && original.trim().length > body.length + 12);
  const violated = thin
    || (!passed && (hasRepairPeso(original) || isRepairQuote(original) || isScheduleTalk(original) || /https?:\/\//i.test(original)))
    || reasksKnown(original, thread)
    || (String(original).trim() === SAFE_TEMPLATE && scripted)
    || (scripted && !coversScript(body, scripted))
    || (asksCheckupFee(latest) && !/₱\s?(?:300|1,?000)\b/.test(body))
    || (/warranty|garantiya|back-?job|backjob/i.test(latest || '') && body !== WARRANTY_ONLY)
    || (/\b(?:galit|bwisit|tangina|putangina|leche|scam|reklamo)\b/i.test(latest || ''))
    || (/mali (?:po )?(?:yan|yun|yon)|hindi tama|mali po kayo|you(?:'re| are) wrong/i.test(latest || ''));
  return {
    text: capWords(body),
    handoff,
    reason,
    silent: false,
    closeGate: false,
    fallback: violated,
  };
}

function shapeFromScript(thread, latest) {
  const scripted = scriptedReply(latest, thread, {
    allowPrice: !(thread && (thread.problemViaVideo || (thread.mediaNotes || []).length)),
  });
  if (!scripted) return null;
  const found = String(scripted).match(/\[+\s*HANDOFF\s*:?\s*([^\]]*)\]+/i);
  const body = String(scripted).replace(/\[+\s*HANDOFF\s*:?\s*[^\]]*\]+/gi, '').trim();
  const shaped = legacyShape(thread, body, latest);
  return {
    ...shaped,
    handoff: shaped.handoff || Boolean(found),
    reason: (found && found[1] && found[1].trim()) || shaped.reason,
    fallback: true,
  };
}

function legacyShape(thread, text, latest) {
  rememberJob(thread);
  let body = staffVoice(stripWarrantyLength(text));
  const passed = gatePassed(thread);
  const reason = [];
  // Only a crack with no separate question. A later or mixed question is answered.
  if (isCracked(latest) && !otherThanCrack(latest)) {
    const estimate = listEstimate(latest, thread, { force: 'replace' });
    if (estimate) return { text: estimate, handoff: true, reason: 'cracked lcd', silent: false, closeGate: false };
    return { text: ASK_SIZE, handoff: false, reason: '', silent: false, closeGate: false };
  }
  if (/\[\[?\s*HANDOFF/i.test(body)) {
    body = body.replace(/\[+\s*HANDOFF\s*:?\s*[^\]]*\]+/gi, '').trim();
    const found = String(text || '').match(/\[+\s*HANDOFF\s*:?\s*([^\]]*)\]+/i);
    const why = ((found && found[1]) || '').trim() || 'model';
    return { text: body || HANDOFF_LINE, handoff: true, reason: why, silent: false, closeGate: false };
  }
  if (/warranty|garantiya|back-?job|backjob/i.test(latest || '')) {
    return { text: WARRANTY_ONLY, handoff: true, reason: 'warranty or backjob', silent: false };
  }
  if (/mali (?:po )?(?:yan|yun|yon)|hindi tama|mali po kayo|you(?:'re| are) wrong/i.test(latest || '')) {
    return { text: HANDOFF_LINE, handoff: true, reason: 'customer correction', silent: false };
  }
  if (/\b(?:galit|bwisit|tangina|putangina|leche|scam|reklamo)\b/i.test(latest || '')) {
    return { text: HANDOFF_LINE, handoff: true, reason: 'anger', silent: false };
  }
  if (asksCheckupFee(latest) || (!passed && isMagkano(latest))) {
    if (!asksCheckupFee(latest)) {
      const estimate = listEstimate(latest, thread);
      if (estimate) return { text: estimate, handoff: false, reason: '', silent: false };
    }
    return { text: capWords(flexiblePriceReply(thread, latest)), handoff: false, reason: '', silent: false };
  }
  if (!passed && (isRepairQuote(body) || isScheduleTalk(body) || (/https?:\/\//i.test(body) && /form|book|schedule/i.test(body)))) {
    const explain = sizeAndSymptomKnown(thread) ? NEED_VIDEO_LINE : NEED_FACTS_LINE;
    return { text: nextAsk(thread) || capWords(withOneAsk(explain, thread)), handoff: false, reason: '', silent: false };
  }
  if (bannedPart(body)) {
    body = body.replace(/power supply|mainboard|motherboard/gi, 'reprogramming');
  }
  if (passed && /kailan po (?:kayo|sila) free|i-?book|schedule/i.test(latest || '') && /confirmed|naka-?book na|see you/i.test(body)) {
    body = SCHEDULE_HOLD;
  }
  return { text: capWords(body), handoff: false, reason: reason[0] || '', silent: false };
}

// Validator. A clean model draft is kept. A draft that breaks a hard rule falls back to the old template.
function shapeReply(thread, text, latest) {
  rememberJob(thread);
  if (/^Nasa ₱/i.test(String(text || '')) || /^Para sa \d/i.test(String(text || ''))) {
    return { text: String(text || '').trim(), handoff: false, reason: '', silent: false, closeGate: false, fallback: false };
  }
  if (gatePassed(thread) && /https?:\/\//i.test(text) && /form|book|schedule/i.test(text)) {
    return { text: String(text || '').trim(), handoff: false, reason: '', silent: false, closeGate: false, fallback: false };
  }
  if (isCracked(latest) && otherThanCrack(latest)) {
    const rest = legacyShape(thread, text, latest);
    const combined = rest.text && rest.text !== CRACKED_PRICE_LINE
      ? `${CRACKED_PRICE_LINE} ${rest.text}`
      : CRACKED_PRICE_LINE;
    return { text: combined.trim(), handoff: true, reason: 'cracked lcd', silent: false, closeGate: false, fallback: true };
  }
  const legacy = legacyShape(thread, text, latest);
  if (isCracked(latest) && !otherThanCrack(latest)) return { ...legacy, fallback: true };
  if (legacy.reason === 'cracked lcd') return { ...legacy, fallback: true };
  const guarded = guardCustomerReply(thread, text, latest);
  if (asksCheckupFee(latest) || (!gatePassed(thread) && isMagkano(latest))
      || (legacy.handoff && legacy.closeGate !== false && legacy.reason !== 'model' && !isPanelPriceHandoff(legacy.reason))) {
    return { ...legacy, fallback: true };
  }
  if (!guarded.fallback) return guarded;
  if (isSafeTemplate(legacy.text)) return { ...legacy, fallback: true };
  const fromScript = shapeFromScript(thread, latest);
  if (fromScript && (isSafeTemplate(fromScript.text) || fromScript.handoff)) return fromScript;
  return { ...guarded, text: guarded.text || legacy.text, fallback: true };
}

module.exports = {
  rulesText,
  MAGKANO_LINE,
  NEED_VIDEO_LINE,
  NEED_FACTS_LINE,
  WAIT_LINE,
  WARRANTY_ONLY,
  HANDOFF_LINE,
  CRACKED_PRICE_LINE,
  SCHEDULE_HOLD,
  VIDEO_ACK,
  ASK_VIDEO,
  ASK_SIZE,
  flexiblePriceReply,
  rememberJob,
  gatePassed,
  nextAsk,
  isWait,
  isMagkano,
  isCracked,
  isPanelPriceHandoff,
  shapeReply,
  stripWarrantyLength,
  capWords,
  staffVoice,
};
