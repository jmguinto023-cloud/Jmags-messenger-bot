'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PrivateMessengerTest, SESSION_MS, ENROLL_MS, MAX_PROMPTS } = require('../src/private-messenger-test');
const { loadConfig } = require('../src/config');

const token = 'JMAGS-TEST-0123456789ABCDEF01234567';
function fixture(extra = {}) {
  let time = Date.parse('2026-10-20T15:00:00Z');
  const outbound = [];
  const calls = [];
  const logs = [];
  const cfg = loadConfig({
    BOT_ENABLED: 'false', BOT_TEST_MODE: 'true', BOT_TEST_TOKEN: token,
    AI_ROUTER_ENABLED: 'true', AI_EXTERNAL_DATA_ALLOWED: 'true',
    ...extra,
  });
  const graph = {
    sendText: async (psid, content) => { outbound.push({ psid, content }); },
  };
  const llm = {
    configured: () => true,
    reply: async (history) => {
      calls.push(history.map((t) => ({ ...t })));
      return 'Sample response from AI';
    },
  };
  const log = { info: (msg) => logs.push(msg), warn: (msg) => logs.push(msg) };
  const runner = new PrivateMessengerTest(cfg, { now: () => time, graph, llm, log });
  return { runner, outbound, calls, logs, cfg, advance: (ms) => { time += ms; } };
}
test('disabled unless explicitly opt-in with every safety gate', () => {
  for (const env of [
    { BOT_TEST_MODE: 'false' },
    { BOT_ENABLED: 'true' },
    { AI_ROUTER_ENABLED: 'false' },
    { AI_EXTERNAL_DATA_ALLOWED: 'false' },
    { BOT_TEST_TOKEN: 'too-short' },
  ]) {
    assert.equal(fixture(env).runner.enabled(), false);
  }
});
test('enroll one owner, suppress token logging and block others', async () => {
  const x = fixture();
  assert.equal(await x.runner.handle({ psid: 'tester', text: token }), true);
  assert.equal(x.outbound.length, 1);
  assert.match(x.outbound[0].content, /PRIVATE AI TEST READY/);
  assert.equal(x.runner.ownerPsid, 'tester');
  assert.equal(await x.runner.handle({ psid: 'other', text: token }), true);
  assert.equal(await x.runner.handle({ psid: 'other', text: 'Hello' }), false);
  assert.equal(x.outbound.length, 1);
  assert.equal(x.logs.join(' ').includes(token), false);
});
test('test-only replies get generated without stored customer history', async () => {
  const x = fixture();
  await x.runner.handle({ psid: 'tester', text: token });
  await x.runner.handle({ psid: 'tester', text: '55 inch TV flickering po' });
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].map((m) => m.content), ['55 inch TV flickering po']);
  assert.equal(x.outbound.length, 2);
  assert.equal(x.outbound[1].psid, 'tester');
});
test('no personal contact details can be sent to AI during test', async () => {
  const x = fixture();
  await x.runner.handle({ psid: 'tester', text: token });
  await x.runner.handle({ psid: 'tester', text: 'Call me at 09171234567' });
  assert.equal(x.calls.length, 0);
  assert.match(x.outbound[1].content, /without a name/);
});
test('media and standby messages cannot trigger provider requests', async () => {
  const x = fixture();
  await x.runner.handle({ psid: 'tester', text: token });
  await x.runner.handle({ psid: 'tester', text: 'video', media: [{type:'video'}] });
  await x.runner.handle({ psid: 'tester', text: 'hello', isStandby: true });
  assert.equal(x.calls.length, 0);
});
test('the 30-minute enrollment window closes', async () => {
  const x = fixture();
  x.advance(ENROLL_MS + 1);
  await x.runner.handle({ psid: 'tester', text: token });
  assert.equal(x.runner.ownerPsid, '');
  assert.equal(x.outbound.length, 0);
});
test('the 15-minute session expires and cannot be renewed', async () => {
  const x = fixture();
  await x.runner.handle({ psid: 'tester', text: token });
  x.advance(SESSION_MS + 1);
  await x.runner.handle({ psid: 'tester', text: 'hello' });
  await x.runner.handle({ psid: 'tester', text: token });
  assert.equal(x.calls.length, 0);
  assert.equal(x.outbound.length, 2);
  assert.match(x.outbound[1].content, /test finished/);
});
test('maximum five prompts, no sixth provider call', async () => {
  const x = fixture();
  await x.runner.handle({ psid: 'tester', text: token });
  for (let i = 0; i < MAX_PROMPTS + 3; i++) {
    await x.runner.handle({ psid: 'tester', text: 'Sample test question ' + i });
  }
  assert.equal(x.calls.length, MAX_PROMPTS);
  assert.equal(x.outbound.length, 1 + MAX_PROMPTS + 1);
});
test('AI handoff marker does not trigger actual staff handoff', async () => {
  const x = fixture();
  x.runner.llm.reply = async () => '[HANDOFF: wants Ivan]';
  await x.runner.handle({ psid: 'tester', text: token });
  await x.runner.handle({ psid: 'tester', text: 'staff po' });
  assert.match(x.outbound[1].content, /No staff notification/);
});
test('errors never reveal provider secrets or trigger staff handoff', async () => {
  const x = fixture();
  x.runner.llm.reply = async () => { throw new Error('api-key-leak'); };
  await x.runner.handle({ psid: 'tester', text: token });
  await x.runner.handle({ psid: 'tester', text: 'What is flickering?' });
  assert.match(x.outbound[1].content, /could not complete/);
  assert.doesNotMatch(x.logs.join(' '), /api-key-leak/);
});
