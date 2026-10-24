'use strict';
// What we already know about a TV job, so the bot does not ask for it again.
const { summarizeConversation } = require('./summary');

const CLOSE_LINE = 'Salamat po. Si Ivan na po ang nagre-review ng video at ipapadala po namin ang all-in price shortly 😊';

const QUESTIONS = {
  brandSize: 'Anong brand at size po ng TV?',
  age: 'Ilang taon na po ang TV?',
  location: 'Pwede po malaman kung taga-saan po sila?',
  repaired: 'Na-repair na po ba ito sa ibang shop?',
  problem: 'Ano po ang problema ng TV?',
};

function problemClaim(text) {
  return /nasa video|na-?sen[dt] ko na ang vide[oi]|nasend ko na ang vide[oi]|nandito sa video|kita sa video|makikita sa video|pinakita|pinadala ko na ang video|sent the video|problem.{0,40}video|video.{0,40}problem|sa video (?:po )?(?:ang|yung) (?:problema|issue|sira)/i.test(text || '');
}

function questionTopic(text) {
  const t = String(text || '');
  if (!/\?/.test(t)) return '';
  if (/problema|ano po ang (?:issue|sira|problema)|anong (?:issue|problema)|what's wrong/i.test(t)) return 'problem';
  if (/brand|size|pulgada|ilang inch|anong tv/i.test(t)) return 'brandSize';
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
  return (thread && thread.history || [])
    .filter((h) => h && h.content && (!h.ts || h.ts >= cutoff))
    .map((h) => h.content)
    .join('\n');
}

function updateIntake(thread, latestText, hasMedia) {
  const blob = `${factsBlob(thread)}\n${latestText || ''}`;
  const summary = summarizeConversation([{ content: blob }]);
  const slots = thread.slots || { brandSize: '', problemOrVideo: false, problemText: '', age: '', location: '', repairedElsewhere: '' };
  if (summary.brand || summary.size) slots.brandSize = [summary.brand, summary.size].filter(Boolean).join(' ');
  if (summary.problem) {
    slots.problemOrVideo = true;
    slots.problemText = summary.problem;
  }
  if (summary.location) slots.location = summary.location;
  if (hasMedia || /\[Customer sent a (?:video|photo)\]/i.test(blob) || problemClaim(blob) || problemClaim(latestText)) {
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

function intakeContext(thread) {
  const s = thread.slots || {};
  const lines = [
    'Collected intake slots. Never ask for a slot that is already filled.',
    `Brand/size: ${s.brandSize || 'missing'}.`,
    `Problem: ${thread.problemViaVideo ? 'PROVIDED via the customer video. Never ask what the problem is.' : (s.problemOrVideo ? 'provided in text' : 'missing')}.`,
    `TV age: ${s.age || 'missing'}.`,
    `Location: ${s.location || 'missing'}.`,
    `Repaired at another shop: ${s.repairedElsewhere || 'missing'}.`,
  ];
  if (thread.intakeClosed) {
    lines.push('Intake is complete: a video was sent and they gave location and TV age. Do not ask any intake question. Only answer what they just asked. The price will come from Ivan after he reviews the video. Do not mention an older booking or cancellation. Never blame the customer or say they themselves asked to cancel.');
  } else {
    lines.push('Ask only ONE still-missing item, in order: brand/size, TV age, location, whether another shop already repaired it. Do not repeat the question you asked last.');
  }
  return lines.join(' ');
}

function nextQuestion(thread, skip) {
  const s = thread.slots || {};
  const order = [
    ['brandSize', !s.brandSize, QUESTIONS.brandSize],
    ['age', !s.age, QUESTIONS.age],
    ['location', !s.location, QUESTIONS.location],
    ['repaired', !s.repairedElsewhere, QUESTIONS.repaired],
  ];
  for (const [key, missing, q] of order) {
    if (missing && key !== skip) return q;
  }
  if (!thread.problemViaVideo && !s.problemOrVideo && skip !== 'problem') return QUESTIONS.problem;
  return '';
}

// Drop a repeated intake question, a problem question after a video, and any intake question once intake is closed.
function slotFilled(thread, topic) {
  const s = thread.slots || {};
  if (topic === 'brandSize') return Boolean(s.brandSize);
  if (topic === 'age') return Boolean(s.age);
  if (topic === 'location') return Boolean(s.location);
  if (topic === 'repaired') return Boolean(s.repairedElsewhere);
  if (topic === 'problem') return Boolean(s.problemOrVideo || thread.problemViaVideo);
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
    return kept || 'Noted po. Si Ivan na po ang titingin sa video at magpapadala ng all-in price shortly.';
  }
  thread.lastAskedTopic = topic;
  return body;
}

module.exports = { updateIntake, intakeContext, applyReplyGuard, questionTopic, problemClaim, CLOSE_LINE, QUESTIONS };
