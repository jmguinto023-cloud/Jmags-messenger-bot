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
  bookingFormMessage,
  DEFAULT_TIPS,
};
module.exports = lines;
