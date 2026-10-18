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
  asksJobStatus, asksWarrantyProblem, importOps, parseJobsCsv, jobBalance, duplicatePayments,
  ensureOps,
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
  assert.equal(jobStatusText(noted), 'Hello po 😊 Yung TV niyo po ay naka-under repair na. Note ni Ivan: hinihintay po ang backlight. Babalikan po namin kayo.');
  assert.equal(
    dailyStatusText({ status: 'Under Repair', statusNote: 'Si Ivan po ay inaayos na ang backlight' }),
    'Hello po 😊 Update lang po sa TV niyo. Under repair pa po. Si Ivan po ay inaayos na ang backlight. Babalikan po namin kayo pag tapos na.',
  );
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
      status: 'Under Repair', branch: 'San Pablo', psid, statusNote: 'Si Ivan po ay inaayos na ang backlight',
      warrantyEnd: '2027-01-18', price: 5000,
    });
    s.app.store.addTurn(psid, 'user', 'hello po', TEN_AM - 60 * 60 * 1000);
    s.app.bot.now = () => TEN_AM;
    const off = await s.app.bot.maybeDailyStatus(TEN_AM);
    assert.deepEqual(off.sent, []);
    assert.equal(s.mock.calls.messages.length, 0);

    s.app.cfg.dailyStatusUpdates = true;
    s.app.bot.now = () => Date.parse('2026-10-18T01:00:00Z');
    assert.deepEqual((await s.app.bot.maybeDailyStatus()).sent, []);
    s.app.bot.now = () => TEN_AM;
    const sent = await s.app.bot.checkFollowups();
    void sent;
    assert.equal(s.mock.calls.messages.length, 1);
    assert.equal(s.mock.calls.messages[0].message.text, 'Hello po 😊 Update lang po sa TV niyo. Under repair pa po. Si Ivan po ay inaayos na ang backlight. Babalikan po namin kayo pag tapos na.');
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
