'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { Bot, isActiveNow, keywordHit } = require('../src/bot');
const { Store, psidHash } = require('../src/store');
const { parseSignedRequest } = require('../src/signed-request');
const { parseHandoff, normalizeTurns } = require('../src/llm');
const { sanitizeOutgoing } = require('../src/messages');
const { updateIntake, intakeContext, CLOSE_LINE } = require('../src/intake');
const { summarizeConversation } = require('../src/summary');
const { videoFollowupText, quietDeferUntil } = require('../src/video-followup');
const { loadConfig } = require('../src/config');
const { CHECKUP_FEE_PLAIN } = require('../src/estimate');
const { visibleHistory, asksReviewStatus, PENDING_REVIEW_STATUS } = require('../src/recency');
const {
  genericInboxUrl, businessSuiteThreadUrl, messengerAppHref, inboxLinks, threadItemId,
  candidateInboxUrls, inboxClientKind, primaryInboxHref, BUSINESS_SUITE_PACKAGE,
} = require('../src/inbox-link');

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

async function dashCookie(base, password = 'secret') {
  const login = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(password)}`,
  });
  const setCookie = login.headers.get('set-cookie') || '';
  return { status: login.status, cookie: (setCookie.match(/jmags_dash=[^;]+/) || [])[0] || '' };
}

let n = 0;
const msg = (psid, message, ts = Date.now()) => ({
  object: 'page',
  entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `mid.${++n}`, ...message } }] }],
});
const standby = (psid, text, ts = Date.now()) => ({
  object: 'page',
  entry: [{ id: PAGE, time: ts, standby: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `mid.${++n}`, text } }] }],
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
    assert.match(first.at(-1).content, /\[Customer sent a photo at \d{2}:\d{2} - RECEIVED, forwarded to technician Ivan for review\. You cannot view it, but it WAS received\.\]/);
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
    assert.match(sent.at(-1).content, /\[Customer sent a video at \d{2}:\d{2} - RECEIVED, forwarded to technician Ivan for review\. You cannot view it, but it WAS received\.\]/);
  } finally { await s.close(); }
});

test('a numeric NEEDS_IVAN_LABEL is applied as the label id', async () => {
  const s = await setup({ NEEDS_IVAN_LABEL: '555001' });
  try {
    await s.post(msg('num', { attachments: [{ type: 'image', payload: { url: 'https://example.com/pic.jpg' } }] }));
    assert.equal(s.mock.calls.labelCreates.length, 0);
    assert.match(s.mock.calls.labels[0].path, /\/555001\/label$/);
    assert.equal(s.mock.calls.labels[0].user, 'num');
    assert.equal(s.mock.calls.pass.length, 0);
  } finally { await s.close(); }
});

test('a custom label whose id is the PSID is not posted to /{psid}/label', async () => {
  const s = await setup({ LOG_LEVEL: 'warn' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  s.mock.state.customLabels = [{ id: '555', page_label_name: 'Video for review' }];
  s.mock.state.labelId = '555';
  try {
    await s.post(msg('555', { attachments: [{ type: 'image', payload: { url: 'https://example.com/pic.jpg' } }] }));
    assert.equal(s.mock.calls.labels.length, 0);
    assert.equal(s.mock.calls.labelCreates[0].page_label_name, 'Video for review');
    assert.ok(logged.some((l) => /refusing to POST \/555\/label/.test(l)));
  } finally {
    console.error = orig;
    await s.close();
  }
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
    s.app.store.thread('888').lastUserTs -= 60e3; // Ivan types a minute later
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
  assert.match(prompt, /at most two short follow-ups/);
  assert.match(prompt, /09386369374 \(Smart\)/);
  assert.match(prompt, /09267229506 \(Globe\)/);
  assert.match(prompt, /Ay naku, sayang naman po, bago pa naman po yung TV niyo/);
  assert.match(prompt, /NEVER say you did not see it/);
  assert.match(prompt, /NEVER ask them to send it again/);
  assert.match(prompt, /Pero mas mainam pa rin po na ma-check ng technician personally ang TV para mas eksakto ang estimate/);
  assert.match(prompt, /If they ask how much the check-up is, answer plainly and only that: "₱1,000 check-up fee \(₱500 for 32" and 40" TVs\), waived if they proceed with the repair\."/);
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

    s.app.store.thread('mdone').lastUserTs -= 60e3;
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

test('quiet-customer follow-up fires once at 120 minutes, again only inside 23h, then stops', async () => {
  const s = await setup();
  assert.equal(s.app.bot._followTimer, undefined);
  const MIN = 60 * 1000;
  const HOUR = 3600 * 1000;
  let now = Date.now();
  s.app.bot.now = () => now;
  s.mock.state.llmResponder = (body) => {
    const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (/Write ONE short human Taglish follow-up/.test(sys)) {
      return 'Sir may slot pa po this week. Paki-reply lang po 🙏\n[HANDOFF: quiet]';
    }
    return 'Paki-send po ng video ng TV na naka-plug.';
  };
  try {
    const t0 = now;
    await s.post(msg('fu', { text: 'walang display po' }, t0));
    assert.equal(s.app.store.thread('fu').awaitingVideo, true);
    assert.equal(s.mock.calls.messages.length, 1);

    now = t0 + 119 * MIN;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 1);

    now = t0 + 120 * MIN;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 2);
    assert.match(s.mock.calls.messages[1].message.text, /slot/);
    assert.doesNotMatch(s.mock.calls.messages[1].message.text, /HANDOFF/);
    assert.equal(s.mock.calls.pass.length, 0);
    const followCall = s.mock.calls.llm.find((c) => c.body.messages.some((m) => /Write ONE short human Taglish follow-up/.test(m.content)));
    const followText = followCall.body.messages.map((m) => m.content).join('\n');
    assert.match(followText, /limited slots this week/);
    assert.match(followText, /No discount/);
    assert.match(followText, /Remind them to send the video/);
    assert.equal(followCall.body.messages.at(-1).role, 'user');
    assert.equal(s.app.store.thread('fu').followupCount, 1);

    s.app.store.thread('fu').lastFollowupAt = t0;
    now = t0 + 23 * HOUR + 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 2, 'no second follow-up after 23h from the customer');

    const tUser2 = t0 + 6 * HOUR;
    now = tUser2;
    await s.post(msg('fu', { text: 'nandito pa po ako' }, tUser2));
    assert.equal(s.app.store.thread('fu').followupCount, 1);
    const t = s.app.store.thread('fu');
    t.lastFollowupAt = tUser2 - 22 * HOUR;
    const beforeSecond = s.mock.calls.messages.length;
    now = t.lastFollowupAt + 24 * HOUR;
    assert.ok(now - tUser2 <= 23 * HOUR);
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, beforeSecond + 1);
    assert.equal(s.app.store.thread('fu').followupCount, 2);

    const capped = s.app.store.thread('fu');
    const beforeThird = s.mock.calls.messages.length;
    now += 24 * HOUR;
    capped.lastUserTs = now;
    capped.history.push({ role: 'assistant', content: 'still waiting po', ts: now });
    capped.lastFollowupAt = now - 24 * HOUR;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, beforeThird);
    assert.equal(capped.followupCount, 2);

    s.app.store.flush();
    const store2 = new Store(s.app.cfg.dataDir, { historyTurns: 20 });
    const bot2 = new Bot({
      cfg: s.app.cfg, store: store2, graph: s.app.graph, llm: s.app.llm, log: s.app.log, push: s.app.push, now: () => now,
    });
    await bot2.checkFollowups();
    assert.equal(s.mock.calls.messages.length, beforeThird);
    assert.equal(store2.thread('fu').followupCount, 2);
  } finally { await s.close(); }
});

test('follow-ups skip handoff, human pause, allowlist, a disabled bot, and a submitted booking', async () => {
  const s = await setup({ BOT_TEST_PSIDS: 'allowed' });
  let now = Date.now();
  s.app.bot.now = () => now;
  s.mock.state.llmResponder = () => 'May slot pa po this week.';
  const seed = (psid, extra = {}) => {
    const t = s.app.store.thread(psid);
    t.history = [
      { role: 'user', content: 'hm po', ts: now },
      { role: 'assistant', content: 'Taga saan po?', ts: now },
    ];
    t.lastUserTs = now;
    Object.assign(t, extra);
  };
  try {
    seed('handed', { handedOff: true });
    seed('paused', { pausedUntil: now + 5 * 3600e3 });
    seed('outsider');
    seed('allowed');
    seed('booked', { bookingDone: true });
    now += 121 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.app.store.thread('allowed').followupCount, 1);
    assert.equal(s.app.store.thread('handed').followupCount, 0);
    assert.equal(s.app.store.thread('booked').followupCount, 0);

    s.app.cfg.botEnabled = false;
    const allowed = s.app.store.thread('allowed');
    allowed.lastUserTs = now;
    allowed.history.push({ role: 'assistant', content: 'follow up po', ts: now });
    allowed.lastFollowupAt = now - 24 * 3600e3;
    const before = s.mock.calls.messages.length;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, before);
  } finally { await s.close(); }
});

test('follow-ups are not limited by BOT_ACTIVE_HOURS', async () => {
  const s = await setup({ BOT_ACTIVE_HOURS: '00:00-00:01' });
  let now = new Date('2026-10-19T04:00:00Z').getTime();
  s.app.bot.now = () => now;
  s.mock.state.llmResponder = () => 'May slot pa po this week sir.';
  const t = s.app.store.thread('night');
  t.history = [
    { role: 'user', content: 'hm po', ts: now },
    { role: 'assistant', content: 'Taga saan po sila?', ts: now },
  ];
  t.lastUserTs = now;
  now += 120 * 60 * 1000;
  try {
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(isActiveNow(s.app.cfg, new Date(now)), false);
  } finally { await s.close(); }
});

test('no follow-up after the booking form was sent and the customer says it is done', async () => {
  const s = await setup();
  let now = Date.now();
  s.app.bot.now = () => now;
  const url = 'https://jmagscutomerform.netlify.app/';
  s.mock.state.llmResponder = () => `Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊\n\n${url}`;
  try {
    await s.post(msg('bk', { text: 'sige po bukas' }, now));
    assert.equal(s.app.store.thread('bk').bookingFormSent, true);
    now += 1000;
    await s.post(msg('bk', { text: 'na-fill ko na po' }, now));
    assert.equal(s.app.store.thread('bk').bookingDone, true);
    const n = s.mock.calls.messages.length;
    now += 121 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, n);
  } finally { await s.close(); }
});

test('a sent video clears the outstanding video request', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Paki-send po ng video.';
  try {
    await s.post(msg('vv', { text: 'walang display' }));
    assert.equal(s.app.store.thread('vv').awaitingVideo, true);
    await s.post(msg('vv', { attachments: [{ type: 'video', payload: { url: 'https://example.com/v.mp4' } }] }));
    assert.equal(s.app.store.thread('vv').awaitingVideo, false);
    assert.equal(s.mock.calls.pass.length, 0);
  } finally { await s.close(); }
});

test('photo posts an alert webhook and a dashboard review without the full PSID', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  s.app.cfg.alertWebhookUrl = `${s.mock.base}/alert`;
  try {
    await s.post(msg('psid-secret-9999', {
      text: 'ito po yung tv',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/a.mp4' } }],
    }));
    assert.equal(s.mock.calls.alerts.length, 1);
    const alert = s.mock.calls.alerts[0];
    assert.equal(alert.psid, 'psid-secret-9999');
    assert.equal(alert.type, 'video');
    assert.equal(alert.url, 'https://cdn.example/a.mp4');
    assert.match(alert.snippet, /ito po yung tv/);
    assert.equal(Number.isNaN(Date.parse(alert.timestamp)), false);
    const reviews = await fetch(`${s.base}/dashboard/api/reviews`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(reviews.status, 200);
    const rows = await reviews.json();
    assert.equal(rows[0].type, 'video');
    assert.equal(rows[0].url, 'https://cdn.example/a.mp4');
    assert.equal(rows[0].psidLast4, '9999');
    assert.equal(JSON.stringify(rows).includes('psid-secret-9999'), false);
    assert.equal((await fetch(`${s.base}/dashboard/api/reviews`)).status, 403);
  } finally { await s.close(); }
});

test('dashboard is an installable PWA and push is skipped until VAPID keys exist', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  try {
    const page = await fetch(`${s.base}/dashboard`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /rel="manifest"/);
    assert.match(html, /Log in/);
    assert.match(html, /id="toggle-password"/);
    assert.match(html, /aria-label="Ipakita\/Itago ang password"/);
    assert.match(html, /id="password"[^>]*type="password"/);
    assert.doesNotMatch(html, /Enable notifications/);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /theme-color/);
    const manifest = await (await fetch(`${s.base}/manifest.webmanifest`)).json();
    assert.equal(manifest.name, "JMAG's Video Review");
    assert.equal(manifest.short_name, 'JMAG Videos');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.theme_color, '#10243f');
    assert.ok(manifest.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
    const sw = await (await fetch(`${s.base}/sw.js`)).text();
    assert.match(sw, /cache the app shell/i);
    assert.match(sw, /network-first for data/i);
    const icon = Buffer.from(await (await fetch(`${s.base}/icons/icon-192.png`)).arrayBuffer());
    assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const icon512 = Buffer.from(await (await fetch(`${s.base}/icons/icon-512.png`)).arrayBuffer());
    assert.equal(icon512.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    const status = await fetch(`${s.base}/dashboard/api/push-status`, { headers: { Authorization: 'Bearer adm' } });
    assert.deepEqual(await status.json(), { enabled: false, publicKey: '' });
    const sub = await fetch(`${s.base}/dashboard/api/subscribe`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }),
    });
    assert.equal(sub.status, 200);
    assert.equal((await sub.json()).enabled, false);
    assert.equal(s.app.store.readSubscriptions()[0].endpoint, 'https://push.example/1');
    assert.equal((await fetch(`${s.base}/dashboard/api/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).status, 403);

    await s.post(msg('quiet-push', { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/p.jpg' } }] }));
    assert.equal(s.mock.calls.pass.length, 0);

    s.app.cfg.vapidPublicKey = 'pub';
    s.app.cfg.vapidPrivateKey = 'priv';
    const sent = [];
    s.app.push._client = { sendNotification: async (_sub, body) => { sent.push(JSON.parse(body)); } };
    await s.post(msg('pushy', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/z.mp4' } }] }));
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /video/i);
    assert.equal(sent[0].url, '/dashboard');
    assert.match(sent[0].body, /sent a video/);
  } finally { await s.close(); }
});

test('conversation export hashes the PSID, requires the admin token, and drops lines older than 60 days', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  try {
    await s.post(msg('customer-abc1234', { text: 'hello po export' }));
    await s.post(msg('customer-abc1234', { text: 'pa tawag na lang' }));
    const file = path.join(s.app.cfg.dataDir, 'conversations.jsonl');
    assert.equal(fs.readFileSync(file, 'utf8').includes('customer-abc1234'), false);
    const res = await fetch(`${s.base}/admin/conversations`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.some((r) => r.role === 'user' && r.text.includes('hello po export') && r.psidLast4 === '1234' && r.handoffReason === ''));
    assert.ok(body.every((r) => typeof r.psidHash === 'string' && r.psidHash.length === 16));
    assert.equal(JSON.stringify(body).includes('customer-abc1234'), false);
    const handoff = body.find((r) => r.handoffReason);
    assert.match(handoff.handoffReason, /tawag/);
    assert.equal(s.app.store.thread('customer-abc1234').history.some((h) => h.content === s.mock.calls.messages.at(-1).message.text), false);
    const future = await fetch(`${s.base}/admin/conversations?since=${encodeURIComponent(new Date(Date.now() + 86400e3).toISOString())}`, { headers: { Authorization: 'Bearer adm' } });
    assert.deepEqual(await future.json(), []);
    assert.equal((await fetch(`${s.base}/admin/conversations?since=not-a-date`, { headers: { Authorization: 'Bearer adm' } })).status, 400);
    assert.equal((await fetch(`${s.base}/admin/conversations`)).status, 403);
    const wrong = await fetch(`${s.base}/admin/conversations`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 403);

    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date(Date.now() - 61 * 86400e3).toISOString(), psidHash: 'aaaaaaaaaaaaaaaa', psidLast4: '0000', role: 'user', text: 'ancient line', handoffReason: '' })}\n`);
    s.app.store.addTurn('rot', 'user', 'fresh line', Date.now());
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after.includes('ancient line'), false);
    assert.match(after, /fresh line/);
  } finally { await s.close(); }
});

test('the follow-up scheduler is started only by the main process', async () => {
  const s = await setup();
  try {
    assert.equal(s.app.bot._followTimer, undefined);
    s.app.bot.startFollowups();
    assert.ok(s.app.bot._followTimer);
    s.app.bot.startFollowups();
    clearInterval(s.app.bot._followTimer);
  } finally { await s.close(); }
});

async function postRaw(s, payload) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${s.base}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex'),
    },
    body,
  });
  await new Promise((r) => setImmediate(r));
  return res;
}

test('slot extraction picks brand, size, problem, age, location, and repair history from a story', () => {
  const story = 'Ay grabe po, kagabi nag-brownout habang nanonood yung mga bata. Yung Samsung 55 inch namin, 3 taon pa lang, biglang walang display. Naiinis na po ako. Taga Binan Laguna po kami. Dinala na namin sa ibang shop noong nakaraang buwan, binuksan na nila, hindi pa naayos.';
  const thread = { history: [{ role: 'user', content: story }] };
  updateIntake(thread, story, false);
  assert.equal(thread.slots.brandSize, 'Samsung 55"');
  assert.equal(thread.slots.problemText, 'no display / backlight');
  assert.match(thread.slots.age, /3 taon/i);
  assert.match(thread.slots.location, /Binan/i);
  assert.equal(thread.slots.repairedElsewhere, 'answered');
  const summary = summarizeConversation(thread.history);
  assert.equal(summary.brand, 'Samsung');
  assert.equal(summary.size, '55"');
  assert.equal(summary.problem, 'no display / backlight');
  const note = intakeContext(thread);
  assert.match(note, /Samsung 55/);
  assert.match(note, /Binan/i);
  assert.match(note, /Never ask for a slot that is already filled/);
});

test('a received video stays in later model calls and is never treated as missing', async () => {
  const s = await setup();
  s.mock.state.llmResponder = (body) => {
    const last = body.messages.filter((m) => m.role === 'user').at(-1).content;
    if (/Ok na ba yung video nareview na/.test(last)) {
      return 'Hindi pa po nakikita ni Ivan ang video dito sa chat namin. Pwede po ulit i-send?';
    }
    if (/Sigurado po ba/.test(last)) {
      return 'hindi po namin nakikita ang video dito sa aming side. Pwede po ulit i-send?';
    }
    if (/magkano po ang estimate/.test(last)) return 'Ano po ang problema ng TV?';
    return 'Noted po, ipapatingin sa technician namin ang video';
  };
  try {
    await s.post(msg('vid1', {
      text: 'Samsung 55 inch po',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/live.mp4' } }],
    }));
    assert.match(s.mock.calls.messages[0].message.text, /ipapatingin sa technician namin ang video/);
    assert.equal(s.mock.calls.pass.length, 0);
    const hist = s.app.store.thread('vid1').history.map((h) => h.content).join('\n');
    assert.match(hist, /\[Customer sent a video at \d{2}:\d{2} - RECEIVED, forwarded to technician Ivan for review\. You cannot view it, but it WAS received\.\]/);
    assert.match(s.mock.calls.llm[0].body.messages.map((m) => m.content).join('\n'), /WAS received/);

    await s.post(msg('vid1', { text: 'Ok na ba yung video nareview na?' }));
    const follow = s.mock.calls.llm.at(-1).body.messages.map((m) => m.content).join('\n');
    assert.match(follow, /RECEIVED, forwarded to technician Ivan/);
    assert.match(follow, /NEVER say a video or photo was not received/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /nagre-review ng video/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /all-in price soon/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /Karaniwang range po for Samsung 55"/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /₱5,000/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /₱18,000/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /ma-check ng technician personally/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /₱1,000 check-up fee \(₱500 for 32" and 40" TVs\), waived if they proceed with the repair/);

    await s.post(msg('vid1', { text: 'Sigurado po ba kayo?' }));
    await s.post(msg('vid1', { text: 'magkano po ang estimate?' }));
    const outbound = s.mock.calls.messages.map((m) => m.message.text).join('\n');
    assert.doesNotMatch(outbound, /nakikita|ulit i-send|paki-send ulit|\bresend\b/i);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /problema/i);
    assert.match(s.mock.calls.messages.at(-1).message.text, /Karaniwang range po for Samsung 55"/);
    assert.match(s.mock.calls.messages.at(-1).message.text, /ma-check ng technician personally/);
    assert.equal(s.app.store.thread('vid1').awaitingVideo, false);
  } finally { await s.close(); }
});

test('a price range from a description invites a personal check-up', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Karaniwang range po ay ₱9,000–₱10,000.';
  try {
    await s.post(msg('rng', { text: 'may lines po sa TCL 40 inch, taga Cabuyao' }));
    const text = s.mock.calls.messages[0].message.text;
    assert.match(text, /₱9,000–₱10,000/);
    assert.match(text, /Pero mas mainam pa rin po na ma-check ng technician personally ang TV para mas eksakto ang estimate/);
    assert.match(text, /home service check-up/);
    assert.match(text, /waived if they proceed with the repair/);
  } finally { await s.close(); }
});

test('asking the check-up price gets the plain fee and nothing else', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Depende po sa sira. Ano po ang problema ng TV?';
  try {
    await s.post(msg('fee', { text: 'magkano po ang check-up?' }));
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, CHECKUP_FEE_PLAIN);
    assert.equal(s.mock.calls.pass.length, 0);
  } finally { await s.close(); }
});

test('video, location, and age close intake once and send the free tips once', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'Nasa ₱9,500 po ang all-in, after repair po ang bayad.';
  try {
    await s.post(msg('tip', { text: 'Samsung 55 inch, 5 taon na, taga Binan. Walang display. Nasend ko na ang video.' }));
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(s.mock.calls.messages[0].message.text, CLOSE_LINE);
    assert.match(s.mock.calls.messages[1].message.text, /free tips/);
    assert.match(s.mock.calls.messages[1].message.text, /May lumalabas na lines/);
    assert.match(s.mock.calls.messages[1].message.text, /09386369374 \(Smart\)/);
    assert.match(s.mock.calls.messages[1].message.text, /09267229506 \(Globe\)/);
    assert.equal(s.app.store.thread('tip').tipsSent, true);
    assert.equal(s.app.store.thread('tip').intakeClosed, true);
    const slots = s.app.store.thread('tip').slots;
    assert.match(slots.brandSize, /Samsung 55/);
    assert.match(slots.age, /5 taon/);
    assert.match(slots.location, /Binan/i);
    assert.equal(slots.repairedElsewhere, '');
    await s.post(msg('tip', { text: 'salamat po, magkano na' }));
    assert.equal(s.mock.calls.messages.filter((m) => /09386369374/.test(m.message.text)).length, 1);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /problema|taga-saan|ilang taon|ibang shop/i);
    const n = s.mock.calls.messages.length;
    s.app.bot.now = () => Date.now() + 121 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, n);
  } finally { await s.close(); }
});

test('TIPS_MESSAGE replaces the built-in free tips', async () => {
  const custom = loadConfig({ TIPS_MESSAGE: 'Custom tips line only.\\nSecond line.' });
  assert.equal(custom.tipsMessage, 'Custom tips line only.\nSecond line.');
  const s = await setup({ TIPS_MESSAGE: 'Custom tips line only.' });
  try {
    await s.post(msg('tip2', { text: '5 taon na po, taga Binan, nasend ko na ang video.' }));
    assert.equal(s.mock.calls.messages.filter((m) => m.message.text === 'Custom tips line only.').length, 1);
    assert.equal(s.mock.calls.messages.some((m) => /09386369374/.test(m.message.text)), false);
  } finally { await s.close(); }
});

test('text then a video inside the batch window gets one reply', async () => {
  const s = await setup({ BATCH_WINDOW_MS: '250' });
  s.mock.state.llmResponder = () => 'Salamat po, titingnan ng technician.';
  try {
    await postRaw(s, msg('batch1', { text: 'Nasend ko na ang videi' }));
    await postRaw(s, msg('batch1', {
      text: 'Video',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/v.mp4' } }],
    }));
    await s.app.bot.idle();
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.llm.length, 1);
    const users = s.mock.calls.llm[0].body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    assert.match(users, /Nasend ko na ang videi/);
    assert.match(users, /RECEIVED/);
  } finally { await s.close(); }
});

test('a message that arrives while the model is thinking is answered once', async () => {
  const s = await setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  s.mock.state.llmResponder = async () => {
    calls += 1;
    if (calls === 1) await gate;
    return 'Sige po, noted.';
  };
  try {
    await postRaw(s, msg('fly', { text: 'una po' }));
    for (let i = 0; i < 50 && s.mock.calls.llm.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.mock.calls.llm.length, 1);
    await postRaw(s, msg('fly', { text: 'pangalawa Samsung 55' }));
    release();
    await s.app.bot.idle();
    assert.equal(s.mock.calls.messages.length, 1);
    const lastUsers = s.mock.calls.llm.at(-1).body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    assert.match(lastUsers, /una po/);
    assert.match(lastUsers, /pangalawa Samsung 55/);
  } finally {
    release();
    await s.close();
  }
});

test('standby takes the thread only when this bot should own it', async () => {
  const s = await setup({ LOG_LEVEL: 'warn' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    await s.post(standby('idle1', 'hello po'));
    assert.equal(s.mock.calls.take.length, 1);
    assert.equal(s.mock.calls.messages.length, 0);
    await s.post(msg('idle2', { text: 'pa tawag na lang' }));
    await s.post(standby('idle2', 'nandito pa po'));
    assert.equal(s.mock.calls.take.length, 1);
    s.mock.state.takeFail = '(#27) conversation routing is not enabled';
    await s.post(standby('idle3', 'hello ulit'));
    assert.equal(s.mock.calls.take.length, 2);
    assert.equal(s.mock.calls.messages.length, 1);
    assert.ok(logged.some((l) => /#27/.test(l) && /take_thread_control failed/.test(l)));
  } finally {
    console.error = orig;
    await s.close();
  }
});

test('dashboard login lists videos without the full PSID and marks them reviewed', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret', ADMIN_TOKEN: 'adm' });
  s.mock.state.profiles = { 'cust-7771': { name: 'Maria Cruz' } };
  try {
    const locked = await (await fetch(`${s.base}/dashboard`)).text();
    assert.match(locked, /Log in/);
    assert.doesNotMatch(locked, /Maria Cruz/);
    const bad = await fetch(`${s.base}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.match(await bad.text(), /Wrong password/);
    const forged = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: 'jmags_dash=999.aaaa' } })).text();
    assert.match(forged, /Log in/);
    assert.doesNotMatch(forged, /Mark reviewed/);

    await s.post(msg('cust-7771', {
      text: 'Samsung 55 inch walang display taga Binan',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/dash.mp4' } }],
    }));
    const login = await fetch(`${s.base}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=secret',
    });
    assert.equal(login.status, 303);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const pair = (setCookie.match(/jmags_dash=[^;]+/) || [])[0];
    const page = await fetch(`${s.base}/dashboard`, { headers: { Cookie: pair } });
    const html = await page.text();
    assert.match(html, /Enable notifications/);
    assert.match(html, /Maria Cruz/);
    assert.match(html, /Samsung/);
    assert.match(html, /55/);
    assert.match(html, /Binan/i);
    assert.match(html, /<video/);
    assert.match(html, />Open</);
    assert.match(html, /Messenger links can expire/);
    assert.match(html, /<textarea/);
    assert.match(html, />Send</);
    assert.match(html, /Buksan ang Inbox/);
    assert.match(html, /Huling mensahe/);
    assert.match(html, new RegExp(`asset_id=${PAGE}`));
    assert.doesNotMatch(html, /selected_item_id/);
    assert.doesNotMatch(html, /Open in Messenger/);
    assert.doesNotMatch(html, /Open chat in Business Suite/);
    assert.doesNotMatch(html, /intent:#Intent/);
    assert.match(html, /Mark reviewed/);
    assert.match(html, /1 new/);
    assert.equal(html.includes('cust-7771'), false);
    const rows = await (await fetch(`${s.base}/dashboard/api/reviews`, { headers: { Authorization: 'Bearer adm' } })).json();
    assert.equal(JSON.stringify(rows).includes('cust-7771'), false);
    const id = s.app.store.data.reviews[0].id;
    const reviewed = await fetch(`${s.base}/dashboard/reviewed`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: pair, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `id=${id}`,
    });
    assert.equal(reviewed.status, 303);
    const after = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: pair } })).text();
    assert.match(after, /0 new/);
    assert.match(after, /Reviewed/);
    assert.equal(s.mock.calls.conversations.length, 1);
    assert.equal(s.app.store.data.reviews[0].conversationId, '');
  } finally { await s.close(); }
});

test('an empty dashboard password cannot log in', async () => {
  const s = await setup();
  try {
    const res = await fetch(`${s.base}/dashboard/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'password=anything',
    });
    assert.equal(res.status, 401);
    assert.match(await res.text(), /not set/);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally { await s.close(); }
});

