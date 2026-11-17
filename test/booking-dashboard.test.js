'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planBookings, jobCovers, fromIntakeRow, fromNetlifyRow, testsToDelete, dedupeKey, TEST_NAME,
} = require('../src/booking-dashboard');
const { BookingDashboard } = require('../src/booking-dashboard');

const NOW = Date.parse('2026-11-17T06:00:00Z');

function intake(over = {}) {
  return fromIntakeRow({
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-11-17T05:12:00Z',
    name: 'Diana Marie Alumbro',
    mobile: '09760788180',
    address: 'Blk 1',
    city: 'San Pablo',
    province: 'Laguna',
    landmark: 'Church',
    pin: 'https://maps.app.goo.gl/abc',
    appliance: 'TV',
    brand: 'Samsung',
    size: '55"',
    problem: 'no display',
    pdate: '2026-11-17',
    service: 'REGULAR',
    details: "JMAG'S SERVICE REQUEST\nName: Diana Marie Alumbro\nMobile: 09760788180",
    ...over,
  });
}

test('the same booking from intake and Netlify, including spam, is one row', () => {
  const diana = intake();
  const netlify = fromNetlifyRow({
    id: '6acb80c2cfef520008a600aa',
    created_at: '2026-11-17T05:12:05Z',
    data: {
      name: 'Diana Marie Alumbro',
      mobile: '0976 078 8180',
      appliance: 'TV',
      problem: 'no display',
      pdate: '2026-11-17',
      city: 'San Pablo',
    },
  }, { spam: true });
  const other = fromNetlifyRow({
    id: '6acb80c2cfef520008a600bb',
    created_at: '2026-11-10T02:00:00Z',
    data: { name: 'Ana Diola', mobile: '09171234567', appliance: 'TV', problem: 'lines', pdate: '2026-11-10', city: 'Silang' },
  }, { spam: true });
  const decision = planBookings([diana, netlify, other], { now: NOW });
  assert.equal(decision.inserts.length, 2);
  const merged = decision.inserts.find((row) => row.dedupeKey === diana.dedupeKey);
  assert.equal(merged.id, netlify.id);
  assert.equal(merged.intakeId, diana.id);
  assert.equal(merged.spam, true);
  assert.equal(decision.inserts.some((row) => row.fields.name === 'Ana Diola' && row.spam), true);
});

test('a hand-added job for the same phone the same day is not inserted again', () => {
  const diana = intake();
  const job = {
    id: 'job-diana',
    phone: '0976-078-8180',
    customerName: 'Diana Alumbro',
    no: 'JO-261117-297',
    createdAt: Date.parse('2026-11-17T05:40:00Z'),
    date: '2026-11-17',
  };
  assert.equal(jobCovers(job, diana.fields, Date.parse(diana.createdAt)), true);
  const decision = planBookings([diana], { jobs: [job], now: NOW });
  assert.equal(decision.inserts.length, 0);
  assert.equal(decision.skippedJob.length, 1);
  assert.equal(decision.skippedJob[0].name, 'Diana Marie Alumbro');
});

test('a different day for the same customer is still a new booking', () => {
  const again = intake({
    id: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-12-01T01:00:00Z',
    pdate: '2026-12-01',
    problem: 'no power',
  });
  const oldJob = {
    phone: '09760788180',
    customerName: 'Diana Marie Alumbro',
    createdAt: Date.parse('2026-11-17T05:40:00Z'),
    date: '2026-11-17',
  };
  const decision = planBookings([again], { jobs: [oldJob], now: Date.parse('2026-12-01T02:00:00Z') });
  assert.equal(decision.inserts.length, 1);
});

test('an existing dashboard row and a dismissed marker are not duplicated', () => {
  const row = intake();
  const have = planBookings([row], {
    now: NOW,
    formDocs: [{ id: 'other', data: { dedupeKey: row.dedupeKey, data: row.fields } }],
  });
  assert.equal(have.inserts.length, 0);
  const dismissed = planBookings([row], {
    now: NOW,
    markers: [{ id: row.id, data: { status: 'dismissed' } }],
  });
  assert.equal(dismissed.inserts.length, 0);
});

