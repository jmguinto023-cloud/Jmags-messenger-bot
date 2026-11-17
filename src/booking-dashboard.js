'use strict';
// Copy customer-form bookings into the operations dashboard collection
// app_docs.formBookings. The dashboard only showed a booking after an open
// owner session copied a verified Netlify submission. This runs on the server:
// intake rows in public.bookings, verified Netlify submissions, and spam
// submissions all become one dashboard row. It never sends SMS or Messenger.

const { phoneKey, namesMatch } = require('./ops');
const { switchHeaders } = require('./page-switches');

const FORM_ID_FALLBACK = '6acb80c2cfef520008a600f5';
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
const TEST_NAME = 'test dashboard sync';
const WINDOW_DAYS = 30;
const TEST_DELETE_AFTER_MS = 90 * 1000;
const JOB_COVER_MS = 36 * 60 * 60 * 1000;

function configured(cfg) {
  const url = String((cfg && cfg.supabaseUrl) || '');
  const key = String((cfg && cfg.supabaseServiceRoleKey) || '');
  return Boolean(cfg && cfg.bookingDashboardSync !== false && /supabase\.co/i.test(url) && key);
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function timeOf(value) {
  if (typeof value === 'number' && value > 1e11) return value;
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function fieldBag(row) {
  if (!row || typeof row !== 'object') return {};
  const nested = [row.payload, row.fields, row.body, row.record]
    .find((v) => v && typeof v === 'object' && !Array.isArray(v)) || {};
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const inner = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data : {};
  const top = {};
  for (const key of ['name', 'mobile', 'phone', 'address', 'subdivision', 'city', 'province', 'landmark', 'pin', 'appliance', 'brand', 'size', 'problem', 'pdate', 'service', 'price', 'details', 'prior', 'priortech', 'willingToWait', 'created_at']) {
    if (row[key] != null && row[key] !== '' && typeof row[key] !== 'object') top[key] = row[key];
  }
  return { ...nested, ...data, ...inner, ...top };
}

function preferredDate(fields) {
  const d = String(fields.pdate || fields.date || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

function createdIso(row, fields) {
  const raw = (row && (row.created_at || row.createdAt || row.inserted_at))
    || fields.created_at
    || fields.createdAt
    || '';
  const t = timeOf(raw);
  return t ? new Date(t).toISOString() : '';
}

function dedupeKey(fields, createdIsoValue) {
  const phone = phoneKey(fields.mobile || fields.phone);
  const name = normName(fields.name || fields.customerName);
  const date = preferredDate(fields) || String(createdIsoValue || fields.created_at || '').slice(0, 10);
  const appliance = normName(fields.appliance);
  const problem = normName(fields.problem).slice(0, 40);
  if (!phone && !name) return '';
  return [phone, name, date, appliance, problem].join('|');
}

function safeId(raw) {
  const id = String(raw || '').trim();
  return ID_RE.test(id) ? id : '';
}

function isTestName(name) {
  return normName(name) === TEST_NAME;
}

function summaryOf(candidate) {
  const fields = candidate.fields || {};
  const phone = phoneKey(fields.mobile || fields.phone);
  return {
    name: String(fields.name || '').slice(0, 80),
    date: preferredDate(fields) || String(candidate.createdAt || '').slice(0, 10),
    city: String(fields.city || '').slice(0, 40),
    source: candidate.source || '',
    spam: Boolean(candidate.spam),
    phoneLast4: phone ? phone.slice(-4) : '',
    id: candidate.id || '',
  };
}

function jobCovers(job, fields, bookingMs) {
  const phone = phoneKey(fields.mobile || fields.phone);
  const jobPhone = phoneKey(job.phone || job.mobile);
  if (!phone || phone !== jobPhone) return false;
  const jobAt = timeOf(job.createdAt) || timeOf(job.updated_at) || timeOf(job.updatedAt);
  if (jobAt && bookingMs && Math.abs(jobAt - bookingMs) <= JOB_COVER_MS) return true;
  const jobDate = String(job.date || '').slice(0, 10);
  const want = preferredDate(fields);
  return Boolean(want && jobDate === want && namesMatch(job.customerName || job.name, fields.name));
}

function asJob(row) {
  const data = row && row.data && typeof row.data === 'object' ? row.data : {};
  return { ...data, id: row.id, updated_at: row.updated_at || data.updatedAt || data.updated_at };
}

function collapse(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const key = candidate.dedupeKey || candidate.id;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...candidate, fields: { ...candidate.fields } });
      continue;
    }
    if (candidate.netlifyId && !prev.netlifyId) {
      prev.intakeId = prev.intakeId || (prev.source === 'intake' ? prev.id : '');
      prev.id = candidate.id;
      prev.netlifyId = candidate.netlifyId;
      prev.source = candidate.spam ? 'netlify-spam' : 'netlify';
    }
    if (candidate.intakeId && !prev.intakeId) prev.intakeId = candidate.intakeId;
    if (candidate.spam) prev.spam = true;
    prev.fields = { ...candidate.fields, ...prev.fields };
  }
  return [...map.values()];
}

