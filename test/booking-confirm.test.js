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

test('a form with no signed ref does not message whoever opens Messenger', async () => {
  const s = await setup();
  try {
    s.app.cfg.botEnabled = true;
    s.mock.state.botSwitches = [
      { page_key: 'sanpablo', enabled: false },
      { page_key: 'cavite', enabled: false },
    ];
    const body = await (await s.submit({ name: 'Pedro', wait: 'yes' })).json();
    assert.equal(body.sent, false);
    assert.equal(body.messengerUrl, '');
    const ref = bc.referralRef('Pedro', 'yes');
    await s.webhook(referral('7770002222', ref));
    await s.webhook(text('7770002222', 'hello po'));
    assert.equal(sentTexts(s.mock).length, 0);
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

test('a forged token or a matching phone does not get a message', async () => {
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
    assert.equal(ok.body.sent, false);
    assert.match(ok.body.reason, /Booking needs staff/);
    assert.equal(sentTexts(s.mock).length, 0);
    assert.notEqual(s.app.bot.store.thread(psid).bookingSource, 'phone');
  } finally { await s.close(); }
});

test('a stored job phone does not receive the confirm', async () => {
  const s = await setup();
  try {
    const psid = '5551120000';
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    s.app.bot.store.data.ops.jobs.push({ id: 'J1', phone: '09175550000', psid, customerName: 'Job Person' });
    const raw = submission({
      name: 'Job Person', willingToWait: 'yes', pdate: '2026-11-12', mobile: '09175550000',
    }, 'sub-job');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, false);
    assert.match(out.body.reason, /Booking needs staff/);
    assert.equal(sentTexts(s.mock).length, 0);
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
    assert.match(out.body.reason, /Booking needs staff/);
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

test('confirm goes only to the submitter and does not turn any switch on', async () => {
  const s = await setup({ CAVITE_PAGE_ACCESS_TOKEN: 'CAV-TOKEN', BATCH_WINDOW_MS: '0' });
  try {
    s.app.cfg.botEnabled = false;
    s.mock.state.botSwitches = [
      { page_key: 'sanpablo', enabled: false },
      { page_key: 'cavite', enabled: false },
    ];
    const psid = '5551130001';
    const other = '5551130002';
    const caviteCustomer = '5551130003';
    s.app.bot.store.thread(psid).lastUserTs = Date.now();
    const token = bc.makeToken(s.app.cfg, psid, 'sanpablo');
    const raw = submission({
      name: 'Only One', willingToWait: 'yes', pdate: '2026-11-12',
      psid, page: 'sanpablo', token, mobile: '09170000000',
    }, 'sub-only');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    assert.equal(s.mock.calls.messages[0].recipient.id, psid);
    assert.equal(s.app.cfg.botEnabled, false);
    assert.deepEqual(s.mock.state.botSwitches.map((row) => row.enabled), [false, false]);

    await s.webhook(text(psid, 'AGREE po'));
    assert.equal(sentTexts(s.mock).length, 2);
    assert.equal(s.mock.calls.messages[1].recipient.id, psid);
    const thread = s.app.bot.store.thread(psid);
    assert.equal(thread.bookingConfirmed, true);
    assert.equal(thread.bookingStaffOnly, true);
    assert.equal(s.app.cfg.botEnabled, false);
    assert.deepEqual(s.mock.state.botSwitches.map((row) => row.enabled), [false, false]);

    s.app.cfg.botEnabled = true;
    await s.webhook(text(other, 'magkano po'));
    await s.webhook({
      object: 'page',
      entry: [{
        id: CAVITE,
        time: Date.now(),
        messaging: [{
          sender: { id: caviteCustomer },
          recipient: { id: CAVITE },
          timestamp: Date.now(),
          message: { mid: `bk.cav.${Date.now()}`, text: 'hello po' },
        }],
      }],
    });
    await s.webhook(text(psid, 'ano na po'));
    assert.equal(sentTexts(s.mock).length, 2);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.ok((s.mock.calls.switches || []).length >= 1);
    assert.ok((s.mock.calls.switches || []).every((call) => call.method === 'GET'));

    s.app.bot.switches.cache = null;
    s.app.bot.switches.cacheMs = 0;
    s.mock.state.botSwitches = [
      { page_key: 'sanpablo', enabled: true },
      { page_key: 'cavite', enabled: true },
    ];
    assert.equal(await s.app.bot.send(psid, 'Auto status po', { ops: true }), false);
    assert.equal(sentTexts(s.mock).length, 2);
    await s.webhook(text(other, 'hello po'));
    const replies = s.mock.calls.messages.map((m) => m.recipient.id);
    assert.deepEqual(replies.slice(0, 2), [psid, psid]);
    assert.ok(replies.slice(2).includes(other));
    assert.equal(replies.includes(psid) ? replies.filter((id) => id === psid).length : 0, 2);
    assert.equal(replies.includes(caviteCustomer), false);
  } finally { await s.close(); }
});

function echo(psid, body, pageId = PAGE) {
  return {
    object: 'page',
    entry: [{
      id: pageId,
      time: Date.now(),
      messaging: [{
        sender: { id: pageId },
        recipient: { id: psid },
        timestamp: Date.now(),
        message: { mid: `echo.${++n}`, is_echo: true, app_id: '999', text: body },
      }],
    }],
  };
}

test('the live calendar date 11/12/26 is included, including from the details text', () => {
  const fromField = bc.parseNetlifySubmission({
    form_name: 'booking',
    data: { name: 'Ana Cruz', willingToWait: 'yes', pdate: '11/12/26' },
  });
  assert.match(bc.confirmText(fromField.name, 'yes', fromField.date), /Regular service po kayo sa Huwebes, Nov 12\./);
  const fromDetails = bc.parseNetlifySubmission({
    data: { name: 'Ana Cruz', willingToWait: 'yes', details: 'Preferred date: 11/12/26\nService type: REGULAR' },
  });
  assert.equal(bc.prettyBookingDate(fromDetails.date), 'Huwebes, Nov 12');
});

test('initials are not a name clash, a real clash blocks, and two chats stay ambiguous', () => {
  const live = [{
    psid: '5550009161', pageKey: 'sanpablo', entryIds: ['a'],
    phones: ['09386369374'], names: ['JM AG'], label: 'JM AG',
  }];
  const hit = bc.pickStaffLink(live, { name: 'Jhon Michael Angelo Guinto', mobile: '09386369374' });
  assert.equal(hit.match.psid, '5550009161');
  assert.equal(hit.decisions[0].why, 'accepted: unique mobile, name does not clash');
  assert.equal(JSON.stringify(hit.decisions).includes('09386369374'), false);
  assert.equal(JSON.stringify(hit.decisions).includes('5550009161'), false);

  const jmag = [{ ...live[0], names: ['JMAG'], label: 'JMAG' }];
  assert.equal(bc.pickStaffLink(jmag, { name: 'Jhon Michael Angelo Guinto', mobile: '09386369374' }).match.psid, '5550009161');

  const only = [{ ...live[0], phones: ['09170000000'] }];
  const anyPhone = bc.pickStaffLink(only, { name: 'Jhon Michael Angelo Guinto', mobile: '09998887777' });
  assert.equal(anyPhone.match.psid, '5550009161');
  assert.equal(anyPhone.decisions[0].why, 'accepted: only open staff link, name does not clash');

  const clash = [{
    psid: '5550009161', pageKey: 'sanpablo', entryIds: ['a'],
    phones: ['09386369374'], names: ['Maria Santos'], label: 'Maria Santos',
  }];
  const blocked = bc.pickStaffLink(clash, { name: 'Pedro Reyes', mobile: '09386369374' });
  assert.equal(blocked.match, null);
  assert.match(blocked.reason, /Booking needs staff/);
  assert.match(blocked.reason, /9161/);
  assert.equal(blocked.reason.includes('5550009161'), false);
  assert.equal(blocked.decisions[0].why, 'rejected: name clash');

  const two = [
    live[0],
    {
      psid: '5550001002', pageKey: 'sanpablo', entryIds: ['b'],
      phones: ['09386369374'], names: ['Ana Cruz'], label: 'Ana Cruz',
    },
  ];
  const amb = bc.pickStaffLink(two, { name: 'Jhon Michael Angelo Guinto', mobile: '09386369374' });
  assert.equal(amb.match, null);
  assert.match(amb.reason, /9161/);
  assert.match(amb.reason, /1002/);
  assert.equal(amb.decisions.every((row) => row.why.startsWith('rejected:')), true);
});

test('a stored name of JM AG still confirms the one chat that has the form phone', async () => {
  const s = await setup();
  const notes = [];
  s.app.bot.log.info = (...a) => notes.push(a.map(String).join(' '));
  try {
    const psid = '5550009161';
    s.app.bot.store.addTurn(psid, 'user', '09386369374', Date.now());
    s.app.bot.store.thread(psid).profileName = 'JM AG';
    await s.webhook(echo(psid, 'https://jmagscutomerform.netlify.app'));
    const raw = submission({
      name: 'Jhon Michael Angelo Guinto', mobile: '09386369374', willingToWait: 'yes', pdate: '11/12/26',
    }, 'sub-jm-ag');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    assert.equal(s.mock.calls.messages[0].recipient.id, psid);
    assert.match(sentTexts(s.mock)[0], /Jhon Michael Angelo Guinto/);
    assert.equal(s.app.store.data.formLinkSends.find((row) => row.psid === psid).consumedAt > 0, true);
    assert.ok(notes.some((line) => line.includes('staff form link recorded sanpablo') && line.includes('9161') && !line.includes(psid)));
    assert.ok(notes.some((line) => line.includes('booking staff-link sanpablo') && line.includes('9161') && line.includes('accepted: unique mobile')));
    assert.equal(notes.some((line) => line.includes('09386369374') || line.includes(psid)), false);

    const clash = await setup();
    try {
      const other = '5550009170';
      clash.app.bot.store.addTurn(other, 'user', 'Ako si Maria Santos, 09386369374', Date.now());
      await clash.webhook(echo(other, 'https://jmagscutomerform.netlify.app'));
      const rawClash = submission({
        name: 'Pedro Reyes', mobile: '09386369374', willingToWait: 'yes', pdate: '11/12/26',
      }, 'sub-clash');
      const blocked = await postHook(clash, rawClash, { 'X-Webhook-Signature': jws(rawClash) });
      assert.equal(blocked.body.sent, false);
      assert.match(blocked.body.reason, /Booking needs staff/);
      assert.match(blocked.body.reason, /9170/);
      assert.equal(blocked.body.reason.includes(other), false);
      assert.equal(sentTexts(clash.mock).length, 0);
      assert.equal(clash.app.store.data.formLinkSends.every((row) => !row.consumedAt), true);
    } finally { await clash.close(); }
  } finally { await s.close(); }
});

test('a staff form-link echo confirms only that chat, then the chatbot stays silent', async () => {
  const s = await setup({ BATCH_WINDOW_MS: '0' });
  try {
    const psid = '5551150001';
    s.app.bot.store.addTurn(psid, 'user', 'Ako si Ana Cruz, 09181234567', Date.now());
    await s.webhook(echo(psid, 'Paki fill-up po https://jmagscutomerform.netlify.app salamat'));
    const t = s.app.bot.store.thread(psid);
    assert.equal(t.bookingStaffOnly || false, false);
    assert.equal((s.app.store.data.formLinkSends || []).some((row) => row.psid === psid && !row.consumedAt), true);
    const raw = submission({
      name: 'Ana Cruz', mobile: '09181234567', willingToWait: 'yes', pdate: '11/12/26',
    }, 'sub-staff-1');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    assert.match(sentTexts(s.mock)[0], /sa Huwebes, Nov 12/);
    assert.equal(s.mock.calls.messages[0].recipient.id, psid);
    assert.equal(s.app.store.data.formLinkSends.find((row) => row.psid === psid).consumedAt > 0, true);

    t.pausedUntil = 0;
    t.pauseSource = '';
    await s.webhook(text(psid, 'AGREE'));
    const quiet = sentTexts(s.mock).length;
    t.pausedUntil = 0;
    t.pauseSource = '';
    s.app.cfg.botEnabled = true;
    await s.webhook(text(psid, 'magkano po ang repair'));
    assert.equal(sentTexts(s.mock).length, quiet);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(t.bookingStaffOnly, true);
    s.app.cfg.botEnabled = false;
    await s.webhook(text(psid, 'hello po ulit'));
    assert.equal(sentTexts(s.mock).length, quiet);
    assert.equal(s.mock.calls.llm.length, 0);

    const again = submission({
      name: 'Ana Cruz', mobile: '09181234567', willingToWait: 'yes', pdate: '11/13/26',
    }, 'sub-staff-2');
    const second = await postHook(s, again, { 'X-Webhook-Signature': jws(again) });
    assert.equal(second.body.sent, false);
    assert.equal(sentTexts(s.mock).length, quiet);
  } finally { await s.close(); }
});

test('two staff-link chats with the same mobile are not messaged, and a chat that never got the link is not either', async () => {
  const s = await setup();
  try {
    const a = '5551151001';
    const b = '5551151002';
    const stranger = '5551151003';
    s.app.bot.store.addTurn(a, 'user', '09170001111 Ana Cruz', Date.now());
    s.app.bot.store.addTurn(b, 'user', '09170001111 Juan Cruz', Date.now());
    s.app.bot.store.addTurn(stranger, 'user', 'number ko 09170001111', Date.now());
    await s.webhook(echo(a, 'https://www.jmagscutomerform.netlify.app/'));
    await s.webhook(echo(b, 'http://jmagscutomerform.netlify.app'));
    const raw = submission({
      name: 'Ana Cruz', mobile: '09170001111', willingToWait: 'no', pdate: '11/12/26',
    }, 'sub-two');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, false);
    assert.match(out.body.reason, /Booking needs staff/);
    assert.match(out.body.reason, /1001/);
    assert.match(out.body.reason, /1002/);
    assert.equal(out.body.reason.includes(a), false);
    assert.equal(sentTexts(s.mock).length, 0);
    assert.equal(s.app.store.data.formLinkSends.every((row) => !row.consumedAt), true);

    const onlyStranger = await setup();
    try {
      onlyStranger.app.bot.store.addTurn(stranger, 'user', '09175556666', Date.now());
      const lone = submission({
        name: 'Ana Cruz', mobile: '09175556666', willingToWait: 'yes', pdate: '11/12/26',
      }, 'sub-stranger');
      const missed = await postHook(onlyStranger, lone, { 'X-Webhook-Signature': jws(lone) });
      assert.equal(missed.body.sent, false);
      assert.equal(sentTexts(onlyStranger.mock).length, 0);
    } finally { await onlyStranger.close(); }
  } finally { await s.close(); }
});

test('a Cavite staff echo confirms with the Cavite Page token', async () => {
  const s = await setup({ CAVITE_PAGE_ACCESS_TOKEN: 'CAV-TOKEN' });
  try {
    const psid = '5551152001';
    const cav = s.app.cfg.pages.find((p) => p.key === 'cavite');
    await withPage(cav, () => s.app.bot.store.addTurn(psid, 'user', 'Cely Ramos 09183334444', Date.now()));
    await s.webhook(echo(psid, 'https://jmagscutomerform.netlify.app', CAVITE));
    assert.equal(s.app.store.data.formLinkSends[0].pageKey, 'cavite');
    const raw = submission({
      name: 'Cely Ramos', mobile: '09183334444', willingToWait: 'yes', service: 'REGULAR', pdate: '11/12/26',
    }, 'sub-cav-staff');
    const out = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(out.body.sent, true);
    assert.ok(s.mock.calls.pages.some((p) => p.kind === 'message' && p.token === 'CAV-TOKEN' && p.path.includes(CAVITE)));
  } finally { await s.close(); }
});

test('copy form link uses the card id for both Pages and does not touch the chat', async () => {
  const { listPage } = require('../src/dashboard-page');
  const { threadCardId } = require('../src/form-link-card');
  const shown = '5550001111';
  const html = listPage({ replyWindowHours: 23.5, pageId: PAGE }, [{
    id: 'aa11bb22cc33dd44',
    timestamp: new Date().toISOString(),
    psid: shown,
    psidLast4: '1111',
    customerName: 'Ana Cruz',
    status: 'new',
    type: 'photo',
    summary: {},
  }], {
    [shown]: { history: [{ role: 'user', content: '09171234567', ts: Date.now() }], lastUserTs: Date.now() },
  }, Date.now(), []);
  assert.match(html, /Copy form link/);
  assert.match(html, /data-card-id="aa11bb22cc33dd44"/);
  assert.match(html, /data-find="Ana Cruz 1111 4567"/);
  assert.match(html, /id="card-search"/);
  assert.equal(html.includes(shown), false);
  assert.equal(html.match(/data-find="([^"]+)"/)[1].includes('09171234567'), false);

  const s = await setup({ CAVITE_PAGE_ACCESS_TOKEN: 'CAV-TOKEN', ADMIN_TOKEN: 'adm' });
  try {
    const denied = await fetch(`${s.base}/dashboard/api/booking-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'aa11bb22cc33dd44' }),
    });
    assert.equal(denied.status, 403);
    const psid = '5551142001';
    const thread = s.app.bot.store.thread(psid);
    thread.lastUserTs = Date.now();
    const before = JSON.stringify(thread);
    const enabledBefore = s.app.cfg.botEnabled;
    s.app.bot.store.data.reviews.push({
      id: 'aa11bb22cc33dd44',
      psid,
      pageId: PAGE,
      threadKey: psid,
      psidLast4: '2001',
      customerName: 'Ana Cruz',
      status: 'new',
      type: 'photo',
      timestamp: new Date().toISOString(),
    });
    const cavitePsid = '5551142002';
    const cavite = s.app.cfg.pages.find((p) => p.key === 'cavite');
    await withPage(cavite, () => { s.app.bot.store.thread(cavitePsid).lastUserTs = Date.now(); });
    const caviteKey = `${CAVITE}:${cavitePsid}`;
    const res = await fetch(`${s.base}/dashboard/api/booking-link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'aa11bb22cc33dd44' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'page', 'url']);
    assert.equal(body.page, 'sanpablo');
    assert.deepEqual(bc.readToken(s.app.cfg, new URL(body.url).searchParams.get('token')), { psid, page: 'sanpablo' });
    assert.equal(JSON.stringify(s.app.bot.store.thread(psid)), before);
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal((s.mock.calls.switches || []).length, 0);
    assert.equal(s.app.cfg.botEnabled, enabledBefore);
    const cav = await (await fetch(`${s.base}/dashboard/api/booking-link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: threadCardId(caviteKey) }),
    })).json();
    assert.equal(cav.page, 'cavite');
    assert.deepEqual(bc.readToken(s.app.cfg, new URL(cav.url).searchParams.get('token')), { psid: cavitePsid, page: 'cavite' });
    assert.equal(s.mock.calls.messages.length, 0);
    const missing = await fetch(`${s.base}/dashboard/api/booking-link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: psid }),
    });
    assert.equal(missing.status, 404);
  } finally { await s.close(); }
});

