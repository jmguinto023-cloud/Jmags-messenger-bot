'use strict';
// Step-by-step Messenger booking: collect details, read them back, and on an explicit "yes"
// create the booking through the Supabase edge function ops-booking-intake (same payload as the
// jmagscutomerform.netlify.app form). BOOKING_INTAKE_URL unset = dry run (logged, nothing sent).
// Any failure falls back to the booking form link, prefilled with what we collected.
const { knownSize, LCD_MOD, BACKLIGHT, PRICES } = require('./estimate');
const { detectLocation } = require('./branch');
const hours = require('./hours');

const FIELDS = ['name', 'mobile', 'address', 'appliance', 'brandSize', 'problem', 'pdate', 'ptime'];
const BRANDS = ['samsung', 'tcl', 'lg', 'sony', 'panasonic', 'skyworth', 'hisense', 'konka', 'haier', 'sharp', 'xiaomi',
  'philips', 'devant', 'coocaa', 'astron', 'toshiba', 'hyundai', 'condura', 'carrier', 'kolin', 'whirlpool', 'fujidenzo', 'midea'];
const APPLIANCES = [
  [/\b(?:tv|telebisyon|television|smart ?tv|led|lcd)\b/i, 'TV'],
  [/\b(?:washing|washer|labahan|laba)\b/i, 'Washing machine'],
  [/\b(?:aircon|air ?con|\bac\b|split ?type|window ?type)\b/i, 'Aircon'],
  [/\b(?:microwave)\b/i, 'Microwave'],
  [/\b(?:oven)\b/i, 'Oven'],
  [/\b(?:electric ?fan|bentilador)\b/i, 'Electric fan'],
  [/\b(?:rice ?cooker)\b/i, 'Rice cooker'],
];

const ASK = {
  name: 'Sige po, i-book na natin 😊 Ano po ang buong pangalan nila?',
  mobile: 'Salamat po. Ano po ang mobile number nila? (hal. 09XXXXXXXXX)',
  address: 'Ano po ang buong address? Paki-include po ang house no./street, barangay, at city/town.',
  barangay: 'Anong barangay po yan?',
  city: 'Anong city/town at province po yan?',
  appliance: 'Anong appliance po ang ipapaayos? (TV, washing machine, aircon, etc.)',
  brandSize: 'Anong brand at size po ng TV?',
  brand: 'Anong brand po ng unit?',
  problem: 'Ano po ang sira o problema ng unit?',
  pdate: '',
  ptime: 'Anong oras po kayo available? Open po kami 8AM hanggang 5PM.',
};

const YES = /^\s*(?:oo+|opo|yes|yup|yep|sige(?: po)?|ok(?:ay)?|okey|tama(?: po)?|correct|g\b|go(?: na)?|confirm(?:ed)?|game)\b/i;
const NO = /^\s*(?:hindi|di |mali|wrong|no\b|nope|teka|wait|palitan|change|baguhin)/i;
const INTENT = /\b(?:pa-?book|i-?book|book(?:ing)? (?:na|po|ko)|pa-?sched(?:ule)?|i-?sched(?:ule)?|schedule (?:na|po|ko)|pa-?schedule|sched na|pa-?home ?service|pa-?check ?up|pa-?checkup|pa-?ayos na|tuloy na|go na po|sige po.{0,20}(?:sched|book|punta))/i;

function bookingIntent(text) {
  return INTENT.test(String(text || ''));
}

function normPhone(text) {
  const m = String(text || '').replace(/[\s-]/g, '').match(/(?:\+?63|0)(9\d{9})/);
  return m ? `0${m[1]}` : '';
}

function brandOf(text) {
  const b = BRANDS.find((x) => new RegExp(`\\b${x}\\b`, 'i').test(text || ''));
  return b ? (b.length <= 3 ? b.toUpperCase() : b[0].toUpperCase() + b.slice(1)) : '';
}

function applianceOf(text) {
  const hit = APPLIANCES.find(([re]) => re.test(text || ''));
  return hit ? hit[1] : '';
}

