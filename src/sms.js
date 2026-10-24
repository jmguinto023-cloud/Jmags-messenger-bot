'use strict';
// Staff-triggered schedule texts via Semaphore. Nothing here sends on its own.
const crypto = require('node:crypto');
const { ensureOps, phoneKey, manilaStamp, addDays } = require('./ops');

const DEFAULT_CONFIRM_TEMPLATE = 'Good day po, this is JMAGS Appliances. Iconfirm ko lang po na nakaschedule po kayo bukas para sa home service ng TV. Reply CONFIRM para ma-fix ang line up para bukas. Salamat po.';
const SEMAPHORE_URL = 'https://api.semaphore.co/api/v4/messages';
const LOG_LIMIT = 200;
const inflight = new WeakSet();

function smsReady(cfg) {
  return Boolean(cfg && cfg.smsEnabled && String(cfg.semaphoreApiKey || '').trim());
}

function confirmTemplate(cfg) {
  const custom = cfg && cfg.smsConfirmTemplate ? String(cfg.smsConfirmTemplate).trim() : '';
  return custom || DEFAULT_CONFIRM_TEMPLATE;
}

// 09xx, 639xx, and +639xx all become 639xxxxxxxxx. Anything else is unusable.
function normalizePhNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('09')) digits = `63${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('9')) digits = `63${digits}`;
  if (digits.length !== 12 || !digits.startsWith('639')) return '';
  return digits;
}

function last4(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-4);
}

function isConfirmReply(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/\bconfirm(?:ed|ation)?\b/i.test(value)) return true;
  if (/\boo\b/i.test(value)) return true;
  if (/\byes\b/i.test(value)) return true;
  return false;
}

function smsBadge(job, today) {
  if (!job || !job.visitDate || job.smsForDate !== job.visitDate) return '';
  if (job.smsStatus === 'confirmed') return 'Confirmed';
  if (job.smsStatus !== 'sent') return '';
  if (today && job.visitDate < today) return 'No reply';
  // The text says "bukas". On the visit day, a text sent on an earlier day is still unanswered.
  if (today && job.visitDate === today && job.smsSentAt) {
    const sentOn = manilaStamp(Date.parse(job.smsSentAt)).date;
    if (sentOn && sentOn < today) return 'No reply';
  }
  return 'Text sent';
}

function alreadySent(job) {
  return Boolean(job && job.visitDate && job.smsForDate === job.visitDate && (job.smsStatus === 'sent' || job.smsStatus === 'confirmed'));
}

function appendLog(ops, row) {
  if (!Array.isArray(ops.smsLog)) ops.smsLog = [];
  ops.smsLog.push(row);
  if (ops.smsLog.length > LOG_LIMIT) ops.smsLog.splice(0, ops.smsLog.length - LOG_LIMIT);
}

function logRow(job, extra) {
  return {
    at: extra.at,
    kind: extra.kind,
    jobId: job ? job.id : '',
    name: job && job.customerName ? job.customerName : 'Job',
    last4: job ? last4(job.phone) : last4(extra.phone),
    visitDate: job && job.visitDate ? job.visitDate : '',
    messageId: extra.messageId || '',
    detail: extra.detail || '',
  };
}

function tokenOk(cfg, got) {
  const expected = String(cfg && cfg.smsInboundToken || '');
  if (!expected) return true;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(got || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function pickField(obj, names) {
  if (!obj || typeof obj !== 'object') return '';
  for (const name of names) {
    if (obj[name] != null && String(obj[name]).trim()) return String(obj[name]).trim();
  }
  return '';
}

function oneInbound(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const nested = obj.data || obj.payload || (Array.isArray(obj.results) ? obj.results[0] : null);
  const src = nested && typeof nested === 'object' ? { ...obj, ...nested } : obj;
  const from = pickField(src, ['sender', 'from', 'msisdn', 'mobile', 'phone', 'number']);
  const text = pickField(src, ['message', 'text', 'body', 'content']);
  const messageId = pickField(src, ['message_id', 'messageId', 'id']);
  const token = pickField(src, ['token']);
  if (!from && !text) return null;
  return { from, text, messageId, token };
}

function parseInbound(raw, contentType) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const type = String(contentType || '');
  if (type.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) return oneInbound(json[0]);
      return oneInbound(json);
    } catch { return null; }
  }
  const params = new URLSearchParams(text);
  return oneInbound(Object.fromEntries(params.entries()));
}

async function postSemaphore({ cfg, number, message, fetchImpl }) {
  const body = new URLSearchParams({
    apikey: cfg.semaphoreApiKey,
    number,
    message,
  });
  // An empty sender name means DEFAULT/none: leave the field off so Semaphore picks its sender.
  if (cfg.smsSenderName) body.set('sendername', cfg.smsSenderName);
  const res = await fetchImpl(SEMAPHORE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { json = null; }
  const row = Array.isArray(json) ? json[0] : json;
  const messageId = row && row.message_id != null ? String(row.message_id) : '';
  const status = row && row.status ? String(row.status) : '';
  if (!res.ok || !messageId || /^failed$/i.test(status) || /^refunded$/i.test(status)) {
    const err = new Error(`Semaphore HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { messageId, status: status || 'Pending' };
}

