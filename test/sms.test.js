'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { loadConfig } = require('../src/config');
const { ensureOps, importOps } = require('../src/ops');
const {
  DEFAULT_CONFIRM_TEMPLATE, normalizePhNumber, isConfirmReply, smsBadge, confirmTemplate, parseInbound, tokenOk,
} = require('../src/sms');

const NOON = Date.parse('2026-10-18T04:00:00Z'); // 12:00 Asia/Manila

async function setup(extraEnv = {}) {
  const mock = await startMock();
  const env = {
    PORT: '0', VERIFY_TOKEN: 'verify_me', APP_SECRET: 'test_app_secret', APP_ID: '999000111', PAGE_ID: '102622881557025',
    PAGE_ACCESS_TOKEN: 'PAGE_TOKEN', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`,
    LLM_API_KEY: 'sk-test', LLM_MODEL: 'mock-model', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-sms-')), LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'adm', DASHBOARD_PASSWORD: 'secret', ...extraEnv,
  };
  const app = build(env);
  app.llm.sleep = async () => {};
  app.bot.now = () => NOON;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, base, close };
}

async function cookie(base) {
  const login = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=secret&next=%2Fops',
  });
  return (login.headers.get('set-cookie').match(/jmags_dash=[^;]+/) || [])[0];
}

function addJob(app, partial) {
  const ops = ensureOps(app.store);
  const job = {
    id: 'JO-SMS-001', date: '2026-10-18', visitDate: '2026-10-19', visitTime: '10:00 AM',
    customerName: 'Mara Quill', phone: '09175550011', city: 'Testville', address: '4 Sample Lane',
    unitType: 'TV', brand: 'Inventa', size: '32', issue: 'no power', technician: 'JM',
    branch: 'San Pablo', status: 'Scheduled', price: 0,
    smsForDate: '', smsSentAt: '', smsMessageId: '', smsStatus: '', smsConfirmedAt: '',
    ...partial,
  };
  ops.jobs.push(job);
  app.store.save();
  return job;
}

async function postAction(base, jar, body) {
  const res = await fetch(`${base}/ops/action`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const location = res.headers.get('location') || '';
  const page = location ? await (await fetch(`${base}${location}`, { headers: { Cookie: jar } })).text() : '';
  return { status: res.status, location, page };
}

test('Philippine numbers, confirm words, and SMS defaults', () => {
  assert.equal(normalizePhNumber('09175550011'), '639175550011');
  assert.equal(normalizePhNumber('+63 917 555 0011'), '639175550011');
  assert.equal(normalizePhNumber('639175550011'), '639175550011');
  assert.equal(normalizePhNumber('9175550011'), '639175550011');
  assert.equal(normalizePhNumber('12345'), '');
  assert.equal(isConfirmReply('CONFIRM'), true);
  assert.equal(isConfirmReply('confirm po'), true);
  assert.equal(isConfirmReply('Oo'), true);
  assert.equal(isConfirmReply('yes please'), true);
  assert.equal(isConfirmReply('yesterday'), false);
  assert.equal(isConfirmReply('no'), false);
  assert.equal(isConfirmReply('book'), false);
  const cfg = loadConfig({});
  assert.equal(cfg.smsEnabled, false);
  assert.equal(cfg.smsSenderName, 'JMAGS');
  assert.equal(cfg.semaphoreApiKey, '');
  assert.equal(confirmTemplate(cfg), DEFAULT_CONFIRM_TEMPLATE);
  assert.equal(loadConfig({ SMS_ENABLED: '' }).smsEnabled, false);
  assert.equal(loadConfig({ SMS_SENDER_NAME: '' }).smsSenderName, 'JMAGS');
  assert.equal(loadConfig({ SMS_ENABLED: 'true', SMS_CONFIRM_TEMPLATE: 'Bukas po.\\nSalamat' }).smsConfirmTemplate, 'Bukas po.\nSalamat');
  assert.equal(smsBadge({ visitDate: '2026-10-19', smsForDate: '2026-10-19', smsStatus: 'sent' }, '2026-10-18'), 'Text sent');
  assert.equal(smsBadge({ visitDate: '2026-10-18', smsForDate: '2026-10-18', smsStatus: 'sent', smsSentAt: '2026-10-17T04:00:00.000Z' }, '2026-10-18'), 'No reply');
  assert.equal(smsBadge({ visitDate: '2026-10-18', smsForDate: '2026-10-18', smsStatus: 'sent', smsSentAt: '2026-10-18T02:00:00.000Z' }, '2026-10-18'), 'Text sent');
  assert.equal(smsBadge({ visitDate: '2026-10-17', smsForDate: '2026-10-17', smsStatus: 'sent' }, '2026-10-18'), 'No reply');
  assert.equal(smsBadge({ visitDate: '2026-10-19', smsForDate: '2026-10-19', smsStatus: 'confirmed' }, '2026-10-18'), 'Confirmed');
  assert.equal(smsBadge({ visitDate: '2026-10-20', smsForDate: '2026-10-19', smsStatus: 'sent' }, '2026-10-18'), '');
  const parsed = parseInbound('sender=09175550011&message=CONFIRM', 'application/x-www-form-urlencoded');
  assert.equal(parsed.from, '09175550011');
  assert.equal(parsed.text, 'CONFIRM');
  assert.equal(tokenOk({ smsInboundToken: 'inbound-secret' }, 'inbound-secret'), true);
  assert.equal(tokenOk({ smsInboundToken: 'inbound-secret' }, 'nope'), false);
  assert.equal(tokenOk({ smsInboundToken: '' }, ''), true);
});

test('SMS stays off until it is configured, and a tap sends nothing', async () => {
  const s = await setup();
  let called = false;
  s.app.cfg.smsFetch = async () => { called = true; throw new Error('should not send'); };
  try {
    addJob(s.app);
    const jar = await cookie(s.base);
    const today = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(today, /SMS not set up yet/);
    assert.match(today, /id="sms-log"/);
    assert.match(today, /No texts sent yet/);
    assert.doesNotMatch(today, /Send confirmation text/);
    const sent = await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.equal(sent.status, 303);
    assert.match(sent.page, /data-sms-notice="sms-off"/);
    assert.match(sent.page, /SMS not set up yet/);
    assert.equal(called, false);
    assert.equal(s.app.store.data.ops.jobs[0].smsStatus || '', '');
    assert.equal((await fetch(`${s.base}/ops/action`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=send-sms&id=JO-SMS-001' })).status, 403);
  } finally { await s.close(); }
});

test('a confirmation text sends once per visit date, then a reply or a button can confirm it', async () => {
  const s = await setup({
    SMS_ENABLED: 'true', SEMAPHORE_API_KEY: 'sem-test-key', SMS_SENDER_NAME: 'JMAGS', SMS_INBOUND_TOKEN: 'inbound-secret',
  });
  const calls = [];
  s.app.cfg.smsFetch = async (url, opts) => {
    calls.push({ url, body: String(opts.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify([{ message_id: 4200 + calls.length, status: 'Pending' }]) };
  };
  try {
    addJob(s.app);
    addJob(s.app, { id: 'JO-SMS-002', customerName: 'Theo Farrow', phone: '09175550022', visitDate: '2026-10-19' });
    const jar = await cookie(s.base);
    const before = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(before, /data-sms="send"/);
    assert.match(before, /Send confirmation text/);
    assert.doesNotMatch(before, /09175550011/);
    assert.doesNotMatch(before, /sem-test-key/);

    const sent = await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.equal(sent.status, 303);
    assert.match(sent.location, /notice=sms-sent/);
    assert.match(sent.page, /data-sms-badge="JO-SMS-001">Text sent/);
    assert.match(sent.page, /id="sms-log"/);
    assert.match(sent.page, /···0011/);
    assert.doesNotMatch(sent.page, /09175550011/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.semaphore.co/api/v4/messages');
    const body = new URLSearchParams(calls[0].body);
    assert.equal(body.get('apikey'), 'sem-test-key');
    assert.equal(body.get('number'), '639175550011');
    assert.equal(body.get('sendername'), 'JMAGS');
    assert.equal(body.get('message'), DEFAULT_CONFIRM_TEMPLATE);
    const job = s.app.store.data.ops.jobs.find((item) => item.id === 'JO-SMS-001');
    assert.equal(job.smsStatus, 'sent');
    assert.equal(job.smsForDate, '2026-10-19');
    assert.equal(job.smsMessageId, '4201');

    const again = await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.match(again.location, /notice=sms-already/);
    assert.equal(calls.length, 1);

    const ignored = await fetch(`${s.base}/sms/inbound?token=inbound-secret`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: '639175550011', message: 'bukas na lang' }),
    });
    assert.equal(ignored.status, 200);
    assert.equal((await ignored.json()).confirmed, false);
    assert.equal(s.app.store.data.ops.jobs.find((item) => item.id === 'JO-SMS-001').smsStatus, 'sent');

    const denied = await fetch(`${s.base}/sms/inbound`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: '639175550011', message: 'CONFIRM' }),
    });
    assert.equal(denied.status, 403);

    const confirmed = await fetch(`${s.base}/sms/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Sms-Token': 'inbound-secret' },
      body: 'sender=09175550011&message=oo',
    });
    assert.equal((await confirmed.json()).confirmed, true);
    assert.equal(s.app.store.data.ops.jobs.find((item) => item.id === 'JO-SMS-001').smsStatus, 'confirmed');
    const afterReply = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(afterReply, /data-sms-badge="JO-SMS-001">Confirmed/);

    const marked = await postAction(s.base, jar, 'action=mark-sms-confirmed&id=JO-SMS-002&returnTab=today');
    assert.match(marked.page, /data-sms-badge="JO-SMS-002">Confirmed/);
    assert.equal(calls.length, 1);

    job.visitDate = '2026-10-20';
    job.smsStatus = 'sent';
    s.app.store.save();
    await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.equal(calls.length, 2);
    assert.equal(s.app.store.data.ops.jobs.find((item) => item.id === 'JO-SMS-001').smsForDate, '2026-10-20');
  } finally { await s.close(); }
});

