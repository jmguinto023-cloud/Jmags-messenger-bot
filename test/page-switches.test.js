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
const { PageSwitches, isJwt } = require('../src/page-switches');

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
  const post = async (pageId, psid, text, attachments = [], extraMessage = {}) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: pageId, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: ts, message: { mid: `sw.${n}`, text, attachments, ...extraMessage } }] }],
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

test('standalone main greeting runs once for concurrent first messages even with AI off', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.mock.state.conversations = { fresh: { id: 'new-chat' }, old: { id: 'old-chat' } };
    const row = (id, sender) => ({ id, from: { id: sender } });
    s.mock.state.threadMessages = {
      'new-chat': [row('sw.2', 'fresh'), row('sw.1', 'fresh')],
      'old-chat': [row('sw.4', 'old'), row('previous', 'old')],
    };
    await Promise.all([s.post(MAIN, 'fresh', 'Hi'), s.post(MAIN, 'fresh', 'Samsung TV')]);
    await s.post(MAIN, 'fresh', 'Still here');
    await s.post(MAIN, 'old', 'Returning customer');
    await s.post(CAVITE_PAGE_ID, 'other', 'Hi');
    await s.post(MAIN, 'fresh', 'Magkano po?');
    assert.equal(s.mock.calls.messages.length, 2);
    assert.deepEqual(s.mock.calls.messages.map(m => m.recipient.id), ['fresh', 'fresh']);
    assert.equal(s.mock.calls.messages[1].message.text, require('../src/inquiry-reminder').REMINDER);
    assert.match(s.mock.calls.messages[0].message.text, /VIDEO ng ACTUAL issue/);
    assert.match(s.mock.calls.messages[0].message.text, /➡️ TAGASAAN PO SILA\?:/);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('first-time click-to-Messenger ad lead receives same intake despite Page auto reply', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const row = (id, sender) => ({ id, from: { id: sender } });
    s.mock.state.conversations = {
      'ad-new': { id: 'ad-new-chat' },
      'ad-return': { id: 'ad-return-chat' },
    };
    s.mock.state.threadMessages = {
      'ad-new-chat': [row('page-auto', MAIN), row('sw.1', 'ad-new'), row('page-before', MAIN)],
      'ad-return-chat': [row('sw.2', 'ad-return'), row('older', 'ad-return')],
    };
    s.app.store.addTurn('ad-new', 'assistant', 'Welcome from the Page', Date.now());
    const referral = { source: 'ADS', type: 'OPEN_THREAD', ad_id: '1234567890' };
    await s.post(MAIN, 'ad-new',
      '42 inches Frestiz may guhit at itim sa harap Alabang', [], { referral });
    await s.post(MAIN, 'ad-return', 'Magkano repair po?', [], { referral });
    await s.post(CAVITE_PAGE_ID, 'cavite-ad', '42 inches may lines', [], { referral });
    await s.post(MAIN, 'ad-new', 'Frestiz 42 panel issue repeated', [], { referral });
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].recipient.id, 'ad-new');
    assert.match(s.mock.calls.messages[0].message.text, /VIDEO ng ACTUAL issue/);
    assert.match(s.mock.calls.messages[0].message.text, /➡️ TAGASAAN PO SILA\?:/);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('initial click-to-Messenger ad postback sends intake once, referral-only tap does not', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const row = (id, sender) => ({ id, from: { id: sender } });
    s.mock.state.conversations = {
      'ad-start': { id: 'ad-postback-chat' },
      'returning-start': { id: 'ad-old-postback-chat' },
    };
    s.mock.state.threadMessages = {
      'ad-postback-chat': [row('page-welcome', MAIN)],
      'ad-old-postback-chat': [row('historic-question', 'returning-start')],
    };
    const event = (psid, data) => ({
      sender: { id: psid }, recipient: { id: MAIN }, timestamp: Date.now(), ...data,
    });
    const postWebhook = async (list) => {
      s.app.bot.handleWebhook({ object: 'page', entry: [{ id: MAIN, messaging: list }] });
      await s.app.bot.idle();
    };
    const referral = { source: 'ADS', ad_id: 'ad-101', type: 'OPEN_THREAD' };
    await postWebhook([event('ad-start', { referral })]);
    assert.equal(s.mock.calls.messages.length, 0, 'opening ad thread alone sends nothing');
    await postWebhook([event('ad-start', { postback: { title: 'Get Started', payload: 'GET_STARTED', referral } })]);
    await postWebhook([event('ad-start', { postback: { title: 'Get Started', payload: 'GET_STARTED', referral } })]);
    await postWebhook([event('returning-start', { postback: { title: 'Get Started', payload: 'GET_STARTED', referral } })]);
    assert.deepEqual(s.mock.calls.messages.map(x => x.recipient.id), ['ad-start']);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('an old Messenger or Facebook ad customer gets a fresh welcome, but a recent repeat does not', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const old = new Date(Date.now() - 70 * 86400e3).toISOString();
    const recent = new Date(Date.now() - 2 * 86400e3).toISOString();
    const row = (id, from, created_time) => ({ id, from: { id: from }, ...(created_time ? { created_time } : {}) });
    s.mock.state.conversations = {
      old: { id: 'old-customer-chat' }, ad: { id: 'old-ad-chat' }, recent: { id: 'recent-customer-chat' },
    };
    s.mock.state.threadMessages = {
      'old-customer-chat': [row('sw.1', 'old'), row('old-jan', 'old', old)],
      'old-ad-chat': [row('page-welcome', MAIN), row('sw.2', 'ad'), row('ad-old', 'ad', old)],
      'recent-customer-chat': [row('sw.3', 'recent'), row('yesterday', 'recent', recent)],
    };
    await s.post(MAIN, 'old', 'Magkano po parepair sa TV?');
    await s.post(MAIN, 'ad', 'TV po repair?', [], { referral: { source: 'ADS', ad_id: '123' } });
    await s.post(MAIN, 'recent', 'Follow up po?');
    await s.post(MAIN, 'old', 'Samsung 55 inches, may lines, hindi pa repaired');
    await s.post(CAVITE_PAGE_ID, 'different', 'Magkano po?');
    assert.deepEqual(s.mock.calls.messages.map(m => m.recipient.id), ['old', 'ad']);
    assert.ok(s.mock.calls.messages.every(m => m.message.text.includes('➡️ TAGASAAN PO SILA?:')));
    assert.equal(s.app.store.thread('old').returnInquiryStartedAt > 0, true);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('returning inquiry starts a fresh once-only reminder without relying on old details or booking', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const sevenWeeksAgo = Date.now() - 49 * 86400e3;
    const older = new Date(sevenWeeksAgo).toISOString();
    s.mock.state.conversations = { old: { id: 'returning-with-history' } };
    s.mock.state.threadMessages = {
      'returning-with-history': [
        { id: 'sw.1', from: { id: 'old' } },
        { id: 'historic', from: { id: 'old' }, created_time: older },
      ],
    };
    const t = s.app.store.thread('old');
    t.lastUserTs = sevenWeeksAgo;
    t.firstInquirySentAt = sevenWeeksAgo;
    t.firstInquiryAttempt = 'historic';
    t.firstInquiryReminderAttempt = 'past-reminder';
    t.firstInquiryComplete = true;
    t.firstInquiryFacts = { video: true, brand: true, size: true, issue: true, repaired: true, when: true };
    t.history = [{ role: 'user', content: 'Samsung 55 inches, no power, hindi pa repaired, kahapon, sent video and details', ts: sevenWeeksAgo }];
    t.bookingFormSent = true;
    t.formSentAt = sevenWeeksAgo;
    t.bookingDone = true;
    t.bookingDoneAt = sevenWeeksAgo;
    t.bookingStaffOnly = true;
    t.bookingConfirmedAt = sevenWeeksAgo;
    t.handedOff = true;
    t.handoffAt = sevenWeeksAgo;
    await s.post(MAIN, 'old', 'Magkano po parepair sa TV?');
    assert.equal(s.mock.calls.messages.length, 1, 'returning intake delivered');
    assert.equal(t.firstInquiryComplete, false, 'historic intake does not complete the new request');
    assert.equal(t.firstInquiryReminderAttempt, null, 'old reminder marker reset');
    assert.equal(t.bookingFormSent, true, 'historic booking remains intact');
    await s.post(MAIN, 'old', 'Hello po?');
    await s.post(MAIN, 'old', 'Follow up po ulit?');
    assert.deepEqual(s.mock.calls.messages.map(m => m.recipient.id), ['old', 'old']);
    assert.equal(s.mock.calls.messages[1].message.text, require('../src/inquiry-reminder').REMINDER);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('Graph does not classify returning without a verifiable old message time', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.mock.state.conversations = { uncertain: { id: 'uncertain-chat' } };
    s.mock.state.threadMessages = {
      'uncertain-chat': [
        { id: 'sw.1', from: { id: 'uncertain' } },
        { id: 'old-unverified', from: { id: 'uncertain' } },
      ],
    };
    await s.post(MAIN, 'uncertain', 'Hello');
    assert.equal(s.mock.calls.messages.length, 0);
  } finally { await s.close(); }
});

test('Cavite new direct and ad customers receive same fixed intake with Main chatbot off', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'false',
    CAVITE_FIRST_INQUIRY_ENABLED: 'true',
  });
  try {
    const row = (id, from, created_time) => ({ id, from: { id: from }, ...(created_time ? { created_time } : {}) });
    const old = new Date(Date.now() - 22 * 86400e3).toISOString();
    s.mock.state.conversations = {
      'cavite-new': { id: 'cavite-new-thread' },
      'cavite-ad': { id: 'cavite-ad-thread' },
      'cavite-return': { id: 'cavite-return-thread' },
    };
    s.mock.state.threadMessages = {
      'cavite-new-thread': [row('page-welcome', CAVITE_PAGE_ID), row('sw.1', 'cavite-new')],
      'cavite-ad-thread': [row('sw.2', 'cavite-ad')],
      'cavite-return-thread': [row('sw.3', 'cavite-return'), row('old-inquiry', 'cavite-return', old)],
    };
    await s.post(CAVITE_PAGE_ID, 'cavite-new', 'Hello may sira TV');
    await s.post(CAVITE_PAGE_ID, 'cavite-ad', 'Magkano pagawa TV?', [], {
      referral: { source: 'ADS', ad_id: 'cavite-ad-123' },
    });
    await s.post(CAVITE_PAGE_ID, 'cavite-return', 'Hello again magkano po?');
    await s.post(MAIN, 'main-new', 'Hello po');
    assert.deepEqual(s.mock.calls.messages.map(m => m.recipient.id),
      ['cavite-new', 'cavite-ad', 'cavite-return']);
    assert.ok(s.mock.calls.messages.every(m => m.message.text.includes('➡️ TAGASAAN PO SILA?:')));
    assert.equal(s.mock.calls.llm.length, 0);
    const caviteGraph = s.mock.calls.pages.filter(p =>
      p.token === 'CAVITE_TOKEN' && p.kind === 'message');
    assert.ok(caviteGraph.length >= 3, 'Cavite Page token used for its Graph send and history calls');
    assert.equal(s.mock.calls.pages.filter(p =>
      p.token === 'MAIN_TOKEN' && p.kind === 'message').length, 0,
    'never use the Main Page token for Cavite Graph messages');
  } finally { await s.close(); }
});

