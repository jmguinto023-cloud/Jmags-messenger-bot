'use strict';
// Booking form → one Messenger confirmation.
//
// The live form (jmagscutomerform.netlify.app) posts to Netlify Forms. It does not
// know the customer's PSID. Links the bot or staff send carry a signed
// ?psid=&page=sanpablo|cavite&token= so the form can submit those hidden fields.
// Netlify's form-notification webhook posts the submission here. A token is the
// only proof of who to message. A phone number is a fallback, and only when it
// matches exactly one Messenger chat or job the bot already stored.
//
// Outside Meta's 24-hour window nothing is sent. An approved tag would be a later
// change: messaging_type MESSAGE_TAG and tag CONFIRMED_EVENT_UPDATE, and only
// after Meta approves that tag for this app. Do not send a tag before that.

const crypto = require('node:crypto');
const hours = require('./hours');

const REF_PARAM = 'ref';
const REFERRAL_PREFIX = 'BK_';
const PAGE_KEYS = {
  sanpablo: 'sanpablo',
  san_pablo: 'sanpablo',
  'san-pablo': 'sanpablo',
  sp: 'sanpablo',
  main: 'sanpablo',
  cavite: 'cavite',
};
const SLOT_TTL_MS = 36 * 3600 * 1000;
const RECENT_TTL_MS = 30 * 60 * 1000;
const PENDING_MS = 2 * 60 * 1000;
const DELIVERY_KEEP_MS = 90 * 86400 * 1000;

function secret(cfg) {
  return String((cfg && (cfg.bookingRefSecret || cfg.appSecret || cfg.adminToken)) || '');
}

function sign(cfg, value) {
  return crypto.createHmac('sha256', secret(cfg)).update(String(value)).digest('base64url').slice(0, 16);
}

function normalizePageKey(value) {
  const k = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  return PAGE_KEYS[k] || '';
}

function pageRecord(cfg, key) {
  const pages = (cfg && cfg.pages) || [];
  const name = normalizePageKey(key);
  if (name === 'cavite') return pages.find((p) => p.key === 'cavite') || null;
  if (name === 'sanpablo') return pages.find((p) => p.primary) || pages.find((p) => p.key === 'main' || p.key === 'sanpablo') || null;
  return null;
}

// Opaque, signed reference to one Messenger thread. The live form still reads ?ref=.
function makeRef(cfg, psid) {
  if (!/^\d{5,30}$/.test(String(psid || '')) || !secret(cfg)) return '';
  return `${psid}.${sign(cfg, psid)}`;
}

function readRef(cfg, ref) {
  const m = /^(\d{5,30})\.([A-Za-z0-9_-]{16})$/.exec(String(ref || '').trim());
  if (!m || !secret(cfg)) return '';
  const want = sign(cfg, m[1]);
  const a = Buffer.from(m[2]);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  return m[1];
}

// Binds one PSID to one Page. A swapped page or PSID does not verify.
function makeToken(cfg, psid, page) {
  const key = normalizePageKey(page);
  if (!key || !/^\d{5,30}$/.test(String(psid || '')) || !secret(cfg)) return '';
  const body = `v1.${key}.${psid}`;
  const sig = crypto.createHmac('sha256', secret(cfg)).update(body).digest('base64url').slice(0, 22);
  return `${body}.${sig}`;
}

function readToken(cfg, token) {
  const m = /^v1\.(sanpablo|cavite)\.(\d{5,30})\.([A-Za-z0-9_-]{22})$/.exec(String(token || '').trim());
  if (!m || !secret(cfg)) return null;
  const body = `v1.${m[1]}.${m[2]}`;
  const want = crypto.createHmac('sha256', secret(cfg)).update(body).digest('base64url').slice(0, 22);
  const a = Buffer.from(m[3]);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { psid: m[2], page: m[1] };
}

const SHORT_LINK_MS = 7 * 86400e3;

function plainFormUrl(cfg) {
  try {
    const u = new URL(String((cfg && cfg.bookingFormUrl) || 'https://jmagscutomerform.netlify.app/'));
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return 'https://jmagscutomerform.netlify.app/';
  }
}

