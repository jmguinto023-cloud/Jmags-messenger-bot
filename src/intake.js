'use strict';
// What we already know about a TV job, so the bot does not ask for it again.
const { summarizeConversation } = require('./summary');

const CLOSE_LINE = 'Salamat po. Ang technician po namin ang nagre-review ng video at ipapadala po namin ang all-in price shortly.';

const QUESTIONS = {
  symptom: 'Ano po ang sira? May sound pero walang picture, may lines, o ayaw mag-on?',
  size: 'Ilang inches po ang TV ninyo?',
  brand: 'Anong brand po ng TV?',
  location: 'Taga saan po kayo?',
  brandSize: 'Anong brand at size po ng TV?',
  age: 'Ilang taon na po ang TV?',
  repaired: 'Na-repair na po ba ito sa ibang shop?',
  problem: 'Ano po ang problema ng TV?',
};

// "Sira" by itself is not a diagnosis. These are the symptoms we can price.
function specificSymptom(text) {
  const t = String(text || '');
  if (/\bbacklight\b|walang (?:display|picture|ilaw)|no (?:display|picture|visual)|black screen|flicker|blink(?:ing)?|kislap|kumikislap/i.test(t)) return 'backlight';
  if (/may (?:sound|tunog).{0,40}walang|walang.{0,30}(?:sound|tunog)/i.test(t)) return 'backlight';
  if (/may linya|\blinya\b|may lines|\blines\b|gumuguhit|bar line/i.test(t)) return 'lines';
  if (/ayaw mag-?on|hindi (?:nag-?o?on|bumubukas)|di umaandar|walang power|no power|won'?t turn on|will not turn on/i.test(t)) return 'power';
  return '';
}

// "Wala pa" is not "walang display". It answers the other-shop question.
function priorShopAnswer(text) {
  return /\bwala pa\b|wala pang ibang|ibang shop|another shop|hindi pa na(?:ayos|repair)|di pa naayos/i.test(String(text || ''));
}

function latestCustomerText(thread, latestText) {
  const given = String(latestText || '').trim();
  if (given) return given;
  const users = (thread && thread.history || []).filter((h) => h && h.role === 'user' && h.content);
  return users.length ? users[users.length - 1].content : '';
}

function symptomAlreadyAsked(thread) {
  if (thread && thread.lastAskedTopic === 'symptom') return true;
  return (thread && thread.history || []).some((h) => h && h.role === 'assistant' && questionTopic(h.content) === 'symptom');
}

function problemClaim(text) {
  return /nasa video|na-?sen[dt] ko na ang vide[oi]|nasend ko na ang vide[oi]|nandito sa video|kita sa video|makikita sa video|pinakita|pinadala ko na ang video|sent the video|problem.{0,40}video|video.{0,40}problem|sa video (?:po )?(?:ang|yung) (?:problema|issue|sira)/i.test(text || '');
}

function questionTopic(text) {
  const t = String(text || '');
  if (!/\?/.test(t)) return '';
  if (/ano po ang sira\?|may sound pero walang picture|may lines, o ayaw/i.test(t)) return 'symptom';
  if (/ilang inches|ilang inch/i.test(t)) return 'size';
  if (/anong brand po ng tv/i.test(t)) return 'brand';
  if (/taga saan po kayo/i.test(t)) return 'location';
  if (/problema|ano po ang (?:issue|sira|problema)|anong (?:issue|problema)|what's wrong/i.test(t)) return 'problem';
  if (/brand|size|pulgada|anong tv/i.test(t)) return 'brandSize';
  if (/ilang taon|gaano katagal|how old|edad ng tv|kailan (?:ito )?(?:binili|nabili)/i.test(t)) return 'age';
  if (/taga-saan|saan po|anong lugar|location|address/i.test(t)) return 'location';
  if (/ibang shop|another shop|na-repair na ba|binuksan na ba/i.test(t)) return 'repaired';
  return '';
}

const FACT_MS = 7 * 24 * 3600 * 1000;

// Brand, size, and the fault can have been told to Ivan yesterday. Do not use the
// 12-hour visible window for that; it hides those facts on purpose.
function factsBlob(thread, now = Date.now()) {
  const cutoff = now - FACT_MS;
  // Customer lines only. The bot's own questions name symptoms ("may lines") and must not fill slots.
  const epoch = Number(thread && thread.intakeEpoch) || 0;
  return (thread && thread.history || [])
    .filter((h) => h && h.role === 'user' && h.content && (!h.ts || h.ts >= cutoff) && (!h.ts || h.ts >= epoch))
    .map((h) => h.content)
    .join('\n');
}

function updateIntake(thread, latestText, hasMedia) {
  const blob = `${factsBlob(thread)}\n${latestText || ''}`;
  const summary = summarizeConversation([{ content: blob }]);
  const slots = thread.slots || {
    brand: '', size: '', symptom: '', brandSize: '', problemOrVideo: false, problemText: '', age: '', location: '', repairedElsewhere: '',
  };
  if (summary.brand) slots.brand = summary.brand;
  if (summary.size) slots.size = summary.size;
  if (slots.brand || slots.size) slots.brandSize = [slots.brand, slots.size].filter(Boolean).join(' ');
  const symptom = specificSymptom(blob);
  if (symptom) slots.symptom = symptom;
  else if (!slots.symptom && /\bsira\b/i.test(blob) && priorShopAnswer(latestCustomerText(thread, latestText)) && symptomAlreadyAsked(thread)) {
    // "Sira" was already said. "Wala pa sa ibang shop" is not a new symptom, so do not ask again.
    slots.symptom = 'sira';
  }
  if (summary.problem) {
    slots.problemOrVideo = true;
    slots.problemText = summary.problem;
  }
  if (summary.location) slots.location = summary.location;
  const epoch = Number(thread.intakeEpoch) || 0;
  const recentMedia = (thread.history || []).some((h) => {
    if (!h || !/\[Customer sent a (?:video|photo)/i.test(h.content || '')) return false;
    const ts = Number(h.ts) || 0;
    if (epoch && ts && ts < epoch) return false;
    if (!ts) return false;
    return Date.now() - ts < 24 * 60 * 60 * 1000;
  });
  const spoken = latestCustomerText(thread, latestText);
  if (hasMedia || problemClaim(spoken) || (recentMedia && !/\bpanibago\b|\bibang tv\b/i.test(spoken))) {
    thread.problemViaVideo = true;
    slots.problemOrVideo = true;
  }
  const age = blob.match(/\b\d+\s*(?:taon|years?|yrs?|buwan|months?)\b/i)
    || blob.match(/\b(?:matagal na|bago lang|bagong bili|how old)\b/i);
  if (age) slots.age = age[0];
  if (/ibang shop|another shop|na-?repair|binuksan na|pinaayos|hindi pa na(?:ayos|repair)|di pa naayos|wala pang ibang/i.test(blob)) {
    slots.repairedElsewhere = 'answered';
  }
  thread.slots = slots;
  thread.intakeClosed = Boolean(thread.problemViaVideo && slots.location && slots.age);
  return thread;
}

function missingSlot(thread) {
  const s = thread.slots || {};
  if (!s.symptom && !thread.problemViaVideo) return 'symptom';
  if (!s.size) return 'size';
  if (!s.brand) return 'brand';
  if (!s.location) return 'location';
  return '';
}

function nextAsk(thread) {
  const key = missingSlot(thread);
  return key ? QUESTIONS[key] : '';
}

function intakeContext(thread) {
  const s = thread.slots || {};
  const lines = [
    'Collected intake slots. Never ask for a slot that is already filled. Do not copy these facts into the reply.',
    `Brand/size: ${s.brandSize || 'missing'}.`,
    `Problem: ${thread.problemViaVideo ? 'PROVIDED via the customer video. Never ask what the problem is.' : (s.symptom || s.problemText || 'missing')}.`,
    `TV age: ${s.age || 'missing'}.`,
    `Location: ${s.location || 'missing'}.`,
    `Repaired at another shop: ${s.repairedElsewhere || 'missing'}.`,
  ];
  const ask = nextAsk(thread);
  if (thread.intakeClosed) {
    lines.push('Intake is complete: a video was sent and they gave location and TV age. Do not ask any intake question. Only answer what they just asked. The price will come from the technician after the video is reviewed. Do not mention an older booking or cancellation. Never blame the customer or say they themselves asked to cancel. Never write the name Ivan.');
  } else if (ask) {
    lines.push(`Ask only ONE still-missing item, and do not repeat their brand, age, or city. Ask only: ${ask}`);
  } else {
    lines.push('Brand, size, and the symptom are known. Give one possible cause and one all-in price, then ask when they are free. Do not repeat their city or age.');
  }
  return lines.join(' ');
}

function nextQuestion(thread, skip) {
  const s = thread.slots || {};
  const order = [
    ['symptom', !s.symptom && !thread.problemViaVideo, QUESTIONS.symptom],
    ['size', !s.size, QUESTIONS.size],
    ['brand', !s.brand, QUESTIONS.brand],
    ['location', !s.location, QUESTIONS.location],
  ];
  for (const [key, missing, q] of order) {
    if (missing && key !== skip) return q;
  }
  return '';
}

function knownFactHits(text, thread) {
  const s = thread.slots || {};
  const t = String(text || '').toLowerCase();
  const hits = [];
  if (s.brand && t.includes(String(s.brand).toLowerCase())) hits.push('brand');
  const inches = parseInt(s.size, 10);
  if (inches && new RegExp(`\\b${inches}\\b`).test(t)) hits.push('size');
  const place = String(s.location || '').toLowerCase().match(/[a-zñ]{4,}/g) || [];
  if (place.some((word) => t.includes(word))) hits.push('location');
  const years = String(s.age || '').match(/\d+/);
  if (years && new RegExp(`\\b${years[0]}\\s*(?:yrs?|years?|taon)\\b`, 'i').test(text || '')) hits.push('age');
  return hits;
}

function asksRealQuestion(text, thread) {
  const topic = questionTopic(text);
  if (topic === 'symptom' || topic === 'problem' || topic === 'size' || topic === 'brand' || topic === 'brandSize' || topic === 'location') {
    const need = missingSlot(thread);
    if (!need) return topic === 'location' || /kailan po/i.test(text || '');
    if (need === 'symptom') return topic === 'symptom' || topic === 'problem';
    if (need === 'size') return topic === 'size' || topic === 'brandSize';
    if (need === 'brand') return topic === 'brand' || topic === 'brandSize';
    if (need === 'location') return topic === 'location';
  }
  return false;
}

// True when the reply only repeats facts we already stored and does not ask the one missing item.
function isEchoOnly(text, thread) {
  const body = String(text || '');
  if (/₱\s?\d|backlight|lcd modification|power supply|motherboard/i.test(body)) return false;
  if (asksRealQuestion(body, thread)) return false;
  if (knownFactHits(body, thread).length) return true;
  const topic = questionTopic(body);
  return (topic === 'age' || topic === 'repaired') && Boolean(missingSlot(thread));
}

// Drop a repeated intake question, a problem question after a video, and any intake question once intake is closed.
function slotFilled(thread, topic) {
  const s = thread.slots || {};
  if (topic === 'brand') return Boolean(s.brand);
  if (topic === 'size') return Boolean(s.size);
  if (topic === 'brandSize') return Boolean(s.brand && s.size);
  if (topic === 'age') return Boolean(s.age);
  if (topic === 'location') return Boolean(s.location);
  if (topic === 'repaired') return Boolean(s.repairedElsewhere);
  if (topic === 'symptom' || topic === 'problem') return Boolean(s.symptom || thread.problemViaVideo);
  return false;
}

function applyReplyGuard(thread, text) {
  const clean = String(text || '').trim();
  if (thread.intakeClosed && !thread.intakeCloseSent) {
    thread.intakeCloseSent = true;
    thread.lastAskedTopic = '';
    return CLOSE_LINE;
  }
  const parts = clean.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const keptParts = parts.filter((part) => {
    const topic = questionTopic(part);
    return !(topic && slotFilled(thread, topic));
  });
  // Keep the original wording when nothing was dropped, so a [HANDOFF] still matches.
  const dropped = keptParts.length !== parts.length;
  const withoutKnown = dropped ? keptParts.join('\n').trim() : clean;
  let topic = questionTopic(withoutKnown);
  if (withoutKnown !== clean && !withoutKnown) {
    const q = nextQuestion(thread, '');
    thread.lastAskedTopic = questionTopic(q);
    return q || withoutKnown;
  }
  const body = withoutKnown || clean;
  topic = questionTopic(body);
  if (thread.problemViaVideo && topic === 'problem') {
    const q = nextQuestion(thread, 'problem');
    thread.lastAskedTopic = questionTopic(q);
    return q || CLOSE_LINE;
  }
  if (topic && topic === thread.lastAskedTopic) {
    const q = nextQuestion(thread, topic);
    thread.lastAskedTopic = questionTopic(q);
    return q || body;
  }
  if (thread.intakeClosed && topic) {
    const kept = body.split(/(?<=[.!?])\s+/).filter((part) => !questionTopic(part)).join(' ').trim();
    thread.lastAskedTopic = '';
    return kept || 'Noted po. Ang technician po namin ang titingin sa video at magpapadala ng all-in price shortly.';
  }
  thread.lastAskedTopic = topic;
  return body;
}

module.exports = {
  updateIntake, intakeContext, applyReplyGuard, questionTopic, problemClaim, CLOSE_LINE, QUESTIONS,
  specificSymptom, missingSlot, nextAsk, isEchoOnly,
};
