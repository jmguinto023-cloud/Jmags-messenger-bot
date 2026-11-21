'use strict';
// Price-card photos (owner's Business Suite saved replies). A card is attached only when the
// price printed on it equals a price in the message the customer is getting, so the photo can
// never contradict the text. Ambiguous or unmatched -> no photo, text only.

const { cards: CARDS } = require('../knowledge/price-cards.json');

const FILE_RE = /^[a-z0-9-]+\.jpg$/;
const FILES = new Set(CARDS.map((c) => c.file));

function amountsIn(text) {
  const out = new Set();
  const re = /(?:₱|php\s?|\bp\s?)(\d{1,3}(?:,\d{3})+|\d{3,6})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.add(Number(m[1].replace(/,/g, '')));
  return out;
}

function sizeOf(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

// The one card that matches this TV size and a price in the text, or null.
function cardForQuote({ size, text } = {}) {
  const n = sizeOf(size);
  if (!n) return null;
  const amts = amountsIn(text);
  const hits = CARDS.filter((c) => c.size === n && c.kind !== 'checkup' && amts.has(c.price));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const t = String(text || '');
    const byWord = hits.filter((c) => (c.kind === 'backlight' ? /backlight/i : /lcd|panel/i).test(t));
    if (byWord.length === 1) return byWord[0];
  }
  return null;
}

function checkupCard() {
  return CARDS.find((c) => c.kind === 'checkup') || null;
}

// The outgoing text states the shop or home check-up fee, and is not a repair quote.
function answersCheckupFee(text) {
  const t = String(text || '');
  if (!/check-?\s*up|checkup|tsek-?\s*ap|tsekap/i.test(t)) return false;
  if (/backlight|lcd modification|power supply|motherboard|reprogramming/i.test(t)) return false;
  return /₱\s?(?:300|1,?000)\b/.test(t);
}

function cardKey(card) {
  return card ? `${card.kind}-${card.size}` : '';
}

function cardUrl(origin, card) {
  if (!card || !FILE_RE.test(card.file)) return '';
  return `${String(origin || '').replace(/\/$/, '')}/price-cards/${card.file}`;
}

module.exports = { CARDS, FILES, FILE_RE, amountsIn, cardForQuote, checkupCard, answersCheckupFee, cardKey, cardUrl };