// One confirmation per job per visit date. A second tap sends nothing.
async function sendJobConfirmation({ store, cfg, jobId, now, log, fetchImpl }) {
  const ops = ensureOps(store);
  const job = ops.jobs.find((item) => item.id === String(jobId || '').trim());
  const at = new Date(now).toISOString();
  if (!job) return { ok: false, notice: 'sms-failed' };
  if (!smsReady(cfg)) return { ok: true, notice: 'sms-off' };
  if (!String(job.phone || '').trim()) return { ok: true, notice: 'sms-nophone' };
  if (!job.visitDate) return { ok: true, notice: 'sms-failed' };
  if (alreadySent(job) || inflight.has(job)) return { ok: true, notice: 'sms-already' };
  const number = normalizePhNumber(job.phone);
  if (!number) return { ok: true, notice: 'sms-bad-number' };
  const message = confirmTemplate(cfg);
  if (/^test\b/i.test(message)) return { ok: true, notice: 'sms-failed' };
  inflight.add(job);
  try {
    const sent = await postSemaphore({ cfg, number, message, fetchImpl: fetchImpl || globalThis.fetch });
    job.smsForDate = job.visitDate;
    job.smsSentAt = at;
    job.smsMessageId = sent.messageId;
    job.smsStatus = 'sent';
    job.smsConfirmedAt = '';
    job.updatedAt = at;
    appendLog(ops, logRow(job, { at, kind: 'sent', messageId: sent.messageId, detail: sent.status }));
    store.save();
    if (log) log.info(`SMS confirmation sent for ${job.id} …${last4(job.phone)} (${sent.messageId})`);
    return { ok: true, notice: 'sms-sent' };
  } catch (e) {
    appendLog(ops, logRow(job, { at, kind: 'failed', detail: 'provider' }));
    store.save();
    if (log) log.error(`SMS confirmation failed for ${job.id} …${last4(job.phone)}: ${e.message}`);
    return { ok: true, notice: 'sms-failed' };
  } finally {
    inflight.delete(job);
  }
}

function markJobConfirmed({ store, jobId, now, log, source }) {
  const ops = ensureOps(store);
  const job = ops.jobs.find((item) => item.id === String(jobId || '').trim());
  if (!job) return { ok: false, notice: 'sms-failed' };
  const at = new Date(now).toISOString();
  job.smsForDate = job.visitDate || job.smsForDate || '';
  job.smsStatus = 'confirmed';
  job.smsConfirmedAt = at;
  job.updatedAt = at;
  appendLog(ops, logRow(job, { at, kind: 'confirmed', detail: source || 'staff' }));
  store.save();
  if (log) log.info(`SMS marked confirmed for ${job.id} …${last4(job.phone)} (${source || 'staff'})`);
  return { ok: true, notice: 'sms-confirmed' };
}

function upcomingMatch(ops, from, today) {
  const key = phoneKey(from);
  if (!key) return null;
  const floor = addDays(today, -1);
  const jobs = ops.jobs.filter((job) => {
    if (phoneKey(job.phone) !== key) return false;
    if (!job.visitDate || job.visitDate < floor) return false;
    if (job.status === 'Cancelled' || job.status === 'Completed') return false;
    return true;
  });
  jobs.sort((a, b) => {
    const aSent = a.smsStatus === 'sent' && a.smsForDate === a.visitDate ? 0 : 1;
    const bSent = b.smsStatus === 'sent' && b.smsForDate === b.visitDate ? 0 : 1;
    if (aSent !== bSent) return aSent - bSent;
    return String(a.visitDate).localeCompare(String(b.visitDate));
  });
  return jobs[0] || null;
}

function applyInboundSms({ store, from, text, messageId, now, tz, log }) {
  const ops = ensureOps(store);
  const today = manilaStamp(now, tz || 'Asia/Manila').date;
  const at = new Date(now).toISOString();
  const job = upcomingMatch(ops, from, today);
  const confirmed = isConfirmReply(text);
  if (job && confirmed) {
    job.smsForDate = job.visitDate || job.smsForDate || '';
    job.smsStatus = 'confirmed';
    job.smsConfirmedAt = at;
    job.updatedAt = at;
    appendLog(ops, logRow(job, { at, kind: 'confirmed', messageId, detail: 'reply' }));
    store.save();
    if (log) log.info(`SMS reply confirmed ${job.id} …${last4(from)}`);
    return { ok: true, confirmed: true };
  }
  appendLog(ops, logRow(job, {
    at,
    kind: 'inbound',
    phone: from,
    messageId,
    detail: confirmed ? 'no matching job' : 'not a confirmation',
  }));
  store.save();
  if (log) log.info(`SMS reply ignored …${last4(from)} (${confirmed ? 'no matching job' : 'not a confirmation'})`);
  return { ok: true, confirmed: false };
}

module.exports = {
  DEFAULT_CONFIRM_TEMPLATE,
  smsReady,
  confirmTemplate,
  normalizePhNumber,
  isConfirmReply,
  smsBadge,
  alreadySent,
  parseInbound,
  tokenOk,
  sendJobConfirmation,
  markJobConfirmed,
  applyInboundSms,
};