test('Business Suite uses the inbox thread id, and phones open the app or Messenger', () => {
  const deep = `https://business.facebook.com/latest/inbox/all?asset_id=${PAGE}&selected_item_id=555001&mailbox_id=${PAGE}&thread_type=FB_MESSAGE`;
  assert.equal(businessSuiteThreadUrl(PAGE, '555001'), deep);
  assert.equal(businessSuiteThreadUrl(PAGE, ''), genericInboxUrl(PAGE));
  assert.equal(threadItemId('t_9988', `/${PAGE}/inbox/555001/`), '555001');
  assert.equal(threadItemId('t_555001', ''), '555001');
  assert.equal(threadItemId('t_not-numeric', 'https://m.me/102622881557025'), '');
  const links = inboxLinks(PAGE, {
    psid: 'cust-7771',
    conversationId: 't_9988',
    conversationLink: `/${PAGE}/inbox/555001/`,
  });
  assert.equal(links.suite, genericInboxUrl(PAGE));
  assert.equal(links.suite.includes('selected_item_id'), false);
  assert.equal(links.messenger, `https://www.facebook.com/${PAGE}/inbox/555001/`);
  assert.equal(JSON.stringify(links).includes('cust-7771'), false);
  assert.equal(links.suite.includes('t_9988'), false);
  assert.equal(links.android, `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${BUSINESS_SUITE_PACKAGE};end`);
  assert.equal(links.android.includes('business.facebook.com'), false);
  assert.equal(links.android.includes('browser_fallback_url'), false);
  assert.equal(links.android.includes('facebook.com'), false);
  const noThread = inboxLinks(PAGE, {});
  assert.equal(noThread.android, `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${BUSINESS_SUITE_PACKAGE};end`);
  assert.equal(noThread.android.includes('browser_fallback_url'), false);
  const fromThreadOnly = inboxLinks(PAGE, { psid: 'cust-7771', conversationId: 't_555001', conversationLink: 'https://m.me/102622881557025' });
  assert.equal(fromThreadOnly.itemId, '555001');
  assert.equal(fromThreadOnly.messenger, `https://www.facebook.com/${PAGE}/inbox/555001/`);
  assert.equal(fromThreadOnly.messenger.includes('m.me'), false);
  assert.equal(messengerAppHref('https://www.messenger.com/t/555001'), 'https://www.messenger.com/t/555001');
  assert.equal(messengerAppHref('https://m.me/102622881557025'), '');
  assert.equal(inboxClientKind('Mozilla/5.0 (Linux; Android 14)', false), 'android');
  assert.equal(inboxClientKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', false), 'ios');
  assert.equal(inboxClientKind('Mozilla/5.0 (X11; Linux x86_64)', false), '');
  assert.equal(inboxClientKind('Mozilla/5.0 (X11; Linux x86_64)', true), 'coarse');
  assert.equal(primaryInboxHref({ kind: 'android', suiteHref: links.suite, androidHref: links.android, messengerHref: links.messenger }), links.android);
  assert.equal(primaryInboxHref({ kind: 'ios', suiteHref: links.suite, androidHref: links.android, messengerHref: links.messenger }), links.suite);
  assert.equal(primaryInboxHref({ kind: 'coarse', suiteHref: links.suite, androidHref: links.android, messengerHref: links.messenger }), links.messenger);
  assert.equal(primaryInboxHref({ kind: '', suiteHref: links.suite, androidHref: links.android, messengerHref: links.messenger }), links.suite);
  const built = candidateInboxUrls({
    pageId: PAGE,
    businessId: '588481615147194',
    psid: 'cust-7771',
    conversationId: 't_9988',
    link: `/${PAGE}/inbox/555001/`,
    participants: [
      { id: PAGE, name: "JMAG's Appliances" },
      { id: 'cust-7771', name: 'Maria Cruz' },
      { id: '999888777', name: 'Other' },
    ],
  });
  assert.equal(built.ids.psid, 'cust-7771');
  assert.equal(built.ids.conversationId, 't_9988');
  assert.equal(built.ids.threadDigitsFromLink, '555001');
  assert.equal(built.ids.threadDigitsFromConversationId, '9988');
  assert.equal(built.ids.participantIds.some((p) => p.id === PAGE), true);
  const urls = built.urls.map((u) => u.url);
  assert.ok(urls.includes(genericInboxUrl(PAGE)));
  assert.ok(urls.includes(deep));
  assert.ok(urls.includes(businessSuiteThreadUrl(PAGE, 'cust-7771')));
  assert.ok(urls.includes(businessSuiteThreadUrl(PAGE, '9988')));
  assert.ok(urls.includes(businessSuiteThreadUrl(PAGE, 't_9988')));
  assert.ok(urls.includes(businessSuiteThreadUrl(PAGE, '999888777')));
  assert.equal(urls.some((u) => u.includes(`selected_item_id=${PAGE}`)), false);
  assert.ok(urls.some((u) => u.startsWith('https://business.facebook.com/latest/inbox/messenger?') && u.includes('selected_item_id=cust-7771')));
  assert.ok(urls.some((u) => u.startsWith('https://www.facebook.com/latest/inbox/messenger?') && u.includes('selected_item_id=555001')));
  assert.ok(urls.some((u) => u.includes('bpn_id=588481615147194') && u.includes('nav_ref=manage_page_ap_plus_default') && u.includes('selected_item_id=cust-7771')));
  assert.ok(urls.includes(`https://www.facebook.com/${PAGE}/inbox/555001/`));
  assert.ok(urls.includes('https://www.facebook.com/messages/t/9988'));
  assert.ok(urls.includes('https://www.facebook.com/messages/t/cust-7771'));
  const js = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
  assert.match(js, /Android\|iPhone\|iPad\|iPod/);
  assert.match(js, /pointer:\s*coarse/);
  assert.match(js, /send-reply/);
  assert.match(js, /15000/);
  assert.match(js, /visibilityState/);
  assert.match(js, /Enter/);
  assert.doesNotMatch(js, /data-android-href/);
  assert.doesNotMatch(js, /personal-inbox/);
  assert.doesNotMatch(js, /selected_item_id/);
  assert.match(js, /Nakopya ang pangalan ni /);
  assert.match(js, /i-paste sa search ng inbox/);
  assert.match(js, /data-copy-name/);
  assert.match(js, /controllerchange/);
  assert.match(js, /location\.reload/);
  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(sw, /jmags-video-shell-v6/);
  assert.match(sw, /skipWaiting/);
  assert.match(sw, /clients\.claim/);
  assert.match(sw, /network-first for data/);
  assert.match(sw, /\/dashboard\.js/);
});

test('a stored conversation keeps the name copy and the plain inbox link', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret', ADMIN_TOKEN: 'adm' });
  s.mock.state.profiles = { 'cust-7771': { name: 'Maria Cruz' } };
  s.mock.state.conversations = {
    'cust-7771': {
      id: 't_9988',
      link: `/${PAGE}/inbox/555001/`,
      updated_time: '2026-05-02T01:02:03+0000',
    },
  };
  try {
    await s.post(msg('cust-7771', {
      text: 'Samsung 55 inch walang display',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/thread.mp4' } }],
    }));
    const saved = s.app.store.data.reviews[0];
    assert.equal(saved.conversationId, 't_9988');
    assert.equal(saved.conversationLink, `/${PAGE}/inbox/555001/`);
    assert.equal(saved.conversationUpdatedTime, '2026-05-02T01:02:03+0000');
    assert.equal(s.mock.calls.conversations.length, 1);
    assert.equal(s.mock.calls.conversations[0].platform, 'messenger');
    assert.equal(s.mock.calls.conversations[0].user_id, 'cust-7771');
    assert.equal(s.mock.calls.conversations[0].fields, 'id,link,updated_time,participants');

    await s.post(msg('cust-7771', {
      attachments: [{ type: 'image', payload: { url: 'https://cdn.example/again.jpg' } }],
    }));
    assert.equal(s.mock.calls.conversations.length, 1, 'a second item for the same PSID uses the cache');

    const { cookie } = await dashCookie(s.base);
    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    const href = genericInboxUrl(PAGE).replaceAll('&', '&amp;');
    assert.match(html, /Buksan ang Inbox/);
    assert.ok(html.includes(`href="${href}"`));
    assert.equal(html.includes('selected_item_id'), false);
    assert.equal(html.includes('cust-7771'), false);
    assert.match(html, /Kopyahin ang pangalan/);
    assert.match(html, /data-copy-name="Maria Cruz"/);
    assert.match(html, /<textarea/);
    assert.match(html, />Send</);
    assert.doesNotMatch(html, /intent:#Intent/);
    assert.doesNotMatch(html, /Open in Messenger/);
    assert.doesNotMatch(html, /Open chat in Business Suite/);
    assert.doesNotMatch(html, new RegExp(`facebook\\.com/${PAGE}/inbox/555001`));
    assert.equal(s.mock.calls.conversations.length, 1);
    const phoneUa = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const phone = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie, 'User-Agent': phoneUa } })).text();
    assert.match(phone, /Buksan ang Inbox/);
    assert.match(phone, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.doesNotMatch(phone, /intent:#Intent/);
    assert.match(phone, /Maria Cruz/);
    assert.match(phone, /Kopyahin ang pangalan/);
    assert.match(phone, /data-copy-name="Maria Cruz"/);
    assert.equal(phone.includes('Open in Messenger'), false);
    assert.doesNotMatch(phone, /class="personal-inbox"/);
    assert.doesNotMatch(phone, new RegExp(`facebook\\.com/${PAGE}/inbox/555001`));
    const rows = await (await fetch(`${s.base}/dashboard/api/reviews`, { headers: { Authorization: 'Bearer adm' } })).json();
    assert.equal(JSON.stringify(rows).includes('cust-7771'), false);
    assert.equal(rows[0].conversationId, 't_9988');
    assert.equal(Object.hasOwn(rows[0], 'psid'), false);
  } finally { await s.close(); }
});

