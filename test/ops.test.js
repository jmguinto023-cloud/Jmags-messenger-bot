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
const { asksReviewStatus, PENDING_REVIEW_STATUS } = require('../src/recency');
const {
  emptyOps, moneyReport, nextJobId, addMonths, jobStatusText, dailyStatusText, warrantyText,
  asksJobStatus, asksWarrantyProblem, importOps, parseJobsCsv, jobBalance, jobPaid, duplicatePayments,
  ensureOps, STATUSES, DELIVERY_NOTICE, DELIVERY_STATUS, areaFromAd, adBudgetOf, adBudgetReport,
} = require('../src/ops');

const SECRET = 'test_app_secret';
const PAGE = '102622881557025';
const APP = '999000111';
const NOON = Date.parse('2026-10-18T04:00:00Z');
const TEN_AM = Date.parse('2026-10-18T02:00:00Z');

const JOBS_CSV = [
  'Job ID,Date received,Date done,Last paid date,Customer name,Contact,Area/City,Lead source,Ad,Ad area,Appliance,Brand/Model,Size,Issue,Service type,Quote (₱),Travel/transpo fee (₱),Total paid (₱),Balance (₱),Payment method,Status,Technician,Parts used,Parts cost (₱),Notes,Branch',
  'JO-261018-001,2026-10-18,,,Liza Mercado,09170001122,Testville,Facebook,,North,TV,Inventa,42,no power,,5000,0,0,5000,Cash,Under Repair,JM,,,shop note,San Pablo',
  'JO-261017-001,2026-10-17,,,Nico Bautista,09180002233,Sample City,Facebook,,South,TV,Inventa,32,no sound,,2000,0,0,2000,Cash,Scheduled,Joshua,,,shop note,Cavite',
].join('\n');

async function setup(extraEnv = {}) {
  const mock = await startMock();
  const env = {
    PORT: '0', VERIFY_TOKEN: 'verify_me', APP_SECRET: SECRET, APP_ID: APP, PAGE_ID: PAGE,
    PAGE_ACCESS_TOKEN: 'PAGE_TOKEN', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`,
    LLM_API_KEY: 'sk-test', LLM_MODEL: 'mock-model', BOT_ENABLED: 'true', BATCH_WINDOW_MS: '0',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-ops-')), LOG_LEVEL: 'silent',
    ADMIN_TOKEN: 'adm', DASHBOARD_PASSWORD: 'secret', ...extraEnv,
  };
  const app = build(env);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (payload) => {
    const raw = JSON.stringify(payload);
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
      },
      body: raw,
    });
    await new Promise((r) => setImmediate(r));
    await app.bot.idle();
    return res;
  };
  const close = async () => { await app.bot.idle(); app.server.close(); await mock.close(); };
  return { app, mock, base, post, close };
}

async function cookie(base) {
  const login = await fetch(`${base}/dashboard/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=secret&next=%2Fops',
  });
  return (login.headers.get('set-cookie').match(/jmags_dash=[^;]+/) || [])[0];
}

let n = 0;
const msg = (psid, text, ts = Date.now()) => ({
  object: 'page',
  entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid: `mid.ops${++n}`, text } }] }],
});

function shopTotals() {
  const ops = emptyOps();
  ops.payments.push(
    { date: '2026-10-12', branch: 'San Pablo', amount: 31000, type: 'Repair', method: 'Cash', jobId: 'A', customerName: '' },
    { date: '2026-10-12', branch: 'Cavite', amount: 84500, type: 'Check-up fee', method: 'Cash', jobId: 'B', customerName: '' },
    { date: '2026-10-12', branch: 'Cavite', amount: 8500, type: 'Check-up fee', method: 'Bank transfer', jobId: 'B', customerName: '' },
  );
  ops.ads.push(
    { start: '2026-10-01', end: '2026-10-17', branch: 'San Pablo', amount: 14172.59, chats: 3181 },
    { start: '2026-10-01', end: '2026-10-17', branch: 'San Pablo', amount: 4295.94, chats: 813 },
    { start: '2026-10-01', end: '2026-10-17', branch: 'Cavite', amount: 4069.98, chats: 1024 },
    { start: '2026-10-01', end: '2026-10-17', branch: 'Cavite', amount: 4295.94, chats: 813 },
  );
  return moneyReport(ops, { period: 'all', now: NOON, tz: 'Asia/Manila' });
}

test('money totals, job ids, warranty date, and sample replies', () => {
  assert.equal(loadConfig({}).dailyStatusUpdates, false);
  assert.equal(loadConfig({ DAILY_STATUS_UPDATES: '' }).dailyStatusUpdates, false);
  assert.equal(loadConfig({ DAILY_STATUS_UPDATES: 'on' }).dailyStatusUpdates, true);
  assert.equal(loadConfig({}).deliveryNotifications, false);
  assert.equal(loadConfig({ DELIVERY_NOTIFICATIONS: '' }).deliveryNotifications, false);
  assert.equal(loadConfig({ DELIVERY_NOTIFICATIONS: 'on' }).deliveryNotifications, true);
  assert.deepEqual(STATUSES, ['Inquiry', 'Scheduled', 'Checked', 'Under Repair', 'For Delivery', 'Completed', 'Cancelled']);

  const report = shopTotals();
  assert.equal(report.collected, 124000);
  assert.equal(report.byType['Check-up fee'], 93000);
  assert.equal(report.byType.Repair, 31000);
  assert.equal(report.byBranch['San Pablo'], 31000);
  assert.equal(report.byBranch.Cavite, 93000);
  assert.equal(report.byMethod.Cash, 115500);
  assert.equal(report.byMethod['Bank transfer'], 8500);
  assert.equal(report.costs, 26834);
  assert.equal(report.profit, 97166);
  assert.equal(report.perBranch['San Pablo'].costs, 18469);
  assert.equal(report.perBranch['San Pablo'].profit, 12531);
  assert.equal(report.perBranch.Cavite.costs, 8366);
  assert.equal(report.perBranch.Cavite.profit, 84634);
  assert.equal(report.investor, 42317);
  assert.equal(report.youKeep, 54848);

  assert.equal(addMonths('2026-10-18', 3), '2027-01-18');
  assert.equal(nextJobId([{ id: 'JO-261018-097' }, { id: 'JO-261018-001' }], '2026-10-18'), 'JO-261018-098');
  const jobs = parseJobsCsv(JOBS_CSV);
  assert.equal(jobs[0].visitDate, '2026-10-18');
  assert.equal(jobs[0].warrantyEnd, '2027-01-18');
  assert.equal(jobBalance({ ...jobs[0], importedPaid: 1500 }, []), 3500);

  const noted = { status: 'Under Repair', statusNote: 'hinihintay po ang backlight' };
  assert.equal(jobStatusText(noted), 'Hello po 😊 Yung TV niyo po ay naka-under repair na. Note: hinihintay po ang backlight. Babalikan po namin kayo.');
  assert.doesNotMatch(jobStatusText(noted), /Note ni Ivan|inaayos ni Ivan/i);
  assert.equal(
    dailyStatusText({ status: 'Under Repair', statusNote: '' }),
    'Hello po 😊 Under repair pa din po ang status ng TV niyo. Babalikan po namin kayo pag tapos na.',
  );
  assert.equal(
    dailyStatusText({ status: 'Under Repair', statusNote: 'hinihintay po ang piyesa (backlight)' }),
    'Hello po 😊 Under repair pa din po ang status ng TV niyo. Note: hinihintay po ang piyesa (backlight). Babalikan po namin kayo pag tapos na.',
  );
  assert.equal(
    dailyStatusText({ status: 'Under Repair', statusNote: 'Inaayos na po ng technician namin' }),
    'Hello po 😊 Under repair pa din po ang status ng TV niyo. Note: Inaayos na po ng technician namin. Babalikan po namin kayo pag tapos na.',
  );
  assert.doesNotMatch(dailyStatusText({ statusNote: 'Inaayos na po ng technician namin' }), /Ivan/);
  assert.equal(jobStatusText({ status: 'For Delivery', statusNote: '' }), DELIVERY_STATUS);
  assert.equal(
    jobStatusText({ status: 'For Delivery', statusNote: 'hinihintay po ang schedule' }),
    'Hello po 😊 Okay na po ang TV niyo at ready na for delivery. Note: hinihintay po ang schedule. Si Ivan po ang magko-confirm ng schedule.',
  );
  assert.equal(DELIVERY_NOTICE, 'Hello po 😊 Good news po! Okay na po ang TV niyo at ready na for delivery. Ichecheck lang po namin ang schedule at babalikan po namin kayo para sa delivery.');
  assert.equal(DELIVERY_STATUS, 'Hello po 😊 Okay na po ang TV niyo at ready na for delivery. Si Ivan po ang magko-confirm ng schedule.');
  const warranty = warrantyText({ date: '2026-10-18', warrantyEnd: '2027-01-18' });
  assert.equal(warranty, 'Hello po 😊 Nasa warranty pa po ang unit hanggang 18 Enero 2027. Pakisend lang po ng issue at video para ma-check ni Ivan. Hindi pa po ako makakapangako kung covered.');
  assert.doesNotMatch(warranty, /\blibre\b|siguradong covered|covered po ito/i);

  assert.equal(asksJobStatus('ano na status'), true);
  assert.equal(asksJobStatus('kumusta na TV ko'), true);
  assert.equal(asksJobStatus('tapos na po ba'), true);
  assert.equal(asksJobStatus('Ano na?'), false);
  assert.equal(asksJobStatus('ano na yung video'), false);
  assert.equal(asksReviewStatus('Ano na?'), true);
  assert.equal(asksWarrantyProblem('sira ulit po'), true);
  assert.equal(asksWarrantyProblem('may warranty pa ba'), false);

  const dupes = duplicatePayments([
    { jobId: 'JO-1', date: '2026-10-18', type: 'Repair', amount: 500, branch: 'San Pablo' },
    { jobId: 'JO-1', date: '2026-10-18', type: 'Repair', amount: 500, branch: 'San Pablo' },
  ], 'ALL');
  assert.equal(dupes.length, 1);

  const sw = fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  assert.match(sw, /jmags-video-shell-v7/);
  assert.match(sw, /\/ops/);
});