// Decide which candidates still need a dashboard row. Same person + day +
// appliance + problem from intake and Netlify collapses to one insert.
function planBookings(candidates, { formDocs = [], jobs = [], markers = [], now = Date.now(), windowMs = WINDOW_DAYS * 86400000 } = {}) {
  const existingIds = new Set();
  const existingKeys = new Set();
  for (const doc of formDocs) {
    if (doc.id) existingIds.add(String(doc.id));
    const data = doc.data && typeof doc.data === 'object' ? doc.data : {};
    const fields = fieldBag(doc);
    const key = data.dedupeKey || dedupeKey(fields, data.created_at);
    if (key) existingKeys.add(key);
    if (data.intakeId) existingIds.add(String(data.intakeId));
    if (data.netlifyId) existingIds.add(String(data.netlifyId));
  }
  const handled = new Set();
  for (const marker of markers) {
    const status = String((marker.data && marker.data.status) || marker.status || '');
    if (marker.id && (status === 'dismissed' || status === 'converted')) handled.add(String(marker.id));
  }
  const inserts = [];
  const skippedJob = [];
  const skippedHave = [];
  const seen = new Set();
  const cutoff = now - windowMs;
  for (const candidate of collapse(candidates)) {
    const at = timeOf(candidate.createdAt) || now;
    if (at < cutoff) continue;
    const fields = candidate.fields || {};
    if (!fields.name && !fields.mobile && !fields.phone) continue;
    const key = candidate.dedupeKey || dedupeKey(fields, candidate.createdAt);
    const known = existingIds.has(candidate.id)
      || (candidate.intakeId && existingIds.has(candidate.intakeId))
      || (candidate.netlifyId && existingIds.has(candidate.netlifyId))
      || (key && (existingKeys.has(key) || seen.has(key)))
      || handled.has(candidate.id);
    if (known) {
      skippedHave.push(summaryOf(candidate));
      if (key) seen.add(key);
      continue;
    }
    if (jobs.some((job) => jobCovers(job, fields, at))) {
      skippedJob.push(summaryOf(candidate));
      if (key) seen.add(key);
      continue;
    }
    if (key) seen.add(key);
    inserts.push(candidate);
  }
  return { inserts, skippedJob, skippedHave };
}

function dashboardData(candidate, now) {
  const fields = candidate.fields || {};
  const data = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || typeof value === 'object') continue;
    if (/^(ip|user_agent|referrer|bot-field|token|psid)$/i.test(key)) continue;
    const text = String(value).slice(0, 2000);
    if (text) data[key] = text;
  }
  return {
    data,
    created_at: candidate.createdAt || new Date(now).toISOString(),
    sharedAt: now,
    source: candidate.source || '',
    spam: Boolean(candidate.spam),
    intakeId: candidate.intakeId || '',
    netlifyId: candidate.netlifyId || '',
    dedupeKey: candidate.dedupeKey || dedupeKey(fields, candidate.createdAt),
  };
}

function fromIntakeRow(row) {
  const fields = fieldBag(row);
  const id = safeId(row.id || row.booking_id || row.bookingId);
  if (!id) return null;
  const createdAt = createdIso(row, fields);
  return {
    id,
    fields,
    createdAt,
    source: 'intake',
    spam: false,
    intakeId: id,
    netlifyId: '',
    dedupeKey: dedupeKey(fields, createdAt),
  };
}

function fromNetlifyRow(row, { spam = false } = {}) {
  const fields = fieldBag(row);
  const id = safeId(row.id || row.submission_id);
  if (!id) return null;
  const createdAt = createdIso(row, fields);
  return {
    id,
    fields,
    createdAt,
    source: spam ? 'netlify-spam' : 'netlify',
    spam: Boolean(spam),
    intakeId: safeId(fields.bookingId || fields.booking_id),
    netlifyId: id,
    dedupeKey: dedupeKey(fields, createdAt),
  };
}