test('Cavite follow-up reminder is separate, once-only, and honors completed details', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'false',
    CAVITE_FIRST_INQUIRY_ENABLED: 'true',
  });
  try {
    s.mock.state.conversations = { 'cavite-lead': { id: 'cavite-lead-thread' } };
    s.mock.state.threadMessages = {
      'cavite-lead-thread': [{ id: 'sw.1', from: { id: 'cavite-lead' } }],
    };
    await s.post(CAVITE_PAGE_ID, 'cavite-lead', 'Hello po');
    await s.post(CAVITE_PAGE_ID, 'cavite-lead', 'Hello, magkano po?');
    await s.post(CAVITE_PAGE_ID, 'cavite-lead', 'Follow up po?');
    assert.equal(s.mock.calls.messages.length, 2);
    assert.equal(s.mock.calls.messages[1].message.text, require('../src/inquiry-reminder').REMINDER);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('Cavite fixed intake flag defaults off and never substitutes Main Page credentials', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', CAVITE_FIRST_INQUIRY_ENABLED: 'false',
    MAIN_FIRST_INQUIRY_ENABLED: 'false',
  });
  try {
    await s.post(CAVITE_PAGE_ID, 'quiet-cavite', 'Hello po');
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(s.app.cfg.caviteFirstInquiryEnabled, false);
  } finally { await s.close(); }
});

