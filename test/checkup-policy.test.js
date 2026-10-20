'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SHOP_CHECKUP_PHP, SHOP_CHECKUP_FEE_PLAIN, CHECKUP_FEE_PLAIN,
  CHECKUP_NUDGE, checkupFeeReply, applyCustomerGuard, asksCheckupFee,
} = require('../src/estimate');
const { HOME_VISIT_FEE_LINE } = require('../src/home-visit-fee');
const { quickReply } = require('../src/quick-replies');

test('owner-confirmed ₱300 for customer bringing any size TV to shop', () => {
  assert.equal(SHOP_CHECKUP_PHP, 300);
  assert.match(SHOP_CHECKUP_FEE_PLAIN, /₱300/);
  assert.doesNotMatch(SHOP_CHECKUP_FEE_PLAIN, /waived|₱500|₱1,000/i);
  for(const q of [
    'Magkano po checkup kung sa shop ko dadalhin?',
    'How much po ang check-up sa branch?',
    'Magkano ang checkup if walk-in?',
    'Magkano ang check-up for Samsung 75 inch sa shop?',
    'Magkano check-up ng 32 inch kung dalhin namin sa shop?',
  ]) assert.equal(checkupFeeReply(q), SHOP_CHECKUP_FEE_PLAIN, q);
});
test('at-home rate remains ₱1,000, waived if repair proceeds', () => {
  for(const q of [
    'How much ang check-up for home service?',
    'Magkano ang checkup pag sa bahay kayo pupunta?',
    'Magkano checkup fee kung puntahan niyo po kami?',
  ]) assert.equal(checkupFeeReply(q), HOME_VISIT_FEE_LINE, q);
  assert.match(HOME_VISIT_FEE_LINE, /₱1,000/);
  assert.match(HOME_VISIT_FEE_LINE, /Waived/);
  assert.match(HOME_VISIT_FEE_LINE, /walang hiwalay/);
});
test('ambiguous checkup question offers both options and asks one question', () => {
  assert.match(CHECKUP_FEE_PLAIN,/₱300/);
  assert.match(CHECKUP_FEE_PLAIN,/₱1,000/);
  assert.doesNotMatch(CHECKUP_FEE_PLAIN,/₱500/);
  assert.equal((CHECKUP_FEE_PLAIN.match(/\?/g)||[]).length,1);
  assert.equal(checkupFeeReply('magkano po ang check-up?'), CHECKUP_FEE_PLAIN);
  assert.equal(quickReply('magkano checkup?', {}), CHECKUP_FEE_PLAIN);
});
test('latest service option overrides older context', () => {
  const thread = { history: [{role:'user',content:'Dadalhin ko sa shop'}] };
  assert.equal(checkupFeeReply('magkano po ang check-up?',thread), SHOP_CHECKUP_FEE_PLAIN);
  assert.equal(checkupFeeReply('magkano ang checkup home service?',thread), HOME_VISIT_FEE_LINE);
});
test('history home-service context is respected for follow-up fee question', () => {
  const thread = { history: [{role:'assistant', content:'Pwede po mag-home service.'},
    {role:'user',content:'Sige po punta kayo sa bahay'}] };
  assert.equal(checkupFeeReply('How much po ang checkup?',thread), HOME_VISIT_FEE_LINE);
});
test('guards never revert to the former small-TV rate', () => {
  assert.equal(asksCheckupFee('magkano po check-up?'),true);
  assert.equal(applyCustomerGuard({history:[]}, '₱500 po', 'magkano po ang check-up?'), CHECKUP_FEE_PLAIN);
  assert.doesNotMatch(CHECKUP_NUDGE,/₱500/);
  assert.match(CHECKUP_NUDGE,/₱1,000/);
});