function expandShortLink(cfg, row) {
  if (!row || !row.psid || !row.page) return plainFormUrl(cfg);
  const base = String((cfg && cfg.bookingFormUrl) || '').trim();
  if (!base) return plainFormUrl(cfg);
  let u;
  try { u = new URL(base); } catch { return plainFormUrl(cfg); }
  u.searchParams.set('psid', String(row.psid));
  u.searchParams.set('page', String(row.page));
  if (row.token) u.searchParams.set('token', String(row.token));
  if (row.ref) u.searchParams.set('ref', String(row.ref));
  return u.toString();
}

function bookingFormLink(cfg, psid, page, extra = {}) {
  const base = String((cfg && cfg.bookingFormUrl) || '').trim();
  const key = normalizePageKey(page);
  const token = makeToken(cfg, psid, key);
  if (!base || !key || !token) return '';
  let u;
  try { u = new URL(base); } catch { return ''; }
  u.searchParams.set('psid', String(psid));
  u.searchParams.set('page', key);
  u.searchParams.set('token', token);
  const ref = makeRef(cfg, psid);
  if (ref) u.searchParams.set('ref', ref);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && String(v) !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// Every booking-form link this bot sends is tied to this chat and this Page.
function personalizeFormUrls(cfg, text, psid, page) {
  const base = String((cfg && cfg.bookingFormUrl) || '').trim();
  const key = normalizePageKey(page) || 'sanpablo';
  const token = makeToken(cfg, psid, key);
  const ref = makeRef(cfg, psid);
  if (!base || !token || !text || !text.includes(base)) return text;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}[^\\s)]*`, 'g'), (link) => {
    let u;
    try { u = new URL(link); } catch { return link; }
    u.searchParams.set('psid', String(psid));
    u.searchParams.set('page', key);
    u.searchParams.set('token', token);
    if (ref) u.searchParams.set('ref', ref);
    return u.toString();
  });
}

function normalizeWait(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['yes', 'y', 'oo', 'true', 'regular', 'willing'].includes(v)) return 'yes';
  if (['no', 'n', 'hindi', 'false', 'priority'].includes(v)) return 'no';
  return '';
}

// YES (willing to wait) is Regular. NO is Priority. The service field is the backup.
function bookingKind(sub) {
  const wait = normalizeWait(sub && (sub.willingToWait != null ? sub.willingToWait : sub.wait));
  if (wait) return wait;
  const service = String((sub && sub.service) || '');
  if (/priority/i.test(service)) return 'no';
  if (/regular/i.test(service)) return 'yes';
  return '';
}

function cleanName(name) {
  return String(name || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function isoFromBookingDate(value) {
  const raw = String(value || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // The live calendar stores month/day/2-digit year, for example 11/12/26.
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  return '';
}

function prettyBookingDate(value) {
  const iso = isoFromBookingDate(value);
  if (iso) {
    const mo = Number(iso.slice(5, 7));
    const da = Number(iso.slice(8, 10));
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return hours.prettyDate(iso);
    return '';
  }
  const cleaned = String(value || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').slice(0, 40);
  if (!cleaned || /https?:/i.test(cleaned)) return '';
  return cleaned;
}

function dateFromDetails(text) {
  const m = String(text || '').match(/Preferred date:\s*([^\n\r]+)/i);
  return m ? m[1].trim() : '';
}

function submissionDate(data, body) {
  const direct = pickField(data, ['pdate', 'preferredDate', 'preferred_date', 'preferred-date', 'bookingDate']);
  if (direct) return direct;
  for (const [key, value] of Object.entries(data || {})) {
    if (/pdate|preferred.?date|^date$/i.test(key) && String(value || '').trim()) return value;
  }
  const blobs = [data && data.details, data && data.summary, body && body.summary, body && body.body];
  for (const blob of blobs) {
    const found = dateFromDetails(blob);
    if (found) return found;
  }
  const human = (body && body.human_fields) || {};
  for (const [key, value] of Object.entries(human)) {
    if (/date/i.test(key) && String(value || '').trim() && !/created|updated/i.test(key)) return value;
  }
  return '';
}

function confirmText(name, wait, date) {
  const who = cleanName(name);
  const when = prettyBookingDate(date);
  if (normalizeWait(wait) === 'no') {
    const hello = who ? `Salamat po sa booking, ${who}! 😊` : 'Salamat po sa booking! 😊';
    const slot = when ? ` sa ${when}` : '';
    return `${hello} Priority service po kayo (+P1,000)${slot}, mauuna po kayo sa line-up. Paki-reply po ng AGREE para ma-confirm.`;
  }
  const hello = who ? `Salamat po sa Pag fill up ng booking, ${who}! 😊` : 'Salamat po sa Pag fill up ng booking! 😊';
  const whenSlot = when ? ` sa ${when}` : '';
  return [
    hello,
    `Nasa line up po kayo${whenSlot} ng "REGULAR SERVICE" ibig sabihin available po kayo anytime? Hintayin na lang po tumawag ang staff namin anytime 9AM-5PM sa araw na iyon. Paki-reply po ng AGREE para ma-confirm.`,
    'Maraming salamat! HAPPY to SERVE you all 😊',
  ].join('\n\n');
}

function agreeAckText() {
  return 'Salamat po, confirmed na po ang booking ninyo.';
}

function isAgree(text) {
  return /^\s*(?:ok(?:ay)?[\s,.!]*)?(?:i\s+)?agree(?:d)?(?:\s+(?:po|na|na po|ako|kami))*[\s.!👍🙂😊]*$/i.test(String(text || ''));
}

function referralRef(name, wait) {
  const w = normalizeWait(wait) === 'no' ? 'N' : 'Y';
  const n = Buffer.from(cleanName(name), 'utf8').toString('base64url').slice(0, 120);
  return `${REFERRAL_PREFIX}${w}_${n}`;
}

function parseReferralRef(ref) {
  const m = /^BK_([YN])_([A-Za-z0-9_-]*)$/.exec(String(ref || '').trim());
  if (!m) return null;
  let name = '';
  try { name = cleanName(Buffer.from(m[2], 'base64url').toString('utf8')); } catch { name = ''; }
  return { wait: m[1] === 'N' ? 'no' : 'yes', name };
}

function messengerConfirmUrl(cfg, name, wait) {
  const page = cfg.pageUsername || cfg.pageId;
  if (!page) return '';
  return `https://m.me/${encodeURIComponent(page)}?ref=${referralRef(name, wait)}`;
}

