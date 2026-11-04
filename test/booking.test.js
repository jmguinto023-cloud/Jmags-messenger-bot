'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('./mock-meta-llm');
const { build } = require('../src/index');
const booking = require('../src/booking');
const hours = require('../src/hours');
const { detectLocation } = require('../src/branch');
const estimate = require('../src/estimate');
const prices = require('../knowledge/prices.json');

// Wed Nov 4 2026, 8:00 PM Manila.
const NOW = Date.parse('2026-11-04T12:00:00Z');

test('prices.json: owner TV prices are what the bot quotes', () => {
  assert.equal(estimate.LCD_MOD[40], 4500);
  assert.equal(estimate.LCD_MOD[75], 14000);
  assert.equal(estimate.LCD_MOD[85], undefined);
  assert.equal(estimate.BACKLIGHT[32], 2500);
  assert.equal(estimate.BACKLIGHT[75], 16000);
  assert.deepEqual([prices.backlight85.other, prices.backlight85.premium], [22000, 28000]);
  assert.deepEqual(estimate.PRICE_RANGE[32], [2000, 4800]);
  assert.deepEqual(estimate.PRICE_RANGE[85], [11500, 46000]);
  assert.ok(prices.conflicts.some((c) => c.item === 'LCD modification' && c.size === 55 && c.xlsx === 7500));
  assert.match(estimate.priceHint(85), /₱22,000 other brands, ₱28,000/);
  assert.match(estimate.confirmedPriceReply('magkano backlight', { history: [{ role: 'user', content: 'Sony 85 walang display' }] }), /₱28,000/);
  assert.match(estimate.confirmedPriceReply('magkano backlight', { history: [{ role: 'user', content: 'TCL 85 walang display' }] }), /₱22,000/);
});

test('hours: Mon-Sat 8-5, no Sundays, late evening starts tomorrow', () => {
  assert.deepEqual(hours.nextOpenDates(NOW, 4), ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09']);
  assert.equal(hours.isOpenDate('2026-11-08'), false);
  assert.equal(hours.parseDate('bukas po', NOW), '2026-11-05');
  assert.equal(hours.parseDate('sa Sabado', NOW), '2026-11-07');
  assert.equal(hours.parseDate('Nov 10', NOW), '2026-11-10');
  assert.equal(hours.parseDate('11/12', NOW), '2026-11-12');
  assert.equal(hours.parseHour('mga 2 ng hapon'), 14);
  assert.equal(hours.parseHour('10am'), 10);
  assert.equal(hours.parseHour('alas 3'), 15);
  assert.equal(hours.isOpenHour(17), false);
  assert.equal(hours.isOpenHour(8), true);
  // Morning: same-day allowed.
  assert.equal(hours.nextOpenDates(Date.parse('2026-11-05T01:00:00Z'), 1)[0], '2026-11-05');
  // Configurable closed days.
  assert.deepEqual(hours.nextOpenDates(NOW, 2, { bookingClosedDays: '0,6' }), ['2026-11-05', '2026-11-06', ].slice(0, 2));
  assert.equal(hours.isOpenDate('2026-11-07', { bookingClosedDays: '0,6' }), false);
});

test('branch routing by province/city, configurable', () => {
  assert.equal(detectLocation('Brgy San Jose, Calamba').branch, 'San Pablo');
  assert.equal(detectLocation('Brgy Bagong Bayan, San Pablo City, Laguna').branch, 'San Pablo');
  assert.equal(detectLocation('Brgy Salitran 2, Dasmariñas, Cavite').branch, 'Cavite');
  assert.equal(detectLocation('brgy 1 gentri').province, 'Cavite');
  for (const town of ['Lipa', 'Brgy Marawoy, Lipa City, Batangas', 'Sto. Tomas Batangas', 'Santo Tomas', 'Tanauan', 'Malvar']) {
    assert.equal(detectLocation(town).branch, 'San Pablo', town);
  }
  for (const town of ['Nasugbu', 'Batangas City', 'Lemery, Batangas', 'Batangas']) assert.equal(detectLocation(town).branch, 'Cavite', town);
  assert.equal(detectLocation('Lipa', { branchMap: '{"cities":{"lipa":"Cavite"}}' }).branch, 'Cavite');
  assert.equal(detectLocation('Rosario, Batangas').province, 'Batangas');
  assert.equal(detectLocation('Quezon City').branch, '');
});

function fakeFetch(reply = { ok: true, id: 'BK-1' }, status = 200) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: status < 300, status, json: async () => reply }; };
  f.calls = calls;
  return f;
}

