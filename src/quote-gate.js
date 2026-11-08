'use strict';
// Jm's quote gate (8 Nov 2026). These checks override earlier reply rules.
const fs = require('node:fs');
const path = require('node:path');
const { summarizeConversation } = require('./summary');

const RULES_PATH = path.join(__dirname, '..', 'prompts', 'rules.md');

const MAGKANO_LINE = 'Para po masiguro namin ang tamang presyo, kailangan po muna namin makita ang video at model number. Hindi po kami nagbibigay ng presyo na hindi pa nakikita ang unit.';
const WAIT_LINE = 'Sige po, hintayin po namin. Thank you po.';
const WARRANTY_ONLY = 'May warranty po ang repair namin. I-ko-confirm lang po ng staff namin ang exact coverage para sa unit ninyo.';
const HANDOFF_LINE = 'I-che-check lang po ng staff namin ito at mag-me-message po sila sa inyo shortly.';
const SCHEDULE_HOLD = 'I-che-check lang po namin ang schedule, babalikan po namin kayo agad.';
const VIDEO_ACK = 'Staff na po namin ang magrereview ng photo or video na sinend nyo, pa hintay na lang po salamat po 🙂';
const ASK_VIDEO = 'Pwede po pa-send ng video ng TV habang naka-on?';
const ASK_SIZE = 'Ilang inches po ang TV?';
const ASK_BRAND = 'Anong brand po ng TV?';
const ASK_MODEL = 'Ano po ang model number sa sticker sa likod?';
const ASK_CITY = 'Pwede po malaman kung taga-saan po sila?';
const ASK_BARANGAY = 'Anong barangay po?';
const ASK_REPAIRED = 'Na-repair na po ba ito sa ibang shop?';

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
  return city || '';
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
  const users = (thread.history || []).filter((h) => h && h.role === 'user').map((h) => h.content || '');
  const blob = users.join('\n');
  const summary = summarizeConversation([{ content: blob }]);
  if (summary.brand) s.brand = s.brand || summary.brand;
  if (summary.size) s.size = s.size || summary.size;
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
  if (isCracked(blob)) s.symptom = 'cracked';
  else if (/nawala|walang display|no display|backlight|lines|linya|ayaw mag-?on/i.test(blob) && !s.symptom) {
    s.symptom = s.symptom || 'screen';
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

function capWords(text) {
  const canonical = [MAGKANO_LINE, WAIT_LINE, WARRANTY_ONLY, HANDOFF_LINE, SCHEDULE_HOLD, VIDEO_ACK, ASK_VIDEO, ASK_SIZE, ASK_BRAND, ASK_MODEL, ASK_CITY, ASK_BARANGAY, ASK_REPAIRED];
  let s = String(text || '');
  if (/Para mabigyan po namin kayo agad ng presyo/.test(s)) return s.trim();
  if (canonical.includes(s.trim())) return s;
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

function shapeReply(thread, text, latest) {
  rememberJob(thread);
  let body = staffVoice(stripWarrantyLength(text));
  const passed = gatePassed(thread);
  const reason = [];
  if (isCracked(latest) || (thread.slots && thread.slots.symptom === 'cracked')) {
    return { text: HANDOFF_LINE, handoff: true, reason: 'cracked lcd', silent: false };
  }
  if (/\[\[?\s*HANDOFF/i.test(body)) {
    body = body.replace(/\[+\s*HANDOFF\s*:?\s*[^\]]*\]+/gi, '').trim();
    return { text: body || HANDOFF_LINE, handoff: true, reason: 'model', silent: false };
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
  if (!passed && isMagkano(latest)) {
    return { text: MAGKANO_LINE, handoff: false, reason: '', silent: false };
  }
  if (!passed && (isRepairQuote(body) || isScheduleTalk(body) || (/https?:\/\//i.test(body) && /form|book|schedule/i.test(body)))) {
    return { text: nextAsk(thread) || MAGKANO_LINE, handoff: false, reason: '', silent: false };
  }
  if (bannedPart(body)) {
    body = body.replace(/power supply|mainboard|motherboard/gi, 'reprogramming');
  }
  if (passed && /kailan po (?:kayo|sila) free|i-?book|schedule/i.test(latest || '') && /confirmed|naka-?book na|see you/i.test(body)) {
    body = SCHEDULE_HOLD;
  }
  return { text: capWords(body), handoff: false, reason: reason[0] || '', silent: false };
}

module.exports = {
  rulesText,
  MAGKANO_LINE,
  WAIT_LINE,
  WARRANTY_ONLY,
  HANDOFF_LINE,
  SCHEDULE_HOLD,
  VIDEO_ACK,
  ASK_VIDEO,
  rememberJob,
  gatePassed,
  nextAsk,
  isWait,
  isMagkano,
  isCracked,
  shapeReply,
  stripWarrantyLength,
  capWords,
  staffVoice,
};
