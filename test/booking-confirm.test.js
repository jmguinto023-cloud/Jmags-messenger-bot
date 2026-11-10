'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { withPage } = require('../src/pages');
const { prettyDate } = require('../src/hours');
const bc = require('../src/booking-confirm');

const SECRET = 'test_app_secret';
const HOOK = 'hook-secret';
const PAGE = '102622881557025';
const CAVITE = '1237499962773846';
const FORM = 'https://jmagscutomerform.netlify.app/';
const ORIGIN = 'https://jmagscutomerform.netlify.app';
const cfg = { appSecret: SECRET, bookingFormUrl: FORM, pageId: PAGE };

async function setup(extraEnv = {}) {
  const mock = await startMock({});
  const env = {
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: SECRET, APP_ID: '1', PAGE_ID: PAGE,
    PAGE_ACCESS_TOKEN: 'T', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`,
    LLM_API_KEY: 'k', LLM_MODEL: 'm', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-bk-')), LOG_LEVEL: 'silent',
    NETLIFY_WEBHOOK_SECRET: HOOK, PAGE_SWITCH_CACHE_MS: '0',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role', ...extraEnv,
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

test('booking form links carry a signed psid, page, and token', () => {
  const out = bc.personalizeFormUrls(cfg, `Fill up po dito: ${FORM} salamat`, '111222333', 'sanpablo');
  const link = out.match(/https:\/\/\S+/)[0];
  const u = new URL(link);
  assert.equal(u.searchParams.get('psid'), '111222333');
  assert.equal(u.searchParams.get('page'), 'sanpablo');
  assert.deepEqual(bc.readToken(cfg, u.searchParams.get('token')), { psid: '111222333', page: 'sanpablo' });
  assert.equal(bc.readRef(cfg, u.searchParams.get('ref')), '111222333');
  assert.match(out, / salamat$/);
  assert.equal(bc.personalizeFormUrls(cfg, 'walang link', '111222333'), 'walang link');
  const cav = new URL(bc.personalizeFormUrls(cfg, FORM, '111222333', 'cavite'));
  assert.equal(cav.searchParams.get('page'), 'cavite');
  assert.deepEqual(bc.readToken(cfg, cav.searchParams.get('token')), { psid: '111222333', page: 'cavite' });
});

test('token binds one PSID to one Page and a bare PSID is rejected', () => {
  const token = bc.makeToken(cfg, '2468013579', 'cavite');
  assert.deepEqual(bc.readToken(cfg, token), { psid: '2468013579', page: 'cavite' });
  assert.equal(bc.readToken(cfg, token.replace('cavite', 'sanpablo')), null);
  assert.equal(bc.readToken({ ...cfg, appSecret: 'other' }, token), null);
  assert.equal(bc.identityFrom(cfg, { token, psid: '9999999999', page: 'cavite' }).error, 'bad messenger token');
  assert.equal(bc.identityFrom(cfg, { psid: '2468013579', page: 'cavite' }).error, 'bad messenger token');
  const link = new URL(bc.bookingFormLink(cfg, '2468013579', 'sanpablo'));
  assert.equal(link.searchParams.get('page'), 'sanpablo');
  assert.equal(link.searchParams.get('psid'), '2468013579');
});

test('YES and NO messages name the service, the date, and staff', () => {
  const when = prettyDate('2026-11-12');
  const yes = bc.confirmText('Maria Santos', 'yes', '2026-11-12');
  assert.equal(yes, `Salamat po sa booking, Maria Santos! 😊 Regular service po kayo sa ${when}. Tatawag po ang staff namin anytime 9AM-5PM sa araw na iyon. Paki-reply po ng AGREE para ma-confirm.`);
  assert.doesNotMatch(yes, /technician/i);
  const no = bc.confirmText('Maria Santos', 'no', '2026-11-12');
  assert.equal(no, `Salamat po sa booking, Maria Santos! 😊 Priority service po kayo (+P1,000) sa ${when}, mauuna po kayo sa line-up. Paki-reply po ng AGREE para ma-confirm.`);
  assert.doesNotMatch(no, /technician/i);
  assert.match(bc.confirmText('', 'yes'), /^Salamat po sa booking! 😊 Regular service po kayo\./);
  assert.equal(bc.agreeAckText('no'), 'Salamat po, confirmed na po ang booking ninyo.');
  assert.equal(bc.bookingKind({ willingToWait: 'yes', service: 'PRIORITY' }), 'yes');
  assert.equal(bc.bookingKind({ service: 'PRIORITY (+P1,000)' }), 'no');
  assert.equal(bc.bookingKind({ service: 'REGULAR' }), 'yes');
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
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    const ref = bc.makeRef(s.app.cfg, psid);
    const res = await s.submit({ ref, name: 'Ana Reyes', wait: 'no', bookingId: 'BK-77' });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const body = await res.json();
    assert.equal(body.sent, true);
    let texts = sentTexts(s.mock);
    assert.equal(texts.length, 1);
    assert.match(texts[0], /Salamat po sa booking, Ana Reyes/);
    assert.match(texts[0], /Priority service po kayo \(\+P1,000\)/);
    assert.doesNotMatch(texts[0], /technician/i);
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
    assert.equal(texts[1], 'Salamat po, confirmed na po ang booking ninyo.');
    assert.equal(t.bookingConfirmed, true);
    assert.equal(t.awaitingAgree, false);
    assert.equal(t.bookingStaffOnly, true);
    assert.equal(s.mock.calls.llm.length, 0, 'AGREE never goes to the AI');
    await s.webhook(text(psid, 'magkano po'));
    assert.equal(sentTexts(s.mock).length, 2, 'staff own the chat after the confirm');
    assert.equal(s.mock.calls.llm.length, 0);
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
    assert.match(texts[0], /Salamat po sa booking, Pedro/);
    assert.match(texts[0], /Regular service po kayo/);
    assert.match(texts[0], /Tatawag po ang staff namin/);
    assert.doesNotMatch(texts[0], /technician/i);
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
    const u = new URL(link);
    assert.equal(bc.readRef(s.app.cfg, u.searchParams.get('ref')), psid);
    assert.equal(u.searchParams.get('psid'), psid);
    assert.equal(u.searchParams.get('page'), 'sanpablo');
    assert.deepEqual(bc.readToken(s.app.cfg, u.searchParams.get('token')), { psid, page: 'sanpablo' });
    assert.equal(s.app.bot.store.thread(psid).bookingFormSent, true);
  } finally { await s.close(); }
});

test('phone match is one stored customer mobile, or nothing', () => {
  const threads = {
    a: { history: [{ role: 'user', content: '09171234567 po' }] },
    b: { history: [{ role: 'assistant', content: '09170000000' }] },
  };
  assert.equal(bc.matchMobile(threads, '0917 123 4567').key, 'a');
  threads.c = { history: [{ role: 'user', content: 'number 09171234567' }] };
  assert.equal(bc.matchMobile(threads, '09171234567').status, 'many');
  assert.equal(bc.matchJobMobile([
    { phone: '09170000000', psid: '55' },
    { phone: '+639170000000', psid: '55' },
  ], '09170000000'), '55');
  assert.equal(bc.matchJobMobile([
    { phone: '09170000000', psid: '55' },
    { mobile: '09170000000', psid: '66' },
  ], '09170000000'), '');
});

test('outside-window Graph errors are recognized and other errors are not', () => {
  assert.equal(bc.outsideWindowError({ message: 'Graph POST failed: 400 (#10) This message is sent outside of allowed window' }), true);
  assert.equal(bc.outsideWindowError({ body: { error: { code: 551, message: 'unavailable' } } }), true);
  assert.equal(bc.outsideWindowError({ body: { error: { error_subcode: 2018278 } } }), true);
  assert.equal(bc.outsideWindowError({ message: 'Graph POST failed: 500 oops' }), false);
});

function jws(raw, secret = HOOK, claims = {}) {
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'netlify', sha256: hash, ...claims })).toString('base64url');
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function submission(fields, id = 'sub-1') {
  return JSON.stringify({ id, form_name: 'booking', data: fields });
}

async function postHook(s, raw, headers = {}, key = '') {
  const url = key ? `${s.base}/booking/netlify?key=${encodeURIComponent(key)}` : `${s.base}/booking/netlify`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

test('Netlify webhook rejects a bad signature and a missing secret', async () => {
  const s = await setup();
  try {
    const raw = submission({ name: 'Ana', willingToWait: 'yes', pdate: '2026-11-12' });
    const bad = await postHook(s, raw, { 'X-Webhook-Signature': jws('other-body') });
    assert.equal(bad.status, 401);
    s.app.cfg.netlifyWebhookSecret = '';
    const open = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(open.status, 401);
    assert.equal(sentTexts(s.mock).length, 0);
    const health = await (await fetch(`${s.base}/health`)).json();
    assert.equal(health.bookingWebhook, 'missing');
  } finally { await s.close(); }
});

test('signed webhook sends one Regular message, retries do not, and a later question stays quiet', async () => {
  const s = await setup();
  try {
    const psid = '5551112222';
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    const token = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const raw = submission({
      name: 'Maria Santos', willingToWait: 'yes', service: 'REGULAR', pdate: '2026-11-12',
      psid, page: 'sanpablo', token,
    }, 'sub-yes');
    const first = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(first.status, 200);
    assert.equal(first.body.sent, true);
    const when = prettyDate('2026-11-12');
    assert.equal(sentTexts(s.mock)[0], `Salamat po sa booking, Maria Santos! 😊 Regular service po kayo sa ${when}. Tatawag po ang staff namin anytime 9AM-5PM sa araw na iyon. Paki-reply po ng AGREE para ma-confirm.`);
    const again = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(again.body.sent, false);
    assert.equal(again.body.reason, 'already sent');
    assert.equal(sentTexts(s.mock).length, 1);
    const other = submission({
      name: 'Maria Santos', willingToWait: 'yes', pdate: '2026-11-12', psid, page: 'sanpablo', token,
    }, 'sub-yes-2');
    const resubmit = await postHook(s, other, { Authorization: `Bearer ${HOOK}` });
    assert.equal(resubmit.body.sent, false);
    assert.equal(sentTexts(s.mock).length, 1);
    await s.webhook(text(psid, 'AGREE'));
    assert.equal(sentTexts(s.mock).at(-1), 'Salamat po, confirmed na po ang booking ninyo.');
    await s.webhook(text(psid, 'ano na po'));
    assert.equal(sentTexts(s.mock).length, 2);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(s.app.bot.store.thread(psid).bookingConfirmed, true);
    assert.equal(s.app.bot.store.thread(psid).bookingStaffOnly, true);
  } finally { await s.close(); }
});

test('webhook still sends when the Page switch and BOT_ENABLED are off', async () => {
  const s = await setup();
  try {
    const psid = '5551113333';
    s.app.cfg.botEnabled = false;
    s.mock.state.switchFail = true;
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    const token = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const raw = submission({
      name: 'Liza', willingToWait: 'no', service: 'PRIORITY (+P1,000)', pdate: '2026-11-13',
      psid, page: 'sanpablo', token,
    }, 'sub-off');
    const out = await postHook(s, raw, { 'X-Webhook-Secret': HOOK });
    assert.equal(out.body.sent, true);
    assert.match(sentTexts(s.mock)[0], /Priority service po kayo \(\+P1,000\)/);
    assert.match(sentTexts(s.mock)[0], /staff|mauuna po/i);
    await s.webhook(text(psid, 'AGREE po'));
    assert.equal(sentTexts(s.mock).length, 2);
    assert.equal(s.app.bot.store.thread(psid).bookingConfirmed, true);
    await s.webhook(text(psid, 'hello po'));
    assert.equal(sentTexts(s.mock).length, 2);
  } finally { await s.close(); }
});

test('outside 24h is flagged once and not sent', async () => {
  const s = await setup();
  try {
    const psid = '5551114444';
    const t = s.app.bot.store.thread(psid);
    t.lastUserTs = Date.now() - 48 * 3600 * 1000;
    let notices = 0;
    s.app.bot.notifyStaff = async () => { notices += 1; };
    const token = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const raw = submission({
      name: 'Nestor', willingToWait: 'yes', pdate: '2026-11-12', psid, page: 'sanpablo', token,
    }, 'sub-old');
    const first = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(first.body.sent, false);
    assert.equal(first.body.reason, 'outside 24h window');
    assert.equal(sentTexts(s.mock).length, 0);
    assert.equal(t.bookingNeedsStaff, true);
    assert.equal(notices, 1);
    const second = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(second.body.sent, false);
    assert.equal(notices, 1);
    t.lastUserTs = Date.now();
    const third = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(third.body.sent, true);
    assert.equal(sentTexts(s.mock).length, 1);
  } finally { await s.close(); }
});

test('Cavite token sends with the Cavite Page token, and a missing Cavite token does not borrow San Pablo', async () => {
  const live = await setup({ CAVITE_PAGE_ACCESS_TOKEN: 'CAV-TOKEN' });
  try {
    const psid = '5551115555';
    const cav = live.app.cfg.pages.find((p) => p.key === 'cavite');
    await withPage(cav, () => { live.app.bot.store.thread(psid).lastUserTs = Date.now(); });
    const token = bc.makeToken(live.app.cfg, psid, 'cavite');
    const raw = submission({
      name: 'Cely', willingToWait: 'yes', pdate: '2026-11-12', psid, page: 'cavite', token,
    }, 'sub-cav');
    const out = await postHook(live, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    const hit = live.mock.calls.pages.find((p) => p.kind === 'message' && p.token === 'CAV-TOKEN');
    assert.ok(hit, 'Cavite Page token was not used');
    assert.match(hit.path, new RegExp(CAVITE));
    assert.equal(live.mock.calls.pages.some((p) => p.kind === 'message' && p.token === 'T'), false);
  } finally { await live.close(); }

  const bare = await setup();
  try {
    const psid = '5551116666';
    const cav = bare.app.cfg.pages.find((p) => p.key === 'cavite');
    await withPage(cav, () => { bare.app.bot.store.thread(psid).lastUserTs = Date.now(); });
    const token = bc.makeToken(bare.app.cfg, psid, 'cavite');
    const raw = submission({
      name: 'Cely', willingToWait: 'yes', pdate: '2026-11-12', psid, page: 'cavite', token,
    }, 'sub-cav-empty');
    const out = await postHook(bare, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, false);
    assert.equal(out.body.reason, 'no page token');
    assert.equal(sentTexts(bare.mock).length, 0);
    cav.token = 'CAV-LATER';
    const later = await postHook(bare, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(later.body.sent, true);
    assert.ok(bare.mock.calls.pages.some((p) => p.kind === 'message' && p.token === 'CAV-LATER'));
  } finally { await bare.close(); }
});

test('a forged token is not saved by a matching phone, and a unique phone can send', async () => {
  const s = await setup();
  try {
    const psid = '5551117777';
    const t = s.app.bot.store.thread(psid);
    t.lastUserTs = Date.now();
    t.history.push({ role: 'user', content: 'mobile ko 09181234567', ts: Date.now() });
    const good = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const forged = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const bad = submission({
      name: 'Ria', willingToWait: 'yes', pdate: '2026-11-12', mobile: '09181234567',
      psid, page: 'sanpablo', token: forged,
    }, 'sub-forged');
    const rejected = await postHook(s, bad, { 'X-Webhook-Signature': jws(bad) });
    assert.equal(rejected.body.sent, false);
    assert.equal(rejected.body.reason, 'bad messenger token');
    assert.equal(sentTexts(s.mock).length, 0);

    const plain = submission({
      name: 'Ria', willingToWait: 'no', pdate: '2026-11-14', mobile: '09181234567',
    }, 'sub-phone');
    const ok = await postHook(s, plain, {}, HOOK);
    assert.equal(ok.body.sent, true);
    assert.equal(s.app.bot.store.thread(psid).bookingSource, 'phone');
    assert.match(sentTexts(s.mock)[0], /Priority service po kayo/);
  } finally { await s.close(); }
});

test('a job that already stores the mobile can identify that Messenger chat', async () => {
  const s = await setup();
  try {
    const psid = '5551120000';
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    s.app.bot.store.data.ops.jobs.push({ id: 'J1', phone: '09175550000', psid, customerName: 'Job Person' });
    const raw = submission({
      name: 'Job Person', willingToWait: 'yes', pdate: '2026-11-12', mobile: '09175550000',
    }, 'sub-job');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    assert.equal(s.app.bot.store.thread(psid).bookingSource, 'phone');
    assert.match(sentTexts(s.mock)[0], /Regular service po kayo/);
  } finally { await s.close(); }
});

test('two chats with the same mobile are not messaged', async () => {
  const s = await setup();
  try {
    for (const id of ['5551118881', '5551118882']) {
      const t = s.app.bot.store.thread(id);
      t.lastUserTs = Date.now();
      t.history.push({ role: 'user', content: '09190001111', ts: Date.now() });
    }
    const raw = submission({ name: 'Duo', willingToWait: 'yes', pdate: '2026-11-12', mobile: '09190001111' }, 'sub-duo');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, false);
    assert.equal(out.body.reason, 'phone matched more than one chat');
    assert.equal(sentTexts(s.mock).length, 0);
    const listed = await fetch(`${s.base}/admin/booking-confirms`);
    assert.equal(listed.status, 401);
  } finally { await s.close(); }
});

test('admin booking link is signed and another form name is ignored', async () => {
  const s = await setup();
  try {
    s.app.cfg.adminToken = 'adm';
    const denied = await fetch(`${s.base}/admin/booking-link?psid=2468013579&page=cavite`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${s.base}/admin/booking-link?psid=2468013579&page=cavite`, {
      headers: { Authorization: 'Bearer adm' },
    });
    const body = await res.json();
    assert.equal(body.page, 'cavite');
    assert.deepEqual(bc.readToken(s.app.cfg, new URL(body.url).searchParams.get('token')), { psid: '2468013579', page: 'cavite' });
    const raw = JSON.stringify({ id: 'other', form_name: 'contact', data: { name: 'X', willingToWait: 'yes' } });
    const ignored = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(ignored.body.reason, 'ignored form');
    assert.equal(sentTexts(s.mock).length, 0);
  } finally { await s.close(); }
});

test('the browser confirm and the webhook do not send two messages for one booking', async () => {
  const s = await setup();
  try {
    const psid = '5551119999';
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    const ref = bc.makeRef(s.app.cfg, psid);
    const token = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const browser = await s.submit({ ref, name: 'Ana Reyes', wait: 'no', bookingId: 'BK-90' });
    assert.equal((await browser.json()).sent, true);
    const raw = submission({
      name: 'Ana Reyes', willingToWait: 'no', pdate: '2026-11-12', psid, page: 'sanpablo', token,
    }, 'sub-both');
    const hook = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(hook.body.sent, false);
    assert.equal(sentTexts(s.mock).length, 1);
  } finally { await s.close(); }
});

