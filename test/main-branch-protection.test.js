'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { routeEntry, withPage, MAIN_PAGE_ID, CAVITE_PAGE_ID, CAVITE_PROFILE_ID } = require('../src/pages');
const { Store } = require('../src/store');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');

test('Main production lock pins verified Page ID and ignores Cavite tokens and PAGES injection', () => {
  const cfg = loadConfig({
    JMAGS_MAIN_PROTECTED: 'true',
    PAGE_ID: CAVITE_PAGE_ID, // accidental Cavite paste cannot change Main routing
    PAGE_ACCESS_TOKEN: 'PROTECTED_MAIN_TOKEN',
    CAVITE_PAGE_ID: MAIN_PAGE_ID, // accidental wrong Cavite Page ID
    CAVITE_PAGE_ACCESS_TOKEN: 'UNTRUSTED_CAVITE_TOKEN',
    PAGES: JSON.stringify([
      { id: MAIN_PAGE_ID, token: 'STOLEN_MAIN_OVERRIDE', key: 'main' },
      { id: CAVITE_PAGE_ID, token: 'UNTRUSTED_EXTRA_CAVITE' },
      { id: '555111222', token: 'UNTRUSTED_THIRD_PAGE' },
    ]),
  });
  assert.equal(cfg.mainProtected, true);
  assert.equal(cfg.pageId, MAIN_PAGE_ID);
  assert.equal(cfg.pageAccessToken, 'PROTECTED_MAIN_TOKEN');
  assert.equal(cfg.pages.length, 2);
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID)?.token, 'PROTECTED_MAIN_TOKEN');
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID)?.primary, true);
  assert.equal(routeEntry(cfg, CAVITE_PAGE_ID)?.token, '');
  assert.equal(routeEntry(cfg, CAVITE_PROFILE_ID)?.token, '');
  assert.equal(routeEntry(cfg, '555111222'), null);
});

test('PAGES JSON can never overwrite Main token or display identity even when unlocked', () => {
  const cfg = loadConfig({
    PAGE_ID: MAIN_PAGE_ID,
    PAGE_ACCESS_TOKEN: 'CORRECT_MAIN_TOKEN',
    CAVITE_PAGE_ID: CAVITE_PAGE_ID,
    CAVITE_PAGE_ACCESS_TOKEN: 'CORRECT_CAVITE_TOKEN',
    PAGES: JSON.stringify([
      { id: MAIN_PAGE_ID, name: 'Fake Cavite', key: 'cavite', token: 'ATTACKER' },
      { id: '777888999', name: 'Other', key: 'main', token: 'ATTACKER' },
    ]),
  });
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID).token, 'CORRECT_MAIN_TOKEN');
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID).name, "JMAG's Appliances");
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID).primary, true);
  assert.equal(routeEntry(cfg, CAVITE_PAGE_ID).token, 'CORRECT_CAVITE_TOKEN');
  assert.equal(routeEntry(cfg, '777888999'), null);
});

test('Using Main Page token in Cavite setting never enables Cavite sends', () => {
  const cfg = loadConfig({
    PAGE_ID: MAIN_PAGE_ID, PAGE_ACCESS_TOKEN: 'MAIN_ONLY_TOKEN',
    CAVITE_PAGE_ACCESS_TOKEN: 'MAIN_ONLY_TOKEN',
    PAGES: JSON.stringify([{ id: CAVITE_PAGE_ID, token: 'MAIN_ONLY_TOKEN' }]),
  });
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID).token, 'MAIN_ONLY_TOKEN');
  assert.equal(routeEntry(cfg, CAVITE_PAGE_ID).token, '');
});

test('Replay IDs and PSID threads are Page-separated while existing Main keys remain unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-branch-lock-'));
  try {
    const store = new Store(dir);
    const main = { id: MAIN_PAGE_ID, token: 'A', key: 'main', primary: true };
    const cavite = { id: CAVITE_PAGE_ID, token: 'B', key: 'cavite', primary: false };
    withPage(main, () => {
      assert.equal(store.seen('same-mid'), false);
      assert.equal(store.seen('same-mid'), true);
      store.addTurn('same-customer', 'user', 'Main only', Date.now());
    });
    withPage(cavite, () => {
      assert.equal(store.seen('same-mid'), false);
      assert.equal(store.seen('same-mid'), true);
      store.addTurn('same-customer', 'user', 'Cavite only', Date.now());
    });
    assert.equal(store.data.threads['same-customer'].history[0].content, 'Main only');
    assert.equal(store.data.threads[CAVITE_PAGE_ID + ':same-customer'].history[0].content, 'Cavite only');
    assert.deepEqual(store.data.seenMids, ['same-mid', CAVITE_PAGE_ID + ':same-mid']);
    store.flushNow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Main-only production webhook sends Main approved FAQ but ignores all Cavite events without recording their customer state', async () => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-main-protected-'));
  const secret = 'safe-test-app-secret';
  const env = {
    PORT: '0', VERIFY_TOKEN: 'test', APP_SECRET: secret, APP_ID: '123456789',
    PAGE_ID: CAVITE_PAGE_ID, // wrong PAGE_ID cannot redirect this service
    PAGE_ACCESS_TOKEN: 'MAIN_TOKEN', JMAGS_MAIN_PROTECTED: 'true',
    CAVITE_PAGE_ID: MAIN_PAGE_ID, CAVITE_PAGE_ACCESS_TOKEN: 'CAVITE_TOKEN',
    PAGES: JSON.stringify([{ id: MAIN_PAGE_ID, token: 'BAD_TOKEN' }]),
    BOT_ENABLED: 'false', APPLIANCE_ONE_TIME_REPLY_ENABLED: 'true',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: mock.base + '/v1',
    LLM_MODEL: 'mock-model', LLM_API_KEY: 'test-key',
    DATA_DIR: dir, LOG_LEVEL: 'silent',
  };
  const app = build(env);
  let mid = 0;
  const send = async (pageId, psid, msg) => {
    const at = Date.now();
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: pageId, time: at, messaging: [{
        sender: { id: psid }, recipient: { id: pageId }, timestamp: at,
        message: { mid: 'security.' + ++mid, text: msg },
      }] }],
    });
    const res = await fetch('http://127.0.0.1:' + app.server.address().port + '/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'),
      },
      body: raw,
    });
    await app.bot.idle();
    return res;
  };
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await send(CAVITE_PAGE_ID, 'same-psid', 'Naghohome service po ba kayo?')).status, 200);
    assert.equal(mock.calls.pages.length, 0);
    assert.equal(app.store.data.threads[CAVITE_PAGE_ID + ':same-psid'], undefined);
    assert.equal(app.store.data.threads['same-psid'], undefined);
    assert.equal((await send(MAIN_PAGE_ID, 'same-psid', 'Naghohome service po ba kayo?')).status, 200);
    assert.equal(mock.calls.messages.length, 1);
    assert.ok(mock.calls.pages.every((p) => p.token === 'MAIN_TOKEN'));
    assert.ok(mock.calls.pages.some((p) => p.path.includes('/' + MAIN_PAGE_ID + '/messages')));
    assert.ok(app.store.data.threads['same-psid']);
    assert.equal(app.store.data.threads[CAVITE_PAGE_ID + ':same-psid'], undefined);
  } finally {
    await app.bot.idle();
    app.server.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
