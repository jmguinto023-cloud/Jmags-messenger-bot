'use strict';
// Shop operations: job orders, money, parts, and the replies that read them.
// Persisted on store.data.ops inside DATA_DIR/state.json. No customer rows live in git.

const { chatCustomerName } = require('./summary');

const STATUSES = ['Inquiry', 'Scheduled', 'Checked', 'Under Repair', 'Completed', 'Cancelled'];
const TECHS = ['JM', 'Joshua', 'Unassigned'];
const BRANCHES = ['San Pablo', 'Cavite'];
const PAY_TYPES = ['Check-up fee', 'Repair', 'Parts', 'Other'];
const METHODS = ['Cash', 'GCash', 'Maya', 'Bank transfer'];
const TABS = ['today', 'jobs', 'customers', 'money', 'finance', 'parts'];
const MONTHS = ['Enero', 'Pebrero', 'Marso', 'Abril', 'Mayo', 'Hunyo', 'Hulyo', 'Agosto', 'Setyembre', 'Oktubre', 'Nobyembre', 'Disyembre'];

const ASK_BOTH = 'Para macheck ko po ang status, pakisabi ang pangalan at phone number na ginamit sa booking.';
const ASK_NAME = 'Salamat po. Paki-confirm lang ang buong pangalan na naka-book.';
const ASK_PHONE = 'Salamat po. Paki-send lang ang phone number na ginamit sa booking.';
const UNSURE = 'Pasensya na po, hindi ko mahanap ang eksaktong record. Ipapaabot ko na po kay Ivan.';

function emptyOps() {
  return {
    jobs: [], payments: [], expenses: [], ads: [], parts: [],
    bookings: [], customers: [], otherIncome: [],
  };
}

function ensureOps(store) {
  const data = store.data;
  data.ops = data.ops && typeof data.ops === 'object' ? data.ops : emptyOps();
  for (const key of Object.keys(emptyOps())) {
    if (!Array.isArray(data.ops[key])) data.ops[key] = [];
  }
  return data.ops;
}

function manilaStamp(now, tz = 'Asia/Manila') {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour };
}

function addDays(ymd, days) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(ymd, months) {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthBounds(ymd) {
  const [y, m] = String(ymd || '').split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

function periodRange(period, now, tz) {
  const today = manilaStamp(now, tz).date;
  if (period === 'all') return null;
  if (period === 'last') {
    const [y, m] = today.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    return monthBounds(prev);
  }
  return monthBounds(today);
}

function inRange(date, range) {
  if (!range) return Boolean(date);
  return Boolean(date) && date >= range.start && date <= range.end;
}

function parseBranch(value) {
  const s = String(value || 'ALL').trim().toLowerCase().replace(/\s+/g, ' ');
  if (s === 'san pablo' || s === 'sanpablo') return 'San Pablo';
  if (s === 'cavite') return 'Cavite';
  return 'ALL';
}

function branchLabel(branch) {
  if (branch === 'San Pablo') return 'SAN PABLO';
  if (branch === 'Cavite') return 'CAVITE';
  return 'ALL';
}

function canon(value, list) {
  const raw = String(value || '').trim();
  const found = list.find((item) => item.toLowerCase() === raw.toLowerCase());
  return found || raw;
}

function canonBranch(value) {
  const parsed = parseBranch(value);
  return parsed === 'ALL' ? String(value || '').trim() : parsed;
}

function money(value) {
  const n = Number(String(value ?? '').replace(/[₱,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function roundPeso(n) {
  return Math.round(Number(n) || 0);
}

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const header = (rows.shift() || []).map((h) => h.trim());
  if (!header.length || header.every((h) => !h)) return [];
  return rows
    .filter((cells) => cells.some((cell) => String(cell || '').trim()))
    .map((cells) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = cells[i] == null ? '' : String(cells[i]).trim(); });
      return obj;
    });
}

function headerMap(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[String(key).toLowerCase().replace(/₱/g, '').replace(/[^a-z0-9]+/g, ' ').trim()] = value;
  }
  return out;
}

function pick(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== '') return row[name];
  }
  return '';
}

function blankJob(partial = {}) {
  return {
    id: '', date: '', doneDate: '', visitDate: '', visitTime: '',
    customerName: '', phone: '', city: '', address: '', landmark: '', mapLink: '',
    unitType: 'TV', brand: '', size: '', issue: '',
    technician: 'Unassigned', branch: '', adArea: '', leadSource: '',
    price: 0, travelFee: 0, importedPaid: 0,
    status: 'Inquiry', statusNote: '', notes: '',
    partsUsed: '', partsCost: 0, psid: '',
    warrantyEnd: '', createdAt: '', updatedAt: '', lastDailyStatusDate: '', dailyStatusSkip: '',
    ...partial,
  };
}

function withWarranty(job) {
  job.warrantyEnd = job.date ? addMonths(job.date, 3) : (job.warrantyEnd || '');
  return job;
}

