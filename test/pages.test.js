'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { loadConfig } = require('../src/config');
const { KNOWN_CAVITE_PAGE_ID, withPage } = require('../src/pages');
const booking = require('../src/booking');

const SECRET = 'test_app_secret';
const MAIN = '102622881557025';
const CAVITE = KNOWN_CAVITE_PAGE_ID;
const NOW = Date.parse('2026-11-04T12:00:00Z');

function sign(raw, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

async function setup(extraEnv = {}) {
  const mock = await startMock();
  const env = {
    PORT: '0', VERIFY_TOKEN: 'verify_me', APP_SECRET: SECRET, APP_ID: '999000111',
    PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_TOKEN',
    CAVITE_PAGE_ID: CAVITE, CAVITE_PAGE_ACCESS_TOKEN: 'CAVITE_TOKEN',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'mock-model',
    BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0', LOG_LEVEL: 'silent',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-pages-')),
    ...extraEnv,
  };
  const app = build(env);
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const postEntry = async (entry) => {
    const raw = JSON.stringify({ object: 'page', entry: Array.isArray(entry) ? entry : [entry] });
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return res;
  };
  const entry = (pageId, psid, message, ts = Date.now()) => ({
    id: pageId,
    time: ts,
    messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: ts, message: { mid: `p.${++n}`, ...message } }],
  });
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, mock, postEntry, entry, close };
}

function texts(thread) {
  return (thread && thread.history || []).map((h) => h.content).join('\n');
}

