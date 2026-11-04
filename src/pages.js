'use strict';
// Which Facebook Page a webhook entry belongs to, and which token Graph must use.
// PAGE_ID + PAGE_ACCESS_TOKEN stay the main Page (JMAG's Appliances).
// CAVITE_PAGE_ID + CAVITE_PAGE_ACCESS_TOKEN add Jmag's Appliances Cavite.
// PAGES is an optional JSON array of {id, token, name, key, defaultBranch} for extras
// or to supply the Cavite token. A Page with no token is recognized and ignored.
const { AsyncLocalStorage } = require('node:async_hooks');

// Graph Page id for Jmag's Appliances Cavite. The profile id is what some
// Business Suite screens show; webhooks may use either, and both map here.
const CAVITE_PAGE_ID = '1237499962773846';
const CAVITE_PROFILE_ID = '61591823125793';
const KNOWN_CAVITE_PAGE_ID = CAVITE_PAGE_ID;
const context = new AsyncLocalStorage();

function cleanId(v) {
  return String(v == null ? '' : v).trim();
}

function mainPage(env) {
  return {
    id: cleanId(env.PAGE_ID),
    token: String(env.PAGE_ACCESS_TOKEN || ''),
    name: "JMAG's Appliances",
    key: 'main',
    primary: true,
    defaultBranch: '',
  };
}

function cavitePage(env) {
  return {
    id: cleanId(env.CAVITE_PAGE_ID) || KNOWN_CAVITE_PAGE_ID,
    token: String(env.CAVITE_PAGE_ACCESS_TOKEN || ''),
    name: "Jmag's Appliances Cavite",
    key: 'cavite',
    primary: false,
    defaultBranch: 'Cavite',
  };
}

function asPage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanId(raw.id || raw.pageId);
  if (!id) return null;
  const key = cleanId(raw.key || raw.role || 'page').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'page';
  return {
    id,
    token: String(raw.token || raw.accessToken || raw.pageAccessToken || ''),
    name: String(raw.name || '').trim(),
    key,
    primary: false,
    defaultBranch: String(raw.defaultBranch || '').trim(),
  };
}

function upsert(pages, page) {
  if (!page || !page.id) return;
  const i = pages.findIndex((p) => p.id === page.id);
  if (i < 0) {
    pages.push(page);
    return;
  }
  const prev = pages[i];
  pages[i] = {
    ...prev,
    name: page.name || prev.name,
    key: prev.primary ? prev.key : (page.key || prev.key),
    token: page.token || prev.token,
    defaultBranch: page.defaultBranch || prev.defaultBranch,
    primary: prev.primary,
  };
}

function loadPages(env = {}) {
  const pages = [];
  const main = mainPage(env);
  if (main.id || main.token) pages.push(main);
  upsert(pages, cavitePage(env));
  let extra = [];
  if (env.PAGES) {
    try {
      const parsed = typeof env.PAGES === 'string' ? JSON.parse(env.PAGES) : env.PAGES;
      if (Array.isArray(parsed)) extra = parsed;
    } catch { extra = []; }
  }
  for (const raw of extra) upsert(pages, asPage(raw));
  return pages;
}

// entry.id -> page record. null means ignore (unknown Page, do not borrow the main token).
// A matched Page with an empty token is returned so the caller can ignore it safely.
function routeEntry(cfg, entryId) {
  const id = cleanId(entryId);
  const pages = (cfg && cfg.pages) || [];
  const primary = pages.find((p) => p.primary) || null;
  if (!id) return primary;
  const hit = pages.find((p) => p.id && p.id === id);
  if (hit) return hit;
  if (id === CAVITE_PAGE_ID || id === CAVITE_PROFILE_ID) {
    const cavite = pages.find((p) => p.key === 'cavite');
    if (cavite) return cavite;
  }
  // Older single-Page deploys that never set PAGE_ID still have one token.
  if (primary && !primary.id) return primary;
  return null;
}

function currentPage() {
  return context.getStore() || null;
}

function withPage(page, fn) {
  if (!page) return fn();
  return context.run(page, fn);
}

// Main Page keeps the bare PSID key so existing state.json and tests stay valid.
// Every other Page is namespaced so the same PSID cannot share a thread.
function storageKey(psid, page) {
  const id = cleanId(psid);
  if (!page || page.primary || !page.id) return id;
  return `${page.id}:${id}`;
}

module.exports = {
  CAVITE_PAGE_ID,
  CAVITE_PROFILE_ID,
  KNOWN_CAVITE_PAGE_ID,
  loadPages,
  routeEntry,
  currentPage,
  withPage,
  storageKey,
};
