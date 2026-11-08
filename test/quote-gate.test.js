'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { compactPrompt } = require('../src/llm');
const {
  MAGKANO_LINE, WAIT_LINE, WARRANTY_ONLY, HANDOFF_LINE, gatePassed, shapeReply, nextAsk, capWords,
} = require('../src/quote-gate');

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
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-gate-')),
  });
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const say = async (psid, text) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: MAIN, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: MAIN }, timestamp: ts, message: { mid: `g.${n}`, text } }] }],
    });
    await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    await app.bot.idle();
    const sent = mock.calls.messages.filter((m) => m.recipient && m.recipient.id === psid).map((m) => m.message.text);
    return sent.at(-1) || '';
  };
  return { app, mock, say, close: async () => { await app.bot.idle(); app.server.close(); await mock.close(); } };
}

function openGate(thread) {
  thread.videoReceived = true;
  thread.videoReviewed = true;
  thread.slots = {
    brand: 'Samsung', size: '55"', symptom: 'backlight', model: 'UA55AU7000',
    city: 'lipa', barangay: 'Marawoy', repairedElsewhere: 'no',
  };
}

test('quote gate blocks every price until video, size, brand, model, barangay, city, and repaired-no', async () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'rules.md'), 'utf8');
  assert.match(rules, /THE QUOTE GATE/);
  assert.match(compactPrompt([{ role: 'user', content: 'hi' }], {}), /THE QUOTE GATE/);
  const s = await setup();
  s.mock.state.llmResponder = () => 'Samsung 55 po. Possible backlight po, ₱8,500. Kailan po kayo free?';
  try {
    const refused = await s.say('g1', 'magkano po');
    assert.equal(refused, MAGKANO_LINE);
    assert.doesNotMatch(refused, /₱/);
    const early = await s.say('g1', '55 samsung nawala display');
    assert.doesNotMatch(early, /₱|Kailan po kayo free|8,500/);
    assert.equal(gatePassed(s.app.store.thread('g1')), false);
    const cracked = await s.say('crack', 'basag ang LCD ng Samsung 55');
    assert.equal(cracked, HANDOFF_LINE);
    assert.doesNotMatch(cracked, /₱/);
    assert.equal(s.app.store.thread('crack').handedOff, true);
  } finally { await s.close(); }
});

test('a known size, brand, and symptom are not asked again', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Ano po ang sira? Ilang inches po ang TV ninyo? Anong brand po?';
  try {
    const first = await s.say('keep', '55 samsung nawala display');
    assert.doesNotMatch(first, /Ano po ang sira|Ilang inches|Anong brand/i);
    const again = await s.say('keep', 'Nawala ang display nga');
    assert.doesNotMatch(again, /Ano po ang sira|Ilang inches/i);
    const slots = s.app.store.thread('keep').slots;
    assert.equal(slots.brand, 'Samsung');
    assert.match(slots.size, /55/);
    assert.ok(slots.symptom);
  } finally { await s.close(); }
});

test('wait words get one hold line and then silence', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Ilang inches po?';
  try {
    const held = await s.say('wait', 'Teka muna');
    assert.equal(held, WAIT_LINE);
    const before = s.mock.calls.messages.length;
    const again = await s.say('wait', 'sandali lang');
    assert.equal(again, WAIT_LINE);
    assert.equal(s.mock.calls.messages.length, before);
    const next = await s.say('wait', '55 samsung');
    assert.notEqual(next, WAIT_LINE);
  } finally { await s.close(); }
});

test('no schedule question or booking form before the gate', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Kailan po kayo free para ma-assign ang home service? https://forms.example/book';
  try {
    const reply = await s.say('sched', '55 samsung nawala display');
    assert.doesNotMatch(reply, /kailan po kayo free|ma-assign|https?:\/\//i);
    assert.equal(s.app.store.thread('sched').bookingFormSent || false, false);
  } finally { await s.close(); }
});

test('warranty replies never state a length', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Backlight po, 6 months warranty. Power supply 5 months.';
  try {
    const reply = await s.say('war', 'may warranty po ba');
    assert.equal(reply, WARRANTY_ONLY);
    assert.doesNotMatch(reply, /\d+\s*months|\d+\s*buwan/i);
    assert.equal(s.app.store.thread('war').handedOff, true);
  } finally { await s.close(); }
});

test('customer replies say staff po namin and never name staff or say bot', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Si Ivan ang technician. Bot ako.';
  try {
    const reply = await s.say('voice', 'hello po');
    assert.match(reply, /staff po namin/);
    assert.doesNotMatch(reply, /\bIvan\b|\btechnician\b|\bbot\b/i);
  } finally { await s.close(); }
});

test('[[HANDOFF]] is stripped, the thread is closed, and the bot stops', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Sandali po. [[HANDOFF]]';
  try {
    const reply = await s.say('hand', 'galit na galit na po ako');
    assert.equal(reply, HANDOFF_LINE);
    assert.doesNotMatch(reply, /HANDOFF/);
    assert.equal(s.app.store.thread('hand').handedOff, true);
    const before = s.mock.calls.messages.length;
    await s.say('hand', 'hello ulit');
    assert.equal(s.mock.calls.messages.length, before);
  } finally { await s.close(); }
});

test('after the gate, one price stays and power supply is not named', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'rules.md'), 'utf8');
  assert.match(rules, /₱1,000, deducted from the repair/);
  assert.match(rules, /₱500 max/);
  assert.match(rules, /₱500 off for check-ups booked within the week/);
  assert.match(rules, /Manila: \+₱1,000/);
  assert.match(rules, /never "power supply" or "mainboard"/);
  const thread = { history: [], slots: {} };
  openGate(thread);
  assert.equal(gatePassed(thread), true);
  const shaped = shapeReply(thread, 'Possible power supply po, ₱8,500. 6 months warranty. Kailan po sila free?', 'sige po');
  assert.match(shaped.text, /₱8,500/);
  assert.match(shaped.text, /reprogramming/i);
  assert.doesNotMatch(shaped.text, /power supply|mainboard|motherboard|\d+\s*months/i);
  assert.equal(nextAsk(thread), '');
});

test('replies stay near 20 words and keep at most one emoji', () => {
  const long = capWords('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo extra 🙂 🙂');
  assert.ok(long.split(/\s+/).length <= 22);
  assert.equal((long.match(/\p{Extended_Pictographic}/gu) || []).length, 1);
});
