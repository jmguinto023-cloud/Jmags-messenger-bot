'use strict';
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const message = form.getAttribute('data-confirm') || 'Delete this job?';
    if (!window.confirm(message)) event.preventDefault();
  });
});

function closeModal(modal) {
  if (!modal) return;
  const editing = new URL(window.location.href).searchParams.has('edit');
  if (editing && modal.id === 'job-form') {
    const url = new URL(window.location.href);
    url.searchParams.delete('edit');
    window.location.href = url.toString();
    return;
  }
  modal.classList.remove('show');
}

function paintDevice() {
  const el = document.querySelector('[data-device-name]');
  if (!el) return;
  const name = window.localStorage.getItem('jmags-ops-device') || '';
  const button = el.querySelector('[data-name-device]');
  el.textContent = name ? `This device: ${name} ` : 'This device: not named yet ';
  if (button) el.appendChild(button);
}

document.addEventListener('click', (event) => {
  const open = event.target.closest('[data-open]');
  if (open) {
    const modal = document.getElementById(open.getAttribute('data-open'));
    if (modal) modal.classList.add('show');
    return;
  }
  const close = event.target.closest('[data-close]');
  if (close) {
    closeModal(close.closest('.modal'));
    return;
  }
  if (event.target.classList && event.target.classList.contains('modal')) {
    closeModal(event.target);
    return;
  }
  const shortcut = event.target.closest('[data-date-shortcut]');
  if (shortcut) {
    const form = shortcut.closest('form');
    const input = form && form.querySelector(`[name="${shortcut.getAttribute('data-for') || 'visitDate'}"]`);
    if (input) input.value = shortcut.getAttribute('data-date-shortcut');
    return;
  }
  if (event.target.closest('[data-refresh]')) {
    window.location.reload();
    return;
  }
  const nameBtn = event.target.closest('[data-name-device]');
  if (nameBtn) {
    const current = window.localStorage.getItem('jmags-ops-device') || '';
    const name = window.prompt('Name this device', current);
    if (name != null) {
      window.localStorage.setItem('jmags-ops-device', name.trim());
      paintDevice();
    }
  }
});

document.querySelectorAll('[data-filter]').forEach((input) => {
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll(input.getAttribute('data-filter')).forEach((row) => {
      row.hidden = Boolean(q) && !row.textContent.toLowerCase().includes(q);
    });
  });
});

paintDevice();

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js');
}
