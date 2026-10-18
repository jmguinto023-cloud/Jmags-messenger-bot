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
const { parseHandoff, normalizeTurns } = require('../src/llm');
const { sanitizeOutgoing } = require('../src/messages');

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

test('photo or video stays with the bot: acknowledgement, inbox label, URL warning, still answers', async () => {
  const s = await setup({ LOG_LEVEL: 'warn' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  s.mock.state.llmResponder = (body) => {
    const last = body.messages.at(-1).content;
    if (/Customer sent a photo/.test(last)) return 'Sige po, anong brand at size?';
    if (/Customer sent a video/.test(last)) return 'Salamat po! Ipapacheck ko po sa technician. May backlight issue po ba?';
    return 'Samsung 55 po, pwede naming tingnan. Taga saan po sila?';
  };
  try {
    await s.post(msg('555', { attachments: [{ type: 'image', payload: { url: 'https://example.com/tv.jpg' } }] }));
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('555').handedOff, false);
    assert.match(s.mock.calls.messages[0].message.text, /^Salamat po! Ipapacheck ko po sa technician/);
    assert.match(s.mock.calls.messages[0].message.text, /brand at size/);
    const first = s.mock.calls.llm[0].body.messages.filter((m) => m.role !== 'system');
    assert.equal(first.at(-1).role, 'user');
    assert.equal(first.at(-1).content, '[Customer sent a photo]');
    assert.equal(s.mock.calls.labelCreates[0].page_label_name, 'Video for review');
    assert.equal(s.mock.calls.labels[0].user, '555');
    assert.match(s.mock.calls.labels[0].path, /\/label123\/label$/);
    assert.ok(logged.some((l) => /\bWARN\b/.test(l) && l.includes('https://example.com/tv.jpg')));

    await s.post(msg('555', { text: 'Samsung 55 walang display' }));
    assert.equal(s.mock.calls.llm.length, 2);
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('555').handedOff, false);

    await s.post(msg('555', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/clip.mp4' } }] }));
    assert.equal(s.mock.calls.labelCreates.length, 1, 'label id is cached');
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('555').handedOff, false);
    assert.match(s.mock.calls.messages.at(-1).message.text, /Ipapacheck ko po sa technician/);
    assert.ok(logged.some((l) => /\bWARN\b/.test(l) && l.includes('https://cdn.example/clip.mp4')));
  } finally {
    console.error = orig;
    await s.close();
  }
});

test('model messages merge same-role turns and always end on a user message', async () => {
  assert.deepEqual(normalizeTurns([
    { role: 'user', content: 'hm po' },
    { role: 'user', content: '55 inch' },
    { role: 'assistant', content: 'Taga saan po?' },
    { role: 'assistant', content: 'echo after the customer' },
  ]), [{ role: 'user', content: 'hm po\n55 inch' }]);
  assert.deepEqual(
    normalizeTurns([{ role: 'assistant', content: 'only the bot spoke' }], { attachmentNote: '[Customer sent a video]' }),
    [{ role: 'user', content: '[Customer sent a video]' }],
  );
  const ended = normalizeTurns([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi po' },
    { role: 'user', content: '[Customer sent a video]' },
    { role: 'assistant', content: 'trailing echo' },
  ]);
  assert.equal(ended.at(-1).role, 'user');
  assert.equal(ended.at(-1).content, '[Customer sent a video]');
  assert.equal(ended.some((m) => /trailing echo/.test(m.content)), false);

  const s = await setup();
  s.mock.state.llmResponder = () => 'ok po';
  try {
    await s.app.llm.reply([
      { role: 'user', content: 'hm po backlight' },
      { role: 'user', content: '55 inch' },
      { role: 'assistant', content: 'assistant message prefill' },
    ], { nowText: 'Saturday' });
    const sent = s.mock.calls.llm[0].body.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(sent, [{ role: 'user', content: 'hm po backlight\n55 inch' }]);
    await s.app.llm.reply([
      { role: 'assistant', content: 'earlier reply' },
    ], { nowText: 'Saturday', attachmentNote: '[Customer sent a video]' });
    const media = s.mock.calls.llm[1].body.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(media, [{ role: 'user', content: '[Customer sent a video]' }]);
  } finally { await s.close(); }
});

test('a video handoff tag does not pass thread control', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => '[HANDOFF: customer sent video]';
  try {
    await s.post(msg('556', { attachments: [{ type: 'video', payload: { url: 'https://example.com/x.mp4' } }] }));
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('556').handedOff, false);
    assert.match(s.mock.calls.messages[0].message.text, /Ipapacheck ko po sa technician/);
    const sent = s.mock.calls.llm[0].body.messages.filter((m) => m.role !== 'system');
    assert.equal(sent.at(-1).role, 'user');
    assert.equal(sent.at(-1).content, '[Customer sent a video]');
  } finally { await s.close(); }
});

