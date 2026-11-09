'use strict';
// Booking form → Messenger confirmation.
//
// The customer form asks "Willing to wait po ba kayo within the day?".
//   YES = Regular, the technician calls any time 9 AM–5 PM that day.
//   NO  = automatic Priority (+₱1,000), first in the line-up.
// After the form is submitted, the bot sends the matching message on Messenger and
// asks the customer to reply AGREE. An AGREE reply marks the booking confirmed.
//
// The form reaches the right Messenger thread in one of two ways:
//   1. The link the bot sends carries ?ref=<signed PSID>. The form posts it back to
//      POST /booking/submitted and the bot messages that thread at once.
//   2. No ref (e.g. Ivan pasted the plain link): the form shows a "Confirm sa Messenger"
//      button to m.me/<page>?ref=BK_... and the bot replies when the customer taps it.
const crypto = require('node:crypto');

const REF_PARAM = 'ref';
const REFERRAL_PREFIX = 'BK_';

function secret(cfg) {
  return String(cfg.bookingRefSecret || cfg.appSecret || cfg.adminToken || '');
}

function sign(cfg, value) {
  return crypto.createHmac('sha256', secret(cfg)).update(String(value)).digest('base64url').slice(0, 16);
}

// Opaque, signed reference to one Messenger thread. Only the bot can mint a valid one.
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

// Give every booking-form link the bot sends this customer's own ref, so the
// form can send the confirmation back to this exact chat.
function personalizeFormUrls(cfg, text, psid) {
  const base = String(cfg.bookingFormUrl || '').trim();
  const ref = makeRef(cfg, psid);
  if (!base || !ref || !text || !text.includes(base)) return text;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A link that already has ?ref= stays as written. Other query params still get this chat's signed ref.
  return text.replace(new RegExp(`${escaped}[^\\s)]*`, 'g'), (link) => {
    let u;
    try { u = new URL(link); } catch { return link; }
    if (u.searchParams.has(REF_PARAM)) return link;
    u.searchParams.set(REF_PARAM, ref);
    if (cfg.bookingBotKey && !u.searchParams.has('b')) u.searchParams.set('b', cfg.bookingBotKey);
    return u.toString();
  });
}

function normalizeWait(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['yes', 'y', 'oo', 'true', 'regular', 'willing'].includes(v)) return 'yes';
  if (['no', 'n', 'hindi', 'false', 'priority'].includes(v)) return 'no';
  return '';
}

function cleanName(name) {
  return String(name || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function confirmText(name, wait) {
  const who = cleanName(name);
  const hello = who ? `Hello po mam/sir ${who}` : 'Hello po mam/sir';
  if (normalizeWait(wait) === 'no') {
    return [
      `${hello},`,
      'Dahil pinili nyo ang "NO" option, automatic po Priority kayo, kayo po ang mauuna sa line-up. Today!',
      'Reply "AGREE" po sa chat para maconfirm po namin. Maraming salamat po. Happy to serve you all 😊',
    ].join('\n');
  }
  return [
    `${hello},`,
    'Dahil pinili nyo po ang YES, ibig sabihin willing to wait po kayo sa schedule nyo within that day.',
    "Don't worry po, from 9am to 5pm marereceive nyo po ang tawag ng technician namin as soon as possible.",
    'Reply "AGREE" lang po kayo sa message para ma-confirm po. Maraming salamat po sa pagtitiwala. Happy to serve you all 🙂',
  ].join('\n');
}

function agreeAckText(wait) {
  return normalizeWait(wait) === 'no'
    ? 'Salamat po! Confirmed na po ang booking ninyo bilang PRIORITY ✅ Kayo po ang mauuna sa line-up.'
    : 'Salamat po! Confirmed na po ang booking ninyo ✅ Tatawagan po kayo ng technician namin within the day, 9am to 5pm.';
}

function isAgree(text) {
  return /^\s*(?:ok(?:ay)?[\s,.!]*)?(?:i\s+)?agree(?:d)?(?:\s+(?:po|na|na po|ako|kami))*[\s.!👍🙂😊]*$/i.test(String(text || ''));
}

// m.me ref payload for the no-ref fallback. Meta allows letters, digits, + / = - . : _ (max 250).
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

module.exports = {
  makeRef, readRef, personalizeFormUrls, normalizeWait, confirmText, agreeAckText, isAgree,
  referralRef, parseReferralRef, messengerConfirmUrl, referralFromEvent, originAllowed, cleanName,
};
