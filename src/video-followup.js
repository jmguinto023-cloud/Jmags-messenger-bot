'use strict';
// One or two short follow-ups after a customer video, when they go quiet.
const { summarizeConversation } = require('./summary');

const HOUR = 3600 * 1000;

function manilaParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Manila',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute),
  };
}

function manilaLocalToUtc(year, month, day, hour, minute, tz) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const got = manilaParts(new Date(utc), tz);
    const delta = Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
    if (!delta) break;
    utc += delta;
  }
  return utc;
}

// 9:00 PM–7:00 AM Asia/Manila. Returns `now` when sending is allowed, otherwise the next 7:00 AM.
function quietDeferUntil(now, tz = 'Asia/Manila') {
  const p = manilaParts(new Date(now), tz);
  const minutes = p.hour * 60 + p.minute;
  if (minutes >= 7 * 60 && minutes < 21 * 60) return now;
  if (minutes < 7 * 60) return manilaLocalToUtc(p.year, p.month, p.day, 7, 0, tz);
  const nextMorning = manilaParts(new Date(manilaLocalToUtc(p.year, p.month, p.day, 12, 0, tz) + 20 * HOUR), tz);
  return manilaLocalToUtc(nextMorning.year, nextMorning.month, nextMorning.day, 7, 0, tz);
}

function videoFacts(thread) {
  const summary = summarizeConversation((thread && thread.history) || []);
  const slots = (thread && thread.slots) || {};
  const brandSize = String(slots.brandSize || '');
  return {
    brand: Boolean(summary.brand || /[a-z]/i.test(brandSize.replace(/\d+/g, ''))),
    size: Boolean(summary.size || /\d/.test(brandSize)),
    issue: Boolean(summary.problem || slots.problemText),
    location: Boolean(summary.location || slots.location),
  };
}

function taglishList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} at ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} at ${items[items.length - 1]}`;
}

function missingFactLabels(facts) {
  const items = [];
  if (!facts.brand) items.push('brand');
  if (!facts.size) items.push('size');
  if (!facts.issue) items.push('issue');
  if (!facts.location) items.push('location');
  return items;
}

function videoFollowupText(thread, { second = false } = {}) {
  const missing = missingFactLabels(videoFacts(thread));
  if (!missing.length) {
    return second
      ? 'Hello po ulit 😊 Kung gusto niyo na pong ipa-check, pwede po nating i-book ang home service check-up. Sabihin lang po kung kailan kayo available.'
      : 'Hello po 😊 Na-review na po ba ni Ivan yung video? Kung okay lang po, pwede na po nating i-book ang home service check-up. Sabihin lang po kung kailan kayo available.';
  }
  const list = taglishList(missing);
  return second
    ? `Hello po ulit 😊 Pasensya na po sa abala. Pag may oras lang po, pwede po bang malaman ang ${list} ng TV? Para lang po ma-check namin agad ang schedule.`
    : `Hello po 😊 Na-review na po ba ni Ivan yung video? Habang hinihintay po, pwede po bang malaman ang ${list} ng TV para ma-check namin agad ang schedule?`;
}

module.exports = { quietDeferUntil, videoFacts, videoFollowupText };