async function run(thread, lines, opts) {
  const out = [];
  for (const l of lines) {
    thread.history = [...(thread.history || []), { role: 'user', content: l }];
    out.push(await booking.bookingTurn(thread, l, { now: NOW, ...opts }));
  }
  return out;
}

test('booking flow: asks step by step, reads back, books on OO with form payload', async () => {
  const f = fakeFetch();
  const cfg = { bookingIntakeUrl: 'https://x.supabase.co/functions/v1/ops-booking-intake', bookingIntakeKey: 'k', bookingFormUrl: 'https://form/' };
  const t = { history: [{ role: 'user', content: 'Samsung 55 walang display pero may sound' }] };
  const r = await run(t, [
    'pa book po',
    'Juan Dela Cruz',
    '0917 123 4567',
    'Blk 3 Lot 5 Brgy Salitran 2, Dasmariñas, Cavite',
    'sa Linggo po',
    'sa Lunes',
    '7pm',
    '10am',
  ], { cfg, fetchImpl: f });
  assert.match(r[0].text, /pangalan/);
  assert.match(r[1].text, /mobile/);
  assert.match(r[2].text, /address/);
  // Brand/size/problem prefilled from earlier chat -> straight to date.
  assert.match(r[3].text, /Kailan po kayo available/);
  assert.match(r[3].text, /Huwebes, Nov 5/);
  assert.match(r[4].text, /Sarado po kami ng Linggo, Nov 8/);
  assert.match(r[5].text, /oras/);
  assert.match(r[6].text, /8AM hanggang 5PM/);
  const sum = r[7].text;
  assert.match(sum, /Juan Dela Cruz/);
  assert.match(sum, /09171234567/);
  assert.match(sum, /Samsung 55"/);
  assert.match(sum, /Lunes, Nov 9, 10:00 AM/);
  assert.match(sum, /₱8,500/);
  assert.match(sum, /Reply OO/);
  assert.equal(f.calls.length, 0, 'nothing sent before yes');
  const [done] = await run(t, ['oo po'], { cfg, fetchImpl: f });
  assert.ok(done.booked);
  assert.equal(f.calls.length, 1);
  const p = f.calls[0].body;
  assert.equal(f.calls[0].opts.headers.apikey, 'k');
  assert.equal(p.name, 'Juan Dela Cruz');
  assert.equal(p.mobile, '09171234567');
  assert.equal(p.province, 'Cavite');
  assert.equal(p.appliance, 'TV');
  assert.equal(p.brand, 'Samsung');
  assert.equal(p.size, '55"');
  assert.equal(p.pdate, '2026-11-09');
  assert.equal(p.ptime, '10:00 AM');
  assert.equal(p.service, 'REGULAR');
  assert.equal(p.price, 8500);
  assert.equal(p.website, '');
  assert.match(p.details, /Branch: Cavite/);
  // Later messages go back to the normal bot.
  assert.equal(await booking.bookingTurn(t, 'salamat', { now: NOW, cfg, fetchImpl: f }), null);
});

test('booking: dry run when intake URL unset; correction before yes; failure falls back to form', async () => {
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const t = {};
  const lines = ['pa schedule po', 'ako si Ana Reyes 09181112222', 'Purok 2 Brgy Bagong Bayan, San Pablo City, Laguna',
    'washing machine', 'LG', 'ayaw umikot', 'bukas 2pm'];
  const r = await run(t, lines, { cfg: { bookingFormUrl: 'https://form/' }, log });
  assert.match(r.at(-1).text, /Paki-check/);
  assert.match(r.at(-1).text, /Washing machine LG/);
  const [fix] = await run(t, ['hindi, 09189998888 pala'], { cfg: {}, log });
  assert.match(fix.text, /Paki-check/);
  assert.match(fix.text, /09189998888/);
  const [ok] = await run(t, ['opo'], { cfg: {}, log });
  assert.ok(ok.dryRun);
  assert.ok(logs.some((l) => /DRY RUN/.test(l)));

  const t2 = {};
  const bad = fakeFetch({ error: 'x' }, 500);
  const cfg = { bookingIntakeUrl: 'https://x/ops-booking-intake', bookingFormUrl: 'https://jmagscutomerform.netlify.app/' };
  await run(t2, lines, { cfg, fetchImpl: bad, log });
  const [fail] = await run(t2, ['oo'], { cfg, fetchImpl: bad, log });
  assert.ok(fail.failed);
  assert.match(fail.text, /jmagscutomerform\.netlify\.app\/\?name=Ana\+Reyes/);
});

test('booking: no intent = untouched; side question mid-flow falls through', async () => {
  assert.equal(await booking.bookingTurn({}, 'magkano po backlight 55', { now: NOW }), null);
  const t = {};
  await run(t, ['pa book po'], { cfg: {} });
  const [q] = await run(t, ['magkano po ang check up?'], { cfg: {} });
  assert.equal(q, null);
  const [next] = await run(t, ['Maria Santos'], { cfg: {} });
  assert.match(next.text, /mobile/);
});

// End to end through the webhook with the flag on and a local fake intake server.
test('webhook: BOOKING_AGENT_ENABLED runs the booking flow and posts to intake', async () => {
  const got = [];
  const intake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"id":"BK-9"}'); });
  });
  await new Promise((r) => intake.listen(0, '127.0.0.1', r));
  const mock = await startMock();
  const PAGE = '102622881557025';
  const env = {
    PORT: '0', VERIFY_TOKEN: 'v', APP_SECRET: 's', APP_ID: '1', PAGE_ID: PAGE, PAGE_ACCESS_TOKEN: 'T', GRAPH_API_BASE: mock.base,
    LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'k', LLM_MODEL: 'm', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    SUPABASE_URL: mock.base, SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-book-')), LOG_LEVEL: 'silent',
    BOOKING_AGENT_ENABLED: 'true', BOOKING_INTAKE_URL: `http://127.0.0.1:${intake.address().port}/functions/v1/ops-booking-intake`,
  };
  const app = build(env);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const say = async (text) => {
    const ts = Date.now() + (++n);
    const raw = JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: '777' }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `bk.${n}`, text } }] }] });
    const sig = 'sha256=' + crypto.createHmac('sha256', 's').update(raw).digest('hex');
    await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return mock.calls.messages.at(-1).message.text;
  };
  try {
    const day = hours.nextOpenDates(Date.now() + 2 * 86400000, 1)[0];
    assert.match(await say('pa book po TCL 43 may linya'), /pangalan/);
    await say('Pedro Penduko');
    await say('09175550000');
    await say('Brgy Mabuhay, Carmona, Cavite');
    const sum = await say(`${day} 9am`);
    assert.match(sum, /Paki-check/);
    assert.match(sum, /₱5,000/);
    assert.equal(got.length, 0);
    assert.match(await say('oo'), /Na-receive na po namin ang booking/);
    assert.equal(got.length, 1);
    assert.equal(got[0].pdate, day);
    assert.equal(got[0].city, 'Carmona');
    assert.equal(mock.calls.llm.length, 0, 'booking turns never call the LLM');
  } finally {
    await app.bot.idle(); app.server.close(); intake.close(); await mock.close();
  }
});