function referralFromEvent(ev) {
  const r = (ev && (ev.referral || (ev.postback && ev.postback.referral) || (ev.message && ev.message.referral))) || null;
  return r && r.ref ? parseReferralRef(r.ref) : null;
}

function originAllowed(cfg, origin) {
  if (!origin) return false;
  const list = (cfg.bookingFormOrigins && cfg.bookingFormOrigins.length)
    ? cfg.bookingFormOrigins
    : [(() => { try { return new URL(cfg.bookingFormUrl).origin; } catch { return ''; } })()];
  return list.filter(Boolean).includes(origin);
}

function secretEqual(got, want) {
  const a = Buffer.from(String(got || ''));
  const b = Buffer.from(String(want || ''));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyNetlifyJws(token, secretValue, raw) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !secretValue) return false;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return false; }
  if (!header || header.alg !== 'HS256') return false;
  if (!payload || payload.iss !== 'netlify') return false;
  const now = Date.now() / 1000;
  if (payload.exp && now > Number(payload.exp)) return false;
  if (payload.nbf && now < Number(payload.nbf)) return false;
  const expected = crypto.createHmac('sha256', secretValue).update(`${parts[0]}.${parts[1]}`).digest();
  let got;
  try { got = Buffer.from(parts[2], 'base64url'); } catch { return false; }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''));
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const claim = String(payload.sha256 || '');
  if (claim.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(claim), Buffer.from(hash));
}

// JWS (X-Webhook-Signature) when Netlify has a secret set. Otherwise the same
// secret as Authorization: Bearer, X-Webhook-Secret, or ?key= on the URL.
function authorizeNetlify(cfg, { raw, signature, authorization, webhookSecret, queryKey } = {}) {
  const hookSecret = String((cfg && cfg.netlifyWebhookSecret) || '');
  if (!hookSecret) return { ok: false, status: 401, error: 'webhook secret not set' };
  const sig = String(signature || '').trim();
  if (sig) {
    return verifyNetlifyJws(sig, hookSecret, raw)
      ? { ok: true, via: 'jws' }
      : { ok: false, status: 401, error: 'bad signature' };
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(authorization || ''));
  const presented = (bearer && bearer[1]) || String(webhookSecret || '') || String(queryKey || '');
  if (presented && secretEqual(presented, hookSecret)) return { ok: true, via: 'secret' };
  return { ok: false, status: 401, error: 'unauthorized' };
}

