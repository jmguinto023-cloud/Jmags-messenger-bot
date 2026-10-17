'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { isActiveNow, keywordHit } = require('../src/bot');
const { parseHandoff } = require('../src/llm');

const SECRET = 'test_app_secret';
const PAGE = '102622881557025';
const APP = '999000111';

async function setup(extraEnv = {}, mockOpts = {}) {
  const mock = await startMock(mockOpts);
  const env = {
    PORT: '0', VERIFY_TOKEN: 'verify_me', APP_SECRET: SECRET, APP_ID: APP, PAGE_ID: PAGE,
    PAGE_ACCESS_TOKEN: 'PAGE_TOKEN', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`,
    LLM_API_KEY: 'sk-test', LLM_MODEL: 'mock-model', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-bot-')), LOG_LEVEL: 'silent', ...extraEnv,
  };
  const app = build(env);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (payload, { sign = true, secret = SECRET } = {}) => {
    const raw = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (sign) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const res = await fetch(`${base}/webhook`, { method: 'POST', headers, body: raw });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return res;
  };
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, mock, base, post, close };
}

let n = 0;
const msg = (psid, message, ts = Date.now()) => ({
  object: 'page',
  entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `mid.${++n}`, ...message } }] }],
});
const echo = (psid, appId, text) => ({
  object: 'page',
  entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: PAGE }, recipient: { id: psid }, timestamp: Date.now(), message: { is_echo: true, mid: `mid.e${++n}`, text, ...(appId ? { app_id: appId } : {}) } }] }],
});

test('GET verification: correct token returns challenge, wrong token 403', async () => {
  const s = await setup();
  try {
    const ok = await fetch(`${s.base}/webhook?hub.mode=subscribe&hub.verify_token=verify_me&hub.challenge=1158201444`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '1158201444');
    const bad = await fetch(`${s.base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    assert.equal(bad.status, 403);
  } finally { await s.close(); }
});

test('POST with missing or wrong signature is rejected and nothing is sent', async () => {
  const s = await setup();
  try {
    assert.equal((await s.post(msg('111', { text: 'hm po' }), { sign: false })).status, 401);
    assert.equal((await s.post(msg('111', { text: 'hm po' }), { secret: 'wrong' })).status, 401);
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('normal text gets an AI reply with typing indicator, RESPONSE type and system prompt', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Pwde po iservice maam/sir 😊 Taga saan po sila?';
  try {
    const res = await s.post(msg('222', { text: 'magkano po palit backlight 55 inch samsung' }));
    assert.equal(res.status, 200);
    assert.equal(s.mock.calls.typing[0].sender_action, 'typing_on');
    assert.equal(s.mock.calls.messages.length, 1);
    const sent = s.mock.calls.messages[0];
    assert.equal(sent.messaging_type, 'RESPONSE');
    assert.equal(sent.recipient.id, '222');
    assert.equal(sent.message.text, 'Pwde po iservice maam/sir 😊 Taga saan po sila?');
    const llmBody = s.mock.calls.llm[0].body;
    assert.equal(llmBody.model, 'mock-model');
    assert.equal(s.mock.calls.llm[0].auth, 'Bearer sk-test');
    assert.match(llmBody.messages[0].content, /JMAG's Appliances/);
    assert.equal(llmBody.messages.at(-1).content, 'magkano po palit backlight 55 inch samsung');
  } finally { await s.close(); }
});

test('history is kept per conversation', async () => {
  const s = await setup();
  try {
    await s.post(msg('333', { text: 'hello po' }));
    await s.post(msg('333', { text: 'TCL 40 inch po' }));
    const last = s.mock.calls.llm.at(-1).body.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(last.map((m) => m.role), ['user', 'assistant', 'user']);
    await s.post(msg('444', { text: 'iba po ako' }));
    assert.equal(s.mock.calls.llm.at(-1).body.messages.filter((m) => m.role !== 'system').length, 1);
  } finally { await s.close(); }
});

test('photo forces handoff: holding line, pass_thread_control to Page Inbox, then silence', async () => {
  const s = await setup({ NEEDS_IVAN_LABEL: 'Needs Ivan' });
  try {
    await s.post(msg('555', { attachments: [{ type: 'image', payload: { url: 'https://example.com/tv.jpg' } }] }));
    assert.equal(s.mock.calls.llm.length, 0, 'AI not called for photos');
    assert.equal(s.mock.calls.messages.length, 1);
    assert.match(s.mock.calls.messages[0].message.text, /Ivan/);
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.mock.calls.pass[0].target_app_id, '263902037430900');
    assert.equal(s.mock.calls.pass[0].recipient.id, '555');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.mock.calls.labels[0].user, '555');
    await s.post(msg('555', { text: 'ano na po?' }));
    assert.equal(s.mock.calls.messages.length, 1, 'no more auto replies after handoff');
  } finally { await s.close(); }
});

test('model [HANDOFF: reason] marker is stripped and triggers handoff', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Noted po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito para ma-confirm ang schedule nyo. Saglit lang po.\n[HANDOFF: booking details given]';
  try {
    await s.post(msg('666', { text: 'sige po bukas umaga, Juan Cruz, Imus' }));
    assert.equal(s.mock.calls.messages.length, 1);
    assert.doesNotMatch(s.mock.calls.messages[0].message.text, /HANDOFF/);
    assert.equal(s.mock.calls.pass.length, 1);
  } finally { await s.close(); }
});

