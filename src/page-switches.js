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
  return `${root}/rest/v1/bot_switches?select=page_key,enabled`;
}

class PageSwitches {
  constructor(cfg = {}, { fetchImpl = fetch, now = () => Date.now(), cacheMs } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.now = now;
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
    if (!key || !loaded.ok) return { ok: false, enabled: false, key: key || '' };
    return { ok: true, enabled: loaded.map[key] === true, key };
  }

  async read() {
    const now = this.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.value;
    const value = await this.fetchMap();
    this.cache = { at: now, value };
    return value;
  }

  async fetchMap() {
    const url = String(this.cfg.supabaseUrl || '').trim();
    const key = String(this.cfg.supabaseServiceRoleKey || '').trim();
    if (!url || !key) return { ok: false, map: { ...CLOSED } };
    try {
      const res = await this.fetchImpl(switchesUrl(url), {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(4000),
      });
      if (!res || !res.ok) return { ok: false, map: { ...CLOSED } };
      const rows = await res.json();
      if (!Array.isArray(rows)) return { ok: false, map: { ...CLOSED } };
      const map = { ...CLOSED };
      for (const row of rows) {
        const name = row && row.page_key;
        if (name === 'sanpablo' || name === 'cavite') map[name] = row.enabled === true;
      }
      return { ok: true, map };
    } catch {
      return { ok: false, map: { ...CLOSED } };
    }
  }
}

module.exports = { PageSwitches, pageKey, switchesUrl };