test('a Graph conversation error keeps the generic inbox link', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret', LOG_LEVEL: 'warn' });
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  s.mock.state.conversationFail = 'boom';
  try {
    await s.post(msg('cust-404', {
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/miss.mp4' } }],
    }));
    const { cookie } = await dashCookie(s.base);
    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.equal(html.includes('selected_item_id'), false);
    assert.equal(html.includes('Open in Messenger'), false);
    assert.doesNotMatch(html, /thread id:/);
    assert.match(html, /Buksan ang Inbox/);
    assert.ok(html.includes(`https://business.facebook.com/latest/inbox/all?asset_id=${PAGE}`));
    assert.equal(s.app.store.data.reviews[0].conversationId, '');
    assert.ok(logged.some((l) => /conversation lookup failed/.test(l) && /boom/.test(l)));
    await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(s.mock.calls.conversations.length, 2);
  } finally {
    console.error = orig;
    await s.close();
  }
});

test('a missing profile name is taken from the conversation participants', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret' });
  s.mock.state.conversations = {
    'noname-1': {
      id: 't_111',
      link: `/${PAGE}/inbox/111/`,
      participants: {
        data: [
          { id: PAGE, name: "JMAG's Appliances" },
          { id: 'noname-1', name: 'Juan Dela Cruz' },
        ],
      },
    },
  };
  try {
    await s.post(msg('noname-1', { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/n.jpg' } }] }));
    assert.equal(s.app.store.data.reviews[0].customerName, 'Juan Dela Cruz');
    const { cookie } = await dashCookie(s.base);
    const phoneUa = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 SamsungBrowser/26.0 Chrome/120.0.0.0 Mobile Safari/537.36';
    const phone = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie, 'User-Agent': phoneUa } })).text();
    assert.match(phone, /Juan Dela Cruz/);
    assert.match(phone, /data-copy-name="Juan Dela Cruz"/);
    assert.match(phone, /Kopyahin ang pangalan/);
    assert.match(phone, /Buksan ang Inbox/);
    assert.equal(phone.includes('Open in Messenger'), false);
    assert.doesNotMatch(phone, /intent:#Intent/);
    const desk = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(desk, /Buksan ang Inbox/);
    assert.doesNotMatch(desk, /Open in Messenger/);
    assert.match(desk, /Kopyahin ang pangalan/);
    assert.match(desk, /data-copy-name="Juan Dela Cruz"/);
  } finally { await s.close(); }
});

