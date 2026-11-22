'use strict';
// Preliminary ranges, the plain check-up fee, and guards for video-received chats.
const { questionTopic } = require('./intake');
const { HOME_VISIT_FEE_LINE, HOME_CHECKUP_FEE_ANSWER, homeTerms } = require('./home-visit-fee');

// All prices come from knowledge/prices.json (built by scripts/build-prices.py from the
// 2026 price list xlsx plus owner-confirmed TV prices). Edit that file, not this one.
const PRICES = require('../knowledge/prices.json');
const numKeys = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [Number(k), v]));
// Low and high of each size row on the price table (before the internal distance add-on).
const PRICE_RANGE = numKeys(PRICES.priceRange);

// Owner-confirmed service rates. Never imply a waiver for shop checkups.
const SHOP_CHECKUP_PHP = 300;
const SHOP_CHECKUP_FEE_PLAIN = '₱300 po ang check-up kapag dadalhin ninyo ang TV sa shop.';
const CHECKUP_FEE_PLAIN = '₱300 po ang check-up kung dadalhin ang TV sa shop. Kung home service naman, ₱1,000 po ang check-up; waived ito kapag itinuloy ang repair. Sa shop po ba o home service?';
const CHECKUP_NUDGE = 'Pero mas mainam pa rin po na ma-check ng technician personally ang TV para mas eksakto ang estimate. Pwede po tayong mag-request ng home-service check-up: ₱1,000 po, waived kung itutuloy ang repair.';
const SHOP_TERMS = /\b(?:shop|branch|walk[\s-]?in|drop[\s-]?off)\b|\b(?:dadalhin|dalhin|dinala|magdadala|punta)\b.{0,35}\b(?:shop|branch)\b/i;

function checkupFeeReply(latestUser, thread = {}) {
  const current = String(latestUser || '');
  // Prefer the explicitly requested option over older chat history.
  if (homeTerms(current)) return HOME_CHECKUP_FEE_ANSWER;
  if (SHOP_TERMS.test(current)) return SHOP_CHECKUP_FEE_PLAIN;
  // On an ambiguous follow-up, consider the latest explicitly selected mode.
  const recent = (thread.history || []).slice(-6).reverse().find((m) =>
    m && m.role === 'user' && (homeTerms(m.content) || SHOP_TERMS.test(m.content)));
  if (recent) return homeTerms(recent.content) ? HOME_CHECKUP_FEE_ANSWER : SHOP_CHECKUP_FEE_PLAIN;
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
  return `[Customer sent a ${kind} at ${when} - RECEIVED, forwarded to the technician for review. You cannot view it, but it WAS received.]`;
}

function asksCheckupFee(text) {
  const t = String(text || '');
  if (!/check-?\s*up|checkup|tsek-?\s*ap|tsekap|diagnos(?:is|tic)/i.test(t)) return false;
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
  const base = 'Ang technician po namin ang nagre-review ng video at magme-message po kami ng all-in price soon.';
  return range ? `${base} ${range}` : base;
}

