'use strict';
const password = document.getElementById('password');
const peek = document.getElementById('toggle-password');
if (password && peek) {
  peek.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    peek.setAttribute('aria-pressed', show ? 'true' : 'false');
  });
}

const statusEl = document.getElementById('status');
const button = document.getElementById('enable-notifications');

function setStatus(text) { if (statusEl) statusEl.textContent = text; }

if (button) button.addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus('This browser cannot show push alerts. Install the app, then try again.');
    return;
  }
  try {
    const res = await fetch('/dashboard/api/push-status');
    if (res.status === 403) { setStatus('Log in again to enable notifications.'); return; }
    const info = await res.json();
    if (!info.enabled || !info.publicKey) {
      setStatus('Notifications are not set up on the server yet.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { setStatus('Notification permission was not granted.'); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.publicKey),
    });
    const saved = await fetch('/dashboard/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    if (!saved.ok) { setStatus('Could not save this device.'); return; }
    setStatus('Notifications are on for this device.');
  } catch (e) {
    setStatus(`Could not enable notifications. ${e.message || ''}`.trim());
  }
});

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js');
}

function isPhone() {
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMessages(messages) {
  if (!messages || !messages.length) return '<p class="meta empty-thread">Wala pang mensahe.</p>';
  return `<ol class="thread">${messages.map((m) => {
    const cls = m.role === 'user' ? 'from-customer' : 'from-us';
    return `<li class="${cls}"><span class="who-line">${esc(m.who)} · ${esc(m.time)}</span><p>${esc(m.text)}</p></li>`;
  }).join('')}</ol>`;
}

function applyCard(article, card) {
  const wrap = article.querySelector('.thread-wrap');
  if (wrap) wrap.innerHTML = renderMessages(card.messages);
  let pill = article.querySelector('.pill.ivan');
  if (card.ivanReplied && !pill) {
    const h = article.querySelector('h2');
    if (h) {
      pill = document.createElement('span');
      pill.className = 'pill ivan';
      pill.textContent = 'Sinagot ni Ivan';
      h.appendChild(document.createTextNode(' '));
      h.appendChild(pill);
    }
  }
  const box = article.querySelector('textarea');
  const btn = article.querySelector('.send-reply');
  const note = article.querySelector('.send-note');
  if (!card.windowOpen) {
    if (box) box.disabled = true;
    if (btn) btn.disabled = true;
    if (note && note.dataset.hold !== '1') note.textContent = 'Lampas na sa 24 oras, i-reply sa Business Suite';
  } else if (article.dataset.sending !== '1') {
    if (box) box.disabled = false;
    if (btn) btn.disabled = false;
  }
}

async function refreshThreads() {
  if (document.visibilityState === 'hidden') return;
  const cards = document.querySelectorAll('article[data-review-id]');
  if (!cards.length) return;
  let data;
  try {
    const res = await fetch('/dashboard/api/threads');
    if (!res.ok) return;
    data = await res.json();
  } catch (e) { return; }
  const known = new Set();
  cards.forEach((article) => {
    const id = article.getAttribute('data-review-id');
    known.add(id);
    const card = (data.cards || []).find((c) => c.id === id);
    if (card) applyCard(article, card);
  });
  const missing = (data.ids || []).some((id) => !known.has(id));
  const dirty = [...document.querySelectorAll('.reply textarea')].some((t) => t.value.trim());
  if (missing && !dirty) window.location.reload();
}

const replyCards = document.querySelectorAll('article[data-review-id]');
if (replyCards.length) {
  setInterval(refreshThreads, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshThreads();
  });
}

async function sendReply(article) {
  if (!article || article.dataset.sending === '1') return;
  const box = article.querySelector('textarea');
  const btn = article.querySelector('.send-reply');
  const note = article.querySelector('.send-note');
  const text = box ? box.value : '';
  if (!text.trim()) {
    if (note) note.textContent = 'Walang laman.';
    return;
  }
  article.dataset.sending = '1';
  if (btn) btn.disabled = true;
  if (note) { note.dataset.hold = '1'; note.textContent = 'Ipinapadala…'; }
  try {
    const res = await fetch('/dashboard/api/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: article.getAttribute('data-review-id'), text }),
    });
    let body = {};
    try { body = await res.json(); } catch (e) { body = {}; }
    if (res.ok && body.ok) {
      if (box) box.value = '';
      if (note) note.textContent = 'Naipadala.';
      await refreshThreads();
    } else if (note) {
      note.textContent = body.error || 'Hindi naipadala. Subukan ulit.';
    }
  } catch (e) {
    if (note) note.textContent = 'Hindi naipadala. Subukan ulit.';
  } finally {
    article.dataset.sending = '';
    if (btn && box && !box.disabled) btn.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const btn = event.target.closest('.send-reply');
  if (!btn) return;
  sendReply(btn.closest('article'));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || isPhone()) return;
  const box = event.target.closest && event.target.closest('.reply textarea');
  if (!box) return;
  event.preventDefault();
  sendReply(box.closest('article'));
});

function copyName(name) {
  let ok = false;
  const ta = document.createElement('textarea');
  ta.value = name;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(name).then(() => {}, () => {});
  return ok;
}

function showToast(text) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 5000);
}

// The click is not cancelled. The Business Suite control stays a real link,
// and the browser follows that intent itself.
document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-copy-name]');
  if (!el) return;
  const name = el.getAttribute('data-copy-name') || '';
  if (!name) return;
  copyName(name);
  showToast(`Nakopya ang pangalan ni ${name} — i-paste sa search ng inbox`);
});