test('after the form link, submit, and AGREE the chatbot stays silent with the bot on or off', async () => {
  const s = await setup({ BATCH_WINDOW_MS: '0', ADMIN_TOKEN: 'adm' });
  try {
    const psid = '5551143001';
    const other = '5551143099';
    s.app.cfg.botEnabled = true;
    s.mock.state.botSwitches = [
      { page_key: 'sanpablo', enabled: true },
      { page_key: 'cavite', enabled: true },
    ];
    s.app.bot.switches.cache = null;
    s.app.bot.switches.cacheMs = 0;
    const thread = s.app.bot.store.thread(psid);
    thread.lastUserTs = Date.now();
    const reviewId = 'bb22cc33dd44ee55';
    s.app.bot.store.data.reviews.push({
      id: reviewId,
      psid,
      pageId: PAGE,
      threadKey: psid,
      psidLast4: '3001',
      customerName: 'Ana Link',
      status: 'new',
      type: 'photo',
      timestamp: new Date().toISOString(),
    });
    const linked = await (await fetch(`${s.base}/dashboard/api/booking-link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: reviewId }),
    })).json();
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(thread.bookingStaffOnly || false, false);
    const token = new URL(linked.url).searchParams.get('token');
    const raw = submission({
      name: 'Ana Link', willingToWait: 'yes', pdate: '2026-11-12',
      psid, page: 'sanpablo', token,
    }, 'sub-silence');
    const sent = await postHook(s, raw, { 'X-Webhook-Signature': jws(raw) });
    assert.equal(sent.body.sent, true);
    await s.webhook(text(psid, 'AGREE'));
    assert.equal(thread.bookingConfirmed, true);
    assert.equal(thread.bookingStaffOnly, true);
    const quiet = sentTexts(s.mock).length;

    s.app.cfg.botEnabled = true;
    await s.webhook(text(psid, 'magkano po ang repair'));
    assert.equal(sentTexts(s.mock).length, quiet);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(thread.bookingStaffOnly, true);

    s.app.cfg.botEnabled = false;
    await s.webhook(text(psid, 'hello po nandito pa ako'));
    assert.equal(sentTexts(s.mock).length, quiet);
    assert.equal(s.mock.calls.llm.length, 0);
    assert.equal(thread.bookingStaffOnly, true);

    s.app.cfg.botEnabled = true;
    await s.webhook(text(other, 'hello po'));
    assert.ok(s.mock.calls.messages.some((m) => m.recipient && m.recipient.id === other));
    assert.equal(s.mock.calls.messages.filter((m) => m.recipient && m.recipient.id === psid).length, quiet);
  } finally { await s.close(); }
});