function nameFrom(text, asked) {
  const t = String(text || '').trim();
  const m = t.match(/(?:ako si|ako po si|name(?: ko)?(?: po)?(?: is| ay|:)?|pangalan(?: ko)?(?: po)?(?: ay|:)?)\s+([A-Za-zÑñ.' -]{2,50})/i);
  if (m) return clean(m[1]);
  if (asked && /^[A-Za-zÑñ.' -]{2,50}$/.test(t) && t.split(/\s+/).length <= 5 && !YES.test(t) && !NO.test(t)) return clean(t);
  return '';
}
function clean(s) {
  return String(s).replace(/\b(?:po|lang|sir|maam|ma'am)\b/gi, '').replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
}

function hasBarangay(text) {
  return /\b(?:brgy|bgy|barangay|baranggay|bry)\b/i.test(text || '');
}

// Pull every field we can from one message. `asked` = field we just asked for (free text allowed).
function extract(b, text, { asked = '', now, cfg } = {}) {
  const f = b.fields;
  const t = String(text || '');
  const changed = [];
  const set = (k, v) => { if (v && f[k] !== v) { f[k] = v; changed.push(k); } };
  set('mobile', normPhone(t));
  const nm = nameFrom(t, asked === 'name');
  if (nm && (asked === 'name' || !f.name)) set('name', nm);
  const loc = detectLocation(t, cfg);
  if (asked === 'address' || asked === 'barangay' || asked === 'city' || (hasBarangay(t) && t.length > 10)) {
    if (asked === 'barangay' || asked === 'city') set('address', `${f.address || ''}, ${t.trim()}`.replace(/^, /, ''));
    else if (!normPhone(t) || t.replace(/(?:\+?63|0)9\d{9}/, '').trim().length > 10) set('address', t.replace(/(?:\+?63|0)9[\d\s-]{9,12}/, '').trim());
  }
  if (loc.province && (asked === 'address' || asked === 'city' || asked === 'barangay' || !f.province)) {
    set('province', loc.province);
    // Cavite Page sets defaultBranch and keeps that branch. The main Page leaves it
    // empty and uses location (src/branch.js): Laguna and nearby Batangas -> San Pablo.
    if (!(cfg && cfg.defaultBranch)) set('branch', loc.branch);
    if (loc.city) set('city', loc.city);
  }
  if (cfg && cfg.defaultBranch) set('branch', cfg.defaultBranch);
  set('appliance', f.appliance ? '' : applianceOf(t));
  const size = knownSize(t);
  if (size && !f.size) set('size', `${size}"`);
  const brand = brandOf(t);
  if (brand && !f.brand) set('brand', brand);
  if (size || /\b(?:tv)\b/i.test(t)) { if (!f.appliance) set('appliance', 'TV'); }
  if (asked === 'problem' && t.trim().length >= 3 && !YES.test(t)) set('problem', t.trim());
  else if (!f.problem && /walang (?:display|picture|ilaw)|black screen|may linya|lines|flicker|ayaw mag-?on|hindi (?:nag-?o?on|bumubukas)|sira|no display|dim|basag/i.test(t)) set('problem', t.trim().slice(0, 200));
  if (/(?:na-?repair|naipaayos|nabuksan|napabuksan|binuksan).{0,25}(?:na|sa ibang)/i.test(t)) set('prior', /\b(?:hindi|wala|di pa|first time)\b/i.test(t) ? 'No' : 'Yes');
  const d = hours.parseDate(t, now);
  if (d) set('pdate', d);
  const h = hours.parseHour(t);
  if (h >= 0 && (asked === 'ptime' || asked === 'pdate' || d || /\b(?:am|pm|alas|umaga|hapon)\b/i.test(t))) set('ptimeHour', h);
  return changed;
}

function datesLine(now, cfg) {
  return hours.nextOpenDates(now, 3, cfg).map(hours.prettyDate).join(' / ');
}

// The next thing to ask, or '' when complete. Also validates date/time.
function nextQuestion(b, now, cfg) {
  const f = b.fields;
  if (!f.name) return ['name', ASK.name];
  if (!f.mobile) return ['mobile', ASK.mobile];
  if (!f.address) return ['address', ASK.address];
  if (!hasBarangay(f.address)) return ['barangay', ASK.barangay];
  if (!f.province) return ['city', ASK.city];
  if (!f.appliance) return ['appliance', ASK.appliance];
  if (f.appliance === 'TV' && (!f.brand || !f.size)) return ['brandSize', ASK.brandSize];
  if (f.appliance !== 'TV' && !f.brand) return ['brand', ASK.brand];
  if (!f.problem) return ['problem', ASK.problem];
  if (!f.pdate) return ['pdate', `Kailan po kayo available? Open po kami Mon-Sat, 8AM-5PM. Pinakamalapit na pwede: ${datesLine(now, cfg)}.`];
  const today = hours.ymd(now);
  if (f.pdate < today || !hours.isOpenDate(f.pdate, cfg) || !hours.nextOpenDates(now, 30, cfg).includes(f.pdate)) {
    const why = !hours.isOpenDate(f.pdate, cfg) ? `Sarado po kami ng ${hours.prettyDate(f.pdate)}.` : 'Hindi na po available ang date na yan.';
    f.pdate = '';
    return ['pdate', `${why} Pwede po: ${datesLine(now, cfg)}. Alin po dito?`];
  }
  if (f.ptimeHour == null || f.ptimeHour < 0) return ['ptime', ASK.ptime];
  if (!hours.isOpenHour(f.ptimeHour, cfg)) {
    f.ptimeHour = null;
    return ['ptime', 'Open po kami 8AM hanggang 5PM lang. Anong oras po sa loob nito ang pwede?'];
  }
  return ['', ''];
}

// Quote only owner-confirmed prices; otherwise 0 (staff sets the price).
function quotedPrice(f) {
  const n = parseInt(f.size, 10);
  if (f.appliance !== 'TV' || !n) return 0;
  const p = String(f.problem || '');
  if (/flicker|kislap|walang (?:display|picture|ilaw)|black screen|backlight|dim/i.test(p)) {
    if (n === 85) return new RegExp(`\\b(?:${PRICES.backlight85.premiumBrands.join('|')})\\b`, 'i').test(f.brand) ? PRICES.backlight85.premium : PRICES.backlight85.other;
    return BACKLIGHT[n] || 0;
  }
  if (/linya|lines|guhit|modif/i.test(p)) return LCD_MOD[n] || 0;
  return 0;
}

const peso = (n) => `₱${Number(n).toLocaleString('en-US')}`;

function summary(f) {
  const price = quotedPrice(f);
  return [
    'Paki-check po kung tama:',
    `• Pangalan: ${f.name}`,
    `• Mobile: ${f.mobile}`,
    `• Address: ${f.address}${f.city && !new RegExp(f.city, 'i').test(f.address) ? `, ${f.city}` : ''}${f.province && !new RegExp(f.province, 'i').test(f.address) ? `, ${f.province}` : ''}`,
    `• Unit: ${f.appliance}${f.brand ? ` ${f.brand}` : ''}${f.size ? ` ${f.size}` : ''}`,
    `• Problema: ${f.problem}`,
    `• Schedule: ${hours.prettyDate(f.pdate)}, ${hours.hourLabel(f.ptimeHour)}`,
    price ? `• Estimated: ${peso(price)} all-in (final after makita ng technician)` : '',
    'Home service check-up ₱1,000, waived kapag itinuloy ang repair.',
    'Tama po ba? Reply OO para i-book, o sabihin kung ano ang babaguhin.',
  ].filter(Boolean).join('\n');
}

// Same shape the Netlify form posts to ops-booking-intake (see form-live-1551.html submit handler).
function buildPayload(f, { psidTag = '' } = {}) {
  const price = quotedPrice(f);
  const ptime = hours.hourLabel(f.ptimeHour);
  const details = [
    "JMAG'S SERVICE REQUEST (Messenger bot)",
    `Name: ${f.name}`, `Mobile: ${f.mobile}`, `Address: ${f.address}`, `Town/City: ${f.city || ''}`,
    `Province: ${f.province || ''}`, `Branch: ${f.branch || ''}`, `Appliance: ${f.appliance}`, `Brand: ${f.brand || ''}`,
    `Size: ${f.size || ''}`, `Problem: ${f.problem}`, `Napaayos na sa iba?: ${f.prior || 'Not asked'}`,
    `Preferred date: ${f.pdate}`, `Preferred time: ${ptime}`, 'Service type: REGULAR',
    `Agreed price: ${price ? peso(price) : 'TBD by staff'}`, psidTag ? `Messenger: ${psidTag}` : '',
  ].filter(Boolean).join('\n');
  return {
    name: f.name, mobile: f.mobile, address: f.address, subdivision: '', city: f.city || '', province: f.province || '',
    landmark: '', pin: '', appliance: f.appliance, brand: f.brand || '', size: f.size || '', problem: f.problem,
    priortech: f.prior || '', prior: f.prior || '', pdate: f.pdate, ptime, service: 'REGULAR', pbase: '',
    price, website: '', details,
  };
}

// Prefilled form link (the form reads ?name=&mobile=... on load).
function formLink(base, f) {
  const q = new URLSearchParams();
  for (const k of ['name', 'mobile', 'address', 'city', 'province', 'appliance', 'brand', 'size', 'problem', 'pdate']) if (f[k]) q.set(k, f[k]);
  if (f.ptimeHour != null && f.ptimeHour >= 0) q.set('ptime', hours.hourLabel(f.ptimeHour));
  const s = q.toString();
  return s ? `${base}${base.includes('?') ? '&' : '?'}${s}` : base;
}

async function createBooking(payload, { cfg = {}, fetchImpl = fetch, log } = {}) {
  const url = cfg.bookingIntakeUrl;
  if (!url) {
    if (log) log.info(`booking DRY RUN (BOOKING_INTAKE_URL unset): ${payload.name} ${payload.pdate} ${payload.ptime} ${payload.city}`);
    return { ok: true, dryRun: true };
  }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.bookingIntakeKey) { headers.apikey = cfg.bookingIntakeKey; headers.Authorization = `Bearer ${cfg.bookingIntakeKey}`; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.bookingIntakeTimeoutMs || 10000);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok === true) return { ok: true, id: body.id || body.bookingId || '' };
    if (log) log.warn(`booking intake failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return { ok: false, status: res.status };
  } catch (e) {
    if (log) log.warn(`booking intake error: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// One customer turn. Returns { text } to send, or null to let the normal bot answer.
async function bookingTurn(thread, text, { cfg = {}, now = Date.now(), fetchImpl, log, psidTag = '' } = {}) {
  const msg = String(text || '');
  let b = thread.booking;
  if (b && b.submittedAt) return null;
  if (!b || !b.active) {
    if (!bookingIntent(msg)) return null;
    const fields = {};
    if (cfg.defaultBranch) fields.branch = cfg.defaultBranch;
    b = thread.booking = { active: true, fields, asked: '', confirmPending: false, startedAt: now };
    // Prefill from what the customer already said in this chat.
    for (const h of (thread.history || [])) if (h && h.role === 'user') extract(b, h.content, { now, cfg });
  }
  if (b.confirmPending) {
    if (YES.test(msg) && !NO.test(msg)) {
      const payload = buildPayload(b.fields, { psidTag });
      const res = await createBooking(payload, { cfg, fetchImpl, log });
      if (res.ok) {
        b.active = false; b.submittedAt = now; b.dryRun = Boolean(res.dryRun); b.bookingId = res.id || '';
        const first = String(b.fields.name).split(' ')[0];
        return { text: `Salamat po ${first}! Na-receive na po namin ang booking nyo for ${hours.prettyDate(b.fields.pdate)}, ${hours.hourLabel(b.fields.ptimeHour)}. Ico-confirm po ng staff namin ang final schedule bago pumunta ang technician 😊`, booked: true, payload, dryRun: Boolean(res.dryRun) };
      }
      b.active = false; b.failedAt = now;
      return { text: `Pasensya na po, nagka-problema sa pag-save ng booking. Paki-fill up na lang po dito, naka-fill na po ang details nyo: ${formLink(cfg.bookingFormUrl || '', b.fields)}`, failed: true };
    }
    b.confirmPending = false;
    const changed = extract(b, msg, { asked: '', now, cfg });
    if (!changed.length) { b.asked = ''; return { text: 'Sige po, ano po ang babaguhin? (pangalan, number, address, unit, problema, o schedule)' }; }
  } else {
    const changed = extract(b, msg, { asked: b.asked, now, cfg });
    // A side question mid-booking: let the normal bot answer; we resume on the next detail.
    if (!changed.length && b.asked && /\?|magkano|how much|warranty|ilang araw/i.test(msg)) return null;
  }
  const [field, question] = nextQuestion(b, now, cfg);
  if (field) { b.asked = field; return { text: question }; }
  b.asked = ''; b.confirmPending = true;
  return { text: summary(b.fields) };
}

module.exports = {
  bookingTurn, bookingIntent, createBooking, buildPayload, extract, nextQuestion, summary, formLink, quotedPrice, normPhone, FIELDS,
};
