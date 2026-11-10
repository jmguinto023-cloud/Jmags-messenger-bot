'use strict';
// Staff copy a signed booking-form link. The request sends the card id only.
async function copyText(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (e) { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

document.addEventListener('click', async (event) => {
  const btn = event.target.closest && event.target.closest('.copy-form-link');
  if (!btn || btn.dataset.copying === '1') return;
  const sourceId = btn.getAttribute('data-card-source');
  const source = sourceId ? document.getElementById(sourceId) : null;
  const id = source ? source.value : (btn.getAttribute('data-card-id') || '');
  const note = btn.parentElement ? btn.parentElement.querySelector('.copy-form-note') : null;
  const label = btn.textContent;
  if (!id) {
    if (note) note.textContent = 'Piliin muna ang chat.';
    return;
  }
  btn.dataset.copying = '1';
  btn.disabled = true;
  try {
    const res = await fetch('/dashboard/api/booking-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    let body = {};
    try { body = await res.json(); } catch (e) { body = {}; }
    if (!res.ok || !body.url) {
      if (note) note.textContent = body.error || 'Hindi makuha ang link.';
      return;
    }
    const copied = await copyText(body.url);
    btn.textContent = 'Copied';
    if (note) note.textContent = copied ? 'Copied' : 'Hindi nakopya. Subukan ulit.';
    setTimeout(() => { btn.textContent = label; }, 2000);
  } catch (e) {
    if (note) note.textContent = 'Hindi makuha ang link.';
  } finally {
    btn.disabled = false;
    btn.dataset.copying = '';
  }
});

const cardSearch = document.getElementById('card-search');
if (cardSearch) {
  cardSearch.addEventListener('input', () => {
    const q = cardSearch.value.trim().toLowerCase();
    document.querySelectorAll('article[data-review-id]').forEach((article) => {
      const hay = (article.getAttribute('data-find') || '').toLowerCase();
      article.hidden = Boolean(q) && !hay.includes(q);
    });
  });
}