test('private owner test sends each fixed template once on an old chat without enabling ordinary replies', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true',
    MAIN_WELCOME_TEST_PSID: 'owner-test-id',
  });
  try {
    const t = s.app.store.thread('owner-test-id');
    t.lastUserTs = Date.now() - 86400000;
    t.history = [{ role: 'user', content: 'Previously inquired', ts: t.lastUserTs }];
    t.bookingFormSent = true;
    t.bookingStaffOnly = true;
    t.handedOff = true;
    await s.post(MAIN, 'owner-test-id', 'Hello magkano magpagawa?');
    assert.equal(s.mock.calls.messages.length, 0, 'ordinary returning inquiry stays silent');
    // A normal returning-customer event may expire an old handoff; establish
    // a fresh staff handoff specifically to verify test commands do not clear it.
    t.handedOff = true;
    t.handoffAt = Date.now();
    await s.post(MAIN, 'someone-else', 'JMAGS TEST WELCOME');
    await s.post(CAVITE_PAGE_ID, 'owner-test-id', 'JMAGS TEST WELCOME');
    assert.equal(s.mock.calls.messages.length, 0, 'test commands never work for other accounts or Cavite');
    await s.post(MAIN, 'owner-test-id', 'JMAGS TEST REMINDER');
    assert.equal(s.mock.calls.messages.length, 0, 'reminder requires first test welcome');
    await s.post(MAIN, 'owner-test-id', 'JMAGS TEST WELCOME');
    await s.post(MAIN, 'owner-test-id', 'JMAGS TEST WELCOME');
    await s.post(MAIN, 'owner-test-id', 'JMAGS TEST REMINDER');
    await s.post(MAIN, 'owner-test-id', 'JMAGS TEST REMINDER');
    assert.equal(s.mock.calls.messages.length, 2, 'each template sent once');
    assert.deepEqual(s.mock.calls.messages.map(x => x.recipient.id), ['owner-test-id', 'owner-test-id']);
    assert.match(s.mock.calls.messages[0].message.text, /VIDEO ng ACTUAL issue/);
    assert.match(s.mock.calls.messages[0].message.text, /➡️ TAGASAAN PO SILA\?:/);
    assert.equal(s.mock.calls.messages[1].message.text, require('../src/inquiry-reminder').REMINDER);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(t.bookingFormSent, true);
    assert.equal(t.bookingStaffOnly, true);
    assert.equal(t.handedOff, true);
  } finally { await s.close(); }
});