test('a failed send can be retried, and a missed visit shows No reply', async () => {
  const s = await setup({ SMS_ENABLED: 'true', SEMAPHORE_API_KEY: 'sem-test-key' });
  let fail = true;
  s.app.cfg.smsFetch = async () => {
    if (fail) return { ok: false, status: 429, text: async () => '{"error":"busy"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify([{ message_id: 77, status: 'Queued' }]) };
  };
  try {
    addJob(s.app);
    const jar = await cookie(s.base);
    const failed = await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.match(failed.location, /notice=sms-failed/);
    assert.equal(s.app.store.data.ops.jobs[0].smsStatus || '', '');
    assert.equal(s.app.store.data.ops.smsLog.at(-1).kind, 'failed');
    fail = false;
    const sent = await postAction(s.base, jar, 'action=send-sms&id=JO-SMS-001&returnTab=today');
    assert.match(sent.page, /data-sms-badge="JO-SMS-001">Text sent/);
    s.app.bot.now = () => Date.parse('2026-10-19T04:00:00Z');
    const later = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(later, /data-sms-badge="JO-SMS-001">No reply/);
  } finally { await s.close(); }
});

test('re-import keeps the SMS record on the job', () => {
  const store = { data: {}, save() {} };
  importOps(store, {
    jobsCsv: 'Job ID,Date received,Customer name,Contact,Status,Branch\nJO-SMS-001,2026-10-18,Mara Quill,09175550011,Scheduled,San Pablo',
  });
  const job = store.data.ops.jobs[0];
  job.smsStatus = 'confirmed';
  job.smsForDate = '2026-10-19';
  job.smsMessageId = '55';
  importOps(store, {
    jobsCsv: 'Job ID,Date received,Customer name,Contact,Status,Branch\nJO-SMS-001,2026-10-18,Mara Quill,09175550011,Scheduled,San Pablo',
  });
  assert.equal(store.data.ops.jobs[0].smsStatus, 'confirmed');
  assert.equal(store.data.ops.jobs[0].smsMessageId, '55');
  assert.equal(store.data.ops.jobs[0].smsForDate, '2026-10-19');
});
