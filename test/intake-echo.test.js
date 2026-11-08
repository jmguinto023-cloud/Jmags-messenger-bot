'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { detectLocation } = require('../src/branch');
const { isEchoOnly, QUESTIONS, updateIntake, missingSlot } = require('../src/intake');
const { quoteKnownTv } = require('../src/estimate');
const { quotedPrice } = require('../src/booking');
const { estimateTokens, compactPrompt } = require('../src/llm');

const SECRET = 's';
const MAIN = '102622881557025';

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

async function setup() {
  const mock = await startMock();
  const app = build({
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: SECRET, APP_ID: '1', PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'T',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm',
    BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0', LOG_LEVEL: 'silent',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-echo-')),
  });
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const say = async (psid, text) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: MAIN, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: MAIN }, timestamp: ts, message: { mid: `e.${n}`, text } }] }],
    });
    await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return app.store.thread(psid).history.filter((h) => h.role === 'assistant').map((h) => h.content).at(-1) || '';
  };
  return { app, mock, say, close: async () => { await app.bot.idle(); app.server.close(); await mock.close(); } };
}

test('echo-only replies are rejected, and Lipa routes to San Pablo', () => {
  const thread = { slots: { brand: 'Devant', size: '', symptom: '', age: '1 year', location: 'Lipa Batangas' } };
  assert.equal(isEchoOnly('Devant po, 1 yr. Ilan ang Laguna?', thread), true);
  assert.equal(isEchoOnly('Devant, 1 yr, Lipa, Batangas. May na-repair na sa ibang shop?', thread), true);
  assert.equal(isEchoOnly('Devant, 1 yr, Lipa, Batangas, wala pa sa ibang shop.', thread), true);
  assert.equal(isEchoOnly(QUESTIONS.symptom, thread), false);
  assert.equal(isEchoOnly(QUESTIONS.size, thread), false);
  assert.equal(detectLocation('Lipa batangas').branch, 'San Pablo');
  assert.equal(detectLocation('Brgy Marawoy, Lipa City, Batangas').branch, 'San Pablo');
});

test('Devant, sira, 1yr, Lipa, wala pa asks the symptom, then the size, then a price', async () => {
  const s = await setup();
  const echoes = [
    'Devant po, 1 yr. Ilan ang Laguna?',
    'Devant, 1 yr, Lipa, Batangas. May na-repair na sa ibang shop?',
    'Devant, 1 yr, Lipa, Batangas, wala pa sa ibang shop.',
    'Devant po, Lipa. Ilang taon na ulit?',
  ];
  let i = 0;
  s.mock.state.llmResponder = () => echoes[Math.min(i++, echoes.length - 1)];
  try {
    const first = await s.say('dv', 'Devant po, sira, 1 year, Lipa Batangas');
    const second = await s.say('dv', 'wala pa sa ibang shop');
    assert.equal(s.app.store.thread('dv').slots.symptom, 'sira');
    const third = await s.say('dv', 'may sound pero walang picture');
    const quote = await s.say('dv', '55 inches po');
    for (const line of [first, second, third]) {
      assert.doesNotMatch(line, /Devant|Lipa|Batangas|1 yr|1 year|Laguna|wala pa/i);
    }
    assert.equal(first, QUESTIONS.symptom);
    assert.equal(second, QUESTIONS.size);
    assert.equal(third, QUESTIONS.size);
    assert.match(quote, /video ng TV habang naka-on/);
    assert.doesNotMatch(quote, /₱|Kailan po sila free/);
    assert.doesNotMatch(quote, /Lipa|Batangas|1 yr|wala pa/i);
    assert.equal(s.app.store.thread('dv').slots.location.toLowerCase().includes('lipa'), true);
    assert.equal(detectLocation(s.app.store.thread('dv').slots.location).branch, 'San Pablo');
  } finally { await s.close(); }
});

test('wala pa keeps the symptom already given and asks the next missing item', () => {
  const asked = {
    history: [
      { role: 'user', content: 'Devant po, sira, 1 year, Lipa Batangas' },
      { role: 'assistant', content: QUESTIONS.symptom },
    ],
    lastAskedTopic: 'symptom',
  };
  updateIntake(asked, 'wala pa sa ibang shop', false);
  assert.equal(asked.slots.symptom, 'sira');
  assert.equal(missingSlot(asked), 'size');
  assert.notEqual(QUESTIONS[missingSlot(asked)], QUESTIONS.symptom);

  const lines = { history: [{ role: 'user', content: 'Samsung po, may lines' }] };
  updateIntake(lines, '', false);
  assert.equal(lines.slots.symptom, 'lines');
  updateIntake(lines, 'wala pa sa ibang shop', false);
  assert.equal(lines.slots.symptom, 'lines');
  assert.equal(missingSlot(lines), 'size');

  const powered = { history: [{ role: 'user', content: 'LG po, ayaw mag-on' }] };
  updateIntake(powered, 'wala pa', false);
  assert.equal(powered.slots.symptom, 'power');
  assert.equal(missingSlot(powered), 'size');
});

test('a set that will not turn on gets the size range and a check-up', () => {
  const text = quoteKnownTv({ slots: { brand: 'LG', size: '32"', symptom: 'power' } });
  assert.match(text, /LG 32/);
  assert.match(text, /₱2,000–₱3,500/);
  assert.match(text, /Possible power supply o motherboard/);
  assert.match(text, /[Cc]heck-up/);
  assert.match(text, /Kailan po sila free/);
  assert.equal(quotedPrice({ appliance: 'TV', brand: 'LG', size: '32', problem: 'ayaw mag-on' }), 2000);
  assert.equal(quotedPrice({ appliance: 'Washing machine', brand: 'LG', problem: 'ayaw umikot' }), 0);
  const fiftyFive = quoteKnownTv({ slots: { brand: 'Samsung', size: '55', symptom: 'power' } });
  assert.match(fiftyFive, /₱5,000–₱8,000/);
});

test('lines without a size ask inches, then quote; a dead set names the cause', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'TCL po, may lines. Ilan ang Laguna?';
  try {
    const ask = await s.say('tcl', 'TCL po, may lines');
    assert.equal(ask, QUESTIONS.size);
    assert.doesNotMatch(ask, /TCL|Laguna/);
    const quote = await s.say('tcl', '40 inches po');
    assert.match(quote, /video ng TV habang naka-on/);
    assert.doesNotMatch(quote, /₱/);
    const dead = await s.say('lg', 'LG 32 inch po, ayaw mag-on, taga Imus Cavite');
    assert.match(dead, /video ng TV habang naka-on/);
    assert.doesNotMatch(dead, /₱|power supply|mainboard|Imus/);
    assert.doesNotMatch(dead, /Imus/);
    assert.equal(detectLocation('Imus Cavite').branch, 'Cavite');
    const prompt = compactPrompt([{ role: 'user', content: 'samsung 55 inch may sound pero walang display' }], {});
    assert.ok(estimateTokens(prompt) < 6000);
    assert.match(prompt, /Taga saan po kayo/);
  } finally { await s.close(); }
});