test('the dashboard fills a missing conversation id on first load', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret' });
  s.mock.state.conversations = {
    'lazy-9001': { id: 't_4242', link: `/${PAGE}/inbox/777/`, updated_time: '2026-05-03T00:00:00+0000' },
  };
  try {
    s.app.store.addReview({
      id: 'rev-lazy',
      timestamp: new Date().toISOString(),
      psid: 'lazy-9001',
      psidLast4: '9001',
      customerName: 'Lazy User',
      summary: { brand: 'TCL' },
      status: 'new',
      type: 'video',
      url: 'https://cdn.example/lazy.mp4',
      snippet: '',
    }, Date.now());
    const { cookie } = await dashCookie(s.base);
    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    const href = genericInboxUrl(PAGE).replaceAll('&', '&amp;');
    assert.ok(html.includes(`href="${href}"`));
    assert.equal(html.includes('selected_item_id'), false);
    assert.match(html, /Buksan ang Inbox/);
    assert.doesNotMatch(html, /Open in Messenger/);
    assert.equal(html.includes('lazy-9001'), false);
    assert.equal(s.app.store.data.reviews[0].conversationId, 't_4242');
    assert.equal(s.app.store.data.reviews[0].conversationLink, `/${PAGE}/inbox/777/`);
    assert.equal(s.mock.calls.conversations.length, 1);
    await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(s.mock.calls.conversations.length, 1);
  } finally { await s.close(); }
});