function pickField(data, names) {
  for (const name of names) {
    if (data && data[name] != null && String(data[name]).trim()) return data[name];
  }
  return '';
}

function parseNetlifySubmission(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body;
  return {
    formName: String(body.form_name || body.formName || '').trim(),
    submissionId: String(body.id || body.submission_id || body.submissionId || '').trim().slice(0, 80),
    name: pickField(data, ['name', 'fullName', 'full_name']),
    mobile: pickField(data, ['mobile', 'phone', 'contact']),
    date: submissionDate(data, body),
    willingToWait: pickField(data, ['willingToWait', 'willing_to_wait', 'wait']),
    service: pickField(data, ['service', 'serviceType', 'service_type']),
    psid: String(pickField(data, ['psid', 'messengerPsid']) || '').trim(),
    page: String(pickField(data, ['page', 'messengerPage']) || '').trim(),
    token: String(pickField(data, ['token', 'messengerToken']) || '').trim(),
    ref: String(pickField(data, ['ref', 'messengerRef']) || '').trim(),
    bookingId: String(pickField(data, ['bookingId', 'booking_id']) || body.bookingId || '').trim().slice(0, 80),
  };
}

// A signed token wins. A bare PSID is rejected. No token and no ref means "unknown".
function identityFrom(cfg, sub) {
  const row = sub || {};
  if (row.token) {
    const token = readToken(cfg, row.token);
    if (!token) return { error: 'bad messenger token' };
    if (row.psid && row.psid !== token.psid) return { error: 'bad messenger token' };
    if (row.page && normalizePageKey(row.page) !== token.page) return { error: 'bad messenger token' };
    return { psid: token.psid, page: token.page, via: 'token' };
  }
  if (row.ref) {
    const psid = readRef(cfg, row.ref);
    if (!psid) return { error: 'bad messenger token' };
    return { psid, page: normalizePageKey(row.page), via: 'ref' };
  }
  if (row.psid || row.page) return { error: 'bad messenger token' };
  return { via: 'none' };
}

function formHosts(cfg) {
  const hosts = ['jmagscutomerform.netlify.app'];
  try {
    const host = new URL(String((cfg && cfg.bookingFormUrl) || '')).host.replace(/^www\./, '');
    if (host && !hosts.includes(host)) hosts.push(host);
  } catch { /* keep the live host */ }
  return hosts;
}