test('native Page welcome before first inbound does not suppress the separate JMAGS intake', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const row = (id, sender) => ({ id, from: { id: sender } });
    s.mock.state.conversations = { newbie: { id: 'welcome-chat' }, returning: { id: 'return-chat' } };
    s.mock.state.threadMessages = {
      'welcome-chat': [row('auto-after', MAIN), row('sw.1', 'newbie'), row('auto-before', MAIN)],
      'return-chat': [row('sw.2', 'returning'), row('auto-before', MAIN), row('old-inquiry', 'returning')],
    };
    // The welcome echo was saved before the customer's first typed inquiry.
    s.app.store.addTurn('newbie', 'assistant', 'Facebook instant reply', Date.now());
    await s.post(MAIN, 'newbie', 'Hello po');
    await s.post(MAIN, 'returning', 'Hello again');
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].recipient.id, 'newbie');
    assert.match(s.mock.calls.messages[0].message.text, /VIDEO ng ACTUAL issue/);
    assert.match(s.mock.calls.messages[0].message.text, /➡️ TAGASAAN PO SILA\?:/);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('Page-only history is accepted across pages, but older customer messages are not', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const row = (id, sender) => ({ id, from: { id: sender } });
    s.mock.state.conversations = { fresh: { id: 'paged-fresh' }, old: { id: 'paged-old' } };
    s.mock.state.messagePages = {
      'paged-fresh': [[row('auto-after', MAIN), row('start', 'fresh')], [row('auto-earlier', MAIN)]],
      'paged-old': [[row('current', 'old')], [row('older-inquiry', 'old')]],
    };
    assert.equal(await withPage(mainPage, () => s.app.graph.firstInquiryStatus('fresh', 'start')), 'first');
    assert.equal(await withPage(mainPage, () => s.app.graph.firstInquiryStatus('old', 'current')), 'existing');
    assert.equal(await withPage(mainPage, () => s.app.graph.firstInquiryStatus('fresh', 'not-indexed')), 'pending');
  } finally { await s.close(); }
});

test('a customer sending details and video receives no reminder, including after a later follow-up', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.mock.state.conversations = { done: { id: 'done-chat' } };
    s.mock.state.threadMessages = { 'done-chat': [{ id: 'sw.1', from: { id: 'done' } }] };
    await s.post(MAIN, 'done', 'Hello po');
    await s.post(MAIN, 'done', 'Samsung 55 inches, walang display. Hindi pa narepair. Kahapon.');
    assert.equal(s.mock.calls.messages.length, 1);
    await Promise.all([
      s.post(MAIN, 'done', 'Hello?'),
      s.post(MAIN, 'done', '', [{ type: 'video', payload: { url: 'https://example.test/tv.mp4' } }]),
    ]);
    await s.post(MAIN, 'done', 'Any update?');
    assert.equal(s.app.store.thread('done').firstInquiryComplete, true);
    assert.equal(s.mock.calls.messages.length, 1);
  } finally { await s.close(); }
});

test('first greeting allows the usual reply handler to run on the very same inquiry', async () => {
  const s = await setup({ MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.mock.state.conversations = { both: { id: 'both-chat' } };
    s.mock.state.threadMessages = { 'both-chat': [{ id: 'sw.1', from: { id: 'both' } }] };
    await s.post(MAIN, 'both', 'Hello po');
    const replies = s.mock.calls.messages.map(call => call.message.text);
    assert.equal(replies.filter(text => text.includes('VIDEO ng ACTUAL issue')).length, 1);
    assert.ok(replies.some(text => !text.includes('VIDEO ng ACTUAL issue')));
  } finally { await s.close(); }
});

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
  assert.equal(seen.opts.headers.Authorization, undefined);

  const secret = ['sb', 'secret', 'x'.repeat(31)].join('_');
  assert.equal(secret.length, 41);
  assert.equal(isJwt(secret), false);
  const notes = [];
  let secretHeaders;
  const secretRead = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: secret,
  }, {
    log: { warn: (line) => notes.push(line) },
    fetchImpl: async (url, opts) => {
      secretHeaders = opts.headers;
      assert.match(url, /select=page_key,enabled$/);
      assert.doesNotMatch(url, /label|updated_by/);
      return { ok: false, status: 401, text: async () => `{"message":"Invalid JWT","key":"${secret}"}` };
    },
  });
  const failed = await secretRead.stateFor(mainPage);
  assert.equal(failed.ok, false);
  assert.equal(secretHeaders.apikey, secret);
  assert.equal(secretHeaders.Authorization, undefined);
  assert.match(notes[0], /page switch read failed: HTTP 401/);
  assert.match(notes[0], /Invalid JWT/);
  assert.equal(notes[0].includes(secret), false);
  assert.match(failed.error, /HTTP 401/);
  assert.equal(failed.error.includes(secret), false);

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig';
  let jwtHeaders;
  const jwtRead = new PageSwitches({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: jwt,
  }, {
    fetchImpl: async (url, opts) => {
      jwtHeaders = opts.headers;
      return {
        ok: true,
        text: async () => JSON.stringify([
          { page_key: 'sanpablo', label: 'San Pablo', enabled: true, updated_at: '2026-11-04T00:00:00Z', updated_by: 'jm' },
          { page_key: 'cavite', label: 'Cavite', enabled: false, updated_at: '2026-11-04T00:00:00Z', updated_by: 'jm' },
        ]),
      };
    },
  });
  assert.equal(await jwtRead.enabled(mainPage), true);
  assert.equal(await jwtRead.enabled(cavitePage), false);
  assert.equal(jwtHeaders.apikey, jwt);
  assert.equal(jwtHeaders.Authorization, `Bearer ${jwt}`);

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


