'use strict';
document.querySelectorAll('form[data-confirm]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    const message = form.getAttribute('data-confirm') || 'Delete this job?';
    if (!window.confirm(message)) event.preventDefault();
  });
});

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js');
}
