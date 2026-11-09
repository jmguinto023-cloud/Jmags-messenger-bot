'use strict';
// Full-thread and past-job context so a reply continues what was already agreed.
const { phoneKey, namesMatch, ensureOps } = require('./ops');
const { formLink } = require('./booking');

const WELCOME = 'Welcome back po.';
const FORM_INTRO = 'Paki-fill up lang po ng booking form para ma-schedule namin kayo:';
const FORM_OK = 'Natanggap na po namin ang booking form ninyo ✅ I-che-check lang po ng staff ang schedule.';
const FORM_MISSING = 'Hindi pa po dumadating ang form ninyo. Paki-check lang po o paki-send ulit.';

function digits(phone) {
  return phoneKey(phone);
}

function jobMatches(job, { psid, name, phone }) {
  if (!job) return false;
  if (psid && job.psid && String(job.psid) === String(psid)) return true;
  const want = digits(phone);
  const have = digits(job.phone);
  if (want && have && want === have) return true;
  const who = job.customerName || job.name || '';
  if (name && who && namesMatch(who, name)) return true;
  return false;
}

function localJobs(store, query) {
  const ops = ensureOps(store);
  const rows = [...(ops.jobs || []), ...(ops.bookings || [])];
  return rows.filter((row) => jobMatches(row, query));
}

async function remoteJobs(query, { url, key, fetchImpl = fetch } = {}) {
  if (!url || !/supabase\.co/i.test(url) || !key) return [];
  const filters = [];
  if (query.psid) filters.push(`psid.eq.${encodeURIComponent(query.psid)}`);
  const phone = digits(query.phone);
  if (phone) filters.push(`phone.eq.${encodeURIComponent(phone)}`);
  if (!filters.length) return [];
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/jobs?select=id,psid,customer_name,phone,status,price,issue,warranty_end&or=(${filters.join(',')})`;
  try {
    const res = await fetchImpl(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      id: row.id,
      psid: row.psid,
      customerName: row.customer_name || row.customerName || '',
      phone: row.phone || '',
      status: row.status || '',
      price: row.price || '',
      issue: row.issue || '',
      warrantyEnd: row.warranty_end || '',
    }));
  } catch {
    return [];
  }
}

function phoneInThread(thread) {
  const blob = (thread.history || []).map((h) => h.content || '').join('\n');
  const m = blob.match(/\b(09\d{9}|\+63\d{10})\b/);
  return m ? m[1] : '';
}

function nameInThread(thread) {
  const s = (thread && thread.slots) || {};
  return s.customerName || '';
}

async function customerBrief(store, thread, psid, remote) {
  const phone = phoneInThread(thread);
  const name = nameInThread(thread);
  const query = { psid, name, phone };
  const jobs = localJobs(store, query);
  const extra = await remoteJobs(query, remote);
  const seen = new Set(jobs.map((j) => j.id));
  for (const row of extra) if (row.id && !seen.has(row.id)) jobs.push(row);
  const staff = (thread.history || []).filter((h) => h && h.role === 'assistant' && h.via === 'ivan').slice(-6);
  const lines = [];
  if (jobs.length) {
    lines.push('Returning customer. If you have not said it yet in this chat, start with "Welcome back po".');
    for (const job of jobs.slice(0, 4)) {
      lines.push(`Past job ${job.id || ''}: ${job.customerName || job.name || ''} ${job.brand || ''} ${job.size || ''} ${job.issue || job.problem || ''} status ${job.status || ''} price ${job.price || ''} warranty ${job.warrantyEnd || ''}. Do not contradict this.`.replace(/\s+/g, ' ').trim());
    }
  } else {
    lines.push('No past job on file. This is not a confirmed returning customer.');
  }
  if (staff.length) {
    lines.push('Human staff already wrote these. Match that voice and do not contradict them:');
    for (const row of staff) lines.push(`- ${String(row.content || '').slice(0, 180)}`);
  }
  lines.push('Use the full thread. Do not restart intake or re-ask a fact that already appears above or earlier in the chat.');
  return {
    returning: jobs.length > 0,
    jobs,
    text: lines.join('\n').slice(0, 1200),
  };
}

function alreadyWelcomed(thread) {
  return (thread.history || []).some((h) => h && h.role === 'assistant' && /welcome back po/i.test(h.content || ''));
}

function withWelcome(thread, text) {
  const body = String(text || '').trim();
  if (!thread || !thread.returning || !body || alreadyWelcomed(thread)) return body;
  if (/welcome back po/i.test(body)) return body;
  return `${WELCOME} ${body}`;
}

function wantsBooking(text) {
  return /\b(?:pa-?book|i-?book|book(?:ing)?|pa-?sched|check-?up|pa-?repair|gusto ko|sige po|opo|oo po)\b/i.test(String(text || ''));
}

function saysFormDone(text) {
  const t = String(text || '');
  // "na-send ko na ang video" is the TV clip, not the booking form.
  if (/\b(?:video|photo|larawan|picture|sticker)\b/i.test(t) && !/\bform\b/i.test(t)) return false;
  return /\b(?:done|nag-?fill(?:\s*up)?|na-?fill(?:\s*up)?|nasubmit|na-?submit)\b/i.test(t)
    || (/\bform\b/i.test(t) && /\b(?:na-?send|sent|tapos|submit)\b/i.test(t));
}

function formUrlFor(base, thread, psid) {
  const s = (thread && thread.slots) || {};
  const link = formLink(base || '', {
    name: s.customerName || '',
    mobile: phoneInThread(thread),
    city: s.city || '',
    brand: s.brand || '',
    size: s.size || '',
    problem: s.symptom || '',
  });
  if (!psid || !link) return link;
  const url = new URL(link);
  url.searchParams.set('psid', psid);
  url.searchParams.set('ref', psid);
  return url.toString();
}

function formMessage(link) {
  return `${FORM_INTRO} ${link}`;
}

function submissionMatches(row, { psid, phone, name }) {
  const data = (row && (row.data || row)) || {};
  const blob = JSON.stringify(data).toLowerCase();
  if (psid && blob.includes(String(psid).toLowerCase())) return true;
  const want = digits(phone);
  const have = digits(data.phone || data.mobile || row.phone || '');
  if (want && have && want === have) return true;
  const who = data.name || data.customer_name || row.name || row.customerName || '';
  if (name && who && namesMatch(who, name)) return true;
  return false;
}

async function netlifySubmissions({ token, formId, fetchImpl = fetch } = {}) {
  if (!token || !formId) return [];
  try {
    const res = await fetchImpl(`https://api.netlify.com/api/v1/forms/${encodeURIComponent(formId)}/submissions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

module.exports = {
  WELCOME,
  FORM_INTRO,
  FORM_OK,
  FORM_MISSING,
  jobMatches,
  localJobs,
  customerBrief,
  withWelcome,
  wantsBooking,
  saysFormDone,
  formUrlFor,
  formMessage,
  submissionMatches,
  netlifySubmissions,
  phoneInThread,
};