function jobFromCsv(row) {
  const h = headerMap(row);
  const date = pick(h, 'date received', 'date');
  const job = blankJob({
    id: pick(h, 'job id', 'jo number', 'id'),
    date,
    doneDate: pick(h, 'date done'),
    visitDate: pick(h, 'visit date') || date,
    visitTime: pick(h, 'visit time'),
    customerName: pick(h, 'customer name', 'customer'),
    phone: pick(h, 'contact', 'phone'),
    city: pick(h, 'area city', 'area', 'city'),
    address: pick(h, 'address'),
    landmark: pick(h, 'landmark'),
    mapLink: pick(h, 'map link', 'map'),
    unitType: pick(h, 'appliance', 'unit type') || 'TV',
    brand: pick(h, 'brand model', 'brand'),
    size: pick(h, 'size'),
    issue: pick(h, 'issue'),
    technician: canon(pick(h, 'technician') || 'Unassigned', TECHS) || 'Unassigned',
    branch: canonBranch(pick(h, 'branch')),
    adArea: pick(h, 'ad area'),
    leadSource: pick(h, 'lead source'),
    price: money(pick(h, 'quote')),
    travelFee: money(pick(h, 'travel transpo fee', 'travel fee')),
    importedPaid: money(pick(h, 'total paid')),
    status: canon(pick(h, 'status') || 'Inquiry', STATUSES) || 'Inquiry',
    notes: pick(h, 'notes'),
    partsUsed: pick(h, 'parts used'),
    partsCost: money(pick(h, 'parts cost')),
  });
  if (!TECHS.includes(job.technician)) job.technician = 'Unassigned';
  if (!STATUSES.includes(job.status)) job.status = 'Inquiry';
  return withWarranty(job);
}

function paymentFromCsv(row) {
  const h = headerMap(row);
  return {
    date: pick(h, 'date'),
    jobId: pick(h, 'jo number', 'job id'),
    customerName: pick(h, 'customer', 'customer name'),
    branch: canonBranch(pick(h, 'branch')),
    type: canon(pick(h, 'type') || 'Other', PAY_TYPES) || 'Other',
    method: canon(pick(h, 'method') || 'Cash', METHODS) || 'Cash',
    amount: money(pick(h, 'amount')),
    note: pick(h, 'note'),
  };
}

function adFromCsv(row) {
  const h = headerMap(row);
  return {
    start: pick(h, 'period start', 'start'),
    end: pick(h, 'period end', 'end'),
    branch: canonBranch(pick(h, 'branch')),
    amount: money(pick(h, 'amount')),
    chats: money(pick(h, 'chats')),
    note: pick(h, 'note'),
  };
}

function parseJobsCsv(text) { return parseCsv(text).map(jobFromCsv).filter((j) => j.id); }
function parsePaymentsCsv(text) { return parseCsv(text).map(paymentFromCsv).filter((p) => p.date || p.amount); }
function parseAdsCsv(text) { return parseCsv(text).map(adFromCsv).filter((a) => a.start || a.amount); }