test('admin inbox candidates lists every id and URL for a PSID', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  s.mock.state.profiles = {
    'cust-7771': { name: 'Maria Cruz' },
    [PAGE]: { business: { id: '588481615147194', name: 'JMAG Business' } },
  };
  s.mock.state.conversations = {
    'cust-7771': {
      id: 't_9988',
      link: `/${PAGE}/inbox/555001/`,
      updated_time: '2026-05-02T01:02:03+0000',
      participants: {
        data: [
          { id: PAGE, name: "JMAG's Appliances" },
          { id: 'cust-7771', name: 'Maria Cruz' },
        ],
      },
    },
  };
  try {
    const denied = await fetch(`${s.base}/admin/inbox-candidates?psid=cust-7771`);
    assert.equal(denied.status, 403);
    const missing = await fetch(`${s.base}/admin/inbox-candidates`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(missing.status, 400);
    const res = await fetch(`${s.base}/admin/inbox-candidates?psid=cust-7771`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.psid, 'cust-7771');
    assert.equal(body.pageId, PAGE);
    assert.equal(body.businessId, '588481615147194');
    assert.equal(body.businessName, 'JMAG Business');
    assert.equal(body.profileName, 'Maria Cruz');
    assert.equal(body.conversation.id, 't_9988');
    assert.equal(body.conversation.link, `/${PAGE}/inbox/555001/`);
    assert.equal(body.ids.threadDigitsFromLink, '555001');
    assert.equal(body.ids.threadDigitsFromConversationId, '9988');
    assert.ok(body.ids.participantIds.some((p) => p.id === 'cust-7771' && p.name === 'Maria Cruz'));
    assert.equal(body.ids.participantIds.some((p) => p.id === PAGE), true);
    const urls = body.urls.map((u) => u.url);
    assert.ok(urls.includes(genericInboxUrl(PAGE)));
    assert.ok(urls.some((u) => u.startsWith('https://business.facebook.com/latest/inbox/all?') && u.includes('selected_item_id=cust-7771')));
    assert.ok(urls.some((u) => u.startsWith('https://business.facebook.com/latest/inbox/all?') && u.includes('selected_item_id=555001')));
    assert.ok(urls.some((u) => u.startsWith('https://business.facebook.com/latest/inbox/messenger?') && u.includes('selected_item_id=cust-7771')));
    assert.ok(urls.some((u) => u.startsWith('https://www.facebook.com/latest/inbox/all?') && u.includes('bpn_id=588481615147194') && u.includes('selected_item_id=555001') && u.includes('nav_ref=manage_page_ap_plus_default')));
    assert.ok(urls.includes(`https://www.facebook.com/${PAGE}/inbox/555001/`));
    assert.ok(urls.includes('https://www.facebook.com/messages/t/9988'));
    assert.ok(urls.includes('https://www.facebook.com/messages/t/cust-7771'));
    const again = await fetch(`${s.base}/admin/inbox-candidates?psid=cust-7771`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(again.status, 200);
    assert.equal(s.mock.calls.conversations.length, 1);
  } finally { await s.close(); }
});

test('a pending video review does not repeat a stale cancel, and an unclear line stays on the video', async () => {
  const s = await setup();
  const old = Date.now() - 2 * 3600e3;
  s.mock.state.llmResponder = (body) => {
    const last = body.messages.filter((m) => m.role === 'user').at(-1).content;
    if (/nagcancel|cancel/i.test(last)) {
      return 'Kayo po mismo nagsabi ng "Huwag muna" at "Cancel" kaya kinancel po namin yung booking niyo nung Oct 17, 9am.';
    }
    return 'Opo, si Ivan na po ang titingin.';
  };
  try {
    s.app.store.addTurn('rev1', 'user', 'Huwag muna. Cancel yung booking nung Oct 17, 9am.', old);
    s.app.store.addTurn('rev1', 'assistant', 'Sige po, cancelled na po yung booking niyo.', old + 1000);
    await s.post(msg('rev1', {
      text: 'Samsung 55 inch',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/rev.mp4' } }],
    }, Date.now()));
    const before = s.mock.calls.llm.length;
    for (const text of ['Ok na ba?', 'Kamusta na?', 'Wala pa ba?', 'Ano na?']) {
      await s.post(msg('rev1', { text }));
    }
    assert.equal(s.mock.calls.llm.length, before);
    const replies = s.mock.calls.messages.slice(-4).map((m) => m.message.text);
    assert.equal(replies.length, 4);
    for (const text of replies) {
      assert.equal(text, PENDING_REVIEW_STATUS);
      assert.match(text, /09386369374/);
      assert.match(text, /09267229506/);
      assert.doesNotMatch(text, /cancel|booking|Oct 17|kayo po mismo/i);
    }
    await s.post(msg('rev1', { text: 'Saan part patingin' }));
    const clarify = s.mock.calls.messages.at(-1).message.text;
    assert.match(clarify, /video na nire-review ni Ivan/);
    assert.doesNotMatch(clarify, /location namin|TV po ba/i);
    assert.equal(s.mock.calls.llm.length, before);

    await s.post(msg('rev1', { text: 'Sigurado po ba?' }));
    const hidden = s.mock.calls.llm.at(-1).body.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(hidden, /Oct 17/);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /cancel|kayo po mismo/i);

    await s.post(msg('rev1', { text: 'Bakit nagcancel?' }));
    const shown = s.mock.calls.llm.at(-1).body.messages.map((m) => m.content).join('\n');
    assert.match(shown, /Oct 17/);
    const blamed = s.mock.calls.messages.at(-1).message.text;
    assert.doesNotMatch(blamed, /kayo po mismo/i);
    assert.match(blamed, /nagre-review pa ng video/);
    assert.match(blamed, /all-in price soon/);
  } finally { await s.close(); }
});

test('booking facts from before the latest video are hidden even inside 12 hours', () => {
  const now = Date.now();
  const history = [
    { role: 'user', content: 'Cancel yung booking Oct 17. Taga Binan, Samsung 55 inch, 3 taon.', ts: now - 3600e3 },
    { role: 'assistant', content: 'Sige po, cancelled na.', ts: now - 3500e3 },
    { role: 'user', content: 'Samsung 55 inch\n[Customer sent a video at 10:00 - RECEIVED]', ts: now - 1000 },
    { role: 'user', content: 'Ok na ba?', ts: now },
  ];
  const visible = visibleHistory(history, now, { pendingReview: true });
  const blob = visible.map((h) => h.content).join('\n');
  assert.doesNotMatch(blob, /Oct 17|cancelled|Binan/);
  assert.match(blob, /Customer sent a video/);
  assert.match(blob, /Ok na ba/);
  assert.equal(asksReviewStatus('Ok na ba?'), true);
  assert.equal(asksReviewStatus('Ok na ba yung video nareview na?'), false);
  const brought = visibleHistory(history, now, { pendingReview: true, keepOldTopic: true });
  assert.match(brought.map((h) => h.content).join('\n'), /Oct 17/);
});