function textHasFormLink(text, cfg) {
  const raw = String(text || '').toLowerCase();
  return formHosts(cfg).some((host) => {
    const escaped = host.replace(/\./g, '\\.');
    return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`, 'i').test(raw);
  });
}

const PERSONAL_LINK_LEAD = '👇 Booking link po ninyo:';

function personalFormLinkText(link) {
  return `${PERSONAL_LINK_LEAD} ${link}`;
}

function isPersonalFormLinkText(text) {
  return String(text || '').trimStart().startsWith(PERSONAL_LINK_LEAD);
}

function normalizeTriggerText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textHasLinkTrigger(text, cfg) {
  const hay = normalizeTriggerText(text);
  if (!hay) return false;
  const phrases = ((cfg && cfg.bookingLinkTriggerPhrases) || [])
    .map(normalizeTriggerText)
    .filter(Boolean);
  return phrases.some((phrase) => hay.includes(phrase));
}

function textIsStaffFormSignal(text, cfg) {
  if (!text || isPersonalFormLinkText(text)) return false;
  return textHasFormLink(text, cfg) || textHasLinkTrigger(text, cfg);
}

function nameTokens(name) {
  return cleanName(name).toLowerCase().replace(/[^a-zñ\s]/gi, ' ').split(/\s+/)
    .filter((word) => word.length >= 3 && !['po', 'sir', 'maam', 'mam', 'the'].includes(word));
}

function namesRoughlyMatch(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return false;
  const phraseL = left.join(' ');
  const phraseR = right.join(' ');
  if (phraseL === phraseR || phraseL.includes(phraseR) || phraseR.includes(phraseL)) return true;
  if (left[0] !== right[0]) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.every((word) => longer.includes(word));
}

function compactLetters(name) {
  return cleanName(name).toLowerCase().replace(/[^a-zñ]/gi, '');
}

function initialsOf(name) {
  return cleanName(name).toLowerCase().replace(/[^a-zñ\s]/gi, ' ').split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join('');
}

// "JM AG" and "JMAG" are the first letters of "Jhon Michael Angelo Guinto".
function initialsCompatible(a, b) {
  const left = initialsOf(a);
  const right = compactLetters(b);
  return left.length >= 2 && right.length >= 2 && left === right;
}

function namesOverlap(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return false;
  return left.some((word) => right.includes(word));
}

// A short stored name such as "JM AG" has no usable token. That is unknown, not a clash.
// A clash is both sides having real words and sharing none of them.
function namesClash(formName, storedNames) {
  const form = cleanName(formName);
  if (!form || !nameTokens(form).length) return false;
  const usable = (storedNames || []).map(cleanName).filter((n) => nameTokens(n).length > 0);
  if (!usable.length) return false;
  return usable.every((n) => !namesOverlap(form, n) && !initialsCompatible(form, n));
}

function nameAgrees(formName, storedNames) {
  const form = cleanName(formName);
  if (!form) return false;
  return (storedNames || []).some((n) => namesRoughlyMatch(form, n) || initialsCompatible(form, n));
}

function phonesInText(text) {
  const found = [];
  const re = /(?:\+?63|0)[\s.-]*9(?:[\s.-]*\d){9}\b/g;
  const raw = String(text || '');
  let m;
  while ((m = re.exec(raw))) {
    const n = normalizeMobile(m[0]);
    if (n && !found.includes(n)) found.push(n);
  }
  return found;
}

function staffNeedReason(candidates) {
  const bits = (candidates || []).map((c) => {
    const last4 = String(c.psid || '').slice(-4);
    const who = cleanName(c.label || '');
    return `${c.pageKey || ''} ··${last4}${who ? ` ${who}` : ''}`.trim();
  });
  return `Booking needs staff${bits.length ? `: ${bits.join(', ')}` : ''}`;
}

function decision(row, accepted, why) {
  return {
    pageKey: (row.c && row.c.pageKey) || '',
    last4: String((row.c && row.c.psid) || '').slice(-4),
    accepted,
    why,
  };
}

// Candidates are only chats that were sent the form link and are still open.
// A mobile the customer typed wins, even when the Facebook name differs.
// Several chats with that mobile use the name to pick one. With no mobile hit,
// one open chat is accepted only when the names do not clash.
function pickStaffLink(candidates, sub) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const phone = normalizeMobile(sub && sub.mobile);
  const formName = cleanName(sub && sub.name);
  const rows = list.map((c) => {
    const phones = (c.phones || []).map(normalizeMobile).filter(Boolean);
    const names = (c.names || []).map(cleanName).filter(Boolean);
    return {
      c,
      names,
      phoneHit: Boolean(phone) && phones.includes(phone),
      nameHit: nameAgrees(formName, names),
      clash: namesClash(formName, names),
    };
  });
  const finish = (match, reason, flagged, whyFor) => ({
    match,
    reason,
    candidates: flagged,
    decisions: rows.map((row) => decision(row, Boolean(match && match === row.c), whyFor(row))),
  });
  const phoneHits = rows.filter((row) => row.phoneHit);
  if (phoneHits.length > 1) {
    const named = phoneHits.filter((row) => row.nameHit);
    if (named.length === 1) {
      const hit = named[0];
      return finish(hit.c, '', [hit.c], (row) => {
        if (row === hit) return 'accepted: name breaks the mobile tie';
        return row.phoneHit ? 'rejected: name does not match' : 'rejected: mobile does not match';
      });
    }
    return finish(null, staffNeedReason(phoneHits.map((row) => row.c)), phoneHits.map((row) => row.c), (row) => (
      row.phoneHit ? 'rejected: mobile matches more than one chat' : 'rejected: mobile does not match'
    ));
  }
  if (phoneHits.length === 1) {
    const hit = phoneHits[0];
    const why = hit.clash ? 'accepted: unique mobile (name differs)' : 'accepted: unique mobile, name does not clash';
    return finish(hit.c, '', [hit.c], (row) => (
      row === hit ? why : 'rejected: mobile does not match'
    ));
  }
  if (list.length === 1) {
    const only = rows[0];
    if (only.clash) {
      return finish(null, staffNeedReason([only.c]), [only.c], () => 'rejected: name clash');
    }
    return finish(only.c, '', [only.c], () => 'accepted: only open staff link, name does not clash');
  }
  const nameHits = rows.filter((row) => row.nameHit);
  if (!phone && nameHits.length === 1) {
    const hit = nameHits[0];
    return finish(hit.c, '', [hit.c], (row) => (
      row === hit ? 'accepted: only name match' : 'rejected: name does not match'
    ));
  }
  return finish(null, staffNeedReason(list), list, (row) => {
    if (row.clash) return 'rejected: name clash';
    if (phone) return 'rejected: mobile does not match';
    if (nameHits.length > 1) return 'rejected: name matches more than one chat';
    return 'rejected: ambiguous';
  });
}

function normalizeMobile(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (/^09\d{9}$/.test(d)) return d;
  if (/^639\d{9}$/.test(d)) return `0${d.slice(2)}`;
  if (/^9\d{9}$/.test(d)) return `0${d}`;
  return '';
}

function mobileLast4(value) {
  const n = normalizeMobile(value);
  return n ? n.slice(-4) : '';
}

function mobilesFromUser(thread) {
  const found = new Set();
  const re = /(?:\+?63|0)[\s.-]*9(?:[\s.-]*\d){9}\b/g;
  for (const turn of (thread && thread.history) || []) {
    if (!turn || turn.role !== 'user') continue;
    const text = String(turn.content || '');
    let m;
    while ((m = re.exec(text))) {
      const n = normalizeMobile(m[0]);
      if (n) found.add(n);
    }
  }
  return found;
}

function matchMobile(threads, mobile) {
  const want = normalizeMobile(mobile);
  if (!want) return { status: 'none' };
  const hits = [];
  for (const [key, thread] of Object.entries(threads || {})) {
    if (mobilesFromUser(thread).has(want)) hits.push({ key, thread });
  }
  if (hits.length === 1) return { status: 'one', key: hits[0].key, thread: hits[0].thread };
  if (hits.length > 1) return { status: 'many' };
  return { status: 'none' };
}

function matchJobMobile(rows, mobile) {
  const want = normalizeMobile(mobile);
  if (!want) return '';
  const ids = new Set();
  for (const row of rows || []) {
    const n = normalizeMobile(row && (row.phone || row.mobile));
    if (n && n === want && row.psid) ids.add(String(row.psid));
  }
  return ids.size === 1 ? [...ids][0] : '';
}

function outsideWindowError(err) {
  const body = err && err.body && err.body.error;
  const sub = body && (body.error_subcode || body.errorSubcode);
  if (sub === 2018278 || (body && body.code === 551)) return true;
  return /outside of allowed window|outside the allowed window/i.test(String((err && err.message) || ''));
}

function bucket(store) {
  store.data.bookingDeliveries ||= {};
  return store.data.bookingDeliveries;
}

function pruneDeliveries(store, now) {
  const all = bucket(store);
  for (const [key, row] of Object.entries(all)) {
    if (!row || !row.at || now - row.at > DELIVERY_KEEP_MS) delete all[key];
  }
  const keys = Object.keys(all);
  if (keys.length > 5000) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
    for (const key of keys.slice(0, keys.length - 5000)) delete all[key];
  }
}

function deliveryKeys({ psid, page, wait, name, date, submissionId, bookingId }) {
  const durable = [];
  if (submissionId) durable.push(`sub:${String(submissionId).slice(0, 80)}`);
  if (bookingId) durable.push(`bid:${String(bookingId).slice(0, 80)}`);
  const soft = [];
  if (date) soft.push({ id: `slot:${psid}|${page}|${date}|${wait}`, ttl: SLOT_TTL_MS });
  soft.push({ id: `recent:${psid}|${page}|${wait}|${name}`, ttl: RECENT_TTL_MS });
  return { durable, soft };
}

function liveRow(row, now) {
  if (!row) return null;
  if (row.expiresAt && now >= row.expiresAt) return null;
  return row;
}

// sent and in-flight stop a second send. An outside-window skip does not:
// a later retry can send once the customer is inside the window again.
function deliveryHold(store, spec, now) {
  pruneDeliveries(store, now);
  const all = bucket(store);
  let outsideNotified = false;
  const ids = [...(spec.durable || []), ...(spec.soft || []).map((item) => item.id)];
  for (const id of ids) {
    const row = liveRow(all[id], now);
    if (!row) continue;
    if (row.status === 'sent') return { action: 'stop', reason: 'already sent' };
    if (row.status === 'pending' && now - row.at < PENDING_MS) return { action: 'stop', reason: 'in flight' };
    // These can become sendable on a later retry (customer messages again, or the
    // Page token is added). A bad token stays a hard stop.
    if (row.status === 'skipped' && (row.reason === 'outside 24h window' || row.reason === 'no page token')) {
      if (row.notified) outsideNotified = true;
      continue;
    }
    if (row.status === 'skipped') return { action: 'stop', reason: row.reason || 'already handled' };
  }
  return { action: 'go', outsideNotified };
}

function markPending(store, spec, now) {
  const all = bucket(store);
  for (const id of spec.durable || []) all[id] = { status: 'pending', at: now };
  for (const item of spec.soft || []) all[item.id] = { status: 'pending', at: now, expiresAt: now + item.ttl };
  store.flushNow();
}

function markSent(store, spec, now, extra = {}) {
  const all = bucket(store);
  for (const id of spec.durable || []) all[id] = { status: 'sent', at: now, ...extra };
  for (const item of spec.soft || []) all[item.id] = { status: 'sent', at: now, expiresAt: now + item.ttl, ...extra };
  store.flushNow();
}

function markSkipped(store, ids, reason, now) {
  const all = bucket(store);
  for (const id of ids || []) {
    if (!id) continue;
    const prev = all[id] || {};
    all[id] = { status: 'skipped', reason, at: prev.at || now, notified: true, psid: prev.psid || '' };
  }
  store.flushNow();
}

function releasePending(store, spec) {
  const all = bucket(store);
  const ids = [...(spec.durable || []), ...(spec.soft || []).map((item) => item.id)];
  for (const id of ids) if (all[id] && all[id].status === 'pending') delete all[id];
  store.flushNow();
}

// First time we record this submission as skipped, the caller should alert staff.
function firstSkip(store, id, reason, now) {
  if (!id) return true;
  const all = bucket(store);
  const prev = all[id];
  const seen = Boolean(prev && prev.status === 'skipped' && prev.notified && prev.reason === reason);
  all[id] = { status: 'skipped', reason, at: (prev && prev.at) || now, notified: true, psid: (prev && prev.psid) || '' };
  store.flushNow();
  return !seen;
}

module.exports = {
  makeRef, readRef, makeToken, readToken, bookingFormLink, personalizeFormUrls,
  plainFormUrl, expandShortLink, SHORT_LINK_MS,
  normalizePageKey, pageRecord, normalizeWait, bookingKind, confirmText, agreeAckText,
  isAgree, referralRef, parseReferralRef, messengerConfirmUrl, referralFromEvent,
  originAllowed, cleanName, prettyBookingDate, authorizeNetlify, verifyNetlifyJws,
  parseNetlifySubmission, submissionDate, identityFrom, normalizeMobile, mobileLast4, matchMobile,
  textHasFormLink, textHasLinkTrigger, textIsStaffFormSignal, normalizeTriggerText,
  personalFormLinkText, isPersonalFormLinkText, namesRoughlyMatch, phonesInText, pickStaffLink, staffNeedReason,
  matchJobMobile, outsideWindowError, deliveryKeys, deliveryHold, markPending,
  markSent, markSkipped, releasePending, firstSkip, REF_PARAM,
};
