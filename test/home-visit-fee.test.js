'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HOME_VISIT_CHECKUP_PHP, HOME_VISIT_FEE_LINE,
  homeVisitIntent, ensureHomeVisitFee, lastAssistantText } = require('../src/home-visit-fee');
const { redactContact } = require('../src/ai-router');

test('JMAGS at-home checkup fee is ₱1,000', () => {
  assert.equal(HOME_VISIT_CHECKUP_PHP, 1000);
  assert.match(HOME_VISIT_FEE_LINE,/₱1,000/);
  assert.match(HOME_VISIT_FEE_LINE,/waived/i);
  assert.match(HOME_VISIT_FEE_LINE,/staff.*confirm/i);
});
test('fee disclosed before sending booking link for an agreed home visit', () => {
  const text = ensureHomeVisitFee('Schedule request: https://example.test/book','Sige po, pa-home service kami');
  assert.match(text,/^Bago po magpa-home service: ₱1,000/);
  assert.ok(text.indexOf('₱1,000') < text.indexOf('https://example.test/book'));
});
test('customer agrees to house visit directly', () => {
  for (const text of ['Puntahan niyo po kami sa bahay', 'Sige po, punta na kayo sa bahay namin',
    'Gusto ko po magpa-home service', 'Paki punta po sa bahay', 'Please come to my house',
    'Sige pa-home service po']) {
    assert.equal(homeVisitIntent(text), true, text);
  }
});
test('short yes to a home-service offer discloses fee', () => {
  const history=[{role:'assistant',content:'Pwede po tayong mag-home service sa bahay ninyo.'}];
  assert.equal(lastAssistantText(history).includes('home service'), true);
  const text=ensureHomeVisitFee('Iko-confirm ng staff ang slot.', 'Opo', history);
  assert.match(text,/₱1,000/);
});
test('normal unrelated yes does not add fee', () => {
  assert.equal(ensureHomeVisitFee('Sige po.', 'Opo', [{role:'assistant',content:'Ano po ang sira?'}]), 'Sige po.');
});
test('home-service question with no acceptance does not invent a booking', () => {
  assert.equal(homeVisitIntent('Pwede po ba home service?'), false);
  assert.equal(homeVisitIntent('Ayoko po mag home service'), false);
});
test('direct question about home checkup returns rate', () => {
  const text=ensureHomeVisitFee('Iche-check po namin.', 'How much checkup fee for home service?');
  assert.match(text,/₱1,000/);
});
test('no duplicate fee if model already gave the correct one', () => {
  const value='₱1,000 po ang check-up fee, waived if repair.';
  assert.equal(ensureHomeVisitFee(value, 'Sige home service na po'), value);
});
test('redaction must preserve natural TV repair messages', () => {
  for (const input of ['Ang unit ay Samsung 65-inch TV.',
    'Kailangan ma-inspect ang TV unit ng technician.',
    'Ang location po ay San Pablo, Laguna.',
    'Need po i-review muna ang actual issue ng unit.']) {
    assert.equal(redactContact(input), input);
  }
});
test('redaction still masks address numbers and contacts', () => {
  const cleaned=redactContact('Call 09171234567, my email is example@example.com, Unit 12, 123 Maple Street.');
  assert.doesNotMatch(cleaned,/09171234567|example@example.com|Unit 12|123 Maple Street/);
});

test('owner-confirmed waiver means no separate ₱1,000 charge if repaired', () => {
  assert.match(HOME_VISIT_FEE_LINE, /waived/i);
  assert.match(HOME_VISIT_FEE_LINE, /walang hiwalay na ₱1,000 check-up charge/i);
  assert.match(HOME_VISIT_FEE_LINE, /Staff .*confirm/i);
});
