'use strict';
const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');

tokenInput.value = localStorage.getItem('jmags-admin-token') || '';

function setStatus(text) { statusEl.textContent = text; }

function authHeaders() {
  return { Authorization: `Bearer ${tokenInput.value.trim()}` };
}

document.getElementById('save-token').addEventListener('click', () => {
  localStorage.setItem('jmags-admin-token', tokenInput.value.trim());
  setStatus('Token saved on this device.');
  loadReviews();
});

document.getElementById('refresh').addEventListener('click', loadReviews);

document.getElementById('enable-notifications').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) { setStatus('Save the admin token first.'); return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    setStatus('This browser cannot show push alerts. Install the app, then try again.');
    return;
  }
  try {
    const res = await fetch('/dashboard/api/push-status', { headers: authHeaders() });
    if (res.status === 403) { setStatus('Admin token was rejected.'); return; }
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
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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

async function loadReviews() {
  const token = tokenInput.value.trim();
  if (!token) { listEl.innerHTML = '<p class="empty">Enter the admin token to load videos.</p>'; return; }
  const res = await fetch('/dashboard/api/reviews', { headers: authHeaders() });
  if (res.status === 403) { listEl.innerHTML = '<p class="empty">Admin token was rejected.</p>'; return; }
  const rows = await res.json();
  if (!rows.length) { listEl.innerHTML = '<p class="empty">No photos or videos yet.</p>'; return; }
  listEl.innerHTML = rows.slice().reverse().map((r) => {
    const when = r.timestamp ? new Date(r.timestamp).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '';
    const href = r.url ? `<p><a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">Open ${escapeText(r.type || 'file')}</a></p>` : '';
    return `<article class="card"><h2>${escapeText(r.type || 'media')} · …${escapeText(r.psidLast4 || '')}</h2><p class="meta">${escapeText(when)}</p><p>${escapeText(r.snippet || '')}</p>${href}</article>`;
  }).join('');
}

function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
loadReviews();