test('PAGE_AI_APP_IDS echoes are logged and do not pause the bot', async () => {
  const s = await setup({ PAGE_AI_APP_IDS: '263902037430900', LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  try {
    await s.post(echo('ai1', '263902037430900', 'Opo cancelled na po yung booking.'));
    await s.post(msg('ai1', { text: 'hello po' }));
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.app.store.thread('ai1').pausedUntil, 0);
    assert.ok(logged.some((l) => /page AI echo/.test(l) && /app_id=263902037430900/.test(l) && /not pausing/.test(l)));
    await s.post(echo('ai2', '555666', 'ako na po'));
    await s.post(msg('ai2', { text: 'hello po' }));
    assert.equal(s.mock.calls.messages.length, 1);
    assert.ok(s.app.store.thread('ai2').pausedUntil > Date.now() + 11 * 3600e3);
    assert.ok(logged.some((l) => /human reply detected/.test(l) && /app_id=555666/.test(l) && /paused/.test(l)));
    assert.deepEqual(loadConfig({}).pageAiAppIds, []);
  } finally {
    console.log = orig;
    await s.close();
  }
});

test('standby and paused videos are saved and pushed without a reply', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm', DASHBOARD_PASSWORD: 'secret' });
  const sent = [];
  s.app.store.writeSubscriptions([{ endpoint: 'https://push.example/s', keys: { p256dh: 'a', auth: 'b' } }]);
  s.app.cfg.vapidPublicKey = 'pub';
  s.app.cfg.vapidPrivateKey = 'priv';
  s.app.push._client = { sendNotification: async (_sub, body) => { sent.push(JSON.parse(body)); } };
  const video = {
    object: 'page',
    entry: [{
      id: PAGE,
      time: Date.now(),
      standby: [{
        sender: { id: 'stand-vid' },
        recipient: { id: PAGE },
        timestamp: Date.now(),
        message: {
          mid: 'mid.stand.1',
          attachments: [{ type: 'video', payload: { url: 'https://cdn.example/stand.mp4' } }],
        },
      }],
    }],
  };
  try {
    await s.post(video);
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.app.store.data.reviews.length, 1);
    assert.equal(s.app.store.data.reviews[0].type, 'video');
    assert.equal(s.app.store.data.reviews[0].url, 'https://cdn.example/stand.mp4');
    assert.equal(s.app.store.data.reviews[0].mid, 'mid.stand.1');
    assert.equal(s.app.store.data.reviews[0].quietNote, 'bot not replying, standby/paused');
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /video/i);
    assert.equal(sent[0].url, '/dashboard');
    assert.match(sent[0].body, /sent a video/);
    s.app.store.data.seenMids = [];
    await s.post(video);
    assert.equal(s.app.store.data.reviews.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(s.mock.calls.messages.length, 0);

    await s.post(echo('pause-vid', '111222', 'ako na po'));
    await s.post(msg('pause-vid', { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/pause.jpg' } }] }));
    assert.equal(s.mock.calls.messages.length, 0);
    const photo = s.app.store.data.reviews.find((r) => r.url === 'https://cdn.example/pause.jpg');
    assert.ok(photo);
    assert.equal(photo.type, 'photo');
    assert.equal(photo.quietNote, 'bot not replying, standby/paused');
    assert.equal(sent.length, 2);
    assert.match(sent[1].title, /photo/i);

    await s.post(msg('else-1', {
      text: 'ref po ito hindi tv',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/else.mp4' } }],
    }));
    const other = s.app.store.data.reviews.find((r) => r.url === 'https://cdn.example/else.mp4');
    assert.ok(other);
    assert.equal(other.quietNote, undefined);
    assert.ok(s.mock.calls.messages.length >= 1);
    assert.equal(sent.length, 3);

    const { cookie } = await dashCookie(s.base);
    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /bot not replying, standby\/paused/);
    assert.equal(html.includes('stand-vid'), false);
  } finally { await s.close(); }
});

function assertLegalPage(html, otherPath) {
  assert.doesNotMatch(html, /\[[^\]\n]{0,80}\]/);
  assert.equal(html.includes('['), false);
  assert.doesNotMatch(html, /email/i);
  assert.match(html, /October 18, 2026/);
  assert.match(html, /San Pablo City, Laguna and General Trias, Cavite, Philippines/);
  assert.match(html, /09386369374 \(Smart\)/);
  assert.match(html, /09267229506 \(Globe\)/);
  assert.match(html, /https:\/\/jmags-messenger-bot\.onrender\.com\/privacy/);
  assert.match(html, /https:\/\/jmags-messenger-bot\.onrender\.com\/data-deletion/);
  assert.match(html, new RegExp(`href="${otherPath}"`));
  assert.match(html, /<footer>/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/data-deletion"/);
  assert.match(html, /name="viewport"/);
}

test('privacy and data-deletion pages are public and have no placeholders', async () => {
  const s = await setup();
  try {
    for (const file of ['privacy.html', 'data-deletion.html']) {
      const raw = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
      assert.equal(raw.includes('['), false);
      assert.doesNotMatch(raw, /email/i);
    }
    const privacy = await fetch(`${s.base}/privacy`);
    const privacyHtml = await privacy.text();
    assert.equal(privacy.status, 200);
    assert.match(privacy.headers.get('content-type'), /text\/html/);
    assertLegalPage(privacyHtml, '/data-deletion');
    assert.match(privacyHtml, /Render/);
    assert.match(privacyHtml, /Anthropic \(Claude\)/);
    assert.match(privacyHtml, /90 days/);
    assert.match(privacyHtml, /60 days/);
    assert.match(privacyHtml, /30 days/);
    assert.equal(loadConfig({}).dataRetentionDays, 90);

    const deletion = await fetch(`${s.base}/data-deletion`);
    const deletionHtml = await deletion.text();
    assert.equal(deletion.status, 200);
    assert.match(deletion.headers.get('content-type'), /text\/html/);
    assertLegalPage(deletionHtml, '/privacy');
    assert.match(deletionHtml, /90 days/);
    assert.match(deletionHtml, /60 days/);
    assert.match(deletionHtml, /30 days/);
    assert.doesNotMatch(deletionHtml, /type="password"/);
  } finally { await s.close(); }
});

test('admin forget deletes every stored record for that PSID', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  try {
    await s.post(msg('del-1', { text: 'please keep this until forget' }));
    await s.post(msg('stay-2', { text: 'leave this customer' }));
    const t = s.app.store.thread('del-1');
    t.followupCount = 2;
    t.lastFollowupAt = Date.now();
    s.app.bot.rev.set('del-1', 4);
    s.app.store.addReview({
      id: 'rev-del',
      timestamp: new Date().toISOString(),
      psid: 'del-1',
      psidHash: psidHash('del-1'),
      psidLast4: 'el-1',
      type: 'video',
      url: 'https://cdn.example/del.mp4',
      status: 'new',
    });
    s.app.store.addReview({
      id: 'rev-stay',
      timestamp: new Date().toISOString(),
      psid: 'stay-2',
      psidHash: psidHash('stay-2'),
      type: 'photo',
      url: 'https://cdn.example/stay.jpg',
      status: 'new',
    });
    s.app.store.writeSubscriptions([
      { endpoint: 'https://push.example/del', psid: 'del-1' },
      { endpoint: 'https://push.example/keep' },
    ]);
    const file = path.join(s.app.cfg.dataDir, 'conversations.jsonl');
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(psidHash('del-1')));
    const res = await fetch(`${s.base}/admin/forget?psid=del-1`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.threads, 1);
    assert.equal(body.reviews, 1);
    assert.ok(body.conversations >= 1);
    assert.equal(body.pushSubscriptions, 1);
    assert.equal(body.followups, 1);
    assert.equal(s.app.store.data.threads['del-1'], undefined);
    assert.equal(s.app.store.data.reviews.some((r) => r.psid === 'del-1'), false);
    assert.ok(s.app.store.data.threads['stay-2']);
    assert.ok(s.app.store.data.reviews.some((r) => r.psid === 'stay-2'));
    const left = fs.readFileSync(file, 'utf8');
    assert.equal(left.includes(psidHash('del-1')), false);
    assert.match(left, new RegExp(psidHash('stay-2')));
    assert.equal(s.app.store.readSubscriptions().some((sub) => sub.psid === 'del-1'), false);
    assert.equal(s.app.store.readSubscriptions().some((sub) => sub.endpoint === 'https://push.example/keep'), true);
    assert.equal(s.app.bot.rev.has('del-1'), false);
  } finally { await s.close(); }
});

test('review cards older than 60 days are pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-reviews-'));
  const store = new Store(dir);
  const now = Date.now();
  store.data.reviews = [
    { id: 'old', timestamp: new Date(now - 61 * 86400e3).toISOString(), psid: 'old-1', type: 'video' },
    { id: 'fresh', timestamp: new Date(now - 10 * 86400e3).toISOString(), psid: 'new-1', type: 'photo' },
  ];
  assert.equal(store.purge(90, now), 0);
  assert.deepEqual(store.data.reviews.map((r) => r.id), ['fresh']);
});