function estimateReply(thread) {
  return rangeSentence(thread)
    || "Depende po sa size at sira, ma'am/sir. Ilang inches po?";
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

const LCD_MOD = numKeys(PRICES.lcdMod);
const LCD_REPLACE = numKeys(PRICES.lcdReplace);
const BACKLIGHT = numKeys(PRICES.backlight);
const PSU_BASIC = numKeys(PRICES.xlsx && PRICES.xlsx.powerSupplyBasic);
const PSU_SMART = numKeys(PRICES.xlsx && PRICES.xlsx.powerSupplySmart);
const MOBO_BASIC = numKeys(PRICES.xlsx && PRICES.xlsx.motherboardBasic);
const MOBO_SMART = numKeys(PRICES.xlsx && PRICES.xlsx.motherboardSmart);

// Won't-turn-on can be a power supply or a motherboard, basic or smart. Quote that size's range.
function powerPriceRange(size) {
  const n = parseInt(size, 10);
  const nums = [PSU_BASIC[n], PSU_SMART[n], MOBO_BASIC[n], MOBO_SMART[n]].filter((v) => Number(v) > 0);
  if (!nums.length) return null;
  return { low: Math.min(...nums), high: Math.max(...nums) };
}

function phpAmount(n) {
  return `₱${Number(n).toLocaleString('en-US')}`;
}

const SIZE_PHRASES = [
  ['trenta y dos', 32], ["trenta'y dos", 32], ['thirty two', 32], ['thirty-two', 32],
  ['kuwarenta y tres', 43], ["kuwarenta'y tres", 43], ['forty three', 43], ['forty-three', 43],
  ['singkuwenta y singko', 55], ["singkuwenta'y singko", 55], ['fifty five', 55], ['fifty-five', 55],
  ['sesenta y singko', 65], ["sesenta'y singko", 65], ['sixty five', 65], ['sixty-five', 65],
  ['setenta y singko', 75], ["setenta'y singko", 75], ['seventy five', 75], ['seventy-five', 75],
  ['otsenta y singko', 85], ["otsenta'y singko", 85], ['eighty five', 85], ['eighty-five', 85],
  ['kuwarenta', 40], ['forty', 40],
  ['singkuwenta', 50], ['fifty', 50],
  ['sesenta', 60], ['sixty', 60],
  ['setenta', 70], ['seventy', 70],
  ['otsenta', 80], ['eighty', 80],
];

// The rightmost size in the text wins, so a later "32 inches" beats an earlier 65.
function knownSize(text) {
  // Blank out clock times ("video at 07:40") so the minutes never read as inches. Same length keeps positions.
  const s = String(text || '').toLowerCase().replace(/\b\d{1,2}:\d{2}\b/g, (t) => ' '.repeat(t.length));
  let best = { at: -1, n: 0 };
  for (const [phrase, n] of SIZE_PHRASES) {
    const at = s.lastIndexOf(phrase);
    if (at > best.at) best = { at, n };
  }
  const re = /(?<![\d,.₱])\b(32|40|43|48|49|50|55|60|65|70|75|80|85)(?!\d)\s*(?:["”″]|''|inches?|in\b|pulgada)?/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m.index >= best.at) best = { at: m.index, n: Number(m[1]) };
  }
  return best.n || 0;
}

const FLICKER = /flicker|blink(?:ing)?|kislap/i;

function faultKind(text) {
  const t = String(text || '');
  const dark = /walang (?:display|picture|ilaw)|nawala(?:n)?(?: ng| ang| yung)? (?:display|picture|ilaw)|no (?:display|picture|visual)|black screen/i.test(t);
  // Flicker and blinking are a backlight fault, including "nag fflicker" and "kumikislap".
  if (FLICKER.test(t)) return 'backlight';
  if (/(?:sound|tunog)/i.test(t) && dark) return 'backlight';
  if (/may linya|\blinya\b|may lines|\blines\b|lcd modification|\bmodif/i.test(t) || /gumuguhit|bar line/i.test(t)) return 'lcd-mod';
  if (/backlight/i.test(t)) return 'backlight';
  return '';
}

const BRANDS = ['samsung', 'tcl', 'lg', 'sony', 'panasonic', 'skyworth', 'hisense', 'konka', 'haier', 'sharp', 'xiaomi', 'philips', 'devant', 'coocaa', 'astron'];

function brandLabel(name) {
  return name.length <= 3 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1);
}

function unitLabel(blob, size) {
  // The most recently mentioned brand wins (a second TV in the same chat).
  let brand = '';
  let at = -1;
  for (const b of BRANDS) {
    const re = new RegExp(`\\b${b}\\b`, 'gi');
    let m;
    while ((m = re.exec(blob))) if (m.index > at) { at = m.index; brand = b; }
  }
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
  if (!n) return 'No size yet. Ask the inches. Do not invent a price.';
  const bits = [];
  if (BACKLIGHT[n]) bits.push(`backlight ${phpAmount(BACKLIGHT[n])}`);
  if (LCD_MOD[n]) bits.push(`LCD modification ${phpAmount(LCD_MOD[n])}`);
  if (LCD_REPLACE[n]) bits.push(`LCD replacement ${phpAmount(LCD_REPLACE[n])}`);
  if (!bits.length) return `${n}" has no listed TV price. Do not invent a price.`;
  return `Price for this chat only: ${n}" ${bits.join(', ')}. List estimate only. Final after staff sees the video.`;
}

// "repair lang", "ayusin lang", "hindi palit LCD", "repair modification": the customer wants the
// LCD repaired (modification), not replaced. Checked before "palit lcd" so a "hindi" is not ignored.
const REPAIR_ONLY = /\b(?:repair|ayos|ayusin|ipaayos|paayos|gawa|gawin|pagawa|modif\w*)\s+(?:lang|only|muna|na lang)\b|\b(?:hindi|hndi|hnd|hinde|di|wag|huwag|ayaw|ayoko)\s+(?:na\s+|po\s+|muna\s+)*(?:mag[\s-]*)?(?:pa[\s-]*)?palit|\brepair\s+(?:modification|lcd)|\blcd\s+(?:repair|modification)|\bmodification\b|\bnot\s+replace/i;

// Any word that means "fix it" rather than "replace it".
const REPAIR_WORD = /\b(?:repair\w*|ni-?repair|ayos\w*|ayusin|maayos|inayos|paayos|ipaayos|pa-?ayos|pagawa|ipagawa|magpagawa|gawa(?:in)?|gawin|ginawa|fix\w*|modif\w*|i-?modify|remedyo|remedy|kaya\s+pa(?:\s+ba)?|pwede\s+pa(?:\s+ba)?\s+(?:ma)?(?:ayos|gawa|repair))\b/i;
// "palit/replace" that is not negated ("hindi palit" is a repair request).
const WANTS_REPLACE = /(?<!\b(?:hindi|hndi|hnd|hinde|di|wag|huwag|ayaw|ayoko|not)\s+(?:na\s+|po\s+|muna\s+)*(?:mag[\s-]*)?(?:pa[\s-]*)?)\b(?:palit\w*|papalitan|replace\w*|bago\s+na\s+lcd|brand\s*new\s+lcd)/i;
const LCD_CONTEXT = /\blcd\b|\blines?\b|linya|basag|cracked|palit|dots|tuldok|kulay|blue screen|gumuguhit|bar\s?line|modif/i;

// Power supply / motherboard named by the customer ("power supply pumutok", "board"). A plain "ayaw mag-on" is not
// quoted here (owner rule: ask for the video, do not name the part). Checked on the latest message first,
// so an earlier "basag" or "palit lcd" in the chat cannot turn this into an LCD price.
const POWER_FAULT = /power\s*supply|\bpsu\b|\bsupply\b|pumutok|pumuputok|sumabog|amoy\s+sunog|nasunog|motherboard|mother\s*board|mainboard|main\s*board|\bboard\b/i;

function powerQuote(text, size, label) {
  const t = String(text || '');
  const n = parseInt(size, 10);
  const board = /motherboard|mother\s*board|mainboard|main\s*board|\bboard\b/i.test(t);
  const psu = /power\s*supply|\bpsu\b|\bsupply\b/i.test(t);
  const nums = (board && !psu ? [MOBO_BASIC[n], MOBO_SMART[n]]
    : psu && !board ? [PSU_BASIC[n], PSU_SMART[n]]
      : [PSU_BASIC[n], PSU_SMART[n], MOBO_BASIC[n], MOBO_SMART[n]]).filter((v) => Number(v) > 0);
  if (!nums.length) return '';
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  const money = low === high ? phpAmount(low) : `${phpAmount(low)}–${phpAmount(high)}`;
  const what = board && !psu ? 'motherboard' : psu && !board ? 'power supply' : 'power supply o motherboard';
  return `Nasa ${money} po ang repair ng ${what} para sa ${label}, depende kung smart o basic TV. Estimate po iyan, final po after makita ng staff ang video.`;
}

// A repair word in an LCD chat asks for the LCD repair (modification), unless they explicitly want a replacement.
function wantsLcdRepair(latest, users) {
  const t = String(latest || '');
  if (!REPAIR_WORD.test(t) || WANTS_REPLACE.test(t) || POWER_FAULT.test(t)) return false;
  if (/backlight|walang ilaw|flicker|kislap/i.test(t)) return false;
  const lcdChat = LCD_CONTEXT.test(t) || LCD_CONTEXT.test(String(users || ''));
  const backlightChat = !LCD_CONTEXT.test(t) && /backlight|walang ilaw|flicker|kislap|(?:sound|tunog)[\s\S]*(?:walang display|black screen)/i.test(String(users || ''));
  return lcdChat && !backlightChat;
}

// Stuck on the logo / boot loop: a software (firmware) fault, quoted as reprogramming, never backlight.
const STUCK_LOGO = /(?:stuck|stock|stack|naka-?stuck|nag-?stuck|hang|nag-?hang|naghang|na-?hang|tumigil|hinto|huminto|nakatigil|naiwan|loop|paulit[\s-]*ulit)\b[^.?!\n]{0,30}\blogo\b|\blogo\b[^.?!\n]{0,20}\b(?:lang|only|stuck|stock|hang|tumitigil|nag-?restart|restart)\b|\bboot\s*loop\b|\bbootloop\b|nag-?re-?restart\s+lang/i;

// About 15% under that size's backlight price (business rule), rounded to ₱100.
function reprogramPrice(size) {
  const b = BACKLIGHT[parseInt(size, 10)];
  return b ? Math.round((b * 0.85) / 100) * 100 : 0;
}

function reprogramQuote(size, label) {
  const price = reprogramPrice(size);
  const why = 'Kapag nag-stuck po sa logo, software/firmware po ang madalas na problema, hindi backlight';
  if (!price) return `${why}, reprogramming po ang ayos para sa ${label}. Final price po after makita ng staff ang video.`;
  return `${why}. Nasa around ${phpAmount(price)} po ang reprogramming para sa ${label}. Estimate po iyan, final po after makita ng staff ang video.`;
}

function listKind(text) {
  const t = String(text || '');
  if (STUCK_LOGO.test(t)) return 'reprogram';
  if (REPAIR_ONLY.test(t)) return 'repair';
  if (/basag|cracked|smashed|broken lcd|durog|palit lcd|lcd replacement|replace(?:ment)? lcd/i.test(t)) return 'replace';
  // Sound with a dark screen is a backlight fault, same as walang ilaw.
  const dark = /walang (?:display|picture|ilaw)|no (?:display|picture)|black screen/i.test(t);
  if (FLICKER.test(t) || ((/sound|tunog/i.test(t) && dark))) return 'backlight';
  if (/may linya|\blinya\b|\blines\b|lcd modification|\bmodif|no display|walang (?:display|picture)/i.test(t)) return 'mod';
  // Dots or colors and blue screen are LCD faults (Meta guide). A bare "LCD" price ask gets both LCD options.
  if (/\blcd\b|dots|tuldok|iba[\s'-]*ibang kulay|blue screen|asul na screen/i.test(t)) return 'mod';
  if (/backlight|walang ilaw/i.test(t)) return 'backlight';
  return '';
}

// Official list price for an explicit size and fault. Empty when either is missing.
function sizeOptions(size) {
  const bits = [
    BACKLIGHT[size] ? `backlight ${phpAmount(BACKLIGHT[size])}` : '',
    LCD_MOD[size] ? `LCD modification ${phpAmount(LCD_MOD[size])}` : '',
    LCD_REPLACE[size] ? `LCD replacement ${phpAmount(LCD_REPLACE[size])}` : '',
  ].filter(Boolean);
  if (!bits.length) return '';
  return `Para sa ${size}": ${bits.join(', ')}. Ano po ang sira, backlight, may lines, o basag?`;
}

// Meta-guide LCD answer: both options for the size, all-in, then ask for the video.
// Sent whole (quote-gate passes lines starting "Para po sa N inches:"). ":)" is text, not an emoji.
function lcdOptions(size) {
  if (!LCD_MOD[size] || !LCD_REPLACE[size]) return '';
  return [
    `Para po sa ${size} inches:`,
    `LCD MODIFICATION: ${phpAmount(LCD_MOD[size])}, para sa unit na pwede pang i-modify depende sa aktwal na sira.`,
    `BRAND NEW LCD REPLACEMENT: ${phpAmount(LCD_REPLACE[size])}, palit ng bagong LCD para sa basag o sirang panel.`,
    'Kasama na po sa presyo ang home service, labor, travel at warranty :)',
    'Estimate po ito, final po after makita ng staff ang video. Pwede po pa-send ng short video ng TV habang naka-on?',
  ].join('\n');
}

function slotKind(thread = {}) {
  const s = (thread.slots && thread.slots.symptom) || '';
  if (s === 'cracked') return 'replace';
  if (s === 'lines') return 'mod';
  if (s === 'backlight') return 'backlight';
  return '';
}

function listEstimate(latest, thread = {}, { force } = {}) {
  const latestText = String(latest || '');
  const blob = chatBlob(latest, thread);
  const users = (thread.history || []).filter((h) => h && h.role === 'user').map((h) => h.content || '').join('\n');
  const size = knownSize(latestText) || knownSize(blob);
  // Customer words decide the fault. The stored symptom is only a backup, so an
  // internal label like "no display / backlight" cannot flip the price.
  const kind = force || (POWER_FAULT.test(latestText) && !/basag|cracked|\blcd\b|lines?\b|linya/i.test(latestText) ? 'power' : '') || (wantsLcdRepair(latestText, users) ? 'repair' : '') || listKind(latestText) || listKind(users) || slotKind(thread);
  if (!size) return '';
  if (!kind) {
    if (!asksPrice(latestText)) return '';
    return sizeOptions(size);
  }
  if (kind === 'mod') {
    const both = lcdOptions(size);
    if (both) return both;
  }
  if (kind === 'reprogram') {
    return reprogramQuote(size, unitLabel(`${latestText}\n${blob}`, size));
  }
  if (kind === 'power') {
    return powerQuote(latestText, size, unitLabel(`${latestText}\n${blob}`, size));
  }
  if (kind === 'repair') {
    const label = unitLabel(`${latestText}\n${blob}`, size);
    // A cracked screen cannot be modified (staff guide). Say so instead of quoting a repair.
    if (/basag|cracked|smashed|durog|nabato|nabagsak/i.test(users + '\n' + latestText) && LCD_REPLACE[size]) {
      return `Nasa ${phpAmount(LCD_REPLACE[size])} po ang palit LCD para sa ${label}. Kapag basag po ang screen, hindi na po applicable ang LCD repair/modification, palit LCD na po ang option. Final po after makita ng staff ang video.`;
    }
    if (!LCD_MOD[size]) return '';
    return `Nasa ${phpAmount(LCD_MOD[size])} po ang LCD repair (modification) para sa ${label}, hindi palit LCD. Estimate po iyan, final po after makita ng staff ang video.`;
  }
  const label = unitLabel(`${latestText}\n${blob}`, size);
  const price = kind === 'replace' ? LCD_REPLACE[size] : kind === 'mod' ? LCD_MOD[size] : BACKLIGHT[size];
  if (!price) return '';
  const what = kind === 'replace' ? 'palit LCD' : kind === 'mod' ? 'LCD modification' : 'backlight';
  const role = kind === 'replace' ? 'Starting price po iyan' : 'Estimate po iyan';
  return `Nasa ${phpAmount(price)} po ang ${what} para sa ${label}. ${role}, final po after makita ng staff ang video.`;
}

function wantsListedPrice(latest) {
  const t = String(latest || '');
  return Boolean(knownSize(t) || asksPrice(t) || listKind(t) || REPAIR_WORD.test(t) || POWER_FAULT.test(t));
}

// A short table answer. No "Confirmed:". Do not ask the fault again once it is known.
function confirmedPriceReply(latest, thread = {}) {
  const ask = String(latest || '');
  const blob = chatBlob(ask, thread);
  const size = knownSize(blob);
  if (!size) return '';
  // The latest message wins. A stored label must not turn "may lines" into flicker.
  const fault = faultKind(ask) || faultKind(blob);
  const stated = Boolean(faultKind(ask));
  if (!asksPrice(ask) && !stated) return '';
  const label = unitLabel(blob, size);
  const possible = /sound|tunog/i.test(blob) && !/\bbacklight\b/i.test(ask);
  if (fault === 'backlight') {
    const price = BACKLIGHT[size];
    if (!price) return '';
    return backlightQuote(label, price, possible);
  }
  if (fault === 'lcd-mod') {
    if (!LCD_MOD[size]) return '';
    return lcdQuote(label, LCD_MOD[size]);
  }
  if (!asksPrice(ask)) return '';
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
  return 'Fixed price na po ito, all-in na po parts and labor with warranty. Gusto nyo po ba ituloy?';
}

function locationReply(text) {
  if (!/san po kayo|saan po kayo|saan (?:po )?(?:ang )?(?:shop|branch)|nasaan (?:po )?(?:kayo|ang shop|ang branch)|where are you|\blocated\b|location (?:nyo|niyo|ninyo)|anong address|address (?:nyo|niyo)|hanggang saan/i.test(text || '')) return '';
  return LOCATION_LINE;
}

function warrantyReply(text) {
  const t = String(text || '');
  if (!/warranty|garantiya|garanty/i.test(t)) return '';
  if (/sira ulit|nasira|backjob|walang resibo|no receipt/i.test(t)) {
    return 'Warranty po nito, ang technician po namin ang titingin sir.\n[HANDOFF: warranty question]';
  }
  if (/backlight/i.test(t)) return 'Backlight po sir, 6 months warranty.';
  if (/new lcd|lcd panel/i.test(t)) return 'New LCD panel po sir, 6 months warranty.';
  if (/motherboard|\bboard\b|power supply|\bpsu\b/i.test(t) && /power|psu|supply/i.test(t)) return 'Power supply po sir, 5 months warranty.';
  if (/motherboard|\bboard\b/i.test(t)) return 'Motherboard po sir, 5 months warranty.';
  if (/rebond/i.test(t)) return 'Rebonding po sir, 3 months warranty.';
  if (/lcd repair|lcd modification|\bmodif/i.test(t)) return 'LCD repair po sir, 3 months (32-65) o 2 months (70-85).';
  if (/warranty (?:ng|sa|for)\b/i.test(t)) {
    return 'Warranty po nito, ang technician po namin ang magko-confirm sir.\n[HANDOFF: warranty question]';
  }
  return WARRANTY_LINE;
}

const DURATION_LINE = 'Depende po sa sira sir. Anong brand at size po ng TV para ma-check namin?';

function durationReply(text) {
  const t = String(text || '');
  // "Ilang taon" is the age of the TV, not how long the repair takes.
  if (/\bilang taon\b|\btaon na\b|how old|\bedad\b|\byears? old\b/i.test(t)) return '';
  if (!/\bilang araw\b|\bgaano katagal\b|\bkailan\b[\s\S]{0,40}\b(?:matatapos|matapos|tapos|maaayos|maayos)\b|\bhow long\b|\bturnaround\b/i.test(t)) return '';
  return DURATION_LINE;
}

function homeSoonReply(text) {
  const t = String(text || '');
  if (!/home\s*service/i.test(t)) return '';
  if (!/\bbukas\b|tomorrow|pwede|pede|puwede/i.test(t)) return '';
  return 'Pwede po sir. ₱1,000 check-up, waived pag tinuloy ang repair. Saan po location nyo at anong oras po kayo free?';
}

function hesitationReply(latest, thread) {
  if (!/\bmahal\b|too expensive|low budget|pag-?iisipan|iisipin ko/i.test(latest || '')) return '';
  const blob = chatBlob(latest, thread);
  if (/\b55\b/.test(blob) && /samsung/i.test(blob)) {
    return '55 Samsung brand-new nasa around ₱35,000 po sir. Repair ₱8,500, about ₱26,500 less, may warranty at home service. Kailan po kayo free?';
  }
  return 'Repair po sir is less than brand new, may warranty at home service, walang hakot. Kailan po kayo free?';
}

function quoteKnownTv(thread = {}) {
  const s = thread.slots || {};
  const n = parseInt(s.size, 10);
  if (!s.brand || !n || !s.symptom) return '';
  const label = `${s.brand} ${n}`;
  const when = 'Kailan po sila free?';
  if (s.symptom === 'lines') {
    const price = LCD_MOD[n];
    if (!price) return `${label} po sir. LCD modification, ang technician po namin ang magko-confirm. ${when}`;
    return `${label} po sir. LCD modification ${phpAmount(price)}. Kasama repair, warranty, at home service. ${when}`;
  }
  if (s.symptom === 'backlight') {
    const price = BACKLIGHT[n];
    if (!price) return '';
    return `${label} po sir. Possible backlight po, ${phpAmount(price)}. Kasama testing, 6 months warranty, at home service. ${when}`;
  }
  if (s.symptom === 'reprogram') return reprogramQuote(n, label);
  if (s.symptom === 'power') {
    const range = powerPriceRange(n);
    if (!range) return `${label} po sir. Possible power supply o motherboard po. Wala pang listed price para sa ${n}". Check-up po para mas eksakto. ${when}`;
    const money = range.low === range.high ? phpAmount(range.low) : `${phpAmount(range.low)}–${phpAmount(range.high)}`;
    return `${label} po sir. Possible power supply o motherboard po, ${money} all-in. Check-up po para mas eksakto. ${when}`;
  }
  return '';
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
    || durationReply(latest)
    || homeSoonReply(latest)
    || (allowPrice ? (confirmedPriceReply(latest, thread) || vagueRepairReply(latest)) : '')
    || hesitationReply(latest, thread)
    || '';
}

module.exports = {
  lcdOptions,
  STUCK_LOGO,
  reprogramPrice,
  wantsLcdRepair,
  PRICES,
  PRICE_RANGE,
  LCD_MOD,
  LCD_REPLACE,
  BACKLIGHT,
  listEstimate,
  listKind,
  wantsListedPrice,
  discountReply,
  confirmedPriceReply,
  quoteKnownTv,
  powerPriceRange,
  scriptedReply,
  priceHint,
  knownSize,
  LOCATION_LINE,
  WARRANTY_LINE,
  CHECKUP_FEE_PLAIN,
  SHOP_CHECKUP_PHP,
  SHOP_CHECKUP_FEE_PLAIN,
  HOME_CHECKUP_FEE_ANSWER,
  HOME_VISIT_FEE_LINE,
  checkupFeeReply,
  CHECKUP_NUDGE,
  mediaReceivedNote,
  asksCheckupFee,
  applyCustomerGuard,
  rangeSentence,
  appendCheckupNudge,
};
