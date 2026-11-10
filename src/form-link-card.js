'use strict';
// Signed booking-form links for staff. The browser sends an opaque card id.
// The PSID and Page stay on the server. Nothing here sends a message or writes state.
const crypto = require('node:crypto');
const { pageKey } = require('./page-switches');
const { bookingFormLink } = require('./booking-confirm');

function threadCardId(storageKey) {
  return crypto.createHash('sha256').update(`jmags-form-card\n${String(storageKey || '')}`).digest('hex').slice(0, 24);
}

function pageName(cfg, pageId, storageKey) {
  const pages = (cfg && cfg.pages) || [];
  const id = String(pageId || '');
  let page = id ? pages.find((p) => p.id === id) : null;
  if (!page && storageKey && String(storageKey).includes(':')) {
    const prefix = String(storageKey).slice(0, String(storageKey).indexOf(':'));
    page = pages.find((p) => p.id === prefix);
  }
  if (!page) page = pages.find((p) => p.primary) || null;
  const key = pageKey(page);
  return key === 'sanpablo' || key === 'cavite' ? key : '';
}

function linkFor(cfg, psid, page) {
  if (!page) return null;
  const url = bookingFormLink(cfg, psid, page);
  return url ? { url, page } : null;
}

// Review id (16 hex) or thread card id (24 hex). Returns { url, page } or null.
function linkForCard(cfg, store, id) {
  const want = String(id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{16,32}$/.test(want)) return null;
  const review = (store.data.reviews || []).find((row) => row && String(row.id || '').toLowerCase() === want);
  if (review && review.psid) {
    return linkFor(cfg, review.psid, pageName(cfg, review.pageId, review.threadKey));
  }
  for (const [storageKey, thread] of Object.entries(store.data.threads || {})) {
    if (!thread || threadCardId(storageKey) !== want) continue;
    const psid = thread.psid
      ? String(thread.psid)
      : (String(storageKey).includes(':')
        ? String(storageKey).slice(String(storageKey).indexOf(':') + 1)
        : String(storageKey));
    return linkFor(cfg, psid, pageName(cfg, thread.pageId, storageKey));
  }
  return null;
}

module.exports = { threadCardId, linkForCard, pageName };