function metaSignedRequest(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${sig}.${body}`;
}

test('Meta data-deletion callback deletes the user and shows a confirmation page', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  try {
    await s.post(msg('meta-user-9', { text: 'delete me later' }));
    s.app.store.addReview({
      id: 'rev-meta',
      timestamp: new Date().toISOString(),
      psid: 'meta-user-9',
      psidHash: psidHash('meta-user-9'),
      type: 'video',
      url: 'https://cdn.example/meta.mp4',
      status: 'new',
    });
    const bad = await fetch(`${s.base}/data-deletion-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'signed_request=not-a-real-signature',
    });
    assert.equal(bad.status, 400);
    assert.ok(s.app.store.data.threads['meta-user-9']);

    const signed = metaSignedRequest({
      algorithm: 'HMAC-SHA256',
      user_id: 'meta-user-9',
      issued_at: Math.floor(Date.now() / 1000),
    }, SECRET);
    assert.equal(parseSignedRequest(signed, SECRET).user_id, 'meta-user-9');
    assert.equal(parseSignedRequest(signed, 'wrong-secret'), null);
    const res = await fetch(`${s.base}/data-deletion-callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `signed_request=${encodeURIComponent(signed)}`,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.url, /^https:\/\/jmags-messenger-bot\.onrender\.com\/data-deletion\?code=/);
    assert.equal(body.confirmation_code, new URL(body.url).searchParams.get('code'));
    assert.equal(s.app.store.data.threads['meta-user-9'], undefined);
    assert.equal(s.app.store.data.reviews.some((r) => r.psid === 'meta-user-9'), false);
    const page = await fetch(`${s.base}/data-deletion?code=${body.confirmation_code}`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, new RegExp(body.confirmation_code));
    assert.match(html, /was received/);
    assert.equal(html.includes('meta-user-9'), false);
    const missing = await (await fetch(`${s.base}/data-deletion?code=does-not-exist`)).text();
    assert.match(missing, /could not find confirmation code/i);
    assert.match(missing, /does-not-exist/);
  } finally { await s.close(); }
});

const WELCOME = "Hello, Catherine Welcome sa JMAG's APPLIANCES Service. We're here to help you sa issue ng TV appliances po ninyo. Before we start, Ask ko lang po mga sumusunod for me to help you better.\n\nUnit/Brand:\nUnit Size:\nIssue:\nLocation:";

test('automated Page Inbox echoes (welcome template, follow-up thanks) do not pause the bot', async () => {
  const s = await setup({ LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  try {
    await s.post(msg('cath', { text: 'magkano pagawa tv 65' }));
    assert.equal(s.mock.calls.messages.length, 1);
    s.app.store.thread('cath').lastUserTs -= 5 * 60e3; // template is caught by text, not timing
    await s.post(echo('cath', '263902037430900', WELCOME));
    await s.post(echo('cath', '263902037430900', 'Maraming salamat po.'));
    assert.equal(s.app.store.thread('cath').pausedUntil, 0);
    assert.ok(logged.some((l) => /automated echo/.test(l) && /template/.test(l) && /not pausing/.test(l)));
    assert.ok(logged.some((l) => /automated echo/.test(l) && /follows an automated echo/.test(l)));
    await s.post(msg('cath', { text: 'san pablo laguna' }));
    assert.equal(s.mock.calls.messages.length, 2, 'bot still answers after the automated greeting');
  } finally {
    console.log = orig;
    await s.close();
  }
});

test('Page Inbox echoes seconds after the customer (instant reply / Meta AI burst) do not pause', async () => {
  const s = await setup();
  try {
    await s.post(msg('burst', { text: 'how much mag pagawa ng tv?' }));
    await s.post(echo('burst', '263902037430900', 'Hello, Magandang araw po. Ano po ang brand ng TV at location po nila?'));
    await s.post(echo('burst', '263902037430900', 'Depende po sa issue. Salamat po!'));
    assert.equal(s.app.store.thread('burst').pausedUntil, 0);
    await s.post(msg('burst', { text: 'nonood lng Balita Bigla namatay' }));
    assert.equal(s.mock.calls.messages.length, 2);
  } finally { await s.close(); }
});

test('own-app echoes are ignored; a genuine human echo minutes later still pauses', async () => {
  const s = await setup({ AUTOMATED_ECHO_WINDOW_MS: '10000' });
  try {
    await s.post(msg('ivan', { text: 'hello po' }));
    await s.post(echo('ivan', APP, 'Anong brand po?'));
    assert.equal(s.app.store.thread('ivan').pausedUntil, 0);
    assert.equal(s.app.store.thread('ivan').history.filter((h) => h.content === 'Anong brand po?').length, 0);
    s.app.store.thread('ivan').lastUserTs -= 3 * 60e3;
    await s.post(echo('ivan', '263902037430900', '8500 po all in na'));
    const t = s.app.store.thread('ivan');
    assert.ok(t.pausedUntil > Date.now() + 11 * 3600e3);
    assert.match(t.pauseSource, /human echo/);
    await s.post(msg('ivan', { text: 'sige po' }));
    assert.equal(s.mock.calls.messages.length, 1);
  } finally { await s.close(); }
});

test('human pause auto-expires after HUMAN_IDLE_RESUME_HOURS with no human reply', async () => {
  const s = await setup();
  try {
    s.app.store.thread('idle').lastUserTs = Date.now() - 3600e3;
    await s.post(echo('idle', '263902037430900', 'ako na po'));
    assert.ok(s.app.store.thread('idle').pausedUntil > Date.now());
    s.app.store.thread('idle').lastHumanEchoAt = Date.now() - 2.5 * 3600e3;
    await s.post(msg('idle', { text: 'hello po nandyan pa kayo?' }));
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.app.store.thread('idle').pausedUntil, 0);
    assert.equal(loadConfig({}).humanIdleResumeHours, 2);
    assert.equal(loadConfig({ HUMAN_IDLE_RESUME_HOURS: '0' }).humanIdleResumeHours, 0);
  } finally { await s.close(); }
});

test('startup clears legacy pauses set by automated echoes, keeps real ones; /admin/paused lists them', async () => {
  const s = await setup({ ADMIN_TOKEN: 'adm' });
  try {
    const now = Date.now();
    const start = now - 10 * 60e3;
    const pausedUntil = start + 12 * 3600e3;
    Object.assign(s.app.store.thread('legacy-tpl'), { pausedUntil, history: [
      { role: 'user', content: '2yrs na po', ts: start - 7000 }, { role: 'assistant', content: WELCOME, ts: start },
    ] });
    Object.assign(s.app.store.thread('legacy-fast'), { pausedUntil, history: [
      { role: 'user', content: 'how much?', ts: start - 2000 }, { role: 'assistant', content: 'Depende po sa issue.', ts: start },
    ] });
    Object.assign(s.app.store.thread('legacy-real'), { pausedUntil, history: [
      { role: 'user', content: 'magkano po', ts: start - 5 * 60e3 }, { role: 'assistant', content: '8500 po', ts: start },
    ] });
    const res = await fetch(`${s.base}/admin/paused`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal((await res.json()).length, 3);
    assert.equal((await fetch(`${s.base}/admin/paused`)).status, 403);
    const cleared = s.app.bot.clearAutomatedPauses().sort();
    assert.deepEqual(cleared, ['legacy-fast', 'legacy-tpl']);
    assert.ok(s.app.store.thread('legacy-real').pausedUntil > now);
    const left = await (await fetch(`${s.base}/admin/paused`, { headers: { Authorization: 'Bearer adm' } })).json();
    assert.deepEqual(left.map((r) => r.psid), ['legacy-real']);
    assert.equal(left[0].last4, 'real');
  } finally { await s.close(); }
});

test('video after an automated greeting still gets the standard reply and a dashboard card', async () => {
  const s = await setup();
  try {
    await s.post(msg('vidauto', { text: 'sira tv namin' }));
    await s.post(echo('vidauto', '263902037430900', WELCOME));
    assert.equal(s.app.store.thread('vidauto').pausedUntil, 0);
    await s.post(msg('vidauto', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/auto.mp4' } }] }));
    assert.match(s.mock.calls.messages.at(-1).message.text, /Ipapacheck ko po sa technician/);
    assert.ok(s.app.store.data.reviews.some((r) => r.url === 'https://cdn.example/auto.mp4' && !r.quietNote));
  } finally { await s.close(); }
});

test('isAutomatedEchoText matches saved-reply templates and custom patterns only', () => {
  const { isAutomatedEchoText } = require('../src/bot');
  assert.equal(isAutomatedEchoText(WELCOME), true);
  assert.equal(isAutomatedEchoText('Unit / Brand: Samsung'), true);
  assert.equal(isAutomatedEchoText('8500 po all in'), false);
  assert.equal(isAutomatedEchoText('Maraming salamat po.'), false);
  assert.equal(isAutomatedEchoText('Salamat sa pag message sa JMAG', ['pag message sa jmag']), true);
  assert.equal(isAutomatedEchoText('', []), false);
});

const VIDEO_ASK = "Hello po 😊 Na-review na po ba ni Ivan yung video? Habang hinihintay po, pwede po bang malaman ang brand, size at location ng TV para ma-check namin agad ang schedule?";
const VIDEO_BOOK = "Hello po 😊 Na-review na po ba ni Ivan yung video? Kung okay lang po, pwede na po nating i-book ang home service check-up. Sabihin lang po kung kailan kayo available.";
const VIDEO_ASK_2 = "Hello po ulit 😊 Pasensya na po sa abala. Pag may oras lang po, pwede po bang malaman ang brand, size at location ng TV? Para lang po ma-check namin agad ang schedule.";
const VIDEO_BOOK_2 = "Hello po ulit 😊 Kung gusto niyo na pong ipa-check, pwede po nating i-book ang home service check-up. Sabihin lang po kung kailan kayo available.";
const NOON = Date.parse('2026-10-18T04:00:00Z'); // 12:00 Asia/Manila

test('video follow-up text asks only for missing facts and offers a check-up when they are known', () => {
  const ask = videoFollowupText({ history: [{ role: 'user', content: 'walang display po' }] });
  assert.equal(ask, VIDEO_ASK);
  const book = videoFollowupText({ history: [{ role: 'user', content: 'Samsung 55 inch walang display taga San Pablo Laguna' }] });
  assert.equal(book, VIDEO_BOOK);
  assert.equal(videoFollowupText({ history: [{ role: 'user', content: 'walang display po' }] }, { second: true }), VIDEO_ASK_2);
  assert.equal(videoFollowupText({ history: [{ role: 'user', content: 'Samsung 55 inch walang display taga San Pablo Laguna' }] }, { second: true }), VIDEO_BOOK_2);
  const issueOnly = videoFollowupText({ history: [{ role: 'user', content: 'Samsung 55 inch taga Binan' }] });
  assert.match(issueOnly, /ang issue ng TV/);
  assert.doesNotMatch(`${ask}\n${book}\n${VIDEO_ASK_2}\n${VIDEO_BOOK_2}`, /discount|tawad|promo|slot|₱/i);
  assert.equal(loadConfig({}).videoFollowupMinutes, 30);
  assert.equal(loadConfig({}).videoFollowup2Minutes, 240);
  assert.equal(loadConfig({ VIDEO_FOLLOWUP2_MINUTES: '0' }).videoFollowup2Minutes, 0);
  const night = Date.parse('2026-10-18T13:30:00Z'); // 21:30 Manila
  const morning = quietDeferUntil(night, 'Asia/Manila');
  assert.equal(new Date(morning).toISOString(), '2026-10-18T23:00:00.000Z');
  assert.equal(quietDeferUntil(Date.parse('2026-10-18T23:00:00Z'), 'Asia/Manila'), Date.parse('2026-10-18T23:00:00Z'));
  assert.equal(quietDeferUntil(Date.parse('2026-10-18T22:59:00Z'), 'Asia/Manila'), Date.parse('2026-10-18T23:00:00Z'));
});

test('a quiet customer gets one video follow-up at 30 minutes and a gentler one 4 hours later', async () => {
  const s = await setup({ LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  let now = NOON;
  s.app.bot.now = () => now;
  try {
    await s.post(msg('vidfu', { text: 'walang display po' }, now));
    await s.post(msg('vidfu', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/quiet.mp4' } }] }, now));
    assert.match(s.mock.calls.messages.at(-1).message.text, /Ipapacheck ko po sa technician/);
    assert.equal(s.app.store.thread('vidfu').videoReplyAt, now);
    assert.ok(logged.some((l) => /video follow-up scheduled/.test(l)));
    const before = s.mock.calls.messages.length;
    now = NOON + 29 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, before);
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.at(-1).message.text, VIDEO_ASK);
    assert.equal(s.app.store.thread('vidfu').videoFollowupCount, 1);
    assert.equal(s.app.store.thread('vidfu').awaitingVideo, false);
    assert.ok(logged.some((l) => /video follow-up 1 sent/.test(l)));
    const llmAfter = s.mock.calls.llm.length;
    now = NOON + 120 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.llm.length, llmAfter, 'generic quiet follow-up stays off while the video follow-up is open');
    now = s.app.store.thread('vidfu').videoFollowupAt + 240 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.at(-1).message.text, VIDEO_ASK_2);
    assert.equal(s.app.store.thread('vidfu').videoFollowupCount, 2);
    const capped = s.mock.calls.messages.length;
    now += 240 * 60 * 1000;
    s.app.store.thread('vidfu').lastUserTs = now;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, capped);
  } finally {
    console.log = orig;
    await s.close();
  }
});

test('video follow-up offers a check-up when brand, size, issue, and location are known', async () => {
  const s = await setup();
  let now = NOON;
  s.app.bot.now = () => now;
  try {
    await s.post(msg('known', { text: 'Samsung 55 inch walang display taga San Pablo Laguna' }, now));
    await s.post(msg('known', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/known.mp4' } }] }, now));
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.at(-1).message.text, VIDEO_BOOK);
  } finally { await s.close(); }
});

test('video follow-up survives a restart and the second nudge can be disabled', async () => {
  const s = await setup({ VIDEO_FOLLOWUP2_MINUTES: '0' });
  let now = NOON;
  s.app.bot.now = () => now;
  try {
    await s.post(msg('restart', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/re.mp4' } }] }, now));
    s.app.store.flush();
    now = NOON + 30 * 60 * 1000;
    const store2 = new Store(s.app.cfg.dataDir, { historyTurns: 20 });
    const bot2 = new Bot({
      cfg: s.app.cfg, store: store2, graph: s.app.graph, llm: s.app.llm, log: s.app.log, push: s.app.push, now: () => now,
    });
    const before = s.mock.calls.messages.length;
    await bot2.checkFollowups();
    assert.equal(s.mock.calls.messages.length, before + 1);
    assert.match(s.mock.calls.messages.at(-1).message.text, /Na-review na po ba ni Ivan yung video/);
    assert.equal(store2.thread('restart').videoFollowupCount, 1);
    now += 240 * 60 * 1000;
    store2.thread('restart').lastUserTs = NOON;
    await bot2.checkFollowups();
    assert.equal(s.mock.calls.messages.length, before + 1);
  } finally { await s.close(); }
});

test('video follow-up is cancelled when the customer replies, Ivan pauses, the bot is off, or the thread is handed off or on standby', async () => {
  const s = await setup({ LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  let now = NOON;
  s.app.bot.now = () => now;
  const video = (psid) => s.post(msg(psid, { attachments: [{ type: 'video', payload: { url: `https://cdn.example/${psid}.mp4` } }] }, now));
  try {
    await video('reply');
    now = NOON + 10 * 60 * 1000;
    await s.post(msg('reply', { text: 'Samsung 55 po' }, now));
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.app.store.thread('reply').videoReplyAt, 0);
    assert.ok(logged.some((l) => /video follow-up skipped/.test(l) && /customer replied/.test(l)));
    assert.equal(s.mock.calls.messages.filter((m) => /Na-review na po ba/.test(m.message.text)).length, 0);

    now = NOON;
    await video('ivan');
    now = NOON + 20 * 60 * 1000;
    s.app.store.thread('ivan').lastUserTs = Date.now() - 60e3;
    await s.post(echo('ivan', '263902037430900', 'ako na po dito'));
    assert.equal(s.app.store.thread('ivan').videoReplyAt, 0);
    assert.ok(logged.some((l) => /video follow-up skipped/.test(l) && /paused for a human/.test(l)));

    now = NOON;
    await video('off');
    s.app.cfg.botEnabled = false;
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.app.store.thread('off').videoReplyAt, 0);
    s.app.cfg.botEnabled = true;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.filter((m) => m.recipient && m.recipient.id === 'off' && /Na-review na po ba/.test(m.message.text)).length, 0);

    now = NOON;
    await video('hand');
    s.app.store.thread('hand').handedOff = true;
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.app.store.thread('hand').videoReplyAt, 0);
    assert.ok(logged.some((l) => /handed to Ivan/.test(l)));

    now = NOON;
    await video('stand');
    s.app.store.thread('stand').standby = true;
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.app.store.thread('stand').videoReplyAt, 0);
    assert.ok(logged.some((l) => /standby, another app owns the thread/.test(l)));
  } finally {
    console.log = orig;
    await s.close(); }
});

