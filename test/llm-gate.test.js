'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LlmGate } = require('../src/llm-gate');

test('a slow call for one customer does not block the next customer', async () => {
  const gate = new LlmGate({ rpm: 0 });
  let releaseSlow;
  const order = [];
  const slow = gate.schedule(() => new Promise((r) => { releaseSlow = () => { order.push('slow'); r('A'); }; }));
  const fast = gate.schedule(async () => { order.push('fast'); return 'B'; });
  assert.equal(await fast, 'B');
  releaseSlow();
  assert.equal(await slow, 'A');
  assert.deepEqual(order, ['fast', 'slow']);
});

test('call starts are still spaced by rpm and a failure reaches only its caller', async () => {
  let t = 0;
  const starts = [];
  const gate = new LlmGate({ rpm: 60, now: () => t, sleep: async (ms) => { t += ms; } });
  const a = gate.schedule(async () => { starts.push(t); throw new Error('boom'); });
  const b = gate.schedule(async () => { starts.push(t); return 'ok'; });
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
  assert.deepEqual(starts, [0, 1000]);
});
