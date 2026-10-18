'use strict';
// Links from a stored review to the Page's thread with that customer.
//
// Desktop Business Suite, with a Messenger thread open, uses:
//   https://business.facebook.com/latest/inbox/all?asset_id={PAGE_ID}&selected_item_id={THREAD}&mailbox_id={PAGE_ID}&thread_type=FB_MESSAGE
// Live captures (Business Suite address bar, community notes May 2026) put a bare
// numeric conversation id in selected_item_id. They do not use the Graph id's "t_"
// prefix, and a customer's PSID in that parameter loads the inbox list then fails
// the thread pane ("Something went wrong") on mobile web.
// The number Meta publishes for the thread is the /inbox/{digits}/ segment of
// Graph's conversation.link. If that path is missing and the Graph id is t_ plus
// digits, those digits are the same id. A non-numeric t_ id is not placed in the URL.
//
// Phones: an https://business.facebook.com link stays in the browser. An
// intent://business.facebook.com/...?selected_item_id=...#Intent;scheme=https
// URL is unwrapped by Samsung Internet back into that website, with or without
// browser_fallback_url, and the mobile thread pane then shows "Something went wrong".
// https://www.facebook.com/{page}/inbox/{thread}/ opens the personal Facebook feed
// (logged in as the person, not the Page). Neither is shown as a phone button.
// Android uses a launcher intent for package com.facebook.pages.app only.
// There is no documented fb:// or fbpages:// route for one Page thread.
// https://m.me/{page} opens a visitor chat with the Page, so it is not used.

const BUSINESS_SUITE_PACKAGE = 'com.facebook.pages.app';

function genericInboxUrl(pageId) {
  if (!pageId) return 'https://business.facebook.com/latest/inbox/all';
  return `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(pageId)}`;
}

function inboxDigits(link) {
  const m = /\/inbox\/(\d+)\/?(?:[?#]|$)/.exec(String(link || ''));
  return m ? m[1] : '';
}

// Bare id for selected_item_id. Never the PSID and never the "t_" prefix.
function threadItemId(conversationId, link) {
  const fromLink = inboxDigits(link);
  if (fromLink) return fromLink;
  const id = String(conversationId || '').trim();
  const prefixed = /^t_(\d+)$/.exec(id);
  if (prefixed) return prefixed[1];
  if (/^\d+$/.test(id)) return id;
  return '';
}

function businessSuiteThreadUrl(pageId, itemId) {
  if (!pageId || !itemId) return genericInboxUrl(pageId);
  const q = new URLSearchParams({
    asset_id: String(pageId),
    selected_item_id: String(itemId),
    mailbox_id: String(pageId),
    thread_type: 'FB_MESSAGE',
  });
  return `https://business.facebook.com/latest/inbox/all?${q.toString()}`;
}

// Graph's conversation.link is often a relative Page inbox path. Absolutize it.
// Drop m.me: that starts a visitor chat with the Page, not this Page thread.
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

function messengerThreadHref(link, conversationId, pageId) {
  const graph = messengerAppHref(link);
  if (graph) return graph;
  const item = threadItemId(conversationId, '');
  if (!item) return '';
  if (pageId) return `https://www.facebook.com/${encodeURIComponent(pageId)}/inbox/${encodeURIComponent(item)}/`;
  return `https://www.facebook.com/messages/t/${encodeURIComponent(item)}`;
}

// Launch the installed Business Suite app. No browser_fallback_url: the only
// fallback we had was the facebook.com inbox link, and that opens the personal feed.
function androidSuiteIntent() {
  return `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${BUSINESS_SUITE_PACKAGE};end`;
}

function inboxLinks(pageId, row) {
  const itemId = threadItemId(row && row.conversationId, row && row.conversationLink);
  const suite = businessSuiteThreadUrl(pageId, itemId);
  const messenger = messengerThreadHref(row && row.conversationLink, row && row.conversationId, pageId);
  return {
    itemId,
    suite,
    android: androidSuiteIntent(),
    messenger,
  };
}

// '' desktop, 'android', 'ios', or 'coarse' (touch device that is not Android or iOS).
function inboxClientKind(ua, pointerCoarse) {
  const s = String(ua || '');
  if (/Android/i.test(s)) return 'android';
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (pointerCoarse) return 'coarse';
  return '';
}

function primaryInboxHref({ kind, suiteHref, androidHref, messengerHref }) {
  if (kind === 'android' && androidHref) return androidHref;
  if (kind === 'ios') return suiteHref || messengerHref || '';
  if (kind === 'coarse' && messengerHref) return messengerHref;
  return suiteHref || '';
}

module.exports = {
  BUSINESS_SUITE_PACKAGE,
  genericInboxUrl,
  threadItemId,
  businessSuiteThreadUrl,
  messengerAppHref,
  messengerThreadHref,
  androidSuiteIntent,
  inboxLinks,
  inboxClientKind,
  primaryInboxHref,
};
