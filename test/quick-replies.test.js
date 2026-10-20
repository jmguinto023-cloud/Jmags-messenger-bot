'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quickReply } = require('../src/quick-replies');
test('simple greeting uses a free approved reply', () => {
  assert.match(quickReply('Hi po', {}), /JMAGS Appliances/);
});
test('bookings are requests, not confirmed appointments', () => {
  const result = quickReply('pa-book po', { bookingFormUrl: 'https://example.test/book' });
  assert.match(result, /example\.test\/book/);
  assert.match(result, /Iko-confirm/);
});
test('warranty and complaints never get canned replies', () => {
  assert.equal(quickReply('warranty', {}), '');
  assert.equal(quickReply('nasira ulit', {}), '');
});
test('unverified shop hours and location never get invented', () => {
  assert.equal(quickReply('operating hours', {}), '');
  assert.equal(quickReply('shop location', {}), '');
});
test('questions involving more than one topic go to the normal bot', () => {
  assert.equal(quickReply('hi pero warranty issue', {}), '');
});
test('do not answer without booking form URL', () => {
  assert.equal(quickReply('pa-book po', { bookingFormUrl: '' }), '');
});