test('one-time monitor and appliance replies stay separate from TV intake and AI bot', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true',
    CAVITE_FIRST_INQUIRY_ENABLED: 'true',
  });
  try {
    await s.post(MAIN, 'specific-repair', 'Gumagawa ba kayo ng monitor?');
    await s.post(MAIN, 'specific-repair', 'Nagawa gawa ba kayo ng monitor?');
    await s.post(MAIN, 'specific-repair', 'Nagawa ba kayo microwave oven?');
    await s.post(MAIN, 'specific-repair', 'Gumagawa ba kayo ref?');
    const texts = s.mock.calls.messages.map(c => c.message.text);
    assert.deepEqual(texts, [
      require('../src/appliance-one-time').REPLIES.monitor,
      require('../src/appliance-one-time').REPLIES.other,
    ]);
    assert.equal(s.mock.calls.llm.length, 0, 'continuous LLM was never called');
    assert.ok(texts.every(text => !text.includes('SIZE NG TV') && !text.includes('schedule')));
    assert.deepEqual(Object.keys(s.app.store.thread('specific-repair').applianceQuickReplyAttempts).sort(),
      ['monitor', 'other']);
    assert.match(s.app.bot.followUpSkip('specific-repair', s.app.store.thread('specific-repair'),
      Date.now(), 23 * 3600e3), /one-time appliance reply/);
  } finally { await s.close(); }
});

test('appliance replies work on Cavite with separate per-Page dedupe, even when conversational replies are on', async () => {
  const s = await setup({ BOT_ENABLED: 'true', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    await s.post(CAVITE_PAGE_ID, 'customer1', 'Nagawa ba kayo ng ref?');
    await s.post(CAVITE_PAGE_ID, 'customer1', 'Nagawa ba kayo microwave oven?');
    await s.post(MAIN, 'customer1', 'Gumagawa ba kayo ng monitor?');
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [
      require('../src/appliance-one-time').REPLIES.other,
      require('../src/appliance-one-time').REPLIES.monitor,
    ]);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('one-time appliance replies honor opt-out and active human handoff', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const t = s.app.store.thread('do-not-disturb');
    t.handedOff = true;
    t.handoffAt = Date.now();
    await s.post(MAIN, 'do-not-disturb', 'Gumagawa ba kayo ng monitor?');
    await s.post(MAIN, 'opted', 'stop');
    await s.post(MAIN, 'opted', 'Nagawa ba kayo ng ref?');
    assert.equal(s.mock.calls.messages.length, 0);
  } finally { await s.close(); }
});

test('appliance intent ignores existing repair status questions and can be independently disabled', async () => {
  const s = await setup({ BOT_ENABLED: 'false', APPLIANCE_ONE_TIME_REPLY_ENABLED: 'false' });
  try {
    await s.post(MAIN, 'one', 'Gumagawa ba kayo ng monitor?');
    assert.equal(s.mock.calls.messages.length, 0);
    assert.deepEqual(require('../src/appliance-one-time').match('Nagawa na ba ang ref ko?'), []);
    assert.deepEqual(require('../src/appliance-one-time').match('Nagawa ba kayo ng ref?'), ['other']);
    assert.deepEqual(require('../src/appliance-one-time').match('nagagawa po ba microwave oven'), ['other']);
  } finally { await s.close(); }
});


test('location instant answer works as first message with AI and first-intake off', async () => {
  const s = await setup({
    BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true',
    APPLIANCE_ONE_TIME_REPLY_ENABLED: 'true',
  });
  try {
    await s.post(MAIN, 'location-first', 'Saan po kayo located?');
    assert.deepEqual(s.mock.calls.messages.map(call => call.message.text),
      [require('../src/appliance-one-time').REPLIES.location]);
    assert.equal(s.mock.calls.llm.length, 0);
    await s.post(MAIN, 'location-first', 'Address niyo po?');
    assert.equal(s.mock.calls.messages.length, 1, 'only one location reply to this customer');
  } finally { await s.close(); }
});

test('middle-of-conversation location question is answered without activating AI', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'false' });
  try {
    await s.post(MAIN, 'location-middle', 'Hello may tanong po ako');
    await s.post(MAIN, 'location-middle', 'Where is your shop?');
    assert.deepEqual(s.mock.calls.messages.map(call => call.message.text),
      [require('../src/appliance-one-time').REPLIES.location]);
    assert.equal(s.mock.calls.llm.length, 0);
    await s.post(CAVITE_PAGE_ID, 'location-middle', 'Location po?');
    assert.equal(s.mock.calls.messages.length, 2, 'location reply is independent per Page');
  } finally { await s.close(); }
});