test('a numeric NEEDS_IVAN_LABEL is applied as the label id', async () => {
  const s = await setup({ NEEDS_IVAN_LABEL: '555001' });
  try {
    await s.post(msg('num', { attachments: [{ type: 'image', payload: { url: 'https://example.com/pic.jpg' } }] }));
    assert.equal(s.mock.calls.labelCreates.length, 0);
    assert.match(s.mock.calls.labels[0].path, /\/555001\/label$/);
    assert.equal(s.mock.calls.pass.length, 0);
  } finally { await s.close(); }
});

test('audio still hands the thread to the Page Inbox', async () => {
  const s = await setup();
  try {
    await s.post(msg('aud', { attachments: [{ type: 'audio', payload: { url: 'https://example.com/note.mp4' } }] }));
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.mock.calls.pass[0].target_app_id, '263902037430900');
    assert.equal(s.app.store.thread('aud').handedOff, true);
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
    await s.post(msg('901', { text: 'pa tawag na lang po' }));
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
    assert.equal(s.mock.calls.pass[0].target_app_id, '263902037430900');
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

test('sanitizeOutgoing strips markdown markers and keeps emoji and line breaks', () => {
  assert.equal(sanitizeOutgoing('**bold** and __under__'), 'bold and under');
  assert.equal(sanitizeOutgoing('# Heading\n## Sub\nkeep # this'), 'Heading\nSub\nkeep # this');
  assert.equal(sanitizeOutgoing('a `code` and ```fence```'), 'a code and fence');
  assert.equal(sanitizeOutgoing('😊 line\nnext'), '😊 line\nnext');
  assert.equal(sanitizeOutgoing('  # Title  '), 'Title');
});

test('markdown in an AI reply is stripped before it is sent', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => '**Pwde po** iservice\n# Presyo\nuse `LCD` __all-in__';
  try {
    await s.post(msg('md', { text: 'magkano po' }));
    assert.equal(s.mock.calls.messages[0].message.text, 'Pwde po iservice\nPresyo\nuse LCD all-in');
  } finally { await s.close(); }
});

test('LLM fallback is not stored in the history sent back to the model', async () => {
  const s = await setup();
  let failed = false;
  s.mock.state.llmGate = () => {
    if (!failed) { failed = true; return { status: 500, message: 'unavailable' }; }
    return null;
  };
  s.mock.state.llmResponder = (body) => {
    const prev = body.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
    if (/brand at size|Pasensya/.test(prev)) return 'Pasensya na po maam/sir 😊 Nandito pa po ako!';
    return 'Samsung 55 po, all-in including home service. Taga saan po sila?';
  };
  try {
    await s.post(msg('fb', { text: 'hm po backlight' }));
    assert.match(s.mock.calls.messages[0].message.text, /brand at size/);
    await s.post(msg('fb', { text: 'Samsung 55 Biñan' }));
    const nonSystem = s.mock.calls.llm.at(-1).body.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(nonSystem.map((m) => m.role), ['user']);
    assert.match(nonSystem[0].content, /hm po backlight/);
    assert.match(nonSystem[0].content, /Samsung 55/);
    assert.equal(nonSystem.some((m) => /brand at size|Pasensya/.test(m.content)), false);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /Pasensya/);
    assert.equal(s.mock.calls.pass.length, 0);
  } finally { await s.close(); }
});

