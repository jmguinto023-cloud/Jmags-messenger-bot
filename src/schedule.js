'use strict';
// Built-in reply window in Asia/Manila. Empty schedule means the bot may reply
// whenever BOT_ENABLED is on. A window may cross midnight, for example 22:00-07:00.

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

function parseSchedule(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const ranges = [];
  for (const part of text.split(',')) {
    const m = part.trim().replace(/[–—]/g, '-').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    const sh = Number(m[1]);
    const sm = Number(m[2]);
    const eh = Number(m[3]);
    const em = Number(m[4]);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) continue;
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start === end) continue;
    ranges.push({ start, end });
  }
  return ranges;
}

function inRange(minutes, range) {
  return range.start <= range.end
    ? minutes >= range.start && minutes < range.end
    : minutes >= range.start || minutes < range.end;
}

function manilaMinutes(date, tz) {
  const p = manilaParts(date, tz);
  return { parts: p, minutes: p.hour * 60 + p.minute };
}

// True when replies are allowed. BOT_ENABLED false is always off.
// An empty schedule is always on. A set schedule that parses to nothing is off.
function activeNow(cfg, date = new Date()) {
  if (!cfg || cfg.botEnabled === false) return false;
  const schedule = String(cfg.schedule || '').trim();
  if (!schedule) return cfg.botEnabled !== false;
  const ranges = parseSchedule(schedule);
  if (!ranges.length) return false;
  const { minutes } = manilaMinutes(date, cfg.timezone);
  return ranges.some((range) => inRange(minutes, range));
}

function nextStart(ranges, minutes) {
  let best = null;
  for (const range of ranges) {
    const dayOffset = minutes < range.start ? 0 : 1;
    const key = dayOffset * 24 * 60 + range.start;
    if (!best || key < best.key) best = { minutes: range.start, dayOffset, key };
  }
  return best;
}

function nextOpenAt(cfg, now = Date.now()) {
  const ranges = parseSchedule(cfg && cfg.schedule);
  if (!ranges.length) return null;
  const tz = (cfg && cfg.timezone) || 'Asia/Manila';
  const when = new Date(now);
  const { parts, minutes } = manilaMinutes(when, tz);
  if (ranges.some((range) => inRange(minutes, range))) return now;
  const next = nextStart(ranges, minutes);
  let { year, month, day } = parts;
  if (next.dayOffset) {
    const shifted = manilaParts(new Date(manilaLocalToUtc(year, month, day, 12, 0, tz) + 20 * HOUR), tz);
    year = shifted.year;
    month = shifted.month;
    day = shifted.day;
  }
  return manilaLocalToUtc(year, month, day, Math.floor(next.minutes / 60), next.minutes % 60, tz);
}

function compact(minutes) {
  let h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

function clockLabel(minutes) {
  let h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h %= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

function rangeLabel(range) {
  return `${compact(range.start)}–${compact(range.end)}`;
}

function statusLine(cfg, now = Date.now()) {
  const enabled = Boolean(cfg && cfg.botEnabled);
  const schedule = String((cfg && cfg.schedule) || '').trim();
  if (!enabled) return 'Bot: OFF';
  if (!schedule) return 'Bot: ON';
  const ranges = parseSchedule(schedule);
  if (!ranges.length) return 'Bot: OFF';
  const label = ranges.map(rangeLabel).join(', ');
  if (activeNow(cfg, new Date(now))) return `Bot: ON (schedule ${label})`;
  const { minutes } = manilaMinutes(new Date(now), cfg.timezone);
  const next = nextStart(ranges, minutes);
  return `OFF now, turns on at ${clockLabel(next.minutes)}`;
}

module.exports = { parseSchedule, activeNow, nextOpenAt, statusLine };
