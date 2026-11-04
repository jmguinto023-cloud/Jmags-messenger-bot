'use strict';
// Service hours for bookings (Asia/Manila, fixed UTC+8, no DST). Default Mon-Sat 8:00 AM-5:00 PM, Sunday closed.
// Configure with BOOKING_HOURS ("08:00-17:00") and BOOKING_CLOSED_DAYS ("0" = Sunday; comma list, 0=Sun..6=Sat).

const OFFSET = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const DAY_NAMES = ['Linggo', 'Lunes', 'Martes', 'Miyerkules', 'Huwebes', 'Biyernes', 'Sabado'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hoursConfig(cfg = {}) {
  const m = String(cfg.bookingHours || '08:00-17:00').match(/^(\d{1,2}):?(\d{2})?\s*-\s*(\d{1,2}):?(\d{2})?$/);
  const open = m ? Number(m[1]) : 8;
  const close = m ? Number(m[3]) : 17;
  const closed = String(cfg.bookingClosedDays == null ? '0' : cfg.bookingClosedDays)
    .split(',').map((x) => x.trim()).filter((x) => x !== '').map(Number);
  return { open, close, closed };
}

// "YYYY-MM-DD" of a timestamp in Manila.
function ymd(ts) {
  return new Date(ts + OFFSET).toISOString().slice(0, 10);
}
function ymdToUtcNoon(s) {
  return Date.parse(`${s}T12:00:00Z`);
}
function weekday(s) {
  return new Date(ymdToUtcNoon(s)).getUTCDay();
}
function addDays(s, n) {
  return new Date(ymdToUtcNoon(s) + n * DAY).toISOString().slice(0, 10);
}
function manilaHour(ts) {
  return new Date(ts + OFFSET).getUTCHours();
}

function isOpenDate(s, cfg) {
  return !hoursConfig(cfg).closed.includes(weekday(s));
}

// Same-day booking only if at least 2 hours remain before closing.
function nextOpenDates(now, n = 3, cfg) {
  const h = hoursConfig(cfg);
  let d = ymd(now);
  if (manilaHour(now) >= h.close - 2) d = addDays(d, 1);
  const out = [];
  for (let i = 0; out.length < n && i < 14; i++, d = addDays(d, 1)) if (isOpenDate(d, cfg)) out.push(d);
  return out;
}

function prettyDate(s) {
  const [, mo, da] = s.split('-').map(Number);
  return `${DAY_NAMES[weekday(s)]}, ${MONTHS[mo - 1]} ${da}`;
}

const WEEKDAYS = [
  [/\b(?:linggo|sunday|sun)\b/i, 0], [/\b(?:lunes|monday|mon)\b/i, 1], [/\b(?:martes|tuesday|tue|tues)\b/i, 2],
  [/\b(?:miyerkules|miyerkoles|wednesday|wed)\b/i, 3], [/\b(?:huwebes|thursday|thu|thurs)\b/i, 4],
  [/\b(?:biyernes|friday|fri)\b/i, 5], [/\b(?:sabado|saturday|sat)\b/i, 6],
];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i;

// Returns "YYYY-MM-DD" or '' from free text, relative to now (Manila).
function parseDate(text, now) {
  const t = String(text || '');
  const today = ymd(now);
  let m = t.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/\b(?:ngayon|today|ngayong araw)\b/i.test(t)) return today;
  if (/\b(?:sa makalawa|makalawa|day after tomorrow)\b/i.test(t)) return addDays(today, 2);
  if (/\b(?:bukas|tomorrow|tom)\b/i.test(t)) return addDays(today, 1);
  const year = Number(today.slice(0, 4));
  const pick = (mo, da) => {
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
    let s = `${year}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    if (s < today) s = `${year + 1}${s.slice(4)}`;
    return s;
  };
  m = t.match(MONTH_RE);
  if (m) return pick(MONTHS.findIndex((x) => x.toLowerCase() === m[1].slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) return pick(Number(m[1]), Number(m[2]));
  for (const [re, wd] of WEEKDAYS) {
    if (re.test(t)) {
      let d = addDays(today, 1);
      while (weekday(d) !== wd) d = addDays(d, 1);
      return d;
    }
  }
  return '';
}

// Returns an hour 0-23 or -1. "umaga" = 9, "hapon" = 1 PM, "tanghali" = 12.
function parseHour(text) {
  const t = String(text || '');
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|n\.?u\.?|ng umaga|ng hapon|ng tanghali)\b/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/pm|hapon|tanghali/i.test(m[3]) && !(h === 0 && /tanghali/i.test(m[3]))) h += 12;
    if (/tanghali/i.test(m[3]) && Number(m[1]) === 12) h = 12;
    return h;
  }
  m = t.match(/\b(?:alas|around|mga|by|at)\s*(\d{1,2})(?::\d{2})?\b/i);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 5 ? n + 12 : n; // "alas 2" in service hours = 2 PM
  }
  if (/\btanghali\b|\bnoon\b/i.test(t)) return 12;
  if (/\bumaga\b|\bmorning\b|\bam\b/i.test(t)) return 9;
  if (/\bhapon\b|\bafternoon\b|\bpm\b/i.test(t)) return 13;
  return -1;
}

function hourLabel(h) {
  return `${(h % 12) || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

function isOpenHour(h, cfg) {
  const c = hoursConfig(cfg);
  return h >= c.open && h < c.close;
}

module.exports = {
  hoursConfig, ymd, addDays, weekday, isOpenDate, nextOpenDates, prettyDate, parseDate, parseHour, hourLabel, isOpenHour,
};
