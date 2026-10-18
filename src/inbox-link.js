'use strict';
// Links from a stored review to the Page's thread with that customer.
//
// Business Suite, when a Messenger thread is open, uses this query shape
// (captured from the live inbox, community notes updated May 2026):
//   /latest/inbox/all?asset_id={PAGE_ID}&mailbox_id={PAGE_ID}&selected_item_id={id}&thread_type=FB_MESSAGE
// asset_id and mailbox_id are the Page id. thread_type=FB_MESSAGE is a Messenger thread.
// selected_item_id in those captures is a bare id, not the Graph conversation id t_...
// We put the customer's PSID there (the id on the Messenger webhook). The t_ id is stored
// separately from GET /{page-id}/conversations and is not placed in selected_item_id.
//
// https://m.me/{page} opens a visitor chat with the Page, not the Page's thread with
// this customer, so it is not used as a fallback.

function genericInboxUrl(pageId) {
  if (!pageId) return 'https://business.facebook.com/latest/inbox/all';
  return `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(pageId)}`;
}

function businessSuiteThreadUrl(pageId, psid) {
  if (!pageId || !psid) return genericInboxUrl(pageId);
  const q = new URLSearchParams({
    asset_id: String(pageId),
    selected_item_id: String(psid),
    mailbox_id: String(pageId),
    thread_type: 'FB_MESSAGE',
  });
  return `https://business.facebook.com/latest/inbox/all?${q.toString()}`;
}

// Graph's conversation.link is often a relative Page inbox path. Absolutize it.
// Drop m.me links; those are the customer-facing chat, not the Page inbox thread.
function messengerAppHref(link) {
  const raw = String(link || '').trim();
  if (!raw) return '';
  const abs = raw.startsWith('/') ? `https://www.facebook.com${raw}` : raw;
  let u;
  try { u = new URL(abs); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  if (host === 'm.me' || host.endsWith('.m.me')) return '';
  if (!host.endsWith('facebook.com') && !host.endsWith('messenger.com')) return '';
  return u.toString();
}

module.exports = { genericInboxUrl, businessSuiteThreadUrl, messengerAppHref };