test('payment import keeps identical rows up to the CSV count and does not double them', () => {
  const csv = [
    'Date,JO number,Customer,Branch,Type,Method,Amount (₱),Note',
    '2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Repair,Cash,2500,first visit',
    '2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Repair,Cash,2500,first visit',
    '2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Check-up fee,GCash,1500,first visit',
  ].join('\n');
  const store = { data: {}, save() {} };
  const first = importOps(store, { paymentsCsv: csv });
  assert.equal(first.payments, 3);
  const repairs = () => store.data.ops.payments.filter((p) => p.type === 'Repair' && p.amount === 2500);
  assert.equal(repairs().length, 2);
  assert.equal(jobPaid({ id: 'JO-261018-001', importedPaid: 0 }, store.data.ops.payments), 6500);

  const again = importOps(store, { paymentsCsv: csv });
  assert.equal(again.payments, 0);
  assert.equal(store.data.ops.payments.length, 3);

  const oneShort = { data: { ops: { jobs: [], payments: [store.data.ops.payments[0]], expenses: [], ads: [], parts: [], bookings: [], customers: [], otherIncome: [] } }, save() {} };
  const caughtUp = importOps(oneShort, { paymentsCsv: csv });
  assert.equal(caughtUp.payments, 2);
  assert.equal(oneShort.data.ops.payments.filter((p) => p.amount === 2500).length, 2);
  assert.equal(oneShort.data.ops.payments.filter((p) => p.amount === 1500).length, 1);

  const extra = importOps(store, {
    paymentsCsv: `${csv}\n2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Repair,Cash,2500,first visit`,
  });
  assert.equal(extra.payments, 1);
  assert.equal(repairs().length, 3);

  const otherNote = importOps(store, {
    paymentsCsv: 'Date,JO number,Customer,Branch,Type,Method,Amount (₱),Note\n2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Repair,Cash,2500,second visit',
  });
  assert.equal(otherNote.payments, 1);
  assert.equal(store.data.ops.payments.filter((p) => p.note === 'second visit').length, 1);
});