test('a labelled TEST row is deleted only after it has been stored', () => {
  const fresh = {
    id: 'test-form',
    updated_at: new Date(NOW).toISOString(),
    data: { data: { name: 'TEST Dashboard Sync' }, sharedAt: NOW, created_at: new Date(NOW).toISOString() },
  };
  const old = {
    id: 'test-old',
    data: { data: { name: 'TEST Dashboard Sync' }, sharedAt: NOW - 120000, created_at: new Date(NOW - 120000).toISOString() },
  };
  const real = { id: 'real', data: { data: { name: 'Ana Diola' }, sharedAt: NOW - 120000 } };
  const purge = testsToDelete([fresh, old, real], [
    { id: 'booking-test', name: 'TEST Dashboard Sync', created_at: new Date(NOW - 120000).toISOString() },
    { id: 'booking-fresh', name: 'TEST Dashboard Sync', created_at: new Date(NOW).toISOString() },
  ], NOW);
  assert.deepEqual(purge.formIds, ['test-old']);
  assert.deepEqual(purge.bookingIds, ['booking-test']);
  assert.ok(dedupeKey({ name: 'TEST Dashboard Sync', mobile: '09000000000' }, '2026-11-17T06:00:00Z'));
  assert.equal(TEST_NAME, 'test dashboard sync');
});

test('sync writes one dashboard row and never calls Messenger', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    const u = String(url);
    if (u.includes('graph.facebook') || u.includes('semaphore') || u.includes('/me/messages')) {
      throw new Error('customer message attempted');
    }
    let body = [];
    if (u.includes('/bookings?')) {
      body = [{
        id: '33333333-3333-4333-8333-333333333333',
        created_at: '2026-11-16T01:00:00Z',
        name: 'Ana Diola',
        mobile: '09171234567',
        city: 'Silang',
        province: 'Cavite',
        appliance: 'TV',
        problem: 'lines',
        pdate: '2026-11-16',
      }];
    } else if (u.includes('state=spam')) {
      body = [{
        id: '6acb80c2cfef520008a600bb',
        created_at: '2026-11-16T01:00:02Z',
        data: { name: 'Ana Diola', mobile: '09171234567', city: 'Silang', appliance: 'TV', problem: 'lines', pdate: '2026-11-16' },
      }];
    } else if (u.includes('api.netlify.com')) body = [];
    else if (u.includes('collection=eq.jobs')) {
      body = [{
        id: 'job-diana',
        updated_at: '2026-11-17T05:40:00Z',
        data: { phone: '09760788180', customerName: 'Diana Marie Alumbro', no: 'JO-261117-297', createdAt: Date.parse('2026-11-17T05:40:00Z'), date: '2026-11-17' },
      }];
    } else if (u.includes('/app_docs')) body = [];
    const text = options.method === 'POST' ? JSON.stringify([{ id: 'stored' }]) : JSON.stringify(body);
    return { ok: true, status: 200, text: async () => text, headers: { get: () => '' } };
  };
  const sync = new BookingDashboard({
    supabaseUrl: 'https://fhjarnogglakehaztbbj.supabase.co',
    supabaseServiceRoleKey: 'service-role-test',
    netlifyApiToken: 'netlify-token-test',
    netlifyFormId: '6acb80c2cfef520008a600f5',
    bookingDashboardSync: true,
  }, { fetchImpl, now: () => NOW, log: { info() {}, warn() {} } });
  const result = await sync.sync();
  assert.equal(result.ok, true);
  const posts = calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/rest\/v1\/app_docs/);
  assert.equal(result.inserted.length, 1);
  assert.equal(result.inserted[0].name, 'Ana Diola');
  assert.equal(result.inserted[0].spam, true);
  assert.equal(calls.some((call) => /facebook|semaphore|messages/.test(call.url)), false);
});
