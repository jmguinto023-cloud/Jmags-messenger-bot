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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