test('LLM HTTP 4xx is logged at ERROR and does not hand off', async () => {
  const s = await setup({ LOG_LEVEL: 'error' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  s.mock.state.llmFail = true;
  s.mock.state.llmStatus = 400;
  s.mock.state.llmError = 'invalid api key';
  try {
    await s.post(msg('cfg', { text: 'hm po' }));
    await s.post(msg('cfg', { text: 'hello ulit po' }));
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.mock.calls.llm.length, 2);
    assert.equal(s.app.store.thread('cfg').handedOff, false);
    assert.equal(s.app.store.thread('cfg').history.some((h) => h.role === 'assistant'), false);
    assert.ok(logged.some((l) => /\bERROR\b/.test(l) && /400/.test(l) && /config error/i.test(l)));
  } finally {
    console.error = orig;
    await s.close();
  }
});

test('temperature 400 is retried once without temperature and then omitted', async () => {
  const s = await setup();
  s.mock.state.llmGate = (body) => {
    if (body.temperature !== undefined) return { status: 400, message: 'temperature is deprecated for this model' };
    return null;
  };
  s.mock.state.llmResponder = () => 'Pwde po iservice maam/sir 😊 Taga saan po sila?';
  try {
    await s.post(msg('temp', { text: 'magkano po backlight' }));
    assert.equal(s.mock.calls.messages[0].message.text, 'Pwde po iservice maam/sir 😊 Taga saan po sila?');
    assert.equal(s.mock.calls.llm.length, 2);
    assert.equal(s.mock.calls.llm[0].body.temperature, 0.4);
    assert.equal(s.mock.calls.llm[1].body.temperature, undefined);
    assert.equal(s.mock.calls.pass.length, 0);
    await s.post(msg('temp', { text: '55 inch samsung po' }));
    assert.equal(s.mock.calls.llm.length, 3);
    assert.equal(s.mock.calls.llm[2].body.temperature, undefined);
    assert.equal(s.app.store.thread('temp').handedOff, false);
  } finally { await s.close(); }
});

test('system prompt hides the travel fee, stays plain, and sends the form before any booking handoff', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'system-prompt.md'), 'utf8');
  assert.match(prompt, /add ₱500 to every quoted price when they are 1-50 km/);
  assert.match(prompt, /₱1,500 when 50-85 km/);
  assert.match(prompt, /up to 85 km from the nearest branch/);
  assert.match(prompt, /in Biñan quote ₱9,500–₱10,000 all-in including home service/);
  assert.match(prompt, /walang dagdag/);
  assert.match(prompt, /Never write "travel fee", "pamasahe", or "transpo"/);
  assert.match(prompt, /never tell the customer km/);
  assert.match(prompt, /Check-up fee: ₱1,000, ₱500 for 32" and 40" TVs/);
  assert.match(prompt, /Waived if the repair proceeds/);
  assert.match(prompt, /No \*\*bold\*\*/);
  assert.match(prompt, /Do not open with an apology/);
  assert.match(prompt, /Do not propose a day or time/);
  assert.match(prompt, /Pwede po malaman kung taga-saan po sila\?/);
  assert.match(prompt, /Hello Mam\/Sir eto po ang schedule form niyo/);
  assert.match(prompt, /\{\{BOOKING_FORM_URL\}\}/);
  assert.match(prompt, /Only once per conversation/);
  assert.match(prompt, /Google Maps pin is required/);
  assert.match(prompt, /Do NOT hand off to Ivan\. Do not output \[HANDOFF\]/);
  assert.match(prompt, /filled it up or submitted the form/);
  assert.match(prompt, /first time they ask for a discount, tawad, less, or promo/);
  assert.match(prompt, /No receipt, no warranty/);
  assert.match(prompt, /At 55" the base is ₱8,000/);
  assert.match(prompt, /Monday to Saturday, 8am–5pm/);
  assert.match(prompt, /We do repair refrigerators and aircon/);
  assert.match(prompt, /Do not quote a price\. Then hand off to Ivan for the quote/);
  assert.doesNotMatch(prompt, /no refrigerator/i);
  assert.doesNotMatch(prompt, /don't repair refrigerator/i);
  assert.match(prompt, /A photo or video is not a handoff/);
  assert.doesNotMatch(prompt, /They send a photo or video/);
  const example = prompt.slice(prompt.indexOf('Example quote'), prompt.indexOf('Send the schedule form'));
  assert.doesNotMatch(example, /travel fee|within 50 km|\bkm\b/i);
});

