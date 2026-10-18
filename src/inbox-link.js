'use strict';
// Links from a stored review to the Page inbox for that customer.
//
// The dashboard button opens the inbox list, not one thread:
//   https://business.facebook.com/latest/inbox/all?asset_id={PAGE_ID}
// A desktop click on
//   .../latest/inbox/all?asset_id={PAGE}&selected_item_id={THREAD}&mailbox_id={PAGE}&thread_type=FB_MESSAGE
// redirects to facebook.com with bpn_id and nav_ref=manage_page_ap_plus_default, then
// shows "Sorry, this content isn't available right now". {THREAD} (the /inbox/{digits}/
// segment, or the digits after t_) is not a selected_item_id Business Suite accepts.
// A PSID in that parameter failed the mobile thread pane ("Something went wrong").
// Candidate URLs for both ids, both inbox paths, and bpn_id are returned by
// GET /admin/inbox-candidates so they can be tried on a logged-in desktop.
// The card also copies the customer name so the inbox search can find the chat.
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
  // Do not put itemId in the button. That selected_item_id is the one desktop
  // Business Suite rejects. The button opens the inbox list.
  const suite = genericInboxUrl(pageId);
  const messenger = messengerThreadHref(row && row.conversationLink, row && row.conversationId, pageId);
  return {
    itemId,
    suite,
    android: androidSuiteIntent(),
    messenger,
  };
}

function withQuery(base, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v) === '') continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}

// Every id and URL worth trying for one PSID. The dashboard does not render these.
function candidateInboxUrls({ pageId, businessId, psid, conversationId, link, participants } = {}) {
  const page = String(pageId || '');
  const business = String(businessId || '');
  const user = String(psid || '');
  const convo = String(conversationId || '');
  const people = (Array.isArray(participants) ? participants : []).map((p) => ({
    id: String((p && p.id) || ''),
    name: String((p && p.name) || '').trim(),
  })).filter((p) => p.id);
  const linkDigits = inboxDigits(link);
  const prefixed = /^t_(\d+)$/.exec(convo);
  const tDigits = prefixed ? prefixed[1] : (/^\d+$/.test(convo) ? convo : '');
  const ids = {
    psid: user,
    conversationId: convo,
    threadDigitsFromLink: linkDigits,
    threadDigitsFromConversationId: tDigits,
    participantIds: people,
  };
  const selections = [];
  const add = (source, id) => {
    const v = String(id || '').trim();
    if (!v) return;
    if (selections.some((s) => s.source === source && s.id === v)) return;
    selections.push({ source, id: v });
  };
  add('psid', user);
  add('conversationId', convo);
  add('threadDigitsFromLink', linkDigits);
  add('threadDigitsFromConversationId', tDigits);
  for (const person of people) {
    if (person.id !== page) add('participant', person.id);
  }
  const bases = [
    ['business_suite_all', 'https://business.facebook.com/latest/inbox/all'],
    ['business_suite_messenger', 'https://business.facebook.com/latest/inbox/messenger'],
    ['facebook_all', 'https://www.facebook.com/latest/inbox/all'],
    ['facebook_messenger', 'https://www.facebook.com/latest/inbox/messenger'],
  ];
  const urls = [];
  const seen = new Set();
  const push = (label, url, extra) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push({ label, url, ...extra });
  };
  push('business_suite_list', genericInboxUrl(page), { selectedItemId: '', idSource: '' });
  if (page) {
    push('facebook_list', withQuery('https://www.facebook.com/latest/inbox/all', { asset_id: page }), { selectedItemId: '', idSource: '' });
  }
  for (const sel of selections) {
    for (const [baseLabel, base] of bases) {
      const core = {
        asset_id: page,
        selected_item_id: sel.id,
        mailbox_id: page,
        thread_type: 'FB_MESSAGE',
      };
      push(`${baseLabel} selected=${sel.source}`, withQuery(base, core), { selectedItemId: sel.id, idSource: sel.source });
      if (business) {
        push(`${baseLabel} selected=${sel.source} bpn_id`, withQuery(base, {
          bpn_id: business,
          asset_id: page,
          nav_ref: 'manage_page_ap_plus_default',
          selected_item_id: sel.id,
          mailbox_id: page,
          thread_type: 'FB_MESSAGE',
        }), { selectedItemId: sel.id, idSource: sel.source });
      }
    }
  }
  const threadDigits = linkDigits || tDigits;
  if (page && threadDigits) {
    push('facebook_inbox_thread', `https://www.facebook.com/${encodeURIComponent(page)}/inbox/${encodeURIComponent(threadDigits)}/`, {
      selectedItemId: threadDigits, idSource: linkDigits ? 'threadDigitsFromLink' : 'threadDigitsFromConversationId',
    });
  }
  if (tDigits) {
    push('facebook_messages_thread', `https://www.facebook.com/messages/t/${encodeURIComponent(tDigits)}`, {
      selectedItemId: tDigits, idSource: 'threadDigitsFromConversationId',
    });
  }
  if (user) {
    push('facebook_messages_psid', `https://www.facebook.com/messages/t/${encodeURIComponent(user)}`, {
      selectedItemId: user, idSource: 'psid',
    });
  }
  const graph = messengerAppHref(link);
  if (graph) push('graph_conversation_link', graph, { selectedItemId: '', idSource: 'conversationLink' });
  return { ids, urls };
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
  candidateInboxUrls,
  inboxClientKind,
  primaryInboxHref,
};
