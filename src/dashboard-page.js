'use strict';
// Server-rendered Ivan dashboard. No build step.
const { inboxLinks, inboxClientKind, primaryInboxHref } = require('./inbox-link');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function manila(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

function shell({ title, body, refresh }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#10243f">
  ${refresh ? '<meta http-equiv="refresh" content="30">' : ''}
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="JMAG Videos">
  <title>${esc(title)}</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/icon-192.png" type="image/png">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
${body}
<script src="/dashboard.js"></script>
</body>
</html>`;
}

function loginPage(error) {
  const msg = error === 'missing'
    ? 'Dashboard password is not set on the server yet.'
    : error === 'bad'
      ? 'Wrong password.'
      : 'Enter the dashboard password to see new videos and photos.';
  return shell({
    title: "JMAG's Video Review",
    refresh: false,
    body: `<header><h1>JMAG's Video Review</h1><p class="lede">${esc(msg)}</p></header>
<main>
  <form method="post" action="/dashboard/login">
    <label for="password">Password</label>
    <div class="password-field">
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="button" class="peek" id="toggle-password" aria-label="Ipakita/Itago ang password" aria-pressed="false">
        <svg class="eye" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" stroke-width="2" d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/>
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
          <path class="slash" fill="none" stroke="currentColor" stroke-width="2" d="M4 20L20 4"/>
        </svg>
      </button>
    </div>
    <div class="row"><button type="submit">Log in</button></div>
  </form>
</main>`,
  });
}

function mediaBlock(row) {
  const url = row.url || '';
  if (!url) return '<p class="meta">No attachment address was stored.</p>';
  const tag = row.type === 'video'
    ? `<video controls playsinline preload="metadata" src="${esc(url)}"></video>`
    : `<img alt="Customer ${esc(row.type || 'photo')}" src="${esc(url)}">`;
  return `${tag}
    <p><a href="${esc(url)}" target="_blank" rel="noopener">Open</a></p>
    <p class="meta">Messenger links can expire. This address is saved with the item.</p>`;
}

function reviewCard(row, pageId, ua) {
  const summary = row.summary || {};
  const who = row.customerName || `…${row.psidLast4 || ''}`;
  const status = row.status === 'reviewed' ? 'Reviewed' : 'New';
  const links = inboxLinks(pageId, row);
  const kind = inboxClientKind(ua, false);
  const phone = kind === 'android' || kind === 'ios';
  const href = primaryInboxHref({
    kind,
    suiteHref: links.suite,
    androidHref: links.android,
    messengerHref: links.messenger,
  });
  const named = String(row.customerName || '').trim();
  const copyAttr = named ? ` data-copy-name="${esc(named)}"` : '';
  const thread = links.itemId ? `thread id: ${links.itemId}` : 'thread id: not found';
  const debug = [thread, `button: ${href}`];
  if (links.messenger) debug.push(`messenger: ${links.messenger}`);
  debug.push(`desktop: ${links.suite}`);
  const fields = [
    ['Size', summary.size],
    ['Brand', summary.brand],
    ['Problem', summary.problem],
    ['Location', summary.location],
  ].filter(([, v]) => v);
  const dl = fields.length
    ? `<dl>${fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    : '<p class="meta">No size, brand, problem, or location in the chat yet.</p>';
  const button = status === 'New'
    ? `<form method="post" action="/dashboard/reviewed"><input type="hidden" name="id" value="${esc(row.id)}"><button type="submit">Mark reviewed</button></form>`
    : '';
  const copyButton = named
    ? `<p><button type="button" class="ghost copy-name" data-copy-name="${esc(named)}">Kopyahin ang pangalan</button></p>`
    : '';
  return `<article class="card">
    <h2 class="who">${esc(who)} <span class="pill ${status === 'New' ? 'new' : 'done'}">${status}</span></h2>
    <p class="meta">${esc(manila(row.timestamp))} · ${esc(row.type || 'photo')}</p>
    ${dl}
    ${mediaBlock(row)}
    <p><a class="inbox-primary" href="${esc(href)}"${copyAttr} data-android-href="${esc(links.android)}" data-ios-href="${esc(links.suite)}" data-messenger-href="${esc(links.messenger)}">Open chat in Business Suite</a></p>
    ${copyButton}
    ${!phone && links.messenger ? `<p><a class="personal-inbox" href="${esc(links.messenger)}">Open in Messenger</a></p>` : ''}
    <p class="meta debug">${esc(debug.join(' · '))}</p>
    ${button}
  </article>`;
}

function listPage(cfg, reviews, ua) {
  const rows = [...(reviews || [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const fresh = rows.filter((r) => r.status !== 'reviewed').length;
  const title = fresh ? `(${fresh}) JMAG's Video Review` : "JMAG's Video Review";
  const cards = rows.length
    ? rows.map((r) => reviewCard(r, cfg.pageId, ua)).join('\n')
    : '<p class="empty">No photos or videos yet.</p>';
  return shell({
    title,
    refresh: true,
    body: `<header>
      <h1>JMAG's Video Review <span class="badge" id="new-count">${fresh} new</span></h1>
      <p class="lede">Reply in Business Suite and the bot pauses in that chat so you can give the price. This page refreshes every 30 seconds.</p>
    </header>
    <main>
      <div class="row">
        <button id="enable-notifications" type="button">Enable notifications</button>
        <form method="post" action="/dashboard/logout"><button class="ghost" type="submit">Log out</button></form>
      </div>
      <p id="status" class="status"></p>
      <section id="list">${cards}</section>
    </main>`,
  });
}

function publicReview(row) {
  if (!row) return row;
  const copy = { ...row };
  delete copy.psid;
  return copy;
}

module.exports = { loginPage, listPage, publicReview, esc };