test('import requires the admin token and the operations page stays behind the dashboard login', async () => {
  const s = await setup();
  try {
    const denied = await fetch(`${s.base}/admin/ops/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 403);
    const locked = await (await fetch(`${s.base}/ops`)).text();
    assert.match(locked, /JMAG's Operations/);
    assert.match(locked, /Log in/);
    assert.doesNotMatch(locked, /Liza Mercado|09170001122/);
    assert.equal((await fetch(`${s.base}/ops/export?kind=jobs`)).status, 403);

    const imported = await fetch(`${s.base}/admin/ops/import`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobsCsv: JOBS_CSV,
        paymentsCsv: 'Date,JO number,Customer,Branch,Type,Method,Amount (₱),Note\n2026-10-18,JO-261018-001,Liza Mercado,San Pablo,Check-up fee,Cash,1500,test',
        adSpendCsv: 'Period start,Period end,Branch,Amount (₱),Chats,Cost per chat (₱),Note\n2026-10-01,2026-10-31,San Pablo,100,10,10,test ads',
        customers: [{ name: 'Liza Mercado', phone: '09170001122', address: '12 Test Street' }],
        parts: [{ name: 'Test capacitor', branch: 'San Pablo', cost: 40, stock: 0, reorder: true }],
        bookings: [{ name: 'Rafi Gomez', phone: '09160004455', city: 'Testville', address: '9 Sample Road', branch: 'San Pablo', unitType: 'TV', issue: 'no power', price: 1500, visitDate: '2026-10-19', sentAt: '2026-10-18' }],
      }),
    });
    assert.equal(imported.status, 200);
    const body = await imported.json();
    assert.equal(body.jobs, 2);
    assert.equal(body.payments, 1);
    const job = s.app.store.data.ops.jobs.find((j) => j.id === 'JO-261018-001');
    job.statusNote = 'hinihintay po ang backlight';
    job.visitDate = '2026-10-20';
    job.psid = 'keep-me';
    const again = await fetch(`${s.base}/admin/ops/import`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'text/csv' },
      body: JOBS_CSV,
    });
    assert.equal(again.status, 400);
    const csvAgain = await fetch(`${s.base}/admin/ops/import?type=jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'text/csv' },
      body: JOBS_CSV,
    });
    assert.equal(csvAgain.status, 200);
    const kept = s.app.store.data.ops.jobs.find((j) => j.id === 'JO-261018-001');
    assert.equal(kept.statusNote, 'hinihintay po ang backlight');
    assert.equal(kept.visitDate, '2026-10-20');
    assert.equal(kept.psid, 'keep-me');
    assert.equal(kept.address, '12 Test Street');

    s.app.bot.now = () => NOON;
    const jar = await cookie(s.base);
    assert.match((await fetch(`${s.base}/dashboard/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=secret&next=%2Fops' })).headers.get('location'), /^\/ops$/);
    const today = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(today, /Open jobs/);
    assert.match(today, /data-kpi="open"/);
    assert.match(today, /Under repair/);
    assert.match(today, /data-kpi="for-delivery"/);
    assert.match(today, /For delivery/);
    assert.match(today, /Needs text update \(delivery\)/);
    assert.match(today, /Delivery notifications are off/);
    assert.match(today, /Visits today/);
    assert.match(today, /Collected today/);
    assert.match(today, /Profit this month/);
    assert.match(today, /Low stock/);
    assert.match(today, /Rafi Gomez/);
    assert.match(today, /Create job/);
    assert.match(today, /Dismiss/);
    assert.match(today, /Past visit/);
    assert.match(today, /Nico Bautista/);
    assert.match(today, /Collections, last 14 days/);
    assert.match(today, /data-amount="1500"/);
    assert.match(today, /Technician load/);
    assert.match(today, /Reorder soon/);
    assert.match(today, /Test capacitor/);
    assert.match(today, /Daily status updates are off/);
    assert.match(today, /href="\/dashboard"/);
    assert.doesNotMatch(today, /keep-me/);

    const cavite = await (await fetch(`${s.base}/ops?tab=today&branch=CAVITE`, { headers: { Cookie: jar } })).text();
    assert.match(cavite, /Nico Bautista/);
    assert.doesNotMatch(cavite, /Liza Mercado/);
    const jobs = await (await fetch(`${s.base}/ops?tab=jobs&branch=SAN%20PABLO`, { headers: { Cookie: jar } })).text();
    assert.match(jobs, /JO-261018-001/);
    assert.match(jobs, /2027-01-18/);
    assert.match(jobs, /data-confirm="Delete JO-261018-001\?"/);
    assert.match(jobs, /Status note for customer|Add job/);
    assert.match(jobs, /Under Repair<\/option><option>For Delivery<\/option><option>Completed/);
    assert.doesNotMatch(jobs, /Nico Bautista/);
    const customers = await (await fetch(`${s.base}/ops?tab=customers`, { headers: { Cookie: jar } })).text();
    assert.match(customers, /Liza Mercado/);
    assert.match(customers, /09170001122/);
    assert.match(customers, /12 Test Street/);
    const money = await (await fetch(`${s.base}/ops?tab=money&period=all`, { headers: { Cookie: jar } })).text();
    assert.match(money, /Cavite investor 50%/);
    assert.match(money, /Real profit per branch/);
    assert.match(money, /Check-up fee/);
    assert.match(money, /data-unpaid/);
    const finance = await (await fetch(`${s.base}/ops?tab=finance&period=all`, { headers: { Cookie: jar } })).text();
    assert.match(finance, /data-kpi="roas"/);
    assert.match(finance, /data-kpi="cost-per-booking"/);
    assert.match(finance, /data-kpi="booking-rate"/);
    assert.match(finance, /Other income/);
    const parts = await (await fetch(`${s.base}/ops?tab=parts`, { headers: { Cookie: jar } })).text();
    assert.match(parts, /Test capacitor/);
    assert.match(parts, /Reorder/);

    const csv = await (await fetch(`${s.base}/ops/export?kind=jobs`, { headers: { Cookie: jar } })).text();
    assert.match(csv, /JO-261018-001/);
    assert.match(csv, /Liza Mercado/);
    const dash = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: jar } })).text();
    assert.match(dash, /href="\/ops"/);
  } finally { await s.close(); }
});

test('jobs can be created, updated, finished, exported, and deleted while payments remain', async () => {
  const s = await setup();
  s.app.bot.now = () => NOON;
  try {
    const jar = await cookie(s.base);
    const created = await fetch(`${s.base}/ops/action`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
        customerName: 'Liza Mercado', phone: '09170001122', city: 'Testville', address: '12 Test Street',
        landmark: 'near the test hall', mapLink: 'https://maps.example/test',
        unitType: 'TV', brand: 'Inventa', size: '42', issue: 'no power',
        date: '2026-10-18', visitDate: '2026-10-19', visitTime: '10:00',
        technician: 'JM', branch: 'San Pablo', adArea: 'North', price: '5000', status: 'Scheduled',
        statusNote: 'bukas po ang visit',
      }).toString(),
    });
    assert.equal(created.status, 303);
    assert.equal((await fetch(`${s.base}/ops/action`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=create-job&customerName=Nope' })).status, 403);
    const job = s.app.store.data.ops.jobs[0];
    assert.equal(job.id, 'JO-261018-001');
    assert.equal(job.warrantyEnd, '2027-01-18');
    assert.equal(job.visitDate, '2026-10-19');
    const edited = await fetch(`${s.base}/ops/action`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: 'update-job', returnTab: 'jobs', id: job.id,
        customerName: 'Liza Mercado', phone: '09170001122', city: 'Testville', address: '12 Test Street',
        date: '2026-10-18', visitDate: '2026-10-19', technician: 'Joshua', branch: 'Cavite',
        price: '5000', status: 'Checked', statusNote: 'na-check na po',
      }).toString(),
    });
    assert.equal(edited.status, 303);
    assert.equal(s.app.store.data.ops.jobs[0].status, 'Checked');
    assert.equal(s.app.store.data.ops.jobs[0].branch, 'Cavite');
    await fetch(`${s.base}/ops/action`, {
      method: 'POST', headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=status&id=${job.id}&status=Under%20Repair&returnTab=jobs`,
    });
    assert.equal(s.app.store.data.ops.jobs[0].status, 'Under Repair');
    await fetch(`${s.base}/ops/action`, {
      method: 'POST', headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=add-payment&date=2026-10-18&jobId=${job.id}&customerName=Liza%20Mercado&branch=Cavite&type=Repair&method=GCash&amount=2000&returnTab=money`,
    });
    await fetch(`${s.base}/ops/action`, {
      method: 'POST', headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=done&id=${job.id}&returnTab=jobs`,
    });
    assert.equal(s.app.store.data.ops.jobs[0].status, 'Completed');
    assert.equal(s.app.store.data.ops.jobs[0].doneDate, '2026-10-18');
    assert.equal(jobBalance(s.app.store.data.ops.jobs[0], s.app.store.data.ops.payments), 3000);
    const money = await (await fetch(`${s.base}/ops/export?kind=money&period=all`, { headers: { Cookie: jar } })).text();
    assert.match(money, /GCash/);
    assert.match(money, /2000/);
    await fetch(`${s.base}/ops/action`, {
      method: 'POST', headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `action=delete-job&id=${job.id}&returnTab=jobs`,
    });
    assert.equal(s.app.store.data.ops.jobs.length, 0);
    assert.equal(s.app.store.data.ops.payments.length, 1);
  } finally { await s.close(); }
});

