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
const { CAVITE_PAGE_ID, CAVITE_PROFILE_ID, withPage } = require('../src/pages');
const { PageSwitches } = require('../src/page-switches');

const SECRET = 'test_app_secret';
const MAIN = '102622881557025';
const mainPage = { id: MAIN, key: 'main', primary: true };
const cavitePage = { id: CAVITE_PAGE_ID, key: 'cavite', defaultBranch: 'Cavite' };

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

async function setup(extraEnv = {}) {
  const mock = await startMock();
  const env = {
    PORT: '0', VERIFY_TOKEN: 'verify_me', APP_SECRET: SECRET, APP_ID: '999000111',
    PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'MAIN_TOKEN',
    CAVITE_PAGE_ID: CAVITE_PAGE_ID, CAVITE_PAGE_ACCESS_TOKEN: 'CAVITE_TOKEN',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'sk-test', LLM_MODEL: 'mock-model',
    BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0', LOG_LEVEL: 'silent', PAGE_SWITCH_CACHE_MS: '0',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-switch-')),
    ...extraEnv,
  };
  const app = build(env);
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const post = async (pageId, psid, text) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: pageId, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: ts, message: { mid: `sw.${n}`, text } }] }],
    });
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return res;
  };
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, mock, post, close };
}

test('migration creates bot_switches off, and only authenticated users can update', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261104124600_bot_switches.sql'), 'utf8');
  assert.match(sql, /create table if not exists public\.bot_switches/);
  assert.match(sql, /page_key text primary key/);
  assert.match(sql, /enabled boolean not null default false/);
  assert.match(sql, /updated_at timestamptz not null default now\(\)/);
  assert.match(sql, /\('sanpablo', false\), \('cavite', false\)/);
  assert.match(sql, /on conflict \(page_key\) do nothing/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /for select\s+to authenticated/i);
  assert.match(sql, /for update\s+to authenticated/i);
  assert.doesNotMatch(sql, /for update\s+to anon/i);
  assert.equal(loadConfig({}).pageSwitchCacheMs, 15000);
  assert.equal(loadConfig({}).supabaseUrl, '');
});

test('a failed or missing switch read is off, and a good read is cached for 15 seconds', async () => {
  const closed = new PageSwitches({ supabaseUrl: '', supabaseServiceRoleKey: '' });
  assert.equal(await closed.enabled(mainPage), false);
  assert.equal((await closed.stateFor(cavitePage)).ok, false);

  const down = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: 'svc',
  }, { fetchImpl: async () => { throw new Error('network'); } });
  assert.equal(await down.enabled(mainPage), false);

  const http = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: 'svc',
  }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal((await http.stateFor(mainPage)).ok, false);

  let now = 0;
  let reads = 0;
  let seen;
  const sw = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: 'svc-key',
    pageSwitchCacheMs: 15000,
  }, {
    now: () => now,
    fetchImpl: async (url, opts) => {
      reads += 1;
      seen = { url, opts };
      const enabled = reads === 1;
      return { ok: true, json: async () => [{ page_key: 'sanpablo', enabled }, { page_key: 'cavite', enabled: false }] };
    },
  });
  assert.equal(await sw.enabled(mainPage), true);
  assert.equal(await sw.enabled(cavitePage), false);
  assert.equal(reads, 1);
  now = 14999;
  assert.equal(await sw.enabled(mainPage), true);
  assert.equal(reads, 1);
  now = 15000;
  assert.equal(await sw.enabled(mainPage), false);
  assert.equal(reads, 2);
  assert.equal(seen.url, 'https://fhjarnogglakehaztbbj.supabase.co/rest/v1/bot_switches?select=page_key,enabled');
  assert.equal(seen.opts.headers.apikey, 'svc-key');
  assert.equal(seen.opts.headers.Authorization, 'Bearer svc-key');

  const fuzzy = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: 'svc',
  }, { fetchImpl: async () => ({ ok: true, json: async () => [{ page_key: 'sanpablo', enabled: 'true' }] }) });
  assert.equal(await fuzzy.enabled(mainPage), false);
});