test('video follow-up waits until 7 AM Manila and is dropped when that is outside the 24h window', async () => {
  const s = await setup({ LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  let now = Date.parse('2026-10-18T13:00:00Z'); // 21:00 Manila
  s.app.bot.now = () => now;
  try {
    await s.post(msg('night', { text: 'walang display po' }, now));
    await s.post(msg('night', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/night.mp4' } }] }, now));
    const n = s.mock.calls.messages.length;
    now = Date.parse('2026-10-18T13:30:00Z');
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, n);
    assert.ok(logged.some((l) => /deferred/.test(l) && /07:00 Asia\/Manila/.test(l)));
    now = Date.parse('2026-10-18T23:00:00Z'); // 07:00 Manila
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.at(-1).message.text, VIDEO_ASK);

    now = Date.parse('2026-10-17T14:00:00Z'); // 22:00 Manila
    await s.post(msg('late', { attachments: [{ type: 'video', payload: { url: 'https://cdn.example/late.mp4' } }] }, now));
    const lateCount = s.mock.calls.messages.length;
    now = Date.parse('2026-10-18T13:00:00Z'); // next 21:00, 7 AM would miss the window
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, lateCount);
    assert.equal(s.app.store.thread('late').videoReplyAt, 0);
    assert.ok(logged.some((l) => /quiet hours past the 24h window/.test(l)));
  } finally {
    console.log = orig;
    await s.close();
  }
});

test('a photo does not schedule a video follow-up', async () => {
  const s = await setup();
  let now = NOON;
  s.app.bot.now = () => now;
  try {
    await s.post(msg('pic', { attachments: [{ type: 'image', payload: { url: 'https://cdn.example/pic.jpg' } }] }, now));
    assert.equal(s.app.store.thread('pic').videoReplyAt, 0);
    const n = s.mock.calls.messages.length;
    now = NOON + 30 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, n);
  } finally { await s.close(); }
});

test('dashboard reply sends inside 24h, pauses the bot, and ignores a double-tap or our own echo', async () => {
  const s = await setup({ DASHBOARD_PASSWORD: 'secret', ADMIN_TOKEN: 'adm', LOG_LEVEL: 'info' });
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.map(String).join(' '));
  const now = NOON;
  s.app.bot.now = () => now;
  const price = '8500 po all in';
  try {
    await s.post(msg('dash-reply', {
      text: 'Samsung 55 inch walang display taga Binan',
      attachments: [{ type: 'video', payload: { url: 'https://cdn.example/reply-box.mp4' } }],
    }, now));
    const review = s.app.store.data.reviews[0];
    assert.ok(review.videoReplyAt === undefined);
    assert.ok(s.app.store.thread('dash-reply').videoReplyAt);
    const { cookie } = await dashCookie(s.base);
    const replyUrl = `${s.base}/dashboard/api/reply`;
    const threadsUrl = `${s.base}/dashboard/api/threads`;
    const payload = JSON.stringify({ id: review.id, text: price });
    const denied = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(denied.status, 403);
    assert.equal((await fetch(threadsUrl)).status, 403);
    assert.equal(s.mock.calls.messages.some((m) => m.message && m.message.text === price), false);

    const late = s.app.store.thread('dash-reply');
    const savedLast = late.lastUserTs;
    late.lastUserTs = now - 25 * 3600 * 1000;
    const closed = await fetch(replyUrl, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(closed.status, 409);
    assert.equal((await closed.json()).error, 'Lampas na sa 24 oras, i-reply sa Business Suite');
    assert.equal(s.mock.calls.messages.some((m) => m.message && m.message.text === price), false);
    assert.equal(late.pausedUntil, 0);
    late.lastUserTs = savedLast;

    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const [a, b] = await Promise.all([
      fetch(replyUrl, { method: 'POST', headers, body: payload }),
      fetch(replyUrl, { method: 'POST', headers, body: payload }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const sent = s.mock.calls.messages.filter((m) => m.message && m.message.text === price);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].messaging_type, 'RESPONSE');
    assert.equal(sent[0].tag, undefined);
    assert.equal(sent[0].recipient.id, 'dash-reply');
    assert.equal(sent[0].message.metadata, 'jmags-ivan');
    const again = await fetch(replyUrl, { method: 'POST', headers, body: payload });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    assert.equal(s.mock.calls.messages.filter((m) => m.message && m.message.text === price).length, 1);

    const t = s.app.store.thread('dash-reply');
    assert.equal(t.videoReplyAt, 0);
    assert.equal(t.pauseSource, 'dashboard reply');
    assert.equal(t.pausedUntil, now + 12 * 3600 * 1000);
    assert.equal(t.lastHumanEchoAt, now);
    assert.equal(s.app.bot.humanPaused(t, now), true);
    assert.equal(s.app.bot.humanPaused(t, now + (2 * 3600 * 1000) + 1000), false);
    t.pausedUntil = now + 12 * 3600 * 1000;
    t.lastHumanEchoAt = now;
    t.pauseSource = 'dashboard reply';
    const ivanLines = t.history.filter((h) => h.content === price);
    assert.equal(ivanLines.length, 1);
    assert.equal(ivanLines[0].via, 'ivan');
    assert.equal(review.ivanRepliedAt, new Date(now).toISOString());
    assert.ok(logged.some((l) => /dashboard reply to/.test(l) && /paused/.test(l)));
    assert.ok(logged.some((l) => /video follow-up skipped/.test(l) && /Ivan replied from the dashboard/.test(l)));

    const echoMid = s.app.store.data.seenMids.at(-1);
    await s.post({
      object: 'page',
      entry: [{ id: PAGE, time: now, messaging: [{ sender: { id: PAGE }, recipient: { id: 'dash-reply' }, timestamp: now, message: { is_echo: true, mid: echoMid, text: price, app_id: APP } }] }],
    });
    await s.post({
      object: 'page',
      entry: [{ id: PAGE, time: now, messaging: [{ sender: { id: PAGE }, recipient: { id: 'dash-reply' }, timestamp: now, message: { is_echo: true, mid: echoMid, text: price } }] }],
    });
    assert.equal(s.app.store.thread('dash-reply').history.filter((h) => h.content === price).length, 1);
    assert.equal(s.app.store.thread('dash-reply').pauseSource, 'dashboard reply');

    await s.post(msg('dash-reply', { text: 'sige po bukas' }, now + 1000));
    const threads = await (await fetch(threadsUrl, { headers: { Cookie: cookie } })).json();
    assert.equal(JSON.stringify(threads).includes('dash-reply'), false);
    const card = threads.cards.find((c) => c.id === review.id);
    assert.equal(card.ivanReplied, true);
    assert.ok(card.messages.some((m) => m.who === 'Customer' && /sige po bukas/.test(m.text)));
    assert.ok(card.messages.some((m) => m.who === 'Ivan' && m.text === price));
    assert.ok(card.messages.length <= 10);

    const huge = await fetch(replyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: review.id, text: 'x'.repeat(2001) }),
    });
    assert.equal(huge.status, 400);
    assert.match((await huge.json()).error, /2000/);
    assert.equal(s.mock.calls.messages.filter((m) => m.message && m.message.text && m.message.text.length > 2000).length, 0);

    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(html, /Sinagot ni Ivan/);
    assert.match(html, /sige po bukas/);
    assert.match(html, /8500 po all in/);
  } finally {
    console.log = orig;
    await s.close();
  }
});