test('location intent recognizes Tagalog and English location wording', () => {
  const matcher = require('../src/appliance-one-time').match;
  for (const sample of ['Saan kayo?', 'Asan po ang shop niyo?', 'Where are you located?',
    'Address niyo po?', 'Location po', 'Paano pumunta sa shop?', 'San yung branch nyo?']) {
    assert.deepEqual(matcher(sample), ['location'], sample);
  }
  assert.deepEqual(matcher('Taga San Pablo City ako'), []);
  assert.deepEqual(matcher('Nagawa ba kayo ng ref?'), ['other']);
});


test('home-service variations send exactly one fixed reply without continuous bot, booking or TV intake', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const variants = [
      'Naghohome service po ba kayo?',
      'Pwde po ba kayo mag service?',
      'Nagseservice po ba kayo?',
      'Gumagawa ba kayo sa bahay?',
      'Pwde ba kayo dito sa Calamba?',
      'Kaya ba dito sa Batangas?',
      'Kaya nyo ba gumawa sa bahay?',
      'Gusto nyo ba guma dito?',
    ];
    const reply = require('../src/appliance-one-time').REPLIES.homeservice;
    for (const question of variants) {
      assert.deepEqual(require('../src/appliance-one-time').match(question), ['homeservice'], question);
    }
    await s.post(MAIN, 'home-new', variants[0]);
    await s.post(MAIN, 'home-new', variants[1]);
    await s.post(MAIN, 'home-new', variants[3]);
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [reply]);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.deepEqual(Object.keys(s.app.store.thread('home-new').applianceQuickReplyAttempts), ['homeservice']);
    assert.match(s.app.bot.followUpSkip('home-new', s.app.store.thread('home-new'),
      Date.now(), 23 * 3600e3), /one-time appliance reply/);
  } finally { await s.close(); }
});

test('home service can answer mid-conversation independently on both Pages without switching continuous AI on', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'false', CAVITE_FIRST_INQUIRY_ENABLED: 'false' });
  try {
    await s.post(MAIN, 'returning-home', 'May tanong lang po');
    await s.post(MAIN, 'returning-home', 'Pwede po ba kayo mag service?');
    await s.post(CAVITE_PAGE_ID, 'returning-home', 'Kaya nyo ba gumawa sa bahay?');
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [
      require('../src/appliance-one-time').REPLIES.homeservice,
      require('../src/appliance-one-time').REPLIES.homeservice,
    ]);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});

test('scheduling and non-question mentions do not trigger the new generic home-service greeting', () => {
  const match = require('../src/appliance-one-time').match;
  assert.deepEqual(match('pwede po ba bukas home service'), []);
  assert.deepEqual(match('Sa bahay namin may Samsung TV'), []);
  assert.deepEqual(match('Magkano home service checkup bukas?'), []);
  assert.deepEqual(match('Nagawa ba kayo ng ref?'), ['other']);
  assert.deepEqual(match('Saan po shop nyo?'), ['location']);
});


test('one-time FAQs reply during a temporary human staff pause without enabling continuous bot', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const thread = s.app.store.thread('staff-conversation');
    thread.pausedUntil = Date.now() + 30 * 60 * 1000;
    thread.lastHumanEchoAt = Date.now();
    await s.post(MAIN, 'staff-conversation', 'Gumagawa ba kayo ng monitor?');
    await s.post(MAIN, 'staff-conversation', 'Gumagawa ba kayo ng monitor?');
    assert.deepEqual(s.mock.calls.messages.map(m => m.message.text),
      [require('../src/appliance-one-time').REPLIES.monitor]);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(Boolean(thread.pausedUntil > Date.now()), true, 'staff pause must remain intact');
    assert.equal(Boolean(thread.firstInquirySentAt), false, 'TV intake is not triggered');
    assert.deepEqual(Object.keys(thread.applianceQuickReplyAttempts), ['monitor']);
  } finally { await s.close(); }
});