test('BOOKING_FORM_URL is injected into the system prompt', async () => {
  const s = await setup();
  try {
    await s.post(msg('bookurl', { text: 'magkano po' }));
    const sys = s.mock.calls.llm[0].body.messages[0].content;
    assert.match(sys, /https:\/\/jmagscutomerform\.netlify\.app\//);
    assert.match(sys, /Hello Mam\/Sir eto po ang schedule form/);
    assert.doesNotMatch(sys, /\{\{BOOKING_FORM_URL\}\}/);
  } finally { await s.close(); }
});

test('custom BOOKING_FORM_URL replaces the default in the system prompt', async () => {
  const s = await setup({ BOOKING_FORM_URL: 'https://forms.example.com/jmag' });
  try {
    await s.post(msg('bookurl2', { text: 'magkano po' }));
    const sys = s.mock.calls.llm[0].body.messages[0].content;
    assert.match(sys, /https:\/\/forms\.example\.com\/jmag/);
    assert.doesNotMatch(sys, /jmagscutomerform/);
  } finally { await s.close(); }
});

test('HANDOFF for booking intent sends the form instead of passing the thread', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Noted po, i-confirm ko na.\n[HANDOFF: Customer ready to book]';
  try {
    await s.post(msg('ready', { text: 'sige po bukas 10am' }));
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('ready').handedOff, false);
    assert.equal(
      s.mock.calls.messages[0].message.text,
      "Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊\n\nhttps://jmagscutomerform.netlify.app/",
    );
  } finally { await s.close(); }
});

test('a schedule-form reply is sent and does not hand off even with a HANDOFF tag', async () => {
  const s = await setup();
  const url = 'https://jmagscutomerform.netlify.app/';
  s.mock.state.llmResponder = () => `Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊\n\n${url}\n[HANDOFF: Customer ready to book]`;
  try {
    await s.post(msg('bf', { text: 'sige po bukas 10am' }));
    assert.equal(s.mock.calls.pass.length, 0);
    assert.equal(s.app.store.thread('bf').handedOff, false);
    assert.match(s.mock.calls.messages[0].message.text, /jmagscutomerform\.netlify\.app/);
    assert.doesNotMatch(s.mock.calls.messages[0].message.text, /HANDOFF/);
    assert.match(s.mock.calls.messages[0].message.text, /Hello Mam\/Sir eto po ang schedule form/);
  } finally { await s.close(); }
});

test('Mark as done: a normal message after our handoff resumes; standby does not; inbox echo still pauses', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Pwde po iservice maam/sir 😊 Taga saan po sila?';
  try {
    await s.post(msg('mdone', { text: 'pa tawag na lang po' }));
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.app.store.thread('mdone').passedByBot, true);
    assert.equal(s.app.store.thread('mdone').handedOff, true);

    await s.post({ object: 'page', entry: [{ id: PAGE, time: Date.now(), standby: [{ sender: { id: 'mdone' }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: 'st.mdone', text: 'nandito pa po ako' } }] }] });
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(s.app.store.thread('mdone').handedOff, true);

    await s.post(msg('mdone', { text: 'hello ulit po' }));
    assert.equal(s.mock.calls.llm.length, 1);
    assert.equal(s.mock.calls.messages.length, 2);
    const t = s.app.store.thread('mdone');
    assert.equal(t.handedOff, false);
    assert.equal(t.pausedUntil, 0);
    assert.equal(t.passedByBot, false);

    await s.post(echo('mdone', '263902037430900', 'ako na po'));
    await s.post(msg('mdone', { text: 'salamat po' }));
    assert.equal(s.mock.calls.llm.length, 1, 'human inbox reply still pauses the bot');
    assert.ok(s.app.store.thread('mdone').pausedUntil > Date.now());

    await s.post({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: 'ext' }, recipient: { id: PAGE }, timestamp: Date.now(), pass_thread_control: { new_owner_app_id: '555', metadata: '' } }] }] });
    await s.post(msg('ext', { text: 'hello po' }));
    assert.equal(s.mock.calls.llm.length, 1, 'a handoff this bot did not start stays silent');
    assert.equal(s.app.store.thread('ext').handedOff, true);
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
