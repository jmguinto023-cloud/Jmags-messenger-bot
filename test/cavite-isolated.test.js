'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { routeEntry, MAIN_PAGE_ID, CAVITE_PAGE_ID } = require('../src/pages');
const faq = require('../src/appliance-one-time');
const { build } = require('../src/index');
const { startMock } = require('./mock-meta-llm');

test('Cavite-only mode rejects Main token, Page ID, and all extra Page injections', () => {
  const cfg = loadConfig({
    JMAGS_CAVITE_ONLY: 'true', PAGE_ID: MAIN_PAGE_ID,
    PAGE_ACCESS_TOKEN: 'SECRET_MAIN', CAVITE_PAGE_ID: MAIN_PAGE_ID,
    CAVITE_PAGE_ACCESS_TOKEN: 'SECRET_CAVITE',
    PAGES: JSON.stringify([{ id: MAIN_PAGE_ID, token: 'EVIL' }]),
  });
  assert.equal(cfg.caviteOnly, true);
  assert.equal(cfg.pageId, CAVITE_PAGE_ID);
  assert.equal(cfg.pageAccessToken, '');
  assert.equal(cfg.pages.length, 1);
  assert.equal(cfg.pages[0].key, 'cavite');
  assert.equal(cfg.pages[0].primary, false);
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID), null);
  assert.equal(routeEntry(cfg, CAVITE_PAGE_ID).token, 'SECRET_CAVITE');
});

test('Cavite without valid token cannot borrow Main Page credential', () => {
  const cfg = loadConfig({
    JMAGS_CAVITE_ONLY: 'true',
    PAGE_ID: MAIN_PAGE_ID, PAGE_ACCESS_TOKEN: 'SECRET_MAIN',
    CAVITE_PAGE_ACCESS_TOKEN: '',
  });
  assert.equal(routeEntry(cfg, CAVITE_PAGE_ID).token, '');
  assert.equal(routeEntry(cfg, MAIN_PAGE_ID), null);
  assert.equal(cfg.pageAccessToken, '');
});

test('Cavite location FAQ is branch-specific and Main FAQ unchanged', () => {
  assert.match(faq.response(['location'], { pageKey: 'cavite' }), /General Trias, Cavite/);
  assert.doesNotMatch(faq.response(['location'], { pageKey: 'cavite' }), /San Pablo/);
  assert.match(faq.response(['location']), /San Pablo City/);
});

test('Cavite-only service accepts Cavite FAQ but ignores a signed Main webhook', async () => {
  const mock = await startMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-cavite-test-'));
  const secret = 'test-only-cavite-app-secret';
  const app = build({
    PORT: '0', JMAGS_CAVITE_ONLY: 'true',
    PAGE_ID: MAIN_PAGE_ID, PAGE_ACCESS_TOKEN: 'DO_NOT_USE_MAIN',
    CAVITE_PAGE_ID: CAVITE_PAGE_ID, CAVITE_PAGE_ACCESS_TOKEN: 'CAVITE_TOKEN',
    APP_ID: '123123', APP_SECRET: secret, VERIFY_TOKEN: 'cavite-verify',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: mock.base + '/v1',
    LLM_MODEL: 'mock-model', LLM_API_KEY: 'test-only',
    DATA_DIR: dir, BOT_ENABLED: 'false',
    MAIN_FIRST_INQUIRY_ENABLED: 'false', CAVITE_FIRST_INQUIRY_ENABLED: 'true',
    APPLIANCE_ONE_TIME_REPLY_ENABLED: 'true', LOG_LEVEL: 'silent',
  });
  let seq = 0;
  const send = async (pageId, psid, text) => {
    const now = Date.now();
    const raw = JSON.stringify({ object: 'page', entry: [{
      id: pageId, time: now, messaging: [{
        sender: { id: psid }, recipient: { id: pageId }, timestamp: now,
        message: { mid: 'cav.' + ++seq, text },
      }],
    }] });
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
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    assert.equal((await send(MAIN_PAGE_ID, 'same-psid', 'location po')).status, 200);
    assert.equal(mock.calls.messages.length, 0);
    assert.equal(Object.keys(app.store.data.threads).length, 0);
    assert.equal((await send(CAVITE_PAGE_ID, 'same-psid', 'location po')).status, 200);
    assert.equal(mock.calls.messages.length, 1);
    assert.match(mock.calls.messages[0].message.text, /General Trias, Cavite/);
    assert.ok(mock.calls.pages.every(p => p.token === 'CAVITE_TOKEN'));
    assert.equal(app.store.data.threads['same-psid'], undefined);
    assert.ok(app.store.data.threads[CAVITE_PAGE_ID + ':same-psid']);
  } finally {
    await app.bot.idle();
    app.server.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