test('standalone FAQ honors explicit handoff but does not mistakenly treat staff pause as handoff', async () => {
  const s = await setup({ BOT_ENABLED: 'false' });
  try {
    const staff = s.app.store.thread('staff-handoff');
    staff.pausedUntil = Date.now() + 30 * 60 * 1000;
    staff.handedOff = true;
    staff.handoffAt = Date.now();
    await s.post(MAIN, 'staff-handoff', 'Gumagawa ba kayo ng monitor?');
    assert.equal(s.mock.calls.messages.length, 0, 'explicit handoff suppresses reply');
    assert.equal(staff.applianceQuickReplyAttempts?.monitor, undefined);
    const regular = s.app.store.thread('regular-staff-pause');
    regular.pausedUntil = Date.now() + 30 * 60 * 1000;
    await s.post(MAIN, 'regular-staff-pause', 'Naghohome service po ba kayo?');
    assert.deepEqual(s.mock.calls.messages.map(m => m.message.text),
      [require('../src/appliance-one-time').REPLIES.homeservice]);
  } finally { await s.close(); }
});


test('existing booked customer still gets standalone monitor FAQ once with continuous chatbot disabled', async () => {
  const s = await setup({
    BOT_ENABLED: 'false',
    MAIN_FIRST_INQUIRY_ENABLED: 'true',
  });
  try {
    const t = s.app.store.thread('previous-booking-monitor');
    t.bookingStaffOnly = true;
    t.bookingFormSent = true;
    t.bookingDone = true;
    t.bookingConfirmedAt = Date.now() - 3600e3;
    t.pausedUntil = Date.now() + 30 * 60e3;
    await s.post(MAIN, 'previous-booking-monitor', 'Gumagawa ba kayo ng monitor?');
    await s.post(MAIN, 'previous-booking-monitor', 'Gumagawa ba kayo ng monitor?');
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [
      require('../src/appliance-one-time').REPLIES.monitor,
    ]);
    assert.equal(s.mock.calls.llm.length, 0, 'continuous bot still off');
    assert.equal(t.bookingStaffOnly, true, 'staff booking restriction remains intact');
    assert.equal(t.bookingFormSent, true, 'do not modify booking form state');
    assert.equal(t.bookingDone, true);
    assert.equal(t.firstInquirySentAt || 0, 0, 'TV greeting must not run');
  } finally { await s.close(); }
});

test('separate location and home service FAQs remain available after staff-managed booking', async () => {
  const s = await setup({ BOT_ENABLED: 'false', CAVITE_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const page = s.app.cfg.pages.find(p => p.key === 'cavite');
    const { withPage } = require('../src/pages');
    withPage(page, () => { s.app.store.thread('previous-booking-faq').bookingStaffOnly = true; });
    await s.post(CAVITE_PAGE_ID, 'previous-booking-faq', 'Saan po kayo located?');
    await s.post(CAVITE_PAGE_ID, 'previous-booking-faq', 'Naghohome service po ba kayo?');
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [
      require('../src/appliance-one-time').REPLIES.location,
      require('../src/appliance-one-time').REPLIES.homeservice,
    ]);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(withPage(page, () => s.app.store.thread('previous-booking-faq').bookingStaffOnly), true);
  } finally { await s.close(); }
});


test('live spelling Nag hohome service ba kayo triggers its fixed one-time reply', async () => {
  const match = require('../src/appliance-one-time').match;
  const cases = [
    'Nag hohome service ba kayo?',
    'Nag hohome service po ba kayo?',
    'Nag ho-home service po ba kayo?',
    'Naghohome service ba kayo?',
    'Nag home service po ba kayo?',
    'Naghohome-service ba kayo?',
  ];
  for (const question of cases) {
    assert.deepEqual(match(question), ['homeservice'], question);
  }
  assert.deepEqual(match('Gumagawa ba kayo ng monitor?'), ['monitor']);
  assert.deepEqual(match('Gumagawa ba kayo ng ref?'), ['other']);
  assert.deepEqual(match('Pwede po ba bukas home service?'), []);
});

test('real customer home-service spelling works once when monitor and ref answered earlier', async () => {
  const s = await setup({ BOT_ENABLED: 'false' });
  try {
    await s.post(MAIN, 'same-actual-customer', 'Gumagawa ba kayo ng monitor?');
    await s.post(MAIN, 'same-actual-customer', 'Nag hohome service ba kayo?');
    await s.post(MAIN, 'same-actual-customer', 'Gumagawa ba kayo ng ref?');
    await s.post(MAIN, 'same-actual-customer', 'Nag hohome service ba kayo?');
    assert.deepEqual(s.mock.calls.messages.map(c => c.message.text), [
      require('../src/appliance-one-time').REPLIES.monitor,
      require('../src/appliance-one-time').REPLIES.homeservice,
      require('../src/appliance-one-time').REPLIES.other,
    ]);
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});


test('a technical second reply after staff clarification gets the missing-video reminder once', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.mock.state.conversations = { 'video-lead': { id: 'video-lead-thread' } };
    s.mock.state.threadMessages = {
      'video-lead-thread': [{ id: 'sw.1', from: { id: 'video-lead' } }],
    };
    await s.post(MAIN, 'video-lead', 'Hello po, nag inquire ako sa ad');
    assert.equal(s.mock.calls.messages.length, 1, 'first inquiry form sent');
    const t = s.app.store.thread('video-lead');
    // Simulate a staff reply: the continuous AI is paused but the one-time
    // video reminder must still be able to send.
    t.lastHumanEchoAt = Date.now();
    t.pausedUntil = Date.now() + 30 * 60 * 1000;
    await s.post(MAIN, 'video-lead', '55"\\nSHARP\\nBLANCO NO VIDEO\\nNO\\nSEPTEMBER\\nPASIG CITY');
    assert.equal(s.mock.calls.messages.length, 1, 'do not interrupt the first detail reply');
    await s.post(MAIN, 'video-lead', 'may power siya walang lumabas sa screen');
    assert.equal(s.mock.calls.messages.length, 2, 'remind after second reply without video');
    assert.equal(s.mock.calls.messages[1].message.text, require('../src/inquiry-reminder').REMINDER);
    await s.post(MAIN, 'video-lead', 'wala pa rin po');
    assert.equal(s.mock.calls.messages.length, 2, 'never repeat the reminder');
    assert.equal(s.mock.calls.llm.length, 0, 'continuous chatbot remains off');
  } finally { await s.close(); }
});


