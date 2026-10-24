'use strict';
// Canned Ivan-style lines used when the AI is not called or fails.

function bookingFormMessage(url) {
  return `Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊\n\n${url}`;
}

// Messenger shows raw Markdown. Drop the markers the model copies from the prompt.
// A normal answer is 2–3 short lines and must stay under 300 characters.
function capCustomerReply(text) {
  let s = String(text || '').replace(/\p{Extended_Pictographic}/gu, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n').trim();
  s = s.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).join('\n');
  if (s.length <= 300) return s;
  const cut = s.slice(0, 300);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return (at >= 80 ? cut.slice(0, at + 1) : cut).trim();
}

function replyOverflows(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const count = s.split('\n').map((line) => line.trim()).filter(Boolean).length;
  return s.length > 300 || count > 3;
}

// CRT, tube, and other non-flatscreen units. Do not guess whether JMAG repairs them.
const NON_FLATSCREEN = /\bcrt\b|cathode|picture tube|\btube tv\b|rear projection|projection tv|non-?flatscreen|hindi flat(?:\s*screen)?|not a flat screen|makapal na tv/i;

function nonFlatscreenLine(text) {
  const t = String(text || '');
  if (!NON_FLATSCREEN.test(t)) return '';
  if (/\bcrt\b|cathode|picture tube|\btube tv\b|makapal na tv/i.test(t)) {
    return 'CRT po ba sir? Si Ivan na po ang sasagot dito.';
  }
  return 'Hindi po flatscreen ito sir? Si Ivan na po ang sasagot dito.';
}

function sanitizeOutgoing(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`+/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .trim();
}

const DEFAULT_TIPS = `Habang nirereview po ng technician ang video, eto po ang aming free tips para malaman ang senyales ng TV bago ito tuluyang masira:

- May lumalabas na lines
- May spot na puti o itim
- Nag-iiba ang kulay
- Nagloloko ang power
- Nag-iiba ang program

Mas mainam po na kumonsulta agad sa JMAG's, libre po ang aming consultation. Pwede po kayong tumawag sa:
09386369374 (Smart)
09267229506 (Globe)`;

const lines = {
  fallback:
    "Hi po maam/sir, salamat po sa message sa JMAG's Appliances! 😊 Para mabigyan po namin kayo agad ng presyo, paki-send lang po: brand at size ng TV, issue, at taga saan po sila 🙏",
  holding:
    'Noted po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito. Saglit lang po.',
  holdingMedia:
    'Noted po maam/sir 🙏 Natanggap po namin, si Ivan na po ang titingin at tutuloy sa inyo dito. Saglit lang po.',
  // Photo/video stay in this chat. No "video" in the text (a later follow-up treats that word as a request).
  mediaAck:
    'Salamat po! Ipapacheck ko po sa technician.',
  holdingPerson:
    'Sige po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito. Saglit lang po.',
  sanitizeOutgoing,
  capCustomerReply,
  replyOverflows,
  nonFlatscreenLine,
  bookingFormMessage,
  DEFAULT_TIPS,
};
module.exports = lines;