test('an off Page stays silent and logged; the other Page still replies', async () => {
  const s = await setup();
  s.mock.state.botSwitches = [
    { page_key: 'sanpablo', enabled: true },
    { page_key: 'cavite', enabled: false },
  ];
  s.mock.state.llmResponder = () => 'Sige po sir.';
  try {
    await s.post(MAIN, 'sp-1', 'hello from san pablo');
    await s.post(CAVITE_PAGE_ID, 'cv-1', 'hello from cavite');
    await s.post(CAVITE_PROFILE_ID, 'cv-profile', 'hello from the cavite profile id');
    const recipients = s.mock.calls.messages.map((m) => m.recipient.id);
    assert.deepEqual(recipients, ['sp-1']);
    assert.equal(s.app.store.data.threads['cv-1'], undefined);
    const cavThread = s.app.store.data.threads[`${CAVITE_PAGE_ID}:cv-1`];
    assert.match(cavThread.history.map((h) => h.content).join('\n'), /hello from cavite/);
    assert.equal(cavThread.history.some((h) => h.role === 'assistant'), false);
    assert.equal(s.mock.calls.llm.length, 1);
    const cavSends = s.mock.calls.pages.filter((p) => p.path.includes(`/${CAVITE_PAGE_ID}/`) && p.token === 'CAVITE_TOKEN');
    assert.equal(cavSends.length, 0);
  } finally { await s.close(); }
});

test('Cavite profile id uses the Cavite switch and the Cavite Page token', async () => {
  const s = await setup();
  s.mock.state.botSwitches = [
    { page_key: 'sanpablo', enabled: false },
    { page_key: 'cavite', enabled: true },
  ];
  s.mock.state.llmResponder = () => 'Cavite po.';
  try {
    await s.post(CAVITE_PROFILE_ID, 'via-profile', 'pa check po');
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].recipient.id, 'via-profile');
    assert.ok(s.mock.calls.pages.some((p) => p.token === 'CAVITE_TOKEN' && p.path.includes(`/${CAVITE_PAGE_ID}/messages`)));
    assert.equal(s.mock.calls.pages.some((p) => p.token === 'MAIN_TOKEN' && p.kind === 'message'), false);
  } finally { await s.close(); }
});

test('BOT_ENABLED and BOT_TEST_PSIDS still override a Page that is switched on', async () => {
  const off = await setup({ BOT_ENABLED: 'false' });
  off.mock.state.botSwitches = [
    { page_key: 'sanpablo', enabled: true },
    { page_key: 'cavite', enabled: true },
  ];
  const allow = await setup({ BOT_TEST_PSIDS: 'only-me' });
  allow.mock.state.llmResponder = () => 'Allowed po.';
  try {
    await off.post(MAIN, 'nobody', 'hello');
    assert.equal(off.mock.calls.messages.length, 0);
    await allow.post(MAIN, 'stranger', 'hello');
    await allow.post(MAIN, 'only-me', 'hello');
    assert.deepEqual(allow.mock.calls.messages.map((m) => m.recipient.id), ['only-me']);
  } finally {
    await off.close();
    await allow.close();
  }
});

test('an unreadable switch stays silent, including follow-ups', async () => {
  const s = await setup({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
  s.mock.state.llmResponder = () => 'Should not send.';
  try {
    await s.post(MAIN, 'quiet', 'hello po');
    assert.equal(s.mock.calls.messages.length, 0);
    assert.match(s.app.store.thread('quiet').history.map((h) => h.content).join('\n'), /hello po/);
    const page = s.app.cfg.pages.find((p) => p.primary);
    let now = Date.now();
    s.app.bot.now = () => now;
    withPage(page, () => {
      const t = s.app.store.thread('fu-off');
      t.history = [
        { role: 'user', content: 'hm po', ts: now },
        { role: 'assistant', content: 'Taga saan po?', ts: now },
      ];
      t.lastUserTs = now;
    });
    now += 121 * 60 * 1000;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.app.store.thread('fu-off').followupCount || 0, 0);
  } finally { await s.close(); }
});

test('HTTP failure from Supabase is off until the cache expires', async () => {
  const s = await setup({ PAGE_SWITCH_CACHE_MS: '15000' });
  s.mock.state.switchFail = true;
  s.mock.state.llmResponder = () => 'Nope.';
  try {
    await s.post(MAIN, 'down', 'hello');
    assert.equal(s.mock.calls.messages.length, 0);
    s.mock.state.switchFail = false;
    await s.post(MAIN, 'down', 'hello again');
    assert.equal(s.mock.calls.messages.length, 0, 'the failed read stays cached');
  } finally { await s.close(); }
});