test('a video card can link to a job, and a matching phone is only a suggestion', async () => {
  const s = await setup();
  try {
    ensureOps(s.app.store);
    s.app.store.data.ops.jobs.push({
      id: 'JO-261018-001', date: '2026-10-18', visitDate: '2026-10-18', customerName: 'Liza Mercado',
      phone: '09170001122', city: 'Testville', address: '12 Test Street', status: 'Under Repair',
      technician: 'JM', branch: 'San Pablo', price: 5000, statusNote: 'hinihintay po ang backlight',
      psid: '', warrantyEnd: '2027-01-18',
    });
    const psid = 'ops-secret-4242';
    s.app.store.addReview({
      id: 'rev-ops-1', timestamp: '2026-10-18T04:00:00.000Z', psid, psidHash: 'hash', psidLast4: '4242',
      type: 'video', url: 'https://cdn.example/tv.mp4', status: 'new', customerName: '',
    });
    await s.post(msg(psid, '09170001122', NOON));
    const thread = s.app.store.thread(psid);
    assert.equal(thread.jobSuggestion.jobId, 'JO-261018-001');
    assert.equal(thread.jobSuggestion.reason, 'phone');
    assert.equal(s.app.store.data.ops.jobs[0].psid, '');
    const jar = await cookie(s.base);
    const html = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: jar } })).text();
    assert.match(html, /Link to job/);
    assert.match(html, /Suggested: JO-261018-001 · Liza Mercado \(phone\)/);
    assert.doesNotMatch(html, /ops-secret-4242/);
    const denied = await fetch(`${s.base}/dashboard/link-job`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'review=rev-ops-1&jobId=JO-261018-001',
    });
    assert.equal(denied.status, 403);
    const linked = await fetch(`${s.base}/dashboard/link-job`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'review=rev-ops-1&jobId=JO-261018-001',
    });
    assert.equal(linked.status, 303);
    assert.equal(s.app.store.data.ops.jobs[0].psid, psid);
    assert.equal(s.app.store.thread(psid).jobId, 'JO-261018-001');
    assert.equal(s.app.store.thread(psid).jobSuggestion, null);
    const after = await (await fetch(`${s.base}/dashboard`, { headers: { Cookie: jar } })).text();
    assert.match(after, /Linked: JO-261018-001/);
    assert.doesNotMatch(after, /ops-secret-4242/);
    const edit = await (await fetch(`${s.base}/ops?tab=jobs&edit=JO-261018-001`, { headers: { Cookie: jar } })).text();
    assert.match(edit, /Messenger chat/);
    assert.match(edit, /••4242/);
    assert.match(edit, /Status note for customer/);
    assert.doesNotMatch(edit, /ops-secret-4242/);
  } finally { await s.close(); }
});

test('status answers come from the matching job and never from another customer', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'LLM should not answer a linked status question';
  try {
    ensureOps(s.app.store);
    s.app.store.data.ops.jobs.push(
      {
        id: 'JO-261018-001', date: '2026-10-18', customerName: 'Liza Mercado', phone: '09170001122',
        city: 'Testville', address: '12 Test Street', status: 'Under Repair', branch: 'San Pablo',
        statusNote: 'hinihintay po ang backlight', psid: 'linked-liza', warrantyEnd: '2027-01-18', price: 5000,
      },
      {
        id: 'JO-261017-001', date: '2026-10-17', customerName: 'Nico Bautista', phone: '09180002233',
        city: 'Sample City', address: '9 Sample Road', status: 'Scheduled', branch: 'Cavite',
        statusNote: 'secret note for nico', psid: '', warrantyEnd: '2027-01-17', price: 2000,
      },
    );
    s.app.store.addTurn('linked-liza', 'user', 'hello', NOON);
    const before = s.mock.calls.llm.length;
    await s.post(msg('linked-liza', 'ano na status po', NOON + 1000));
    assert.equal(s.mock.calls.llm.length, before);
    const reply = s.mock.calls.messages.at(-1).message.text;
    assert.match(reply, /naka-under repair na/);
    assert.match(reply, /hinihintay po ang backlight/);
    assert.doesNotMatch(reply, /Nico Bautista|09180002233|9 Sample Road|secret note for nico/);

    await s.post(msg('linked-liza', 'ano na yung video', NOON + 2000));
    assert.equal(s.mock.calls.messages.at(-1).message.text, 'LLM should not answer a linked status question');

    s.app.store.thread('linked-liza').problemViaVideo = true;
    await s.post(msg('linked-liza', 'ano na yung video', NOON + 3000));
    assert.equal(s.mock.calls.messages.at(-1).message.text, PENDING_REVIEW_STATUS);

    await s.post(msg('ask-1', 'ano na status', NOON + 4000));
    assert.equal(s.mock.calls.messages.at(-1).message.text, 'Para macheck ko po ang status, pakisabi ang pangalan at phone number na ginamit sa booking.');
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /Liza|Nico|0917|0918/);
    await s.post(msg('ask-1', '09170001122', NOON + 5000));
    assert.match(s.mock.calls.messages.at(-1).message.text, /buong pangalan/);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /Liza Mercado|Nico/);
    assert.equal(s.app.store.data.ops.jobs[0].psid, 'linked-liza');

    await s.post(msg('ask-2', 'ano na status', NOON + 6000));
    await s.post(msg('ask-2', 'ako si Liza Mercado', NOON + 6500));
    await s.post(msg('ask-2', '09180002233', NOON + 7000));
    assert.match(s.mock.calls.messages.at(-1).message.text, /Ipapaabot ko na po kay Ivan/);
    assert.doesNotMatch(s.mock.calls.messages.at(-1).message.text, /Nico|secret note|9 Sample Road|Liza Mercado/);
    assert.ok(s.mock.calls.pass.length >= 1);
    assert.equal(s.app.store.thread('ask-2').handedOff, true);

    await s.post(msg('ask-3', 'ano na status', NOON + 8000));
    await s.post(msg('ask-3', 'ako si Liza Mercado', NOON + 9000));
    await s.post(msg('ask-3', '09170001122', NOON + 10000));
    const matched = s.mock.calls.messages.at(-1).message.text;
    assert.match(matched, /naka-under repair na/);
    assert.doesNotMatch(matched, /Nico|secret note/);
    assert.equal(s.app.store.data.ops.jobs[0].psid, 'ask-3');
    assert.equal(s.app.store.thread('ask-3').jobId, 'JO-261018-001');
  } finally { await s.close(); }
});

test('a repeat problem inside warranty is handed to Ivan without a coverage promise', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'LLM fallback';
  try {
    ensureOps(s.app.store);
    s.app.store.data.ops.jobs.push({
      id: 'JO-261018-001', date: '2026-10-18', warrantyEnd: '2027-01-18', customerName: 'Liza Mercado',
      phone: '09170001122', status: 'Completed', branch: 'San Pablo', psid: 'war-1', price: 5000,
    });
    s.app.bot.now = () => NOON;
    await s.post(msg('war-1', 'sira ulit po yung tv', NOON));
    const text = s.mock.calls.messages.at(-1).message.text;
    assert.match(text, /hanggang 18 Enero 2027/);
    assert.match(text, /Hindi pa po ako makakapangako kung covered/);
    assert.match(text, /issue at video/);
    assert.doesNotMatch(text, /\blibre\b|siguradong covered|covered po ito/i);
    assert.equal(s.app.store.thread('war-1').handedOff, true);
    assert.equal(s.app.store.thread('war-1').awaitingVideo, false);
    assert.equal(s.app.store.thread('war-1').videoReplyAt || 0, 0);
    assert.equal(s.mock.calls.pass.length, 1);
    assert.equal(s.mock.calls.llm.length, 0);

    s.app.store.data.ops.jobs[0].psid = 'war-2';
    s.app.store.data.ops.jobs[0].date = '2026-01-01';
    s.app.store.data.ops.jobs[0].warrantyEnd = '2026-04-01';
    await s.post(msg('war-2', 'sira ulit po', NOON));
    assert.equal(s.mock.calls.messages.at(-1).message.text, 'LLM fallback');
    assert.equal(s.app.store.thread('war-2').handedOff, false);
  } finally { await s.close(); }
});