test('keyword "tao" / "tawag" forces handoff, but "bot ka ba?" goes to the AI', async () => {
  const s = await setup();
  try {
    await s.post(msg('777', { text: 'may tao po ba dyan? pa tawag na lang' }));
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.mock.calls.llm.length, 0);
    await s.post(msg('778', { text: 'bot ka ba?' }));
    assert.equal(s.mock.calls.llm.length, 1);
    assert.equal(s.mock.calls.pass.length, 1);
  } finally { await s.close(); }
});

test('human takeover: echo from another app (or no app_id) pauses the bot; own echoes do not', async () => {
  const s = await setup();
  try {
    await s.post(echo('888', APP, 'bot reply'));
    await s.post(msg('888', { text: 'hello po' }));
    assert.equal(s.mock.calls.messages.length, 1, 'own echo does not pause');
    await s.post(echo('888', '263902037430900', '8500 po'));
    await s.post(msg('888', { text: 'sige po' }));
    assert.equal(s.mock.calls.messages.length, 1, 'paused after Ivan replied from inbox');
    const t = s.app.store.thread('888');
    assert.ok(t.pausedUntil > Date.now() + 11 * 3600e3);
    await s.post(echo('889', null, 'manual reply, no app id'));
    await s.post(msg('889', { text: 'ok po' }));
    assert.equal(s.mock.calls.messages.length, 1);
  } finally { await s.close(); }
});

test('thread control passed back to the bot resumes auto-replies', async () => {
  const s = await setup();
  try {
    await s.post(msg('901', { attachments: [{ type: 'video', payload: { url: 'x' } }] }));
    assert.equal(s.mock.calls.pass.length, 1);
    await s.post({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: '901' }, recipient: { id: PAGE }, timestamp: Date.now(), pass_thread_control: { previous_owner_app_id: '263902037430900', new_owner_app_id: APP, metadata: '' } }] }] });
    await s.post(msg('901', { text: 'hello ulit po' }));
    assert.equal(s.mock.calls.llm.length, 1);
  } finally { await s.close(); }
});

test('allowlist: only BOT_TEST_PSIDS get replies; BOT_ENABLED=false sends nothing', async () => {
  const s = await setup({ BOT_TEST_PSIDS: 'jm_psid,ivan_psid' });
  try {
    await s.post(msg('stranger', { text: 'hm po' }));
    assert.equal(s.mock.calls.messages.length, 0);
    await s.post(msg('jm_psid', { text: 'hm po' }));
    assert.equal(s.mock.calls.messages.length, 1);
  } finally { await s.close(); }
  const off = await setup({ BOT_ENABLED: 'false' });
  try {
    await off.post(msg('jm_psid', { text: 'hm po' }));
    assert.equal(off.mock.calls.messages.length, 0);
    assert.equal(off.mock.calls.llm.length, 0);
  } finally { await off.close(); }
});