test('existing customer fresh TV inquiry gets one video reminder even when conversational AI is off', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.app.store.addTurn('existing-tv', 'user', 'Gumagawa ba kayo ng refrigerator?', Date.now() - 5 * 60 * 1000);
    const t = s.app.store.thread('existing-tv');
    t.lastHumanEchoAt = Date.now();
    t.pausedUntil = Date.now() + 30 * 60 * 1000;
    await s.post(MAIN, 'existing-tv', 'Hello po, may sira akong TV.');
    assert.equal(s.mock.calls.messages.length, 0, 'do not send another first-time welcome to an existing customer');
    await s.post(MAIN, 'existing-tv', 'May power siya pero walang lumalabas sa screen.');
    assert.equal(s.mock.calls.messages.length, 1, 'one-time reminder sent despite staff pause and AI off');
    assert.equal(s.mock.calls.messages[0].message.text, require('../src/inquiry-reminder').REMINDER);
    await s.post(MAIN, 'existing-tv', 'Magkano po?');
    assert.equal(s.mock.calls.messages.length, 1, 'no duplicate reminder');
    assert.equal(s.mock.calls.llm.length, 0, 'continuous chatbot remains off');
  } finally { await s.close(); }
});

test('existing customer who sends video does not receive missing-video reminder', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    s.app.store.addTurn('existing-with-video', 'user', 'Saan shop niyo?', Date.now() - 5 * 60 * 1000);
    await s.post(MAIN, 'existing-with-video', 'Hello po, may sira akong TV.');
    await s.post(MAIN, 'existing-with-video', '', [
      { type: 'video', payload: { url: 'https://example.com/issue.mp4' } },
    ]);
    await s.post(MAIN, 'existing-with-video', 'Magkano po?');
    assert.equal(s.mock.calls.messages.length, 0, 'video already submitted, no reminder');
    assert.equal(s.mock.calls.llm.length, 0, 'continuous AI still disabled');
  } finally { await s.close(); }
});


test('old booking form and old handoff do not block a new existing-customer TV reminder', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const old = Date.now() - 10 * 86400e3;
    s.app.store.addTurn('old-booking-tv', 'user', 'May booking po ako noon', old);
    const t = s.app.store.thread('old-booking-tv');
    t.bookingFormSent = true;
    t.formSentAt = old;
    t.bookingDone = true;
    t.bookingDoneAt = old;
    t.bookingStaffOnly = true;
    t.bookingConfirmedAt = old;
    t.handedOff = true;
    t.handoffAt = old;
    await s.post(MAIN, 'old-booking-tv', 'Hello po, may sira akong TV.');
    await s.post(MAIN, 'old-booking-tv', 'May power siya pero walang display.');
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, require('../src/inquiry-reminder').REMINDER);
    assert.equal(s.mock.calls.llm.length, 0);
    await s.post(MAIN, 'old-booking-tv', 'Magkano po?');
    assert.equal(s.mock.calls.messages.length, 1, 'no duplicate reminder after old flags');
  } finally { await s.close(); }
});

test('current booking handoff still blocks existing-customer missing-video reminder', async () => {
  const s = await setup({ BOT_ENABLED: 'false', MAIN_FIRST_INQUIRY_ENABLED: 'true' });
  try {
    const old = Date.now() - 5 * 60e3;
    s.app.store.addTurn('current-booking-tv', 'user', 'Old customer chat', old);
    const t = s.app.store.thread('current-booking-tv');
    await s.post(MAIN, 'current-booking-tv', 'Hello po, may sira akong TV.');
    t.bookingStaffOnly = true;
    t.bookingConfirmedAt = Date.now();
    await s.post(MAIN, 'current-booking-tv', 'Magkano po?');
    assert.equal(s.mock.calls.messages.length, 0, 'active booking remains staff-only');
    assert.equal(s.mock.calls.llm.length, 0);
  } finally { await s.close(); }
});
