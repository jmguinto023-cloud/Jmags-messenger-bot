'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const { ensureOps } = require('../src/ops');
const { saysFormDone, FORM_OK, FORM_MISSING } = require('../src/customer-context');
const { readRef } = require('../src/booking-confirm');

const SECRET = 's';
const MAIN = '102622881557025';
const FORM = 'https://jmagscutomerform.netlify.app/';

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

async function setup() {
  const mock = await startMock();
  const app = build({
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: SECRET, APP_ID: '1', PAGE_ID: MAIN, PAGE_ACCESS_TOKEN: 'T',
    GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm',
    BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0', LOG_LEVEL: 'silent',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    BOOKING_FORM_URL: FORM,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-ctx-')),
  });
  app.llm.sleep = async () => {};
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const say = async (psid, text) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({
      object: 'page',
      entry: [{ id: MAIN, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: MAIN }, timestamp: ts, message: { mid: `c.${n}`, text } }] }],
    });
    await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
      body: raw,
    });
    await app.bot.idle();
  };
  const texts = (psid) => mock.calls.messages.filter((m) => m.recipient && m.recipient.id === psid).map((m) => m.message.text);
  return { app, mock, say, texts, close: async () => { await app.bot.idle(); app.server.close(); await mock.close(); } };
}

function openGate(thread) {
  thread.videoReceived = true;
  thread.videoReviewed = true;
  thread.slots = {
    brand: 'Samsung', size: '55"', symptom: 'backlight', model: 'UA55AU7000',
    city: 'lipa', barangay: 'Marawoy', repairedElsewhere: 'no',
  };
}

test('a sent video is not a finished booking form', () => {
  assert.equal(saysFormDone('na-send ko na ang video'), false);
  assert.equal(saysFormDone('nasend ko na ang photo'), false);
  assert.equal(saysFormDone('nag-fill up na ako'), true);
  assert.equal(saysFormDone('done na po'), true);
  assert.equal(saysFormDone('na-send ko na ang form'), true);
});

test('full inbox history and a past job are in the reply', async () => {
  const ctx = await setup();
  try {
    const ago = new Date(Date.now() - 20 * 3600e3).toISOString();
    const older = new Date(Date.now() - 30 * 3600e3).toISOString();
    ctx.mock.state.conversations = { hist: { id: 'c-hist' } };
    ctx.mock.state.messagePages = { 'c-hist': [
      [{ message: 'Samsung 55 inch po, model UA55AU7000', from: { id: 'hist' }, created_time: older }],
      [{ message: 'Sige po, 8500 all-in na yan. Bukas ng umaga ang schedule.', from: { id: MAIN }, created_time: ago }],
    ]};
    ensureOps(ctx.app.store).jobs.push({
      id: 'JO-9', psid: 'hist', customerName: 'Ana Cruz', phone: '09171234567',
      status: 'Completed', price: 8500, issue: 'backlight', brand: 'Samsung', size: '55',
    });
    await ctx.say('hist', 'hello po');
    const thread = ctx.app.store.thread('hist');
    const blob = (thread.history || []).map((h) => h.content).join('\n');
    assert.match(blob, /Samsung 55 inch/);
    assert.match(blob, /8500 all-in/);
    assert.equal(thread.returning, true);
    assert.match(thread.customerContext, /JO-9/);
    assert.match(thread.customerContext, /8500 all-in/);
    const sent = ctx.texts('hist');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^Welcome back po\./);
    const note = JSON.stringify(ctx.mock.calls.llm);
    assert.match(note, /JO-9/);
    assert.match(note, /8500 all-in/);
  } finally { await ctx.close(); }
});

test('a human staff reply in the last 12 hours keeps the bot quiet', async () => {
  const ctx = await setup();
  try {
    ctx.mock.state.conversations = { quiet: { id: 'c-quiet' } };
    ctx.mock.state.threadMessages = { 'c-quiet': [{
      message: 'Ako na ang bahala dito.',
      from: { id: MAIN },
      created_time: new Date(Date.now() - 3600e3).toISOString(),
    }]};
    await ctx.say('quiet', 'hello po');
    assert.deepEqual(ctx.texts('quiet'), []);
    const thread = ctx.app.store.thread('quiet');
    assert.equal(thread.pauseSource, 'staff inbox history');
  } finally { await ctx.close(); }
});

test('an agreed deal gets the booking form once, then one confirmation', async () => {
  const ctx = await setup();
  try {
    const psid = '5550001111';
    openGate(ctx.app.store.thread(psid));
    await ctx.say(psid, 'sige po pa-book');
    const first = ctx.texts(psid);
    assert.equal(first.length, 1);
    assert.match(first[0], /jmagscutomerform\.netlify\.app/);
    assert.match(first[0], /psid=5550001111/);
    assert.match(first[0], /brand=Samsung/);
    const link = first[0].match(/https:\/\/\S+/)[0];
    assert.equal(readRef(ctx.app.cfg, new URL(link).searchParams.get('ref')), psid);
    ensureOps(ctx.app.store).jobs.push({
      id: 'BK-1', psid, customerName: 'Ana Cruz', phone: '', status: 'For Schedule', price: 8500,
    });
    await ctx.say(psid, 'nag-fill up na ako');
    const after = ctx.texts(psid);
    assert.equal(after.filter((t) => t.includes('Natanggap na po')).length, 1);
    assert.match(after.at(-1), /Natanggap na po namin ang booking form/);
    await ctx.say(psid, 'done na po');
    assert.equal(ctx.texts(psid).filter((t) => t.includes(FORM_OK)).length, 1);
  } finally { await ctx.close(); }
});

test('a missing form is flagged once and a video send is ignored', async () => {
  const ctx = await setup();
  try {
    const thread = ctx.app.store.thread('miss');
    openGate(thread);
    thread.bookingFormSent = true;
    await ctx.say('miss', 'na-send ko na ang video');
    assert.equal(ctx.texts('miss').some((t) => t.includes('Hindi pa po dumadating')), false);
    await ctx.say('miss', 'done na po');
    const flagged = ctx.texts('miss').filter((t) => t.includes('Hindi pa po dumadating'));
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0], FORM_MISSING);
    assert.equal(ctx.app.store.thread('miss').needsStaff, true);
    await ctx.say('miss', 'done na po');
    assert.equal(ctx.texts('miss').filter((t) => t.includes('Hindi pa po dumadating')).length, 1);
  } finally { await ctx.close(); }
});

test('a repeat problem on a past job is handed to staff and stays quiet', async () => {
  const ctx = await setup();
  try {
    ensureOps(ctx.app.store).jobs.push({
      id: 'JO-2', psid: 'back', customerName: 'Ana Cruz', status: 'Completed', price: 4500,
      issue: 'backlight', warrantyEnd: '2027-06-01', date: '2026-06-01',
    });
    await ctx.say('back', 'sira ulit po yung tv');
    const sent = ctx.texts('back');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /issue at video/);
    assert.match(sent[0], /Hindi pa po ako makakapangako kung covered/);
    assert.equal(ctx.app.store.thread('back').handedOff, true);
    assert.equal(ctx.app.store.thread('back').gateClosed, true);
    await ctx.say('back', 'hello ulit');
    assert.equal(ctx.texts('back').length, 1);
  } finally { await ctx.close(); }
});