test('config keeps PAGE_ID and PAGE_ACCESS_TOKEN, and reads Cavite or PAGES', () => {
  const bare = loadConfig({ PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_TOKEN' });
  assert.equal(bare.pageId, MAIN);
  assert.equal(bare.pageAccessToken, 'MAIN_TOKEN');
  const cav = bare.pages.find((p) => p.key === 'cavite');
  assert.equal(cav.id, CAVITE);
  assert.equal(cav.token, '');
  assert.equal(cav.defaultBranch, 'Cavite');
  assert.equal(bare.pages.find((p) => p.primary).token, 'MAIN_TOKEN');

  const set = loadConfig({
    PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_TOKEN',
    CAVITE_PAGE_ID: CAVITE, CAVITE_PAGE_ACCESS_TOKEN: 'CAVITE_TOKEN',
  });
  assert.equal(set.pages.find((p) => p.key === 'cavite').token, 'CAVITE_TOKEN');

  const fromJson = loadConfig({
    PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_TOKEN',
    PAGES: JSON.stringify([{ id: CAVITE, token: 'FROM_JSON', name: "Jmag's Appliances Cavite", defaultBranch: 'Cavite' }]),
  });
  assert.equal(fromJson.pageAccessToken, 'MAIN_TOKEN');
  assert.equal(fromJson.pages.find((p) => p.id === CAVITE).token, 'FROM_JSON');
  assert.equal(fromJson.pages.find((p) => p.id === CAVITE).defaultBranch, 'Cavite');
});

test('webhook entry.id picks the Page token; the same PSID does not share a thread', async () => {
  const s = await setup();
  s.mock.state.llmResponder = (body) => {
    const last = body.messages.at(-1).content;
    return `reply:${last}`;
  };
  try {
    const ts = Date.now();
    const res = await s.postEntry([
      s.entry(MAIN, 'same', { text: 'main-only hello' }, ts),
      s.entry(CAVITE, 'same', { text: 'cavite-only hello' }, ts + 1),
    ]);
    assert.equal(res.status, 200);
    const mainThread = s.app.store.data.threads.same;
    const cavThread = s.app.store.data.threads[`${CAVITE}:same`];
    assert.ok(mainThread);
    assert.ok(cavThread);
    assert.match(texts(mainThread), /main-only hello/);
    assert.doesNotMatch(texts(mainThread), /cavite-only/);
    assert.match(texts(cavThread), /cavite-only hello/);
    assert.doesNotMatch(texts(cavThread), /main-only/);
    assert.equal(mainThread.pageId, MAIN);
    assert.equal(cavThread.pageId, CAVITE);
    assert.equal(cavThread.psid, 'same');

    const mainSends = s.mock.calls.pages.filter((p) => p.kind === 'message' && p.path.includes(`/${MAIN}/`));
    const cavSends = s.mock.calls.pages.filter((p) => p.kind === 'message' && p.path.includes(`/${CAVITE}/`));
    assert.ok(mainSends.length >= 1);
    assert.ok(cavSends.length >= 1);
    assert.ok(mainSends.every((p) => p.token === 'MAIN_TOKEN'));
    assert.ok(cavSends.every((p) => p.token === 'CAVITE_TOKEN'));
    assert.equal(s.mock.calls.messages.filter((m) => m.recipient.id === 'same').length, 2);
  } finally { await s.close(); }
});

test('labels, handover, and follow-ups use the Page that owns the chat', async () => {
  const s = await setup({ NEEDS_IVAN_LABEL: 'Needs Ivan' });
  s.mock.state.llmResponder = (body) => {
    const sys = body.messages.map((m) => m.content).join('\n');
    if (/Write ONE short human Taglish follow-up/.test(sys)) return 'FOLLOWUP-LINE po';
    return 'ok po';
  };
  try {
    await s.postEntry(s.entry(CAVITE, 'pic', { attachments: [{ type: 'image', payload: { url: 'https://example.com/a.jpg' } }] }));
    const labelCalls = s.mock.calls.pages.filter((p) => p.kind === 'labels' || p.kind === 'label');
    assert.ok(labelCalls.length >= 1);
    assert.ok(labelCalls.every((p) => p.token === 'CAVITE_TOKEN'));
    assert.ok(s.mock.calls.pages.some((p) => p.kind === 'labels' && p.token === 'CAVITE_TOKEN' && p.path.includes(`/${CAVITE}/custom_labels`)));

    await s.postEntry(s.entry(CAVITE, 'hand', { text: 'tao po' }));
    const passes = s.mock.calls.pages.filter((p) => p.kind === 'pass');
    assert.equal(passes.length, 1);
    assert.equal(passes[0].token, 'CAVITE_TOKEN');
    assert.match(passes[0].path, new RegExp(`/${CAVITE}/pass_thread_control`));
    assert.equal(s.app.store.data.threads[`${CAVITE}:hand`].handedOff, true);
    assert.equal(s.app.store.data.threads.hand, undefined);

    await s.postEntry(s.entry(MAIN, 'hand', { text: 'tao po' }));
    const mainPass = s.mock.calls.pages.filter((p) => p.kind === 'pass' && p.token === 'MAIN_TOKEN');
    assert.equal(mainPass.length, 1);
    assert.match(mainPass[0].path, new RegExp(`/${MAIN}/pass_thread_control`));

    const mainPage = s.app.cfg.pages.find((p) => p.primary);
    const cavPage = s.app.cfg.pages.find((p) => p.key === 'cavite');
    let now = Date.now();
    s.app.bot.now = () => now;
    const seed = (page, psid) => withPage(page, () => {
      const t = s.app.store.thread(psid);
      t.history = [
        { role: 'user', content: 'hm po', ts: now },
        { role: 'assistant', content: 'Taga saan po?', ts: now },
      ];
      t.lastUserTs = now;
      t.handedOff = false;
    });
    seed(mainPage, 'fu-main');
    seed(cavPage, 'fu-cav');
    s.app.store.data.threads[`${CAVITE}:pic`].followupCount = 2;
    now += 121 * 60 * 1000;
    const before = s.mock.calls.pages.length;
    await s.app.bot.checkFollowups();
    await s.app.bot.checkFollowups();
    const added = s.mock.calls.pages.slice(before);
    assert.equal(s.mock.calls.messages.filter((m) => /FOLLOWUP-LINE/.test(m.message.text)).length, 2);
    assert.ok(added.some((p) => p.kind === 'message' && p.token === 'MAIN_TOKEN' && p.path.includes(`/${MAIN}/messages`)));
    assert.ok(added.some((p) => p.kind === 'message' && p.token === 'CAVITE_TOKEN' && p.path.includes(`/${CAVITE}/messages`)));
    assert.equal(s.app.store.thread('fu-main').followupCount, 1);
    assert.equal(s.app.store.data.threads[`${CAVITE}:fu-cav`].followupCount, 1);
    assert.equal(s.app.store.data.threads['fu-cav'], undefined);
  } finally { await s.close(); }
});

test('Cavite messages are ignored when the Cavite token is unset, and unknown pages are ignored', async () => {
  const s = await setup({ CAVITE_PAGE_ACCESS_TOKEN: '' });
  s.mock.state.llmResponder = () => 'main reply po';
  try {
    await s.postEntry(s.entry(CAVITE, 'quiet', { text: 'cavite but no token' }));
    await s.postEntry(s.entry('999000111222', 'quiet', { text: 'unknown page' }));
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.mock.calls.pages.length, 0);
    assert.equal(s.app.store.data.threads[`${CAVITE}:quiet`], undefined);
    assert.equal(s.app.store.data.threads.quiet, undefined);
    await s.postEntry(s.entry(MAIN, 'quiet', { text: 'main still works' }));
    assert.equal(s.mock.calls.messages.length, 1);
    assert.ok(s.mock.calls.pages.every((p) => p.token === 'MAIN_TOKEN'));
    assert.match(texts(s.app.store.data.threads.quiet), /main still works/);
  } finally { await s.close(); }
});

test('Cavite Page bookings use Cavite; the main Page still routes by location', async () => {
  const cav = { history: [] };
  const cfg = { defaultBranch: 'Cavite' };
  await booking.bookingTurn(cav, 'pa book po', { now: NOW, cfg });
  await booking.bookingTurn(cav, 'Ana Cruz', { now: NOW, cfg });
  await booking.bookingTurn(cav, '09171234567', { now: NOW, cfg });
  await booking.bookingTurn(cav, 'Brgy San Jose, Calamba, Laguna', { now: NOW, cfg });
  assert.equal(cav.booking.fields.branch, 'Cavite');
  assert.equal(cav.booking.fields.province, 'Laguna');
  assert.equal(cav.booking.fields.city, 'Calamba');

  const main = { history: [] };
  await booking.bookingTurn(main, 'pa book po', { now: NOW, cfg: {} });
  await booking.bookingTurn(main, 'Ana Cruz', { now: NOW, cfg: {} });
  await booking.bookingTurn(main, '09171234567', { now: NOW, cfg: {} });
  await booking.bookingTurn(main, 'Brgy San Jose, Calamba, Laguna', { now: NOW, cfg: {} });
  assert.equal(main.booking.fields.branch, 'San Pablo');
  assert.equal(main.booking.fields.city, 'Calamba');

  const s = await setup({ BOOKING_AGENT_ENABLED: 'true' });
  try {
    const say = async (pageId, text) => {
      await s.postEntry(s.entry(pageId, pageId === CAVITE ? 'book-c' : 'book-m', { text }));
    };
    await say(CAVITE, 'pa book po');
    await say(CAVITE, 'Pedro Penduko');
    await say(CAVITE, '09175550000');
    await say(CAVITE, 'Brgy San Jose, Calamba, Laguna');
    const cavThread = s.app.store.data.threads[`${CAVITE}:book-c`];
    assert.equal(cavThread.booking.fields.branch, 'Cavite');
    assert.equal(cavThread.booking.fields.province, 'Laguna');
    await say(MAIN, 'pa book po');
    await say(MAIN, 'Pedro Penduko');
    await say(MAIN, '09175550000');
    await say(MAIN, 'Brgy San Jose, Calamba, Laguna');
    assert.equal(s.app.store.data.threads['book-m'].booking.fields.branch, 'San Pablo');
    const cavSends = s.mock.calls.pages.filter((p) => p.kind === 'message' && p.path.includes(`/${CAVITE}/`));
    assert.ok(cavSends.length >= 1);
    assert.ok(cavSends.every((p) => p.token === 'CAVITE_TOKEN'));
  } finally { await s.close(); }
});