test('daily status stays off until enabled, sends once inside 24h, and lists the phone otherwise', async () => {
  const s = await setup();
  const psid = 'daily-4242';
  try {
    ensureOps(s.app.store);
    s.app.store.data.ops.jobs.push({
      id: 'JO-261018-001', date: '2026-10-18', customerName: 'Liza Mercado', phone: '09170001122',
      status: 'Under Repair', branch: 'San Pablo', psid, statusNote: 'hinihintay po ang piyesa (backlight)',
      warrantyEnd: '2027-01-18', price: 5000,
    });
    s.app.store.addTurn(psid, 'user', 'hello po', TEN_AM - 60 * 60 * 1000);
    s.app.bot.now = () => TEN_AM;
    const off = await s.app.bot.maybeDailyStatus(TEN_AM);
    assert.deepEqual(off.sent, []);
    assert.equal(s.mock.calls.messages.length, 0);

    s.app.cfg.dailyStatusUpdates = true;
    const seven = Date.parse('2026-10-17T23:00:00Z');
    s.app.store.thread(psid).lastUserTs = seven - 30 * 60 * 1000;
    s.app.bot.now = () => seven;
    assert.deepEqual((await s.app.bot.maybeDailyStatus()).sent, []);
    assert.equal(s.mock.calls.messages.length, 0);
    const eight = Date.parse('2026-10-18T00:00:00Z');
    s.app.store.thread(psid).lastUserTs = eight - 30 * 60 * 1000;
    s.app.bot.now = () => eight;
    await s.app.bot.checkFollowups();
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, 'Hello po 😊 Under repair pa din po ang status ng TV niyo. Note: hinihintay po ang piyesa (backlight). Babalikan po namin kayo pag tapos na.');
    assert.equal(s.mock.calls.messages[0].messaging_type, 'RESPONSE');
    await s.app.bot.maybeDailyStatus(TEN_AM);
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.app.store.data.ops.jobs[0].lastDailyStatusDate, '2026-10-18');

    s.app.store.data.ops.jobs[0].lastDailyStatusDate = '';
    const late = Date.parse('2026-10-18T10:00:00Z');
    s.app.store.thread(psid).lastUserTs = late - 30 * 60 * 1000;
    s.app.bot.now = () => late;
    await s.app.bot.maybeDailyStatus(late);
    assert.equal(s.mock.calls.messages.length, 2);

    s.app.store.data.ops.jobs[0].lastDailyStatusDate = '';
    const night = Date.parse('2026-10-18T11:00:00Z');
    s.app.bot.now = () => night;
    await s.app.bot.maybeDailyStatus(night);
    assert.equal(s.mock.calls.messages.length, 2);
    s.app.store.data.ops.jobs[0].lastDailyStatusDate = '2026-10-18';

    const quiet = 'quiet-4242';
    s.app.store.data.ops.jobs.push({
      id: 'JO-261018-002', date: '2026-10-18', customerName: 'Mina Solis', phone: '09190003344',
      status: 'Under Repair', branch: 'Cavite', psid: quiet, statusNote: '', price: 1000,
    });
    s.app.store.addTurn(quiet, 'user', 'hello', TEN_AM - 30 * 3600 * 1000);
    const paused = 'pause-4242';
    s.app.store.data.ops.jobs.push({
      id: 'JO-261018-003', date: '2026-10-18', customerName: 'Rafi Gomez', phone: '09160004455',
      status: 'Under Repair', branch: 'San Pablo', psid: paused, price: 1000,
    });
    const pauseThread = s.app.store.thread(paused);
    pauseThread.lastUserTs = TEN_AM - 60 * 1000;
    pauseThread.pausedUntil = TEN_AM + 12 * 3600 * 1000;
    pauseThread.lastHumanEchoAt = TEN_AM;
    s.app.bot.now = () => TEN_AM;
    await s.app.bot.maybeDailyStatus(TEN_AM);
    const texts = s.mock.calls.messages.map((m) => m.message.text).join('\n');
    assert.doesNotMatch(texts, /09190003344|09160004455/);
    const jar = await cookie(s.base);
    const page = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(page, /Needs text update/);
    assert.match(page, /09190003344/);
    assert.doesNotMatch(page, /09160004455/);
    assert.doesNotMatch(page, new RegExp(quiet));

    s.app.store.purge(1, TEN_AM + 10 * 86400e3);
    assert.equal(s.app.store.data.ops.jobs.length, 3);
    const forgotten = await fetch(`${s.base}/admin/forget?psid=${encodeURIComponent(quiet)}`, {
      method: 'POST', headers: { Authorization: 'Bearer adm' },
    });
    assert.equal(forgotten.status, 200);
    assert.equal(s.app.store.data.ops.jobs.find((j) => j.id === 'JO-261018-002').psid, '');
    assert.ok(s.app.store.data.ops.jobs.find((j) => j.id === 'JO-261018-001'));
  } finally { await s.close(); }
});