function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function namesMatch(a, b) {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(' ');
  const ys = y.split(' ');
  return xs.length >= 2 && ys.length >= 2 && xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

function extractPhone(text) {
  const m = String(text || '').match(/(?:\+63|63|0)9\d{9}/);
  return m ? m[0] : '';
}

function nextJobId(jobs, ymd) {
  const stamp = String(ymd || '').replace(/-/g, '').slice(2);
  const re = new RegExp(`^JO-${stamp}-(\\d+)$`);
  let max = 0;
  for (const job of jobs) {
    const m = String(job.id || '').match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `JO-${stamp}-${String(max + 1).padStart(3, '0')}`;
}

function nextSeq(rows, prefix) {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const row of rows) {
    const m = String(row.id || '').match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function jobPaid(job, payments) {
  const rows = (payments || []).filter((p) => p.jobId === job.id);
  if (rows.length) return rows.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return Number(job.importedPaid || 0);
}

function jobBalance(job, payments) {
  const price = Number(job.price || 0) + Number(job.travelFee || 0);
  return Math.round((price - jobPaid(job, payments)) * 100) / 100;
}

function filterBranch(rows, branch) {
  if (!branch || branch === 'ALL') return rows || [];
  return (rows || []).filter((row) => canonBranch(row.branch) === branch);
}

function payKey(p) {
  return [p.date, p.jobId, p.type, p.method, Number(p.amount), p.note || ''].join('|');
}

function upsertJobs(ops, incoming) {
  let n = 0;
  for (const raw of incoming) {
    if (!raw.id) continue;
    const prev = ops.jobs.find((j) => j.id === raw.id);
    const job = withWarranty({
      ...blankJob(),
      ...raw,
      psid: prev ? prev.psid || '' : '',
      statusNote: prev ? prev.statusNote || '' : (raw.statusNote || ''),
      visitDate: prev && prev.visitDate ? prev.visitDate : (raw.visitDate || raw.date || ''),
      visitTime: prev && prev.visitTime ? prev.visitTime : (raw.visitTime || ''),
      address: raw.address || (prev && prev.address) || '',
      landmark: raw.landmark || (prev && prev.landmark) || '',
      mapLink: raw.mapLink || (prev && prev.mapLink) || '',
      lastDailyStatusDate: prev ? prev.lastDailyStatusDate || '' : '',
      dailyStatusSkip: prev ? prev.dailyStatusSkip || '' : '',
      createdAt: prev ? prev.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    if (prev) Object.assign(prev, job);
    else ops.jobs.push(job);
    n += 1;
  }
  return n;
}

function addPayments(ops, incoming) {
  const seen = new Set(ops.payments.map(payKey));
  let n = 0;
  for (const row of incoming) {
    const key = payKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    ops.payments.push(row);
    n += 1;
  }
  return n;
}

function addAds(ops, incoming) {
  const keyOf = (a) => [a.start, a.end, a.branch, a.amount, a.chats, a.note || ''].join('|');
  const seen = new Set(ops.ads.map(keyOf));
  let n = 0;
  for (const row of incoming) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    ops.ads.push(row);
    n += 1;
  }
  return n;
}

function upsertCustomers(ops, incoming) {
  let n = 0;
  for (const row of incoming || []) {
    const name = String(row.name || '').trim();
    const phone = String(row.phone || '').trim();
    const address = String(row.address || '').trim();
    if (!name && !phone) continue;
    const key = phoneKey(phone);
    const prev = ops.customers.find((c) => (key && phoneKey(c.phone) === key) || (!key && namesMatch(c.name, name)));
    if (prev) {
      if (name) prev.name = name;
      if (phone) prev.phone = phone;
      if (address) prev.address = address;
    } else ops.customers.push({ name, phone, address });
    n += 1;
  }
  return n;
}

function upsertParts(ops, incoming) {
  let n = 0;
  for (const row of incoming || []) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    const branch = canonBranch(row.branch);
    const prev = ops.parts.find((p) => normName(p.name) === normName(name) && canonBranch(p.branch) === branch);
    const part = {
      id: prev ? prev.id : (row.id || nextSeq(ops.parts, 'P')),
      name,
      branch,
      cost: money(row.cost),
      stock: money(row.stock),
      reorder: Boolean(row.reorder) || Number(row.stock) <= 0,
    };
    if (prev) Object.assign(prev, part);
    else ops.parts.push(part);
    n += 1;
  }
  return n;
}

function upsertBookings(ops, incoming) {
  let n = 0;
  for (const row of incoming || []) {
    const name = String(row.name || '').trim();
    if (!name && !row.phone) continue;
    const id = row.id || nextSeq(ops.bookings, 'BK');
    const prev = ops.bookings.find((b) => b.id === id);
    const booking = {
      id,
      name,
      phone: String(row.phone || '').trim(),
      city: String(row.city || '').trim(),
      address: String(row.address || '').trim(),
      landmark: String(row.landmark || '').trim(),
      unitType: String(row.unitType || 'TV').trim() || 'TV',
      brand: String(row.brand || '').trim(),
      size: String(row.size || '').trim(),
      issue: String(row.issue || '').trim(),
      price: money(row.price),
      visitDate: String(row.visitDate || '').trim(),
      visitTime: String(row.visitTime || '').trim(),
      branch: canonBranch(row.branch),
      sentAt: String(row.sentAt || new Date().toISOString()).trim(),
      status: prev ? prev.status : 'new',
      jobId: prev ? prev.jobId || '' : '',
    };
    if (row.status && ['new', 'dismissed', 'converted'].includes(row.status)) booking.status = row.status;
    if (prev) Object.assign(prev, booking);
    else ops.bookings.push(booking);
    n += 1;
  }
  return n;
}

function fillAddresses(ops) {
  for (const job of ops.jobs) {
    if (job.address) continue;
    const key = phoneKey(job.phone);
    const customer = ops.customers.find((c) => (key && phoneKey(c.phone) === key) || namesMatch(c.name, job.customerName));
    if (customer && customer.address) job.address = customer.address;
  }
}

function importOps(store, payload) {
  const ops = ensureOps(store);
  const body = payload || {};
  const result = {
    jobs: body.jobsCsv ? upsertJobs(ops, parseJobsCsv(body.jobsCsv)) : 0,
    payments: body.paymentsCsv ? addPayments(ops, parsePaymentsCsv(body.paymentsCsv)) : 0,
    ads: body.adSpendCsv ? addAds(ops, parseAdsCsv(body.adSpendCsv)) : 0,
    customers: upsertCustomers(ops, body.customers),
    parts: upsertParts(ops, body.parts),
    bookings: upsertBookings(ops, body.bookings),
    expenses: 0,
    otherIncome: 0,
  };
  for (const row of body.expenses || []) {
    if (!row || (!row.date && !row.amount)) continue;
    ops.expenses.push({
      date: String(row.date || ''),
      branch: canonBranch(row.branch),
      amount: money(row.amount),
      note: String(row.note || ''),
    });
    result.expenses += 1;
  }
  for (const row of body.otherIncome || []) {
    if (!row || (!row.date && !row.amount)) continue;
    ops.otherIncome.push({
      date: String(row.date || ''),
      branch: canonBranch(row.branch),
      amount: money(row.amount),
      note: String(row.note || ''),
    });
    result.otherIncome += 1;
  }
  if (body.csv && body.type === 'jobs') result.jobs += upsertJobs(ops, parseJobsCsv(body.csv));
  if (body.csv && body.type === 'payments') result.payments += addPayments(ops, parsePaymentsCsv(body.csv));
  if (body.csv && (body.type === 'ads' || body.type === 'adSpend')) result.ads += addAds(ops, parseAdsCsv(body.csv));
  fillAddresses(ops);
  if (typeof store.flushNow === 'function') store.flushNow();
  else store.save();
  return result;
}

function directory(ops) {
  const map = new Map();
  const add = (row) => {
    const key = phoneKey(row.phone) || (normName(row.name) ? `name:${normName(row.name)}` : '');
    if (!key) return;
    const cur = map.get(key) || { name: '', phone: '', address: '', jobIds: [] };
    if (row.name) cur.name = row.name;
    if (row.phone) cur.phone = row.phone;
    if (row.address && !cur.address) cur.address = row.address;
    if (row.jobId && !cur.jobIds.includes(row.jobId)) cur.jobIds.push(row.jobId);
    map.set(key, cur);
  };
  for (const customer of ops.customers) add(customer);
  for (const job of ops.jobs) add({ name: job.customerName, phone: job.phone, address: job.address, jobId: job.id });
  return [...map.values()];
}

function totalPaidFor(ops, customer) {
  const ids = new Set(customer.jobIds);
  const pays = ops.payments.filter((p) => ids.has(p.jobId));
  if (pays.length) return pays.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  return ops.jobs.filter((j) => ids.has(j.id)).reduce((sum, j) => sum + Number(j.importedPaid || 0), 0);
}

function customerRows(ops, branch) {
  return directory(ops)
    .map((c) => {
      const jobIds = !branch || branch === 'ALL'
        ? c.jobIds
        : c.jobIds.filter((id) => {
          const job = ops.jobs.find((j) => j.id === id);
          return job && canonBranch(job.branch) === branch;
        });
      return { ...c, jobIds };
    })
    .filter((c) => !branch || branch === 'ALL' || c.jobIds.length)
    .map((c) => ({
      name: c.name,
      phone: c.phone,
      address: c.address,
      jobs: c.jobIds.length,
      paid: totalPaidFor(ops, c),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function openJob(job) {
  return job.status !== 'Completed' && job.status !== 'Cancelled';
}

function pickJob(jobs) {
  const list = (jobs || []).filter((j) => j.status !== 'Cancelled');
  const open = list.filter(openJob);
  const pool = (open.length ? open : list).slice();
  pool.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  return pool[0] || null;
}

function jobsForCustomer(ops, customer) {
  const ids = new Set(customer.jobIds);
  return ops.jobs.filter((j) => ids.has(j.id));
}

function customersMatchingPhone(ops, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  return directory(ops).filter((c) => phoneKey(c.phone) === key);
}

function customersMatchingName(ops, name) {
  if (!normName(name)) return [];
  return directory(ops).filter((c) => namesMatch(c.name, name));
}

function suggestionFor(ops, history) {
  const users = (history || []).filter((h) => h && h.role === 'user').map((h) => h.content || '').join('\n');
  const phone = extractPhone(users);
  const name = chatCustomerName(history);
  const byPhone = phone ? customersMatchingPhone(ops, phone) : [];
  if (byPhone.length === 1) {
    const job = pickJob(jobsForCustomer(ops, byPhone[0]));
    if (job) return { jobId: job.id, reason: 'phone' };
  }
  if (byPhone.length > 1) return null;
  const byName = name ? customersMatchingName(ops, name) : [];
  if (byName.length === 1) {
    const job = pickJob(jobsForCustomer(ops, byName[0]));
    if (job) return { jobId: job.id, reason: 'name' };
  }
  return null;
}

function jobByPsid(ops, psid) {
  const rows = (ops.jobs || []).filter((j) => j.psid && j.psid === psid);
  return pickJob(rows) || rows[0] || null;
}

function matchIdentity(ops, { name, phone }) {
  const key = phoneKey(phone);
  const named = normName(name);
  if (!key || !named) return { status: 'incomplete' };
  const byPhone = customersMatchingPhone(ops, phone);
  const both = byPhone.filter((c) => namesMatch(c.name, name));
  if (both.length === 1) return { status: 'one', customer: both[0] };
  if (byPhone.length || customersMatchingName(ops, name).length) return { status: 'mismatch' };
  return { status: 'none' };
}

function asksJobStatus(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/ano na yung video|na-?review|nareview/i.test(t)) return false;
  if (/video/i.test(t) && !/status ng|tv ko|tapos na/i.test(t)) return false;
  if (/ano na (?:po )?status\b/i.test(t)) return true;
  if (/kumusta na (?:po )?(?:yung |ang )?tv\b/i.test(t)) return true;
  if (/tapos na po ba\b/i.test(t)) return true;
  if (/naayos na ba\b/i.test(t)) return true;
  if (/status (?:ng|nang) (?:tv|job|repair|unit)\b/i.test(t)) return true;
  return false;
}

function asksWarrantyProblem(text) {
  const t = String(text || '');
  if (/sira ulit|nasira (?:na )?naman|bumalik ang sira|sira nanaman|paulit(?: ulit)? ang sira|same problem/i.test(t)) return true;
  return /(warranty|garantiya)/i.test(t) && /sira|problem|issue|ayaw|hindi gumagana|nasira/i.test(t);
}

function friendlyStatus(status) {
  return {
    Inquiry: 'naka-inquiry pa',
    Scheduled: 'naka-schedule na',
    Checked: 'na-check na',
    'Under Repair': 'naka-under repair na',
    Completed: 'tapos na',
    Cancelled: 'na-cancel',
  }[status] || String(status || '').toLowerCase();
}

function longDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

function jobStatusText(job) {
  const note = String(job.statusNote || '').trim();
  const status = friendlyStatus(job.status);
  if (note) {
    const line = /[.!?]$/.test(note) ? note : `${note}.`;
    return `Hello po 😊 Yung TV niyo po ay ${status}. Note ni Ivan: ${line} Babalikan po namin kayo.`;
  }
  return `Hello po 😊 Yung TV niyo po ay ${status}. Babalikan po namin kayo pag may update.`;
}

function dailyStatusText(job) {
  const note = String(job.statusNote || '').trim();
  const noteLine = note ? (/\.$/.test(note) ? note : `${note}.`) : '';
  const statusLine = job.status === 'Under Repair' ? 'Under repair pa po.' : `${friendlyStatus(job.status)}.`;
  return `Hello po 😊 Update lang po sa TV niyo. ${statusLine}${noteLine ? ` ${noteLine}` : ''} Babalikan po namin kayo pag tapos na.`;
}

function warrantyEndOf(job) {
  if (job.warrantyEnd) return job.warrantyEnd;
  return job.date ? addMonths(job.date, 3) : '';
}

function warrantyText(job) {
  return `Hello po 😊 Nasa warranty pa po ang unit hanggang ${longDate(warrantyEndOf(job))}. Pakisend lang po ng issue at video para ma-check ni Ivan. Hindi pa po ako makakapangako kung covered.`;
}

function inWarranty(job, now, tz) {
  const end = warrantyEndOf(job);
  if (!end) return false;
  return end >= manilaStamp(now, tz).date;
}

function nameGuess(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 60 || /\d/.test(t) || t.includes('?')) return '';
  const words = t.split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w));
  if (words.length < 2 || words.length > 4) return '';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function adOverlaps(ad, range) {
  if (!range) return true;
  const start = ad.start || '0000-01-01';
  const end = ad.end || '9999-12-31';
  return start <= range.end && end >= range.start;
}

function sumAmount(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
}

function branchMoney(ops, branch, range) {
  const payments = ops.payments.filter((p) => canonBranch(p.branch) === branch && inRange(p.date, range));
  const ads = ops.ads.filter((a) => canonBranch(a.branch) === branch && adOverlaps(a, range));
  const expenses = ops.expenses.filter((e) => canonBranch(e.branch) === branch && inRange(e.date, range));
  const parts = ops.jobs.filter((j) => canonBranch(j.branch) === branch && inRange(j.date, range));
  const collected = sumAmount(payments);
  const raw = sumAmount(ads) + sumAmount(expenses) + parts.reduce((s, j) => s + Number(j.partsCost || 0), 0);
  const costs = roundPeso(raw);
  return { collected, costs, profit: collected - costs, raw };
}

function moneyReport(ops, { period = 'month', branch = 'ALL', now = Date.now(), tz = 'Asia/Manila' } = {}) {
  const range = periodRange(period, now, tz);
  const selected = branch && branch !== 'ALL' ? [branch] : BRANCHES;
  const per = {};
  let rawAll = 0;
  for (const name of BRANCHES) {
    per[name] = branchMoney(ops, name, range);
    rawAll += per[name].raw;
  }
  const payments = filterBranch(ops.payments, branch).filter((p) => inRange(p.date, range));
  const collected = sumAmount(payments);
  const costs = branch === 'ALL' || !branch
    ? roundPeso(rawAll)
    : per[branch].costs;
  const by = (key) => {
    const out = {};
    for (const row of payments) {
      const name = row[key] || '—';
      out[name] = (out[name] || 0) + Number(row.amount || 0);
    }
    return out;
  };
  const cavite = per.Cavite;
  const investor = roundPeso(cavite.profit / 2);
  const caviteKeep = cavite.profit - investor;
  const youKeep = branch === 'Cavite'
    ? caviteKeep
    : branch === 'San Pablo'
      ? per['San Pablo'].profit
      : per['San Pablo'].profit + caviteKeep;
  const unpaidJobs = filterBranch(ops.jobs, branch)
    .filter((j) => j.status !== 'Cancelled' && jobBalance(j, ops.payments) > 0)
    .map((j) => ({ id: j.id, customerName: j.customerName, phone: j.phone, balance: jobBalance(j, ops.payments), branch: j.branch }));
  return {
    range, collected, costs, profit: collected - costs,
    byType: by('type'), byBranch: by('branch'), byMethod: by('method'),
    perBranch: per, investor, youKeep,
    unpaid: unpaidJobs,
    unpaidTotal: unpaidJobs.reduce((s, j) => s + j.balance, 0),
    payments, expenses: filterBranch(ops.expenses, branch).filter((e) => inRange(e.date, range)),
    selected,
  };
}

function duplicatePayments(payments, branch) {
  const groups = new Map();
  for (const row of filterBranch(payments, branch)) {
    const key = [row.jobId, row.date, row.type, Number(row.amount)].join('|');
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()].filter((list) => list.length > 1);
}

function bookingDate(booking) {
  return String(booking.sentAt || '').slice(0, 10);
}

function financeReport(ops, { period = 'month', branch = 'ALL', now = Date.now(), tz = 'Asia/Manila' } = {}) {
  const range = periodRange(period, now, tz);
  const ads = filterBranch(ops.ads, branch).filter((a) => adOverlaps(a, range));
  const adSpend = sumAmount(ads);
  const chats = ads.reduce((s, a) => s + Number(a.chats || 0), 0);
  const bookings = filterBranch(ops.bookings, branch).filter((b) => b.status !== 'dismissed' && inRange(bookingDate(b), range));
  const income = filterBranch(ops.otherIncome, branch).filter((row) => inRange(row.date, range));
  const collected = sumAmount(filterBranch(ops.payments, branch).filter((p) => inRange(p.date, range)));
  return {
    ads, adSpend, chats, bookings: bookings.length, bookingRows: bookings,
    otherIncome: sumAmount(income), incomeRows: income, collected,
    costPerChat: chats > 0 ? adSpend / chats : null,
    costPerBooking: bookings.length > 0 ? adSpend / bookings.length : null,
    bookingRate: chats > 0 ? bookings.length / chats : null,
    roas: adSpend > 0 ? collected / adSpend : null,
  };
}

function lowStock(parts, branch) {
  return filterBranch(parts, branch).filter((p) => p.reorder || Number(p.stock) <= 0);
}

function pausedReadOnly(thread, now, cfg) {
  if (!thread || !thread.pausedUntil || now >= thread.pausedUntil) return false;
  const idleHours = cfg.humanIdleResumeHours;
  if (idleHours > 0) {
    const last = thread.lastHumanEchoAt || (thread.pausedUntil - cfg.humanPauseHours * 3600e3);
    if (now - last > idleHours * 3600e3) return false;
  }
  return true;
}

function needsTextUpdates(ops, threads, now, cfg, branch) {
  const windowMs = (cfg.replyWindowHours || 23.5) * 3600e3;
  const rows = [];
  for (const job of filterBranch(ops.jobs, branch)) {
    if (job.status !== 'Under Repair' || !job.psid) continue;
    const thread = (threads || {})[job.psid];
    if (thread && (thread.handedOff || pausedReadOnly(thread, now, cfg))) continue;
    const last = thread && thread.lastUserTs ? thread.lastUserTs : 0;
    if (last && now - last <= windowMs) continue;
    rows.push({
      jobId: job.id,
      customerName: job.customerName,
      phone: job.phone || '',
    });
  }
  return rows;
}

function buildView(store, opts) {
  const ops = ensureOps(store);
  const tz = opts.tz || 'Asia/Manila';
  const now = opts.now || Date.now();
  const branch = parseBranch(opts.branch);
  const tab = TABS.includes(opts.tab) ? opts.tab : 'today';
  const period = ['month', 'last', 'all'].includes(opts.period) ? opts.period : 'month';
  const today = manilaStamp(now, tz).date;
  const tomorrow = addDays(today, 1);
  const jobs = filterBranch(ops.jobs, branch);
  const month = moneyReport(ops, { period: 'month', branch, now, tz });
  const payments = filterBranch(ops.payments, branch);
  const visitsToday = jobs.filter((j) => j.visitDate === today && j.status !== 'Cancelled');
  const visitsTomorrow = jobs.filter((j) => j.visitDate === tomorrow && j.status !== 'Cancelled');
  const chart = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(today, -i);
    chart.push({ date, amount: sumAmount(payments.filter((p) => p.date === date)) });
  }
  const statusFilter = STATUSES.includes(opts.status) ? opts.status : '';
  const visibleJobs = (statusFilter ? jobs.filter((j) => j.status === statusFilter) : jobs)
    .slice()
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  const editing = opts.edit ? ops.jobs.find((j) => j.id === opts.edit) || null : null;
  return {
    tab, branch, branchLabel: branchLabel(branch), period, today, tomorrow, statusFilter, editing,
    dailyOn: Boolean(opts.dailyOn),
    kpis: {
      open: jobs.filter(openJob).length,
      underRepair: jobs.filter((j) => j.status === 'Under Repair').length,
      visitsToday: visitsToday.length,
      collectedToday: sumAmount(payments.filter((p) => p.date === today)),
      collectedMonth: month.collected,
      profitMonth: month.profit,
      lowStock: lowStock(ops.parts, branch).length,
    },
    bookings: filterBranch(ops.bookings, branch).filter((b) => b.status === 'new'),
    visitsToday, visitsTomorrow, chart,
    attention: {
      past: jobs.filter((j) => j.visitDate && j.visitDate < today && (j.status === 'Inquiry' || j.status === 'Scheduled')),
      balance: jobs.filter((j) => j.status === 'Completed' && jobBalance(j, ops.payments) > 0)
        .map((j) => ({ ...j, balance: jobBalance(j, ops.payments) })),
      dupes: duplicatePayments(ops.payments, branch),
    },
    needsText: needsTextUpdates(ops, opts.threads || {}, now, opts.cfg || { replyWindowHours: 23.5, humanPauseHours: 12, humanIdleResumeHours: 2 }, branch),
    techLoad: TECHS.map((tech) => ({
      tech,
      open: jobs.filter((j) => (j.technician || 'Unassigned') === tech && openJob(j)).length,
      visits: visitsToday.filter((j) => (j.technician || 'Unassigned') === tech).length,
    })),
    reorder: lowStock(ops.parts, branch),
    jobs: visibleJobs.map((j) => ({ ...j, balance: jobBalance(j, ops.payments), warrantyEnd: warrantyEndOf(j) })),
    customers: customerRows(ops, branch),
    money: moneyReport(ops, { period, branch, now, tz }),
    finance: financeReport(ops, { period, branch, now, tz }),
    parts: filterBranch(ops.parts, branch),
    reviews: opts.reviews || [],
  };
}

function field(params, key) {
  return String(params.get(key) || '').trim();
}

function applyAction(store, params, now, tz = 'Asia/Manila') {
  const ops = ensureOps(store);
  const action = field(params, 'action');
  const today = manilaStamp(now, tz).date;
  const touch = (job) => { job.updatedAt = new Date(now).toISOString(); };

  if (action === 'create-job' || action === 'update-job') {
    const date = field(params, 'date') || today;
    const id = action === 'update-job' ? field(params, 'id') : nextJobId(ops.jobs, date);
    if (!id) return { ok: false, error: 'Job id required' };
    const prev = ops.jobs.find((j) => j.id === id);
    const job = withWarranty(blankJob({
      ...(prev || {}),
      id,
      date,
      doneDate: field(params, 'doneDate') || (prev && prev.doneDate) || '',
      visitDate: field(params, 'visitDate') || date,
      visitTime: field(params, 'visitTime'),
      customerName: field(params, 'customerName'),
      phone: field(params, 'phone'),
      city: field(params, 'city'),
      address: field(params, 'address'),
      landmark: field(params, 'landmark'),
      mapLink: field(params, 'mapLink'),
      unitType: field(params, 'unitType') || 'TV',
      brand: field(params, 'brand'),
      size: field(params, 'size'),
      issue: field(params, 'issue'),
      technician: TECHS.includes(field(params, 'technician')) ? field(params, 'technician') : 'Unassigned',
      branch: canonBranch(field(params, 'branch')),
      adArea: field(params, 'adArea'),
      price: money(field(params, 'price')),
      travelFee: money(field(params, 'travelFee')),
      status: STATUSES.includes(field(params, 'status')) ? field(params, 'status') : 'Inquiry',
      statusNote: field(params, 'statusNote'),
      notes: field(params, 'notes'),
      partsUsed: field(params, 'partsUsed'),
      partsCost: money(field(params, 'partsCost')),
      psid: prev ? prev.psid || '' : '',
      importedPaid: prev ? prev.importedPaid || 0 : 0,
      lastDailyStatusDate: prev ? prev.lastDailyStatusDate || '' : '',
      createdAt: prev ? prev.createdAt : new Date(now).toISOString(),
    }));
    touch(job);
    if (prev) Object.assign(prev, job);
    else ops.jobs.push(job);
    if (field(params, 'link') === '1') {
      const reviewId = field(params, 'review');
      const saved = ops.jobs.find((j) => j.id === id);
      if (!reviewId) {
        if (saved && saved.psid && store.data.threads && store.data.threads[saved.psid] && store.data.threads[saved.psid].jobId === id) {
          store.data.threads[saved.psid].jobId = '';
        }
        if (saved) saved.psid = '';
        store.save();
      } else {
        const linked = linkReviewToJob(store, reviewId, id);
        if (!linked.ok) return linked;
      }
    }
    store.save();
    return { ok: true, id };
  }

  if (action === 'status' || action === 'done') {
    const job = ops.jobs.find((j) => j.id === field(params, 'id'));
    if (!job) return { ok: false, error: 'Hindi makita ang job.' };
    if (action === 'done') {
      job.status = 'Completed';
      if (!job.doneDate) job.doneDate = today;
    } else if (STATUSES.includes(field(params, 'status'))) job.status = field(params, 'status');
    touch(job);
    store.save();
    return { ok: true, id: job.id };
  }

  if (action === 'delete-job') {
    const id = field(params, 'id');
    const job = ops.jobs.find((j) => j.id === id);
    if (job && job.psid && store.data.threads && store.data.threads[job.psid] && store.data.threads[job.psid].jobId === id) {
      store.data.threads[job.psid].jobId = '';
    }
    ops.jobs = ops.jobs.filter((j) => j.id !== id);
    store.save();
    return { ok: true };
  }

  if (action === 'dismiss-booking' || action === 'convert-booking') {
    const booking = ops.bookings.find((b) => b.id === field(params, 'id'));
    if (!booking) return { ok: false, error: 'Hindi makita ang booking.' };
    if (action === 'dismiss-booking') booking.status = 'dismissed';
    else {
      const date = booking.visitDate || today;
      const job = withWarranty(blankJob({
        id: nextJobId(ops.jobs, date),
        date: today,
        visitDate: booking.visitDate || today,
        visitTime: booking.visitTime || '',
        customerName: booking.name,
        phone: booking.phone,
        city: booking.city,
        address: booking.address,
        landmark: booking.landmark,
        unitType: booking.unitType || 'TV',
        brand: booking.brand,
        size: booking.size,
        issue: booking.issue,
        branch: booking.branch,
        price: booking.price,
        status: booking.visitDate ? 'Scheduled' : 'Inquiry',
        createdAt: new Date(now).toISOString(),
      }));
      touch(job);
      ops.jobs.push(job);
      booking.status = 'converted';
      booking.jobId = job.id;
    }
    store.save();
    return { ok: true, id: booking.jobId || booking.id };
  }

  if (action === 'add-payment') {
    ops.payments.push({
      date: field(params, 'date') || today,
      jobId: field(params, 'jobId'),
      customerName: field(params, 'customerName'),
      branch: canonBranch(field(params, 'branch')),
      type: PAY_TYPES.includes(field(params, 'type')) ? field(params, 'type') : 'Other',
      method: METHODS.includes(field(params, 'method')) ? field(params, 'method') : 'Cash',
      amount: money(field(params, 'amount')),
      note: field(params, 'note'),
    });
    store.save();
    return { ok: true };
  }

  if (action === 'add-expense') {
    ops.expenses.push({
      date: field(params, 'date') || today,
      branch: canonBranch(field(params, 'branch')),
      amount: money(field(params, 'amount')),
      note: field(params, 'note'),
    });
    store.save();
    return { ok: true };
  }

  if (action === 'add-ad') {
    ops.ads.push({
      start: field(params, 'start') || today,
      end: field(params, 'end') || today,
      branch: canonBranch(field(params, 'branch')),
      amount: money(field(params, 'amount')),
      chats: money(field(params, 'chats')),
      note: field(params, 'note'),
    });
    store.save();
    return { ok: true };
  }

  if (action === 'add-income') {
    ops.otherIncome.push({
      date: field(params, 'date') || today,
      branch: canonBranch(field(params, 'branch')),
      amount: money(field(params, 'amount')),
      note: field(params, 'note'),
    });
    store.save();
    return { ok: true };
  }

  if (action === 'add-part' || action === 'update-part') {
    const id = action === 'update-part' ? field(params, 'id') : nextSeq(ops.parts, 'P');
    const prev = ops.parts.find((p) => p.id === id);
    const part = {
      id,
      name: field(params, 'name'),
      branch: canonBranch(field(params, 'branch')),
      cost: money(field(params, 'cost')),
      stock: money(field(params, 'stock')),
      reorder: field(params, 'reorder') === 'on' || field(params, 'reorder') === '1' || Number(field(params, 'stock')) <= 0,
    };
    if (!part.name) return { ok: false, error: 'Part name required' };
    if (prev) Object.assign(prev, part);
    else ops.parts.push(part);
    store.save();
    return { ok: true, id };
  }

  if (action === 'link-chat') {
    const job = ops.jobs.find((j) => j.id === field(params, 'id'));
    if (!job) return { ok: false, error: 'Hindi makita ang job.' };
    const reviewId = field(params, 'review');
    if (!reviewId) {
      if (job.psid && store.data.threads && store.data.threads[job.psid] && store.data.threads[job.psid].jobId === job.id) {
        store.data.threads[job.psid].jobId = '';
      }
      job.psid = '';
      touch(job);
      store.save();
      return { ok: true };
    }
    return linkReviewToJob(store, reviewId, job.id);
  }

  return { ok: false, error: 'Unknown action' };
}

function linkReviewToJob(store, reviewId, jobId) {
  const ops = ensureOps(store);
  const review = (store.data.reviews || []).find((r) => r.id === reviewId);
  if (!review || !review.psid) return { ok: false, error: 'Hindi makita ang chat.' };
  const job = ops.jobs.find((j) => j.id === jobId);
  if (!job) return { ok: false, error: 'Hindi makita ang job.' };
  for (const other of ops.jobs) {
    if (other !== job && other.psid === review.psid) other.psid = '';
  }
  if (job.psid && job.psid !== review.psid && store.data.threads && store.data.threads[job.psid]) {
    const prev = store.data.threads[job.psid];
    if (prev.jobId === job.id) prev.jobId = '';
  }
  job.psid = review.psid;
  job.updatedAt = new Date().toISOString();
  const thread = store.thread(review.psid);
  thread.jobId = job.id;
  thread.jobSuggestion = null;
  thread.opsAwait = '';
  store.save();
  return { ok: true, jobId: job.id };
}

function noteSuggestion(store, psid) {
  const ops = ensureOps(store);
  const thread = store.data.threads && store.data.threads[psid];
  if (!thread) return null;
  if (jobByPsid(ops, psid)) {
    if (thread.jobSuggestion) {
      thread.jobSuggestion = null;
      store.save();
    }
    return null;
  }
  const suggestion = suggestionFor(ops, thread.history);
  const prev = thread.jobSuggestion && thread.jobSuggestion.jobId;
  thread.jobSuggestion = suggestion;
  if ((suggestion && suggestion.jobId) !== prev) store.save();
  return suggestion;
}

function linkCustomer(store, psid, customer) {
  const ops = ensureOps(store);
  const job = pickJob(jobsForCustomer(ops, customer));
  if (!job) return null;
  for (const other of ops.jobs) {
    if (other !== job && other.psid === psid) other.psid = '';
  }
  job.psid = psid;
  const thread = store.thread(psid);
  thread.jobId = job.id;
  thread.jobSuggestion = null;
  thread.opsAwait = '';
  store.save();
  return job;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

function exportCsv(store, kind, opts) {
  const view = buildView(store, opts);
  if (kind === 'jobs') {
    return toCsv(
      ['Job ID', 'Date received', 'Visit date', 'Visit time', 'Customer name', 'Contact', 'Area/City', 'Address', 'Landmark', 'Brand/Model', 'Size', 'Issue', 'Quote', 'Balance', 'Status', 'Technician', 'Branch', 'Warranty end', 'Status note'],
      view.jobs.map((j) => ({
        'Job ID': j.id, 'Date received': j.date, 'Visit date': j.visitDate, 'Visit time': j.visitTime,
        'Customer name': j.customerName, Contact: j.phone, 'Area/City': j.city, Address: j.address,
        Landmark: j.landmark, 'Brand/Model': j.brand, Size: j.size, Issue: j.issue, Quote: j.price,
        Balance: j.balance, Status: j.status, Technician: j.technician, Branch: j.branch,
        'Warranty end': j.warrantyEnd, 'Status note': j.statusNote,
      })),
    );
  }
  if (kind === 'money') {
    const summary = [
      { Section: 'summary', Label: 'Collected', Amount: view.money.collected },
      { Section: 'summary', Label: 'Costs', Amount: view.money.costs },
      { Section: 'summary', Label: 'Profit', Amount: view.money.profit },
      { Section: 'summary', Label: 'Cavite investor 50%', Amount: view.money.investor },
      { Section: 'summary', Label: 'You keep', Amount: view.money.youKeep },
    ];
    const pays = view.money.payments.map((p) => ({
      Section: 'payment', Date: p.date, Customer: p.customerName, Type: p.type, Method: p.method, Branch: p.branch, Amount: p.amount, Note: p.note,
    }));
    return toCsv(['Section', 'Label', 'Date', 'Customer', 'Type', 'Method', 'Branch', 'Amount', 'Note'], [...summary, ...pays]);
  }
  const fin = view.finance;
  const summary = [
    { Section: 'summary', Label: 'Ad spend', Value: fin.adSpend },
    { Section: 'summary', Label: 'Chats', Value: fin.chats },
    { Section: 'summary', Label: 'Bookings', Value: fin.bookings },
    { Section: 'summary', Label: 'Cost per booking', Value: fin.costPerBooking ?? '' },
    { Section: 'summary', Label: 'Booking rate', Value: fin.bookingRate ?? '' },
    { Section: 'summary', Label: 'ROAS', Value: fin.roas ?? '' },
    { Section: 'summary', Label: 'Other income', Value: fin.otherIncome },
  ];
  const ads = fin.ads.map((a) => ({
    Section: 'ad', Label: a.note, Start: a.start, End: a.end, Branch: a.branch, Amount: a.amount, Chats: a.chats,
  }));
  return toCsv(['Section', 'Label', 'Start', 'End', 'Branch', 'Amount', 'Chats', 'Value'], [...summary, ...ads]);
}

module.exports = {
  STATUSES, TECHS, BRANCHES, PAY_TYPES, METHODS, TABS,
  ASK_BOTH, ASK_NAME, ASK_PHONE, UNSURE,
  emptyOps, ensureOps, manilaStamp, addMonths, addDays, parseBranch, branchLabel,
  parseCsv, parseJobsCsv, parsePaymentsCsv, parseAdsCsv,
  nextJobId, jobBalance, jobPaid, phoneKey, namesMatch, extractPhone,
  importOps, buildView, applyAction, linkReviewToJob, noteSuggestion, linkCustomer,
  moneyReport, financeReport, duplicatePayments, customerRows,
  asksJobStatus, asksWarrantyProblem, jobStatusText, dailyStatusText, warrantyText,
  inWarranty, warrantyEndOf, suggestionFor, jobByPsid, matchIdentity, nameGuess,
  directory, exportCsv, longDate, friendlyStatus,
};
