'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CARDS, amountsIn, cardForQuote, checkupCard, answersCheckupFee, cardUrl, cardKey } = require('../src/price-cards');

test('every card in the manifest has a photo on disk', () => {
  for (const c of CARDS) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'price-cards', c.file)), c.file);
  assert.equal(CARDS.filter((c) => c.kind === 'backlight').length, 11);
  assert.equal(CARDS.filter((c) => c.kind === 'lcd').length, 7);
  assert.ok(checkupCard());
});

test('amounts are read from peso text', () => {
  assert.deepEqual([...amountsIn('₱6,000 po, all in. PHP 4500 at P 8,500')].sort(), [4500, 6000, 8500]);
});

test('a card is chosen only when its printed price matches the quoted price for that size', () => {
  assert.equal(cardKey(cardForQuote({ size: '43', text: 'Possible backlight po, ₱6,000.' })), 'backlight-43');
  assert.equal(cardKey(cardForQuote({ size: 43, text: 'LCD modification ₱6,500 po.' })), 'lcd-43');
  assert.equal(cardForQuote({ size: 43, text: 'backlight ₱4,500 po' }), null); // card says 6,000
  assert.equal(cardForQuote({ size: 43, text: 'LCD modification ₱5,000' }), null); // old price card not stored
  assert.equal(cardForQuote({ size: 0, text: '₱6,000' }), null);
  assert.equal(cardForQuote({ size: 90, text: '₱6,000' }), null);
});

test('a size where backlight and LCD mod share a price needs the word to pick one', () => {
  assert.equal(cardForQuote({ size: 55, text: 'Total ₱8,500 po all in.' }), null);
  assert.equal(cardKey(cardForQuote({ size: 55, text: 'Backlight po, ₱8,500.' })), 'backlight-55');
  assert.equal(cardKey(cardForQuote({ size: 55, text: 'LCD modification ₱8,500.' })), 'lcd-55');
});

test('a check-up fee answer is recognized and a repair quote is not', () => {
  assert.equal(answersCheckupFee('₱1,000 po ang check-up fee sa bahay, ibabawas po ito sa repair kung itutuloy nyo po.'), true);
  assert.equal(answersCheckupFee('₱300 po ang check-up kapag dadalhin ninyo ang TV sa shop.'), true);
  assert.equal(answersCheckupFee('Depende po sa sira na makikita sa video.'), false);
  assert.equal(answersCheckupFee('Possible backlight po, ₱6,000.'), false);
  assert.equal(cardForQuote({ size: 43, text: 'Possible backlight po, ₱6,000. Check-up ₱1,000 po.' }).kind, 'backlight');
});

test('card url is built from the public base and only for manifest files', () => {
  assert.equal(cardUrl('https://x.test/', CARDS[0]), `https://x.test/price-cards/${CARDS[0].file}`);
  assert.equal(cardUrl('https://x.test', { file: '../x.jpg' }), '');
});
