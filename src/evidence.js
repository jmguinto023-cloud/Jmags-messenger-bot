'use strict';
// A repair price waits for a problem video or photo, then the model sticker.
const { QUESTIONS } = require('./intake');

const ASK_VIDEO = 'Pwede po pa-send ng short video ng TV habang naka-on, para makita ng technician namin ang sira?';
const ASK_MODEL = 'Pakisend din po ng picture ng sticker sa likod ng TV para sa model number.';

function blank() {
  return { problem: '', model: '' };
}

function evidence(thread) {
  if (!thread.evidence) thread.evidence = blank();
  return thread.evidence;
}

function looksLikeModel(text) {
  const t = String(text || '');
  if (/\b(?:model|modelo)\b[:\s#-]*[A-Za-z0-9][A-Za-z0-9-]{3,}/i.test(t)) return true;
  return /\b(?:UA|UN|QN|QA|QE|UE|LH|LC|OLED)\d{2}[A-Z0-9-]{2,}\b/.test(t);
}

function declinesEvidence(text) {
  return /hindi (?:ko|ako|po )?(?:ma-?se?send|makapag-?(?:send|video|picture|photo|picture)|kaya i-?send)|wala(?:ng| po) (?:akong )?(?:ma-?i?pa-?send|video|camera|larawan|picture|sticker|model)|di (?:ko|ako) (?:ma-?send|mahanap(?: ang (?:sticker|model))?)|cannot send|can'?t send|no (?:video|camera|sticker)/i.test(String(text || ''));
}

// "Teka muna, di mo pa nakikita ang video at model" — including typos like dimo / nakkta.
function remindsMissingProof(text) {
  const t = String(text || '').toLowerCase();
  if (!/video|model|sticker/.test(t)) return false;
  return /nakkta|nakikta|nakita|nakikita|hindi (?:mo )?pa|di(?:mo| mo) pa|dimo pa|wala pa(?:ng)? (?:video|picture|larawan|model|sticker)|di mo pa|hindi mo pa/.test(t);
}

function problemClaimed(text) {
  return /nasa video|na-?sen[dt] ko na ang vide[oi]|nasend ko na ang vide[oi]|nandito sa video|pinadala ko na ang video|sent the video|eto na ang video|send ko na/i.test(String(text || ''));
}

function noteEvidence(thread, { hadMedia = false, text = '' } = {}) {
  const e = evidence(thread);
  if (looksLikeModel(text)) e.model = e.model || 'received';
  if (problemClaimed(text) && !e.problem) e.problem = 'received';
  if (hadMedia) {
    if (!e.problem) e.problem = 'received';
    else if (!e.model) e.model = 'received';
  }
  if (declinesEvidence(text)) {
    const both = /video/i.test(text) && /model|sticker/i.test(text);
    if (both) {
      if (!e.problem) e.problem = 'declined';
      if (!e.model) e.model = 'declined';
    } else if (!e.problem) e.problem = 'declined';
    else if (!e.model) e.model = 'declined';
  }
  return e;
}

function evidenceReady(thread) {
  const e = (thread && thread.evidence) || blank();
  const done = (v) => v === 'received' || v === 'declined';
  return done(e.problem) && done(e.model);
}

function evidenceDeclined(thread) {
  const e = (thread && thread.evidence) || blank();
  return e.problem === 'declined' || e.model === 'declined';
}

function nextEvidenceAsk(thread) {
  const e = (thread && thread.evidence) || blank();
  if (e.problem !== 'received' && e.problem !== 'declined') return ASK_VIDEO;
  if (e.model !== 'received' && e.model !== 'declined') return ASK_MODEL;
  return '';
}

function isRepairQuote(text) {
  const t = String(text || '');
  if (!/₱\s?[\d,]/.test(t)) return false;
  if (/check-?\s*up|checkup/i.test(t) && !/backlight|lcd modification|power supply|motherboard/i.test(t)) return false;
  return /backlight|lcd|power supply|motherboard|all-in|palit |repair ₱/i.test(t);
}

function asEstimate(quote) {
  const base = String(quote || '').replace(/\s*Kailan po (?:sila|kayo) free\??/i, '').trim();
  return `${base} Estimate po ito hangga't di nakikita ang TV. Pwede pong magpa-check-up. Kailan po sila free?`;
}

// One customer bubble. A repair price stays back until the video and the model sticker.
function holdRepairPrice(thread, text) {
  if (!isRepairQuote(text)) return text;
  const ask = nextEvidenceAsk(thread);
  if (ask) return ask;
  if (evidenceDeclined(thread)) return asEstimate(text);
  return text;
}

function coreReady(thread) {
  const s = (thread && thread.slots) || {};
  return Boolean(s.brand && s.size && s.symptom);
}

// The single next question. Known brand, size, and symptom are never asked again.
function nextStep(thread) {
  const s = (thread && thread.slots) || {};
  if (!s.symptom && !(thread && thread.problemViaVideo)) return QUESTIONS.symptom;
  if (!s.size) return QUESTIONS.size;
  if (!s.brand) return QUESTIONS.brand;
  return nextEvidenceAsk(thread);
}

function reasksKnown(thread, text) {
  const s = (thread && thread.slots) || {};
  const t = String(text || '');
  if (s.symptom && /ano(?:ng)? po ang sira\?|may sound pero walang picture/i.test(t)) return true;
  if (s.size && /ilang inches/i.test(t)) return true;
  if (s.brand && s.size && /anong brand/i.test(t)) return true;
  return false;
}

function prematureClose(text) {
  return /kailan po (?:kayo|sila) free|ma-assign ang home|technician po namin ang tutuloy/i.test(String(text || ''));
}

// Keep one reply on the next missing step. A correction must not wipe the job or hand it off.
function steerTurn(thread, text, latest) {
  const drafted = String(text || '');
  if (remindsMissingProof(latest) && !declinesEvidence(latest)) return nextEvidenceAsk(thread) || ASK_VIDEO;
  const step = nextStep(thread);
  if (!step) return holdRepairPrice(thread, drafted);
  const started = Boolean((thread.slots && (thread.slots.brand || thread.slots.size || thread.slots.symptom)));
  if (!started) return drafted;
  if (isRepairQuote(drafted) || prematureClose(drafted) || reasksKnown(thread, drafted)) return step;
  return drafted;
}

module.exports = {
  ASK_VIDEO,
  ASK_MODEL,
  noteEvidence,
  evidenceReady,
  evidenceDeclined,
  nextEvidenceAsk,
  nextStep,
  coreReady,
  declinesEvidence,
  remindsMissingProof,
  looksLikeModel,
  isRepairQuote,
  holdRepairPrice,
  steerTurn,
};
