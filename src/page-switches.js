'use strict';
// Per-Page on/off read from Supabase `bot_switches`. The ops dashboard updates
// the rows. This process only reads them. A failed read is off.

const { CAVITE_PAGE_ID, CAVITE_PROFILE_ID } = require('./pages');

const CLOSED = { sanpablo: false, cavite: false };

function pageKey(page) {
  if (!page) return '';
  const id = String(page.id || '');
  if (page.key === 'cavite' || page.defaultBranch === 'Cavite' || id === CAVITE_PAGE_ID || id === CAVITE_PROFILE_ID) return 'cavite';
  if (page.primary || page.key === 'main' || page.key === 'sanpablo') return 'sanpablo';
  return '';
}

function switchesUrl(base) {
  const root = String(base || '').replace(/\/+$/, '');
  // Live columns are page_key, label, enabled, updated_at, updated_by.
  // Only page_key and enabled are needed to decide whether to reply.
  return `${root}/rest/v1/bot_switches?select=page_key,enabled`;
}

// Legacy service-role keys are JWTs (three base64url parts, header starts with eyJ).
// New sb_secret_ keys are not. Sending those as Bearer is rejected.
function isJwt(key) {
  const parts = String(key || '').split('.');
  return parts.length === 3 && parts.every(Boolean) && parts[0].startsWith('eyJ');
}

function switchHeaders(key) {
  const headers = { apikey: key, Accept: 'application/json' };
  if (isJwt(key)) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function scrub(text, key) {
  let out = String(text || '');
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function bodyText(res) {
  if (res && typeof res.text === 'function') return res.text();
  if (res && typeof res.json === 'function') {
    const data = await res.json();
    return typeof data === 'string' ? data : JSON.stringify(data ?? '');
  }
  return '';
}

class PageSwitches {
  constructor(cfg = {}, { fetchImpl = fetch, now = () => Date.now(), cacheMs, log = null } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.cacheMs = Number.isFinite(cacheMs) ? cacheMs : (Number(cfg.pageSwitchCacheMs) || 15000);
    this.cache = null;
  }

  async enabled(page) {
    const state = await this.stateFor(page);
    return state.ok && state.enabled;
  }

  async stateFor(page) {
    const key = pageKey(page);
    const loaded = await this.read();
    if (!key || !loaded.ok) return { ok: false, enabled: false, key: key || '', error: loaded.error || '' };
    return { ok: true, enabled: loaded.map[key] === true, key };
  }

  async read() {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.value;
    const value = await this.fetchMap();
    this.cache = { at: now, value };
    return value;
  }

  fail(status, body) {
    const key = String(this.cfg.supabaseServiceRoleKey || '');
    const detail = `${status ? `HTTP ${status}` : 'network'} ${scrub(body, key)}`.trim();
    if (this.log && this.log.warn) this.log.warn(`page switch read failed: ${detail}`);
    return { ok: false, map: { ...CLOSED }, error: detail };
  }

  async fetchMap() {
    const url = String(this.cfg.supabaseUrl || '').trim();
    const key = String(this.cfg.supabaseServiceRoleKey || '').trim();
    if (!url || !key) return { ok: false, map: { ...CLOSED }, error: 'SUPABASE_URL or key empty' };
    try {
      const res = await this.fetchImpl(switchesUrl(url), {
        method: 'GET',
        headers: switchHeaders(key),
        signal: AbortSignal.timeout(4000),
      });
      const text = await bodyText(res);
      if (!res || !res.ok) return this.fail(res && res.status, text);
      let rows;
      try { rows = JSON.parse(text); } catch { return this.fail(res.status, 'invalid JSON'); }
      if (!Array.isArray(rows)) return this.fail(res.status, text || 'not a row list');
      const map = { ...CLOSED };
      for (const row of rows) {
        const name = row && row.page_key;
        if (name === 'sanpablo' || name === 'cavite') map[name] = row.enabled === true;
      }
      return { ok: true, map };
    } catch (e) {
      return this.fail(0, e && e.message);
    }
  }
}

module.exports = { PageSwitches, pageKey, switchesUrl, isJwt, switchHeaders };
