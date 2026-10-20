'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Bot } = require('../src/bot');
const { loadConfig } = require('../src/config');

const ENROLL_CODE = 'Q8Z2-LH47-C9TR-V4PY';
const PAGE_ID = 'p-test';
const T0 = Date.parse('2026-10-20T14:00:00Z');

function setup(opts = {}) {
  let time = T0, flushCount = 0;
  const sent = [], logLines = [];
  const threads = {};
  const store = {
    data: { testEnrollment: null, threads },
    thread: (psid) => (threads[psid] ||= { history: [], pendingMedia: [], pausedUntil: 0 }),
    save() {},
    flush() { flushCount++; },
    addTurn(psid, role, content) { this.thread(psid).history.push({ role, content }); },
  };
  const cfg = loadConfig({
    PAGE_ID, BOT_ENABLED: 'false', BOT_TEST_MODE_ONLY: 'true',
    BOT_TEST_ENROLL_CODE: ENROLL_CODE, BOT_TEST_TIMEOUT_MINUTES: '30',
    ...opts,
  });
  const log = { info: (m) => logLines.push(m), warn: (m) => logLines.push(m),
    error: (m) => logLines.push(m) };
  const bot = new Bot({ cfg, store, log, now: () => time,
    graph: { sendText: async (id, message) => sent.push({ id, message }) },
    llm: {}, push: null });
  const message = (sender, text, standby = false) =>
    bot.onEvent({ sender: { id: sender }, message: { text, mid: 'test-' + sender } }, standby);
  return { bot, cfg, store, sent, message, logLines,
    setTime(v) { time = v; },
    getFlushCount() { return flushCount; } };
}

test('private test setting is disabled by default', () => {
  assert.equal(loadConfig({}).botTestOnly, false);
});
test('one enrolled account, no API reply and no enrollment secret in history', async () => {
  const t = setup();
  await t.message('owner', 'JMAGS TEST ' + ENROLL_CODE);
  assert.equal(t.bot.isTestAllowed('owner'), true);
  assert.equal(t.bot.isTestAllowed('visitor'), false);
  assert.deepEqual(t.sent, []);
  assert.equal(t.getFlushCount(), 1);
  assert.deepEqual(t.store.thread('owner').history, []);
  assert.doesNotMatch(t.logLines.join(' '), /Q8Z2|owner|visitor/);
});
test('a different account cannot steal an existing test enrollment', async () => {
  const t = setup();
  await t.message('owner', 'JMAGS TEST ' + ENROLL_CODE);
  await t.message('visitor', 'JMAGS TEST ' + ENROLL_CODE);
  assert.equal(t.bot.isTestAllowed('owner'), true);
  assert.equal(t.bot.isTestAllowed('visitor'), false);
});
test('unapproved messages are ignored before entering history', async () => {
  const t = setup();
  await t.message('visitor', 'hi, repair tv');
  assert.equal(t.store.data.threads.visitor, undefined);
  assert.deepEqual(t.sent, []);
});
test('a bad or short enrollment code cannot register a tester', async () => {
  const t = setup();
  await t.message('owner', 'JMAGS TEST wrong');
  assert.equal(t.bot.isTestAllowed('owner'), false);
  const weak = setup({ BOT_TEST_ENROLL_CODE: '123' });
  await weak.message('owner', 'JMAGS TEST 123');
  assert.equal(weak.bot.isTestAllowed('owner'), false);
});
test('enrollment expires and fails closed', async () => {
  const t = setup();
  await t.message('owner', 'JMAGS TEST ' + ENROLL_CODE);
  t.setTime(T0 + 30 * 60000 + 1);
  assert.equal(t.bot.isTestAllowed('owner'), false);
  await t.bot.send('owner', 'Hello');
  assert.equal(t.sent.length, 0);
});
test('sends only to enrolled owner, including manual dashboard sends', async () => {
  const t = setup();
  await t.message('owner', 'JMAGS TEST ' + ENROLL_CODE);
  await t.bot.send('visitor', 'Do not send');
  assert.equal(t.sent.length, 0);
  await t.bot.send('owner', 'Hello po');
  assert.deepEqual(t.sent, [{ id: 'owner', message: 'Hello po' }]);
});
test('cannot enroll another account while bot is enabled', async () => {
  const t = setup({ BOT_ENABLED: 'true' });
  await t.message('visitor', 'JMAGS TEST ' + ENROLL_CODE);
  assert.equal(t.bot.isTestAllowed('visitor'), false);
  assert.equal(t.store.data.threads.visitor, undefined);
});
test('old unrestricted BOT_TEST_PSIDS empty never overrides private test guard', () => {
  const t = setup({ BOT_ENABLED: 'true', BOT_TEST_PSIDS: '' });
  assert.equal(t.bot.blockReason('visitor', { handedOff: false }, T0), 'outside private test allowlist');
});
test('follow-ups are gated for all non-tester PSIDs', () => {
  const t = setup({ BOT_ENABLED: 'true' });
  assert.equal(t.bot.followUpSkip('visitor', {}, T0, 3600000), 'outside private test allowlist');
});