test('ignores delivery/read events and duplicate (retried) messages', async () => {
  const s = await setup();
  try {
    await s.post({ object: 'page', entry: [{ id: PAGE, time: 1, messaging: [
      { sender: { id: '1' }, recipient: { id: PAGE }, timestamp: Date.now(), delivery: { mids: ['x'], watermark: 1 } },
      { sender: { id: '1' }, recipient: { id: PAGE }, timestamp: Date.now(), read: { watermark: 1 } },
    ] }] });
    assert.equal(s.mock.calls.messages.length + s.mock.calls.llm.length, 0);
    const p = msg('dup', { text: 'hello po' });
    await s.post(p); await s.post(p);
    assert.equal(s.mock.calls.messages.length, 1);
  } finally { await s.close(); }
});

test('LLM failure sends Ivan-style fallback, second failure hands off', async () => {
  const s = await setup();
  s.mock.state.llmFail = true;
  try {
    await s.post(msg('fail', { text: 'hm po' }));
    assert.match(s.mock.calls.messages[0].message.text, /brand at size/);
    await s.post(msg('fail', { text: 'hello?' }));
    assert.equal(s.mock.calls.pass.length, 1);
  } finally { await s.close(); }
});

test('24-hour window: old (delayed) messages are not answered', async () => {
  const s = await setup();
  try {
    await s.post(msg('old', { text: 'hm po' }, Date.now() - 25 * 3600e3));
    assert.equal(s.mock.calls.messages.length, 0);
  } finally { await s.close(); }
});

test('active hours (Asia/Manila), keyword matching and marker parsing', () => {
  const cfg = { activeHours: '18:00-08:00', alwaysOnDays: ['sun'], timezone: 'Asia/Manila' };
  assert.equal(isActiveNow(cfg, new Date('2026-10-19T12:00:00Z')), true); // Mon 20:00 PHT
  assert.equal(isActiveNow(cfg, new Date('2026-10-19T03:00:00Z')), false); // Mon 11:00 PHT
  assert.equal(isActiveNow(cfg, new Date('2026-10-18T03:00:00Z')), true); // Sun 11:00 PHT
  assert.equal(isActiveNow({ ...cfg, activeHours: '' }, new Date()), true);
  assert.equal(keywordHit('pa tawag po', ['tawag']), 'tawag');
  assert.equal(keywordHit('nakatayo po', ['tao']), undefined);
  assert.deepEqual(parseHandoff('ok po\n[HANDOFF: photo]'), { text: 'ok po', handoff: true, reason: 'photo' });
  assert.deepEqual(parseHandoff('ok po'), { text: 'ok po', handoff: false, reason: '' });
});

test('outside BOT_ACTIVE_HOURS the bot stays quiet', async () => {
  const s = await setup({ BOT_ACTIVE_HOURS: '00:00-00:01' });
  s.app.bot.now = () => new Date('2026-10-19T04:00:00Z').getTime(); // 12:00 PHT
  try {
    await s.post(msg('day', { text: 'hm po' }, new Date('2026-10-19T04:00:00Z').getTime()));
    assert.equal(s.mock.calls.messages.length, 0);
  } finally { await s.close(); }
});

test('retention purge and forget remove stored chats', async () => {
  const s = await setup();
  try {
    await s.post(msg('keep', { text: 'hello po' }));
    s.app.store.addTurn('stale', 'user', 'old msg', Date.now() - 100 * 86400e3);
    assert.equal(s.app.store.purge(90), 1);
    assert.ok(s.app.store.data.threads.keep);
    assert.equal(s.app.store.data.threads.stale, undefined);
    const res = await fetch(`${s.base}/admin/forget?psid=keep`, { method: 'POST' });
    assert.equal(res.status, 403, 'admin disabled without ADMIN_TOKEN');
  } finally { await s.close(); }
});
