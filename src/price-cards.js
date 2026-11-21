'use strict';
// Price-card photos (owner's Business Suite saved replies). A card is attached only when the
// price printed on it equals a price in the message the customer is getting, so the photo can
// never contradict the text. Ambiguous or unmatched -> no photo, text only.

const fs = require('node:fs');
const path = require('node:path');
const { cards: CARDS } = require('../knowledge/price-cards.json');

const FILE_RE = /^[a-z0-9-]+\.jpg$/;
const CARD_DIR = path.join(__dirname, '..', 'public', 'price-cards');

function fileReady(file) {
  return FILE_RE.test(String(file || '')) && fs.existsSync(path.join(CARD_DIR, file));
}

const FILES = new Set(CARDS.map((c) => c.file).filter(fileReady));

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

function cardAmounts(card) {
  return [card && card.price, card && card.replacePrice].filter((n) => Number(n) > 0);
}

// The card for this size whose printed price is in the text. A missing photo is skipped.
function cardForQuote({ size, text } = {}) {
  const n = sizeOf(size);
  if (!n) return null;
  const amts = amountsIn(text);
  const t = String(text || '');
  const hits = CARDS.filter((c) => c.kind !== 'checkup' && c.size === n && cardAmounts(c).some((p) => amts.has(p)) && fileReady(c.file));
  if (!hits.length) return null;
  const wantBack = /backlight/i.test(t);
  const wantLcd = /lcd|panel|basag|cracked|linya|\blines\b|modification|\bmodif|no display|walang display|palit lcd|replacement/i.test(t);
  if (wantBack && !wantLcd) {
    const back = hits.find((c) => c.kind === 'backlight');
    if (back) return back;
  }
  if (wantLcd && !wantBack) {
    const lcd = hits.find((c) => c.kind === 'lcd');
    if (lcd) return lcd;
  }
  return hits.length === 1 ? hits[0] : null;
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
  if (!card) return '';
  if (card.kind === 'checkup') return 'checkup-1000';
  return `${card.kind}-${card.size}`;
}

function cardUrl(origin, card) {
  if (!card || !fileReady(card.file)) return '';
  return `${String(origin || '').replace(/\/$/, '')}/price-cards/${card.file}`;
}

module.exports = { CARDS, FILES, FILE_RE, amountsIn, cardForQuote, checkupCard, answersCheckupFee, cardKey, cardUrl, fileReady };
