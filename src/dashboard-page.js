'use strict';
// Server-rendered Ivan dashboard. No build step.
const { genericInboxUrl } = require('./inbox-link');
const { customerLabel } = require('./summary');

const WINDOW_ERROR = 'Lampas na sa 24 oras, i-reply sa Business Suite';

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

function threadMessages(history, limit = 10) {
  return (history || []).slice(-limit).map((h) => ({
    role: h.role === 'assistant' ? 'assistant' : 'user',
    who: h.role === 'user' ? 'Customer' : (h.via === 'ivan' ? 'Ivan' : 'Bot'),
    text: String(h.content || ''),
    time: manila(h.ts),
  }));
}

function windowOpen(thread, now, windowMs) {
  const last = thread && thread.lastUserTs;
  return Boolean(last) && now - last <= windowMs;
}

function messageList(history) {
  const rows = threadMessages(history);
  if (!rows.length) return '<p class="meta empty-thread">Wala pang mensahe.</p>';
  return `<ol class="thread">${rows.map((m) => `<li class="${m.role === 'user' ? 'from-customer' : 'from-us'}"><span class="who-line">${esc(m.who)} · ${esc(m.time)}</span><p>${esc(m.text)}</p></li>`).join('')}</ol>`;
}

function reviewCard(row, pageId, thread, now, windowMs) {
  const summary = row.summary || {};
  const named = String(row.customerName || '').trim();
  const who = customerLabel(named, row.psidLast4);
  const status = row.status === 'reviewed' ? 'Reviewed' : 'New';
  const open = windowOpen(thread, now, windowMs);
  const snippet = copySnippet(row);
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
    : (snippet
      ? `<p><button type="button" class="ghost copy-name" data-copy-text="${esc(snippet)}" data-copy-kind="message">Kopyahin ang mensahe</button></p>`
      : '');
  const ivan = row.ivanRepliedAt ? ' <span class="pill ivan">Sinagot ni Ivan</span>' : '';
  const disabled = open ? '' : ' disabled';
  const note = open ? '' : WINDOW_ERROR;
  return `<article class="card" data-review-id="${esc(row.id)}">
    <h2 class="who">${esc(who)} <span class="pill ${status === 'New' ? 'new' : 'done'}">${status}</span>${ivan}</h2>
    <p class="meta">${esc(manila(row.timestamp))} · ${esc(row.type || 'photo')}</p>
    ${row.quietNote ? `<p class="meta quiet">${esc(row.quietNote)}</p>` : ''}
    ${dl}
    ${mediaBlock(row)}
    <h3 class="thread-title">Huling mensahe</h3>
    <div class="thread-wrap">${messageList(thread && thread.history)}</div>
    <div class="reply">
      <label for="reply-${esc(row.id)}">Reply</label>
      <textarea id="reply-${esc(row.id)}" maxlength="2000" rows="3" placeholder="Sulatan si customer"${disabled}></textarea>
      <div class="row"><button type="button" class="send-reply"${disabled}>Send</button></div>
      <p class="send-note" role="status">${esc(note)}</p>
    </div>
    ${copyButton}
    <p><a class="inbox-fallback" href="${esc(genericInboxUrl(pageId))}">Buksan ang Inbox</a></p>
    ${button}
  </article>`;
}

function listPage(cfg, reviews, threads, now = Date.now()) {
  const rows = [...(reviews || [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const fresh = rows.filter((r) => r.status !== 'reviewed').length;
  const title = fresh ? `(${fresh}) JMAG's Video Review` : "JMAG's Video Review";
  const windowMs = (cfg.replyWindowHours || 23.5) * 3600 * 1000;
  const cards = rows.length
    ? rows.map((r) => reviewCard(r, cfg.pageId, (threads || {})[r.psid], now, windowMs)).join('\n')
    : '<p class="empty">No photos or videos yet.</p>';
  return shell({
    title,
    refresh: false,
    body: `<header>
      <h1>JMAG's Video Review <span class="badge" id="new-count">${fresh} new</span></h1>
      <p class="lede">Reply under the video. The bot pauses in that chat. Buksan ang Inbox is only a backup. The chat updates every 15 seconds.</p>
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

function copySnippet(row) {
  const raw = String(row.firstMessage || row.snippet || '');
  return raw.replace(/\[Customer sent a (?:video|photo)[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function threadsPayload(reviews, threads, now, windowMs) {
  const rows = [...(reviews || [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return {
    ids: rows.map((r) => r.id),
    cards: rows.map((r) => {
      const thread = (threads || {})[r.psid] || {};
      return {
        id: r.id,
        ivanReplied: Boolean(r.ivanRepliedAt),
        windowOpen: windowOpen(thread, now, windowMs),
        messages: threadMessages(thread.history),
      };
    }),
  };
}

function publicReview(row) {
  if (!row) return row;
  const copy = { ...row };
  delete copy.psid;
  return copy;
}

module.exports = { loginPage, listPage, publicReview, threadsPayload, esc, WINDOW_ERROR };
