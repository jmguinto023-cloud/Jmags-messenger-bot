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

// Same rules as inboxClientKind / primaryInboxHref in src/inbox-link.js.
// Desktop keeps the https Business Suite link. Android opens the Business Suite
// app by package. The facebook.com inbox link is hidden on a phone.
function inboxClientKind() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return 'coarse';
  } catch (e) { /* matchMedia can throw in old webviews */ }
  return '';
}

function applyMobileInboxLinks() {
  const kind = inboxClientKind();
  if (!kind) return;
  document.querySelectorAll('a.inbox-primary').forEach((a) => {
    const android = a.getAttribute('data-android-href') || '';
    const ios = a.getAttribute('data-ios-href') || '';
    const suite = a.getAttribute('href') || '';
    let next = suite;
    if (kind === 'android') next = android || suite;
    else if (kind === 'ios') next = ios || suite;
    if (next) a.setAttribute('href', next);
  });
  // facebook.com/{page}/inbox/{thread} opens the personal feed, not the Page chat.
  document.querySelectorAll('a.personal-inbox').forEach((a) => {
    const p = a.closest('p');
    if (p) p.hidden = true;
  });
}

applyMobileInboxLinks();

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
  const el = event.target.closest('[data-copy-name], [data-copy-text]');
  if (!el) return;
  const kind = el.getAttribute('data-copy-kind') || 'name';
  const text = kind === 'message'
    ? (el.getAttribute('data-copy-text') || '')
    : (el.getAttribute('data-copy-name') || '');
  if (!text) return;
  copyName(text);
  if (kind === 'message') showToast('Nakopya ang mensahe — i-paste sa search ng inbox');
  else showToast(`Nakopya ang pangalan ni ${text} — i-paste sa search ng inbox`);
});
