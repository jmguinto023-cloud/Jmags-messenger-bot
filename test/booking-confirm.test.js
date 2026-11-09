'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const bc = require('../src/booking-confirm');

const SECRET = 'test_app_secret';
const PAGE = '102622881557025';
const FORM = 'https://jmagscutomerform.netlify.app/';
const ORIGIN = 'https://jmagscutomerform.netlify.app';
const cfg = { appSecret: SECRET, bookingFormUrl: FORM, pageId: PAGE };

async function setup(extraEnv = {}) {
  const mock = await startMock({});
  const env = {
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: SECRET, APP_ID: '1', PAGE_ID: PAGE,
    PAGE_ACCESS_TOKEN: 'T', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`,
    LLM_API_KEY: 'k', LLM_MODEL: 'm', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-bk-')), LOG_LEVEL: 'silent', ...extraEnv,
  };
  const app = build(env);
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const webhook = async (payload) => {
    const raw = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
  };
  const submit = (body, origin = ORIGIN) => fetch(`${base}/booking/submitted`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, mock, base, webhook, submit, close };
}

let n = 0;
const text = (psid, t) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `bk.${++n}`, text: t } }] }] });
const referral = (psid, ref) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] });
const sentTexts = (mock) => mock.calls.messages.map((m) => m.message && m.message.text).filter(Boolean);

test('ref is signed and cannot be forged', () => {
  const ref = bc.makeRef(cfg, '2468013579');
  assert.equal(bc.readRef(cfg, ref), '2468013579');
  assert.equal(bc.readRef(cfg, ref.replace(/^2/, '3')), '');
  assert.equal(bc.readRef(cfg, '2468013579.AAAAAAAAAAAAAAAA'), '');
  assert.equal(bc.readRef({ ...cfg, appSecret: 'other' }, ref), '');
});

test('booking form links get the customer ref, other text is untouched', () => {
  const out = bc.personalizeFormUrls(cfg, `Fill up po dito: ${FORM} salamat`, '111222333');
  assert.match(out, /https:\/\/jmagscutomerform\.netlify\.app\/\?ref=111222333\.[A-Za-z0-9_-]{16} salamat$/);
  assert.equal(bc.personalizeFormUrls(cfg, 'walang link', '111222333'), 'walang link');
  const already = `${FORM}?ref=x`;
  assert.equal(bc.personalizeFormUrls(cfg, already, '111222333'), already);
  assert.match(bc.personalizeFormUrls({ ...cfg, bookingBotKey: 'cavite' }, FORM, '111222333'), /&b=cavite$/);
});

test('YES and NO messages', () => {
  const yes = bc.confirmText('Maria Santos', 'yes');
  assert.match(yes, /^Hello po mam\/sir Maria Santos,/);
  assert.match(yes, /9am to 5pm/);
  assert.match(yes, /Reply "AGREE"/);
  const no = bc.confirmText('', 'NO');
  assert.match(no, /^Hello po mam\/sir,/);
  assert.match(no, /automatic po Priority/);
  assert.match(no, /Today!/);
});

test('AGREE detection', () => {
  for (const ok of ['AGREE', 'agree po', 'Agree!', 'ok agree', 'I agree', 'agreed 👍']) assert.equal(bc.isAgree(ok), true, ok);
  for (const no of ['hindi ako agree', 'agree ba kayo sa presyo?', 'magkano po', '']) assert.equal(bc.isAgree(no), false, no);
});

test('m.me referral round-trip keeps name and choice', () => {
  const ref = bc.referralRef('Juan dela Cruz', 'no');
  assert.ok(ref.length <= 250);
  assert.match(ref, /^BK_N_[A-Za-z0-9_-]+$/);
  assert.deepEqual(bc.parseReferralRef(ref), { wait: 'no', name: 'Juan dela Cruz' });
  assert.equal(bc.parseReferralRef('ADS_123'), null);
});

test('form submit with ref sends the NO message on Messenger, AGREE confirms', async () => {
  const s = await setup();
  try {
    const psid = '5550001111';
    const ref = bc.makeRef(s.app.cfg, psid);
    const res = await s.submit({ ref, name: 'Ana Reyes', wait: 'no', bookingId: 'BK-77' });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const body = await res.json();
    assert.equal(body.sent, true);
    let texts = sentTexts(s.mock);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Hello po mam\/sir Ana Reyes/);
    assert.match(texts[0], /automatic po Priority/);
    const t = s.app.bot.store.thread(psid);
    assert.equal(t.awaitingAgree, true);
    assert.equal(t.bookingPriority, true);
    assert.equal(t.bookingDone, true);

    // Duplicate submit within 10 minutes is not sent twice.
    const again = await (await s.submit({ ref, name: 'Ana Reyes', wait: 'no', bookingId: 'BK-77' })).json();
    assert.equal(again.sent, false);

    await s.webhook(text(psid, 'AGREE po'));
    texts = sentTexts(s.mock);
    assert.equal(texts.length, 2);
    assert.match(texts[1], /Confirmed na po ang booking ninyo bilang PRIORITY/);
    assert.equal(t.bookingConfirmed, true);
    assert.equal(t.awaitingAgree, false);
    assert.equal(s.mock.calls.llm.length, 0, 'AGREE never goes to the AI');
  } finally { await s.close(); }
});

test('form submit without ref returns an m.me button link; tapping it sends the YES message', async () => {
  const s = await setup();
  try {
    const body = await (await s.submit({ name: 'Pedro', wait: 'yes' })).json();
    assert.equal(body.sent, false);
    assert.match(body.messengerUrl, new RegExp(`^https://m\\.me/${PAGE}\\?ref=BK_Y_`));
    const ref = new URL(body.messengerUrl).searchParams.get('ref');
    await s.webhook(referral('7770002222', ref));
    const texts = sentTexts(s.mock);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Hello po mam\/sir Pedro/);
    assert.match(texts[0], /willing to wait/);
  } finally { await s.close(); }
});

test('form submit rejects a missing answer and a foreign origin', async () => {
  const s = await setup();
  try {
    assert.equal((await s.submit({ name: 'X' })).status, 400);
    assert.equal((await s.submit({ wait: 'yes' }, 'https://evil.example')).status, 403);
    assert.equal(sentTexts(s.mock).length, 0);
  } finally { await s.close(); }
});

test('bot-sent booking form link carries the customer ref', async () => {
  const s = await setup();
  try {
    const psid = '8880003333';
    await s.app.bot.send(psid, `Paki-fill up po: ${FORM}`, { ops: true });
    const [sent] = sentTexts(s.mock);
    const link = sent.match(/https:\/\/\S+/)[0];
    assert.equal(bc.readRef(s.app.cfg, new URL(link).searchParams.get('ref')), psid);
    assert.equal(s.app.bot.store.thread(psid).bookingFormSent, true);
  } finally { await s.close(); }
});
