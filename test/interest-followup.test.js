'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { showsRepairInterest, skipReason } = require('../src/interest-followup');

const HOUR = 3600 * 1000;
const base = (over = {}) => ({
  lastUserTs: 1000, history: [{ role: 'user', content: 'Magkano po magpagawa ng TV 43 inch?', ts: 1000 }], ...over,
});
const opts = { now: 1000 + 61 * 60 * 1000, afterMs: HOUR, windowMs: 23 * HOUR, hasReview: false };

test('repair interest is detected, declines and disputes are not', () => {
  assert.equal(showsRepairInterest([{ role: 'user', content: 'Magkano po magpagawa ng Samsung TV?' }]), true);
  assert.equal(showsRepairInterest([{ role: 'user', content: 'Hello po' }]), false);
  assert.equal(showsRepairInterest([{ role: 'user', content: 'magkano po repair? ayaw na pala, naayos na' }]), false);
  assert.equal(showsRepairInterest([{ role: 'user', content: 'reklamo ko yung tv repair' }]), false);
});

test('nudge is due after an hour of silence and only then', () => {
  assert.equal(skipReason(base(), opts), '');
  assert.equal(skipReason(base(), { ...opts, now: 1000 + 30 * 60 * 1000 }), 'too soon');
  assert.equal(skipReason(base(), { ...opts, now: 1000 + 24 * HOUR }), 'outside the messaging window');
});

test('no nudge once a video was sent, a booking started, staff are involved or it was already sent', () => {
  assert.equal(skipReason(base(), { ...opts, hasReview: true }), 'video already sent');
  assert.equal(skipReason(base({ interestFollowupAt: 5 }), opts), 'already nudged');
  assert.equal(skipReason(base({ bookingFormSent: true }), opts), 'booking started');
  assert.equal(skipReason(base({ handedOff: true }), opts), 'with staff');
  assert.equal(skipReason(base({ optedOut: true }), opts), 'opted out');
  assert.equal(skipReason(base({ lastHumanEchoAt: 2000 }), opts), 'staff replied');
});
