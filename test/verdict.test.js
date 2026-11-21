'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeVerdict, parsePrice } = require('../src/verdict');

test('repairable verdict needs a price and asks for availability without proposing a day', () => {
  assert.equal(composeVerdict({ verdict: 'repairable' }).ok, false);
  assert.equal(composeVerdict({ verdict: 'repairable', price: '0' }).ok, false);
  const r = composeVerdict({ verdict: 'repairable', price: '8,500' });
  assert.equal(r.ok, true);
  assert.equal(r.price, 8500);
  assert.match(r.text, /₱8,500/);
  assert.match(r.text, /Kailan po kayo available/);
  assert.doesNotMatch(r.text, /bukas|today|ngayon|technician (?:si|na si)/i);
});

test('other verdicts need no price and the note is appended and trimmed', () => {
  const no = composeVerdict({ verdict: 'not_repairable', note: '  panel po ang sira  ' });
  assert.equal(no.ok, true);
  assert.match(no.text, /panel po ang sira/);
  const more = composeVerdict({ verdict: 'need_video' });
  assert.equal(more.ok, true);
  assert.match(more.text, /mas malinaw na video/);
  assert.equal(composeVerdict({ verdict: 'maybe' }).ok, false);
});

test('prices outside the sane range are rejected', () => {
  assert.equal(parsePrice('abc'), 0);
  assert.equal(parsePrice('-5'), 5);
  assert.equal(parsePrice('999999'), 0);
  assert.equal(parsePrice('₱9,500'), 9500);
});
