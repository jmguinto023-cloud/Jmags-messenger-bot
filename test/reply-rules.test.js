'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { compactPrompt, estimateTokens } = require('../src/llm');
const { howIvanThinks } = require('../src/ivan-thinks');
const {
  optOutReason, staffEscalation, publicCommentReply, PUBLIC_COMMENT_REPLY, STAFF_HANDOFF_LINE,
} = require('../src/reply-rules');

const SECRET = 's';
const MAIN = '102622881557025';

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

async function setup(extra = {}) {
  const mock = await startMock();
  const app = build({
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: SECRET, APP_ID: '1', PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'T',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm',
    BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0', LOG_LEVEL: 'silent',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    NEEDS_IVAN_LABEL: 'Needs Ivan',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-rules-')),
    ...extra,
  });
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const post = async (body) => {
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    assert.equal(res.status, 200);
    await app.bot.idle();
  };
  const say = async (psid, text) => {
    const ts = Date.now() + (++n);
    await post({
      object: 'page',
      entry: [{ id: MAIN, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: MAIN }, timestamp: ts, message: { mid: `r.${n}`, text } }] }],
    });
  };
  const comment = async (id, text, fromId) => {
    await post({
      object: 'page',
      entry: [{
        id: MAIN,
        time: Date.now(),
        changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: id, post_id: 'post1', message: text, from: { id: fromId, name: 'Ana' } } }],
      }],
    });
  };
  return { app, mock, say, comment, close: async () => { await app.bot.idle(); app.server.close(); await mock.close(); } };
}

test('the prompt carries the handover reply rules and not the doc checkup fees', () => {
  const full = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8');
  const thinks = howIvanThinks();
  assert.ok(full.includes(thinks));
  const section = full.slice(full.indexOf('## Reply rules'), full.indexOf('## 1. Voice'));
  assert.match(section, /po or opo/);
  assert.match(section, /one question at a time/i);
  assert.match(section, /brand, model or size, the problem, and the city/i);
  assert.match(section, /public Facebook comment/);
  assert.match(section, /never ask for a phone number or a full address/i);
  assert.match(section, /private Messenger/i);
  assert.match(section, /Never invent a price, a diagnosis, technician availability, a warranty, or a repair guarantee/);
  assert.match(section, /stop, ayaw ko na, or unsubscribe/);
  assert.match(section, /complaint/);
  assert.match(section, /warranty or backjob dispute/);
  assert.match(section, /technical uncertainty/);
  assert.match(section, /payment disagreement/);
  assert.doesNotMatch(section, /₱1,000|₱300/);
  const prompt = compactPrompt([{ role: 'user', content: 'samsung 55 inch may sound pero walang display' }], {});
  assert.match(prompt, /One question at a time/);
  assert.match(prompt, /never ask for a phone number or a full address/i);
  assert.match(prompt, /stop, ayaw ko na, or unsubscribe/i);
  assert.ok(estimateTokens(prompt) < 6000);
});

test('opt-out phrases stop messaging, and a later hello stays quiet', async () => {
  assert.equal(optOutReason('ayaw ko na po'), 'ayaw ko na');
  assert.equal(optOutReason('please unsubscribe'), 'unsubscribe');
  assert.equal(optOutReason('stop'), 'stop');
  assert.equal(optOutReason('nonstop po yung tunog'), '');
  assert.equal(optOutReason('ayaw mag-on'), '');
  const s = await setup();
  try {
    await s.say('out1', 'ayaw ko na');
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.app.store.thread('out1').optedOut, true);
    await s.say('out1', 'hello po, bukas na lang');
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.mock.calls.llm.length, 0);
    await s.say('out2', 'Unsubscribe po');
    await s.say('out3', 'stop');
    assert.equal(s.app.store.thread('out2').optedOut, true);
    assert.equal(s.app.store.thread('out3').optedOut, true);
    assert.equal(s.mock.calls.messages.length, 0);
  } finally { await s.close(); }
});

test('complaints, disputes, uncertainty, payment, and a human request are flagged', async () => {
  assert.equal(staffEscalation('May reklamo ako sa service'), 'complaint');
  assert.equal(staffEscalation('backjob po'), 'backjob dispute');
  assert.equal(staffEscalation('sira ulit po yung tv'), '');
  assert.equal(staffEscalation('ayaw niyo i-warranty ang repair'), 'warranty dispute');
  assert.equal(staffEscalation('refund po, mali ang singil'), 'payment disagreement');
  assert.equal(staffEscalation('hindi niyo sure ang sira, may guarantee ba'), 'technical uncertainty');
  assert.equal(staffEscalation('kausapin ko si jm'), 'asked for a person');
  assert.equal(staffEscalation('may warranty po ba'), '');
  assert.equal(staffEscalation('LG 32 inch po, ayaw mag-on'), '');
  assert.equal(staffEscalation('magkano po ang repair'), '');
  const s = await setup();
  try {
    await s.say('esc', 'May reklamo ako, ang bagal');
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, STAFF_HANDOFF_LINE);
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.mock.calls.llm.length, 0);
    const thread = s.app.store.thread('esc');
    assert.equal(thread.handedOff, true);
    assert.equal(thread.needsStaff, true);
    assert.equal(thread.handoffReason, 'complaint');
    assert.ok(s.mock.calls.labels.some((row) => row.user === 'esc'));
    await s.say('war', 'may warranty po ba');
    assert.equal(s.app.store.thread('war').handedOff, false);
    assert.match(s.mock.calls.messages.at(-1).message.text, /6 months/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /5 months/);
    assert.equal(s.app.store.thread('war').handedOff, false);
  } finally { await s.close(); }
});

test('a public comment never asks for a phone number or a full address', async () => {
  const safe = publicCommentReply('pahingi ng phone number at full address');
  assert.equal(safe, PUBLIC_COMMENT_REPLY);
  assert.match(safe, /Messenger/);
  assert.doesNotMatch(safe, /phone|cellphone|numero|full address|anong address|\?/i);
  assert.equal(publicCommentReply('reklamo po sa comment'), STAFF_HANDOFF_LINE);
  const s = await setup();
  try {
    await s.comment('cmt1', 'Book po. Pahingi ng phone number at full address.', 'fan1');
    assert.equal(s.mock.calls.comments.length, 1);
    assert.match(s.mock.calls.comments[0].path, /cmt1\/comments$/);
    assert.equal(s.mock.calls.comments[0].message, PUBLIC_COMMENT_REPLY);
    assert.equal(s.mock.calls.messages.length, 0);
    await s.comment('cmt-page', 'salamat po', MAIN);
    assert.equal(s.mock.calls.comments.length, 1);
    await s.comment('cmt-stop', 'unsubscribe', 'fan2');
    assert.equal(s.app.store.thread('fan2').optedOut, true);
    assert.equal(s.mock.calls.comments.length, 1);
    await s.comment('cmt-esc', 'May reklamo ako dito', 'fan3');
    assert.equal(s.mock.calls.comments.at(-1).message, STAFF_HANDOFF_LINE);
    assert.equal(s.app.store.thread('fan3').needsStaff, true);
    assert.equal(s.app.store.thread('fan3').handoffReason, 'complaint');
    assert.ok(s.mock.calls.labels.some((row) => row.user === 'fan3'));
  } finally { await s.close(); }
});