test('For Delivery notifies once inside the reply window and lists a text otherwise', async () => {
  const s = await setup();
  s.mock.state.llmResponder = () => 'LLM fallback';
  const psid = 'deliv-4242';
  try {
    s.app.bot.now = () => NOON;
    const jar = await cookie(s.base);
    const postAction = (body) => fetch(`${s.base}/ops/action`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    await postAction({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Liza Mercado', phone: '09170001122', city: 'Testville', address: '12 Test Street',
      unitType: 'TV', brand: 'Inventa', size: '42', issue: 'no power',
      date: '2026-10-18', visitDate: '2026-10-19', technician: 'JM', branch: 'San Pablo',
      price: '5000', status: 'Under Repair',
    });
    const job = s.app.store.data.ops.jobs[0];
    assert.equal(job.id, 'JO-261018-001');
    s.app.store.addTurn(psid, 'user', 'hello po', NOON - 60 * 60 * 1000);
    job.psid = psid;
    s.app.store.thread(psid).jobId = job.id;
    s.app.store.save();

    assert.equal(s.app.cfg.deliveryNotifications, false);
    const off = await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'today', returnBranch: 'ALL' });
    assert.equal(off.status, 303);
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(job.status, 'For Delivery');
    assert.equal(job.deliveryNotifiedAt || '', '');
    const todayOff = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(todayOff, /data-kpi="for-delivery"><span>For delivery<\/span><strong>1<\/strong>/);
    assert.match(todayOff, /data-kpi="open"><span>Open jobs<\/span><strong>1<\/strong>/);
    assert.match(todayOff, /id="delivery-flag"/);
    assert.doesNotMatch(todayOff, /data-needs="delivery"/);
    assert.doesNotMatch(todayOff, /09170001122/);

    s.app.cfg.dailyStatusUpdates = true;
    const eight = Date.parse('2026-10-18T00:00:00Z');
    s.app.bot.now = () => eight;
    assert.deepEqual((await s.app.bot.maybeDailyStatus(eight)).sent, []);
    assert.equal(s.mock.calls.messages.length, 0);
    s.app.cfg.dailyStatusUpdates = false;
    s.app.bot.now = () => NOON;

    await postAction({ action: 'status', id: job.id, status: 'Under Repair', returnTab: 'jobs' });
    s.app.cfg.deliveryNotifications = true;
    s.app.cfg.botEnabled = false;
    await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(job.deliveryNotifiedAt || '', '');
    s.app.cfg.botEnabled = true;
    await postAction({ action: 'status', id: job.id, status: 'Under Repair', returnTab: 'jobs' });

    const thread = s.app.store.thread(psid);
    thread.pausedUntil = NOON + 12 * 3600 * 1000;
    thread.lastHumanEchoAt = NOON;
    await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(s.mock.calls.messages.length, 0);
    assert.equal(job.deliveryNotifiedAt || '', '');
    let page = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.doesNotMatch(page, /data-needs="delivery"/);
    thread.pausedUntil = 0;
    thread.lastHumanEchoAt = 0;
    await postAction({ action: 'status', id: job.id, status: 'Under Repair', returnTab: 'jobs' });

    thread.handedOff = true;
    await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(s.mock.calls.messages.length, 0);
    page = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.doesNotMatch(page, /09170001122/);
    thread.handedOff = false;
    await postAction({ action: 'status', id: job.id, status: 'Checked', returnTab: 'jobs' });

    const sent = await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(sent.status, 303);
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, DELIVERY_NOTICE);
    assert.equal(s.mock.calls.messages[0].messaging_type, 'RESPONSE');
    assert.ok(job.deliveryNotifiedAt);
    const noticedAt = job.deliveryNotifiedAt;
    await postAction({ action: 'status', id: job.id, status: 'Under Repair', returnTab: 'jobs' });
    await postAction({ action: 'status', id: job.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(job.deliveryNotifiedAt, noticedAt);

    await s.post(msg(psid, 'ano na status po', NOON));
    assert.equal(s.mock.calls.messages.at(-1).message.text, DELIVERY_STATUS);
    assert.equal(s.mock.calls.messages.at(-1).messaging_type, 'RESPONSE');
    job.statusNote = 'hinihintay po ang schedule';
    await s.post(msg(psid, 'kumusta na TV ko', NOON + 1000));
    assert.equal(
      s.mock.calls.messages.at(-1).message.text,
      'Hello po 😊 Okay na po ang TV niyo at ready na for delivery. Note: hinihintay po ang schedule. Si Ivan po ang magko-confirm ng schedule.',
    );

    await postAction({
      action: 'create-job', returnTab: 'jobs',
      customerName: 'Nico Bautista', phone: '09180002233', city: 'Sample City', address: '9 Sample Road',
      date: '2026-10-17', branch: 'Cavite', price: '2000', status: 'Checked', unitType: 'TV', issue: 'no sound',
    });
    const nico = s.app.store.data.ops.jobs.find((j) => j.customerName === 'Nico Bautista');
    const nicoPsid = 'nico-4242';
    s.app.store.addTurn(nicoPsid, 'user', 'hello', NOON - 40 * 3600 * 1000);
    nico.psid = nicoPsid;
    s.app.store.save();
    await postAction({
      action: 'update-job', id: nico.id, returnTab: 'jobs',
      customerName: 'Nico Bautista', phone: '09180002233', city: 'Sample City', address: '9 Sample Road',
      date: '2026-10-17', branch: 'Cavite', price: '2000', status: 'For Delivery', unitType: 'TV', issue: 'no sound',
    });
    assert.equal(nico.status, 'For Delivery');
    assert.equal(nico.deliveryNotifiedAt || '', '');
    assert.equal(s.mock.calls.messages.filter((m) => m.message.text === DELIVERY_NOTICE).length, 1);

    const header = JOBS_CSV.split('\n')[0];
    const imported = await fetch(`${s.base}/admin/ops/import?type=jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'text/csv' },
      body: `${header}\nJO-261018-009,2026-10-18,,,Mina Solis,09190003344,Testville,Facebook,,North,TV,Inventa,32,no power,,1000,0,0,1000,Cash,For Delivery,JM,,,shop note,Cavite`,
    });
    assert.equal(imported.status, 200);
    const mina = s.app.store.data.ops.jobs.find((j) => j.id === 'JO-261018-009');
    assert.equal(mina.status, 'For Delivery');
    assert.equal(mina.psid, '');
    assert.equal(mina.deliveryNotifiedAt || '', '');
    assert.equal(s.mock.calls.messages.filter((m) => m.message.text === DELIVERY_NOTICE).length, 1);

    const kept = await fetch(`${s.base}/admin/ops/import?type=jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer adm', 'Content-Type': 'text/csv' },
      body: `${header}\nJO-261018-001,2026-10-18,,,Liza Mercado,09170001122,Testville,Facebook,,North,TV,Inventa,42,no power,,5000,0,0,5000,Cash,For Delivery,JM,,,shop note,San Pablo`,
    });
    assert.equal(kept.status, 200);
    assert.equal(job.deliveryNotifiedAt, noticedAt);
    assert.equal(job.psid, psid);
    assert.equal(s.mock.calls.messages.filter((m) => m.message.text === DELIVERY_NOTICE).length, 1);

    await postAction({
      action: 'create-job', returnTab: 'jobs',
      customerName: 'Rafi Gomez', phone: '09160004455', city: 'Testville', address: '9 Sample Road',
      date: '2026-10-18', branch: 'San Pablo', price: '1000', status: 'Under Repair', unitType: 'TV', issue: 'no power',
    });
    const rafi = s.app.store.data.ops.jobs.find((j) => j.customerName === 'Rafi Gomez');
    const rafiPsid = 'rafi-4242';
    s.app.store.addTurn(rafiPsid, 'user', 'hello', NOON - 30 * 60 * 1000);
    rafi.psid = rafiPsid;
    s.app.store.thread(rafiPsid).handedOff = true;
    s.app.store.save();
    await postAction({ action: 'status', id: rafi.id, status: 'For Delivery', returnTab: 'jobs' });
    assert.equal(rafi.status, 'For Delivery');
    assert.equal(rafi.deliveryNotifiedAt || '', '');
    assert.equal(s.mock.calls.messages.filter((m) => m.message.text === DELIVERY_NOTICE).length, 1);

    const today = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(today, /Needs text update \(delivery\)/);
    assert.match(today, /data-needs="delivery">JO-261017-001 · Nico Bautista · 09180002233/);
    assert.match(today, /data-needs="delivery">JO-261018-009 · Mina Solis · 09190003344/);
    assert.doesNotMatch(today, /data-needs="delivery"[^<]*09170001122/);
    assert.doesNotMatch(today, /data-needs="delivery"[^<]*09160004455/);
    assert.match(today, /data-kpi="for-delivery"><span>For delivery<\/span><strong>4<\/strong>/);
    const cavite = await (await fetch(`${s.base}/ops?tab=today&branch=CAVITE`, { headers: { Cookie: jar } })).text();
    assert.match(cavite, /09180002233/);
    assert.match(cavite, /09190003344/);
    assert.doesNotMatch(cavite, /09170001122/);
    assert.match(cavite, /data-kpi="for-delivery"><span>For delivery<\/span><strong>2<\/strong>/);
    const sanPablo = await (await fetch(`${s.base}/ops?tab=today&branch=SAN%20PABLO`, { headers: { Cookie: jar } })).text();
    assert.doesNotMatch(sanPablo, /09180002233|09190003344/);
    assert.match(sanPablo, /data-kpi="for-delivery"><span>For delivery<\/span><strong>2<\/strong>/);
    const caviteJobs = await (await fetch(`${s.base}/ops?tab=jobs&branch=CAVITE&status=For%20Delivery`, { headers: { Cookie: jar } })).text();
    assert.match(caviteJobs, /Nico Bautista/);
    assert.match(caviteJobs, /Mina Solis/);
    assert.doesNotMatch(caviteJobs, /Liza Mercado|Rafi Gomez/);

    await s.post(msg(psid, 'sira ulit po yung tv', NOON + 2000));
    const warranty = s.mock.calls.messages.at(-1).message.text;
    assert.match(warranty, /Hindi pa po ako makakapangako kung covered/);
    assert.doesNotMatch(warranty, /ready na for delivery/);
    assert.equal(s.app.store.thread(psid).handedOff, true);
    assert.equal(s.app.store.thread(psid).awaitingVideo, false);
  } finally { await s.close(); }
});