function testsToDelete(formDocs, bookingRows, now, minAgeMs = TEST_DELETE_AFTER_MS) {
  const formIds = [];
  const bookingIds = [];
  for (const doc of formDocs) {
    const fields = fieldBag(doc);
    if (!isTestName(fields.name)) continue;
    const at = timeOf(doc.data && doc.data.sharedAt) || timeOf(doc.data && doc.data.created_at) || timeOf(doc.updated_at);
    if (at && now - at >= minAgeMs) formIds.push(String(doc.id));
  }
  for (const row of bookingRows) {
    const fields = fieldBag(row);
    if (!isTestName(fields.name)) continue;
    const at = timeOf(row.created_at || row.createdAt);
    if (!at || now - at >= minAgeMs) bookingIds.push(String(row.id));
  }
  return { formIds, bookingIds };
}

function scrub(text, key) {
  let out = String(text || '');
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 180);
}

class BookingDashboard {
  constructor(cfg, { log = null, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.cfg = cfg || {};
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.running = null;
    this.netlifyWarned = false;
    this.reportedSkips = new Set();
  }

  enabled() {
    return configured(this.cfg);
  }

  formId() {
    return String(this.cfg.netlifyFormId || '').trim() || FORM_ID_FALLBACK;
  }

  async sync() {
    if (!this.enabled()) return { ok: false, reason: 'off' };
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  headers(extra) {
    return { ...switchHeaders(this.cfg.supabaseServiceRoleKey), ...extra };
  }

  async request(url, options) {
    const res = await this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  }

  root() {
    return String(this.cfg.supabaseUrl || '').replace(/\/+$/, '');
  }

  async getJson(path) {
    const res = await this.request(`${this.root()}${path}`, { method: 'GET', headers: this.headers({ Accept: 'application/json' }) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${scrub(res.text, this.cfg.supabaseServiceRoleKey)}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(res.text || 'null');
    return data;
  }

  async getAll(path) {
    const rows = [];
    for (let from = 0; from < 5000; from += 1000) {
      const joiner = path.includes('?') ? '&' : '?';
      const page = await this.getJson(`${path}${joiner}limit=1000&offset=${from}`);
      if (!Array.isArray(page)) break;
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows;
  }

  async loadBookings(sinceIso) {
    const recent = `/rest/v1/bookings?select=*&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.asc`;
    try {
      return await this.getAll(recent);
    } catch (e) {
      if (this.log) this.log.warn(`booking dashboard intake read failed: ${scrub(e.message, this.cfg.supabaseServiceRoleKey)}`);
      try {
        return await this.getAll('/rest/v1/bookings?select=*');
      } catch (again) {
        if (this.log) this.log.warn(`booking dashboard intake read failed: ${scrub(again.message, this.cfg.supabaseServiceRoleKey)}`);
        return [];
      }
    }
  }

  async loadDocs(collection) {
    return this.getAll(`/rest/v1/app_docs?select=id,data,updated_at&collection=eq.${encodeURIComponent(collection)}`);
  }

  async netlifyRows(state) {
    const token = String(this.cfg.netlifyApiToken || '').trim();
    if (!token) {
      if (!this.netlifyWarned && this.log) {
        this.log.info('booking dashboard netlify fallback off (no API token)');
        this.netlifyWarned = true;
      }
      return [];
    }
    const rows = [];
    let url = `https://api.netlify.com/api/v1/forms/${encodeURIComponent(this.formId())}/submissions?per_page=100${state ? `&state=${state}` : ''}`;
    for (let page = 0; page < 10 && url; page += 1) {
      const res = await this.request(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (!res.ok) {
        if (this.log) this.log.warn(`booking dashboard netlify ${state || 'verified'} HTTP ${res.status}`);
        return rows;
      }
      const data = JSON.parse(res.text || '[]');
      if (Array.isArray(data)) rows.push(...data);
      url = nextLink(res.headers);
    }
    return rows;
  }

  async upsertDoc(candidate) {
    const body = {
      collection: 'formBookings',
      id: candidate.id,
      data: dashboardData(candidate, this.now()),
      updated_at: new Date(this.now()).toISOString(),
    };
    const headers = this.headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    });
    const first = await this.request(`${this.root()}/rest/v1/app_docs?on_conflict=collection,id`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (first.ok) return JSON.parse(first.text || '[]');
    const second = await this.request(`${this.root()}/rest/v1/app_docs?on_conflict=id`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    if (!second.ok) {
      throw new Error(`HTTP ${second.status} ${scrub(second.text, this.cfg.supabaseServiceRoleKey)}`);
    }
    return JSON.parse(second.text || '[]');
  }

  async deleteWhere(table, filters) {
    const query = Object.entries(filters)
      .map(([column, value]) => `${column}=eq.${encodeURIComponent(value)}`)
      .join('&');
    const res = await this.request(
      `${this.root()}/rest/v1/${table}?${query}`,
      { method: 'DELETE', headers: this.headers({ Prefer: 'return=minimal' }) },
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`HTTP ${res.status} ${scrub(res.text, this.cfg.supabaseServiceRoleKey)}`);
    }
  }

  async deleteNetlify(id) {
    const token = String(this.cfg.netlifyApiToken || '').trim();
    if (!token || !id) return;
    const res = await this.request(`https://api.netlify.com/api/v1/submissions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404 && this.log) {
      this.log.warn(`booking dashboard test delete netlify HTTP ${res.status}`);
    }
  }

  async run() {
    const now = this.now();
    const since = new Date(now - WINDOW_DAYS * 86400000).toISOString();
    const [bookingRows, formDocs, jobDocs, markerDocs, verified, spam] = await Promise.all([
      this.loadBookings(since),
      this.loadDocs('formBookings'),
      this.loadDocs('jobs'),
      this.loadDocs('bookings'),
      this.netlifyRows(''),
      this.netlifyRows('spam'),
    ]);
    const candidates = [];
    for (const row of bookingRows) {
      const item = fromIntakeRow(row);
      if (item) candidates.push(item);
    }
    for (const row of verified) {
      const item = fromNetlifyRow(row, { spam: false });
      if (item) candidates.push(item);
    }
    for (const row of spam) {
      const item = fromNetlifyRow(row, { spam: true });
      if (item) candidates.push(item);
    }
    const jobs = jobDocs.map(asJob);
    const decision = planBookings(candidates, { formDocs, jobs, markers: markerDocs, now });
    const inserted = [];
    for (const candidate of decision.inserts) {
      await this.upsertDoc(candidate);
      const line = summaryOf(candidate);
      inserted.push(line);
      if (this.log) {
        this.log.info(`booking dashboard insert ${line.source}${line.spam ? ' spam' : ''} ${line.name} ${line.date} ${line.city} …${line.phoneLast4}`);
      }
    }
    for (const line of decision.skippedJob) {
      const key = `${line.name}|${line.phoneLast4}|${line.date}`;
      if (this.reportedSkips.has(key)) continue;
      this.reportedSkips.add(key);
      if (this.log) this.log.info(`booking dashboard already a job ${line.name} ${line.date} ${line.city} …${line.phoneLast4}`);
    }
    const purge = testsToDelete(formDocs, bookingRows, now);
    for (const id of purge.formIds) {
      await this.deleteWhere('app_docs', { collection: 'formBookings', id });
      await this.deleteNetlify(id);
      if (this.log) this.log.info(`booking dashboard deleted test ${id}`);
    }
    for (const id of purge.bookingIds) {
      await this.deleteWhere('bookings', { id });
    }
    if (this.log) {
      this.log.info(`booking dashboard sync inserted=${inserted.length} already-a-job=${decision.skippedJob.length} already-listed=${decision.skippedHave.length}`);
    }
    return { ok: true, inserted, skippedJob: decision.skippedJob, skippedHave: decision.skippedHave.length };
  }
}

function nextLink(headers) {
  if (!headers || typeof headers.get !== 'function') return '';
  const link = headers.get('link') || headers.get('Link') || '';
  const match = /<([^>]+)>;\s*rel="next"/.exec(link);
  return match ? match[1] : '';
}

module.exports = {
  BookingDashboard,
  configured,
  planBookings,
  collapse,
  dedupeKey,
  jobCovers,
  fromIntakeRow,
  fromNetlifyRow,
  testsToDelete,
  isTestName,
  dashboardData,
  TEST_NAME,
  FORM_ID_FALLBACK,
};
