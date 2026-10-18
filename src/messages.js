'use strict';
// Canned Ivan-style lines used when the AI is not called or fails.

function bookingFormMessage(url) {
  return `Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊\n\n${url}`;
}

// Messenger shows raw Markdown. Drop the markers the model copies from the prompt.
function sanitizeOutgoing(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`+/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .trim();
}

const lines = {
  fallback:
    "Hi po maam/sir, salamat po sa message sa JMAG's Appliances! 😊 Para mabigyan po namin kayo agad ng presyo, paki-send lang po: brand at size ng TV, issue, at taga saan po sila 🙏",
  holding:
    'Noted po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito. Saglit lang po.',
  holdingMedia:
    'Noted po maam/sir 🙏 Natanggap po namin, si Ivan na po ang titingin at tutuloy sa inyo dito. Saglit lang po.',
  // Photo/video stay in this chat. No "video" in the text (a later follow-up treats that word as a request).
  mediaAck:
    'Salamat po! Ipapacheck ko po sa technician. Ano po ang issue, kailan po nagsimula, at taga-saan po sila?',
  holdingPerson:
    'Sige po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito. Saglit lang po.',
  sanitizeOutgoing,
  bookingFormMessage,
};
module.exports = lines;