test('ad area fills from the ad name and finance can group profit by ad budget', async () => {
  const parsed = parseJobsCsv(JOBS_CSV);
  assert.equal(parsed[0].ad, '');
  assert.equal(parsed[0].adArea, 'North');
  assert.equal(areaFromAd('CAVITE - area ads'), 'CAVITE');
  assert.equal(areaFromAd('June messaging LAGUNA'), 'LAGUNA');
  assert.equal(areaFromAd('BATANGAS flyer'), 'BATANGAS');
  assert.equal(areaFromAd('Not from an ad'), '');
  assert.equal(areaFromAd('Cavite Page ad'), 'CAVITE');
  assert.equal(areaFromAd('Boosted posts'), 'Boosted posts');
  assert.equal(adBudgetOf({ ad: 'Cavite Page ad', adArea: '' }), 'Cavite');
  assert.equal(adBudgetOf({ ad: '', adArea: 'Boosted posts' }), 'Boosted posts');
  assert.equal(adBudgetOf({ ad: 'Boosted post', adArea: 'North' }), 'Boosted posts');
  assert.equal(adBudgetOf({ adArea: 'CAVITE', ad: 'LAGUNA post' }), 'Cavite');
  assert.equal(adBudgetOf({ adArea: 'North', ad: 'BATANGAS flyer' }), 'San Pablo');
  assert.equal(adBudgetOf({ adArea: 'San Pablo ads', ad: '' }), 'San Pablo');
  assert.equal(adBudgetOf({ adArea: 'North', ad: '' }), '');

  const kept = { data: {}, save() {} };
  importOps(kept, {
    jobsCsv: 'Job ID,Date received,Customer name,Lead source,Ad,Ad area,Branch,Status\nJO-261018-003,2026-10-18,Mara Quill,Facebook,BATANGAS flyer,North,San Pablo,Inquiry',
  });
  assert.equal(kept.data.ops.jobs[0].ad, 'BATANGAS flyer');
  assert.equal(kept.data.ops.jobs[0].adArea, 'North');
  kept.data.ops.jobs[0].ad = 'LAGUNA - area ads';
  kept.data.ops.jobs[0].adArea = 'LAGUNA';
  importOps(kept, {
    jobsCsv: 'Job ID,Date received,Customer name,Lead source,Ad,Ad area,Branch,Status\nJO-261018-003,2026-10-18,Mara Quill,Facebook,,North,San Pablo,Inquiry',
  });
  assert.equal(kept.data.ops.jobs[0].ad, 'LAGUNA - area ads');
  assert.equal(kept.data.ops.jobs[0].adArea, 'North');
  kept.data.ops.jobs[0].adArea = 'LAGUNA';
  importOps(kept, {
    jobsCsv: 'Job ID,Date received,Customer name,Lead source,Ad,Ad area,Branch,Status\nJO-261018-003,2026-10-18,Mara Quill,Facebook,,,San Pablo,Inquiry',
  });
  assert.equal(kept.data.ops.jobs[0].ad, 'LAGUNA - area ads');
  assert.equal(kept.data.ops.jobs[0].adArea, 'LAGUNA');

  const ops = emptyOps();
  ops.jobs.push(
    { id: 'JO-1', date: '2026-10-12', branch: 'San Pablo', ad: 'LAGUNA - area ads', adArea: 'LAGUNA', partsCost: 200, status: 'Under Repair', customerName: 'Mara Quill' },
    { id: 'JO-2', date: '2026-10-12', branch: 'Cavite', ad: 'CAVITE - area ads', adArea: 'CAVITE', partsCost: 0, status: 'For Delivery', customerName: 'Theo Farrow' },
    { id: 'JO-3', date: '2026-10-12', branch: 'San Pablo', ad: '', adArea: 'North', partsCost: 0, status: 'Inquiry', customerName: 'Willa Ibarra' },
  );
  ops.payments.push(
    { date: '2026-10-12', jobId: 'JO-1', branch: 'San Pablo', amount: 124000, type: 'Repair', method: 'Cash' },
    { date: '2026-10-12', jobId: 'JO-2', branch: 'Cavite', amount: 24000, type: 'Repair', method: 'Cash' },
    { date: '2026-10-12', jobId: 'JO-3', branch: 'San Pablo', amount: 5000, type: 'Check-up fee', method: 'Cash' },
  );
  ops.ads.push(
    { start: '2026-10-01', end: '2026-10-17', branch: 'San Pablo', amount: 1000, chats: 10 },
    { start: '2026-10-01', end: '2026-10-17', branch: 'Cavite', amount: 500, chats: 5 },
  );
  const report = adBudgetReport(ops, { period: 'all', now: NOON, tz: 'Asia/Manila' });
  assert.equal(report.groups['San Pablo'].collected, 124000);
  assert.equal(report.groups['San Pablo'].costs, 1200);
  assert.equal(report.groups['San Pablo'].profit, 122800);
  assert.equal(report.groups.Cavite.collected, 24000);
  assert.equal(report.groups.Cavite.costs, 500);
  assert.equal(report.groups.Cavite.profit, 23500);
  assert.equal(report.groups.Untraced.collected, 5000);
  assert.equal(report.groups.Untraced.profit, 5000);
  assert.equal(report.groups.Untraced.jobs, 1);
  assert.equal(report.untraced, 1);
  assert.equal(report.cross['San Pablo']['San Pablo'].collected, 124000);
  assert.equal(report.cross.Cavite.Cavite.jobs, 1);
  assert.equal(report.cross.Untraced['San Pablo'].collected, 5000);
  ops.jobs.push({ id: 'JO-4', date: '2026-10-12', branch: 'Cavite', ad: '', adArea: 'Boosted posts', partsCost: 100, status: 'Completed', customerName: 'Pia Calderon' });
  ops.payments.push({ date: '2026-10-12', jobId: 'JO-4', branch: 'Cavite', amount: 8000, type: 'Repair', method: 'Cash' });
  ops.ads.push({ start: '2026-10-01', end: '2026-10-17', branch: 'Boosted posts', amount: 300, chats: 4 });
  const withBoost = adBudgetReport(ops, { period: 'all', now: NOON, tz: 'Asia/Manila' });
  assert.equal(withBoost.groups.Cavite.collected, 24000);
  assert.equal(withBoost.groups.Cavite.costs, 500);
  assert.equal(withBoost.groups['San Pablo'].collected, 124000);
  assert.equal(withBoost.groups['San Pablo'].costs, 1200);
  assert.equal(withBoost.groups['Boosted posts'].collected, 8000);
  assert.equal(withBoost.groups['Boosted posts'].costs, 400);
  assert.equal(withBoost.groups['Boosted posts'].profit, 7600);
  assert.equal(withBoost.groups['Boosted posts'].jobs, 1);
  assert.equal(withBoost.groups.Untraced.collected, 5000);

  const s = await setup();
  s.app.bot.now = () => NOON;
  try {
    const jar = await cookie(s.base);
    const post = (body) => fetch(`${s.base}/ops/action`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: jar, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    await post({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Mara Quill', phone: '09120001111', city: 'Testville', address: '1 Inventa Road',
      date: '2026-10-12', visitDate: '2026-10-18', branch: 'San Pablo', status: 'Under Repair',
      ad: 'LAGUNA - area ads', adArea: 'North', price: '124000', partsCost: '200',
    });
    await post({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Theo Farrow', phone: '09120002222', city: 'Testville', address: '2 Inventa Road',
      date: '2026-10-12', visitDate: '2026-10-18', branch: 'Cavite', status: 'For Delivery',
      ad: 'CAVITE - area ads', adArea: 'North', price: '24000',
    });
    await post({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Willa Ibarra', phone: '09120003333', city: 'Testville', address: '3 Inventa Road',
      date: '2026-10-12', visitDate: '2026-10-18', branch: 'San Pablo', status: 'Inquiry',
      adArea: 'North', price: '5000',
    });
    await post({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Pia Calderon', phone: '09120005555', city: 'Testville', address: '5 Inventa Road',
      date: '2026-10-12', visitDate: '2026-10-18', branch: 'Cavite', status: 'Scheduled',
      ad: 'Cavite Page ad', adArea: 'North', price: '9000',
    });
    await post({
      action: 'create-job', returnTab: 'jobs', returnBranch: 'ALL',
      customerName: 'Quin Dalberg', phone: '09120006666', city: 'Testville', address: '6 Inventa Road',
      date: '2026-10-12', visitDate: '2026-10-18', branch: 'San Pablo', status: 'Completed',
      adArea: 'Boosted posts', price: '8000', partsCost: '100',
    });
    const jobs = s.app.store.data.ops.jobs;
    const laguna = jobs.find((job) => job.customerName === 'Mara Quill');
    const cavite = jobs.find((job) => job.customerName === 'Theo Farrow');
    const open = jobs.find((job) => job.customerName === 'Willa Ibarra');
    assert.equal(laguna.ad, 'LAGUNA - area ads');
    assert.equal(laguna.adArea, 'LAGUNA');
    assert.equal(cavite.adArea, 'CAVITE');
    assert.equal(open.ad, '');
    assert.equal(open.adArea, 'North');
    const pageAd = jobs.find((job) => job.customerName === 'Pia Calderon');
    const boosted = jobs.find((job) => job.customerName === 'Quin Dalberg');
    assert.equal(pageAd.ad, 'Cavite Page ad');
    assert.equal(pageAd.adArea, 'CAVITE');
    assert.equal(boosted.ad, '');
    assert.equal(boosted.adArea, 'Boosted posts');
    await post({ action: 'add-payment', date: '2026-10-12', jobId: laguna.id, customerName: 'Mara Quill', branch: 'San Pablo', type: 'Repair', method: 'Cash', amount: '124000', returnTab: 'finance', returnGroup: 'ad' });
    await post({ action: 'add-payment', date: '2026-10-12', jobId: cavite.id, customerName: 'Theo Farrow', branch: 'Cavite', type: 'Repair', method: 'Cash', amount: '24000', returnTab: 'finance' });
    await post({ action: 'add-payment', date: '2026-10-12', jobId: open.id, customerName: 'Willa Ibarra', branch: 'San Pablo', type: 'Check-up fee', method: 'Cash', amount: '5000', returnTab: 'finance' });
    await post({ action: 'add-ad', start: '2026-10-01', end: '2026-10-17', branch: 'San Pablo', amount: '1000', chats: '10', note: 'laguna test ads', returnTab: 'finance', returnGroup: 'ad' });
    await post({ action: 'add-ad', start: '2026-10-01', end: '2026-10-17', branch: 'Cavite', amount: '500', chats: '5', note: 'cavite test ads', returnTab: 'finance' });
    await post({ action: 'add-payment', date: '2026-10-12', jobId: boosted.id, customerName: 'Quin Dalberg', branch: 'San Pablo', type: 'Repair', method: 'Cash', amount: '8000', returnTab: 'finance' });
    await post({ action: 'add-ad', start: '2026-10-01', end: '2026-10-17', branch: 'Boosted posts', amount: '300', chats: '4', note: 'boosted test ads', returnTab: 'finance', returnGroup: 'ad' });

    const finance = await (await fetch(`${s.base}/ops?tab=finance&period=all&group=ad`, { headers: { Cookie: jar } })).text();
    assert.match(finance, /Profit by ad budget/);
    assert.match(finance, /data-group="ad-budget"/);
    assert.match(finance, /Cavite Page ad/);
    assert.match(finance, /Boosted posts/);
    assert.match(finance, /data-budget="Boosted posts"/);
    assert.match(finance, /₱8,000/);
    assert.match(finance, /Untraced \(no ad\)/);
    assert.match(finance, /₱124,000/);
    assert.match(finance, /data-untraced="1"/);
    assert.match(finance, /1 job not traced to an ad — tag them/);
    assert.match(finance, /status=untraced/);
    assert.doesNotMatch(finance, /Lead from/);
    const form = await (await fetch(`${s.base}/ops?tab=jobs&edit=${laguna.id}`, { headers: { Cookie: jar } })).text();
    assert.match(form, /Cavite Page ad/);
    assert.match(form, /Boosted posts/);
    assert.match(form, /Which ad brought them/);
    assert.match(form, /name="adArea"/);
    assert.match(form, /value="LAGUNA" selected/);
    assert.doesNotMatch(form, /Lead from/);
    const tagged = await (await fetch(`${s.base}/ops?tab=jobs&status=untraced`, { headers: { Cookie: jar } })).text();
    assert.match(tagged, /Willa Ibarra/);
    assert.doesNotMatch(tagged, /Mara Quill|Theo Farrow|Pia Calderon|Quin Dalberg/);
    const csv = await (await fetch(`${s.base}/ops/export?kind=finance&period=all`, { headers: { Cookie: jar } })).text();
    assert.match(csv, /Untraced \(no ad\)/);
    assert.match(csv, /Boosted posts/);
    assert.match(csv, /Untraced jobs/);
    assert.match(csv, /124000/);
    const jobsCsv = await (await fetch(`${s.base}/ops/export?kind=jobs`, { headers: { Cookie: jar } })).text();
    assert.match(jobsCsv, /LAGUNA - area ads/);
    assert.match(jobsCsv, /Ad area/);
    assert.match(jobsCsv, /,North,/);
  } finally { await s.close(); }
});

test('operations shows when the reply schedule is on or waiting', async () => {
  const s = await setup({ BOT_SCHEDULE: '22:00-07:00' });
  let now = Date.parse('2026-10-19T04:00:00Z'); // 12:00 PHT
  s.app.bot.now = () => now;
  try {
    const jar = await cookie(s.base);
    const off = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(off, /class="bot-status"/);
    assert.match(off, /OFF now, turns on at 10:00 PM/);
    now = Date.parse('2026-10-18T15:00:00Z'); // 23:00 PHT
    const on = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(on, /Bot: ON \(schedule 10PM–7AM\)/);
    s.app.cfg.botEnabled = false;
    const master = await (await fetch(`${s.base}/ops?tab=today`, { headers: { Cookie: jar } })).text();
    assert.match(master, /Bot: OFF/);
    assert.doesNotMatch(master, /turns on at/);
  } finally { await s.close(); }
});
