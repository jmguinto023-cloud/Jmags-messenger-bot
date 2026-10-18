'use strict';
// JMAG's Operations, laid out like the shop dashboard: light cards, green actions, bottom nav.
const { STATUSES, TECHS, BRANCHES, PAY_TYPES, METHODS, KNOWN_ADS, adBudgetOf, branchLabel } = require('./ops');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const PROVINCES = ['Laguna', 'Cavite', 'Batangas', 'Quezon', 'Metro Manila', 'Other'];
const SERVICE_TYPES = ['Not set yet (ask the customer)', 'Regular', 'Warranty', 'Comeback'];
const LEAD_SOURCES = ['Not set yet (ask the customer)', 'Facebook', 'Walk-in', 'Repeat customer', 'Referral'];
const EXPENSE_CATS = ['Parts', 'Fuel', 'Rent', 'Utilities', 'Technician pay', 'Other'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function peso(n) {
  const v = Number(n) || 0;
  return `₱${v.toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
}

function num(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 });
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(Number(n) * 100).toLocaleString('en-PH', { maximumFractionDigits: 1 })}%`;
}

function href(view, extra) {
  const q = new URLSearchParams();
  const tab = extra.tab || view.tab || 'today';
  q.set('tab', tab);
  q.set('branch', branchLabel(extra.branch || view.branch || 'ALL'));
  if ((extra.period || view.period) && tab !== 'today' && tab !== 'jobs' && tab !== 'customers' && tab !== 'parts') {
    q.set('period', extra.period || view.period);
  }
  if (extra.status) q.set('status', extra.status);
  if (extra.edit) q.set('edit', extra.edit);
  const group = extra.group || (tab === 'finance' ? view.group : '');
  if (group && group !== 'branch') q.set('group', group);
  return `/ops?${q.toString()}`;
}

function hidden(view) {
  const group = view.group && view.group !== 'branch'
    ? `<input type="hidden" name="returnGroup" value="${esc(view.group)}">`
    : '';
  return `<input type="hidden" name="returnBranch" value="${esc(branchLabel(view.branch))}"><input type="hidden" name="returnTab" value="${esc(view.tab)}"><input type="hidden" name="returnPeriod" value="${esc(view.period)}">${group}`;
}

function options(list, selected, placeholder) {
  const items = placeholder && !list.includes(selected) && selected ? [selected, ...list] : list;
  return items.map((item) => `<option${item === selected ? ' selected' : ''}>${esc(item)}</option>`).join('');
}

function adOptions(selected, extras) {
  const current = !selected || selected === 'Not checked yet' ? '' : selected;
  const list = ['', ...KNOWN_ADS];
  for (const extra of extras || []) {
    if (extra && extra !== 'Not checked yet' && !list.includes(extra)) list.push(extra);
  }
  if (current && !list.includes(current)) list.push(current);
  return list.map((item) => `<option value="${esc(item)}"${item === current ? ' selected' : ''}>${esc(item || 'Not checked yet')}</option>`).join('');
}

function areaOptions(selected) {
  const current = !selected || selected === 'Not checked yet' ? '' : selected;
  const list = ['', 'CAVITE', 'LAGUNA', 'BATANGAS', 'Boosted posts'];
  if (current && !list.includes(current)) list.push(current);
  return list.map((item) => `<option value="${esc(item)}"${item === current ? ' selected' : ''}>${esc(item || 'Not checked yet')}</option>`).join('');
}

function ymdParts(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function shortDate(ymd) {
  const p = ymdParts(ymd);
  if (!p) return String(ymd || '');
  return `${SHORT[p.m - 1]} ${p.d}`;
}

function monthTitle(range, today) {
  const p = ymdParts((range && range.start) || today);
  if (!p) return '';
  return `${MONTHS[p.m - 1]} '${String(p.y).slice(2)}`;
}

function weekday(ymd) {
  const p = ymdParts(ymd);
  if (!p) return '';
  return DAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
}

function ordinal(n) {
  const v = Number(n) || 0;
  const mod = v % 100;
  const suf = (mod >= 11 && mod <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
  return `${v}${suf}`;
}

function ago(ts, now) {
  const t = Date.parse(ts || '');
  if (!t || !now) return '';
  const hours = Math.max(0, Math.round((now - t) / 3600000));
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function openStatus(job) {
  return job.status !== 'Completed' && job.status !== 'Cancelled';
}

function lineMap(jobs) {
  const groups = {};
  for (const job of jobs) {
    if (!openStatus(job) || !job.visitDate) continue;
    const key = job.branch || 'San Pablo';
    (groups[key] = groups[key] || []).push(job);
  }
  const map = new Map();
  for (const list of Object.values(groups)) {
    list.sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate))
      || String(a.visitTime || '').localeCompare(String(b.visitTime || ''))
      || String(a.id).localeCompare(String(b.id)));
    list.forEach((job, i) => map.set(job.id, { n: i + 1, ahead: i }));
  }
  return map;
}

function nextJobId(jobs, today) {
  const upcoming = jobs.filter((j) => openStatus(j) && j.visitDate && j.visitDate >= today);
  upcoming.sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate))
    || String(a.visitTime || '').localeCompare(String(b.visitTime || ''))
    || String(a.id).localeCompare(String(b.id)));
  return upcoming[0] ? upcoming[0].id : '';
}

function freeTechs(jobs, date, time) {
  if (!date || !time) return [];
  const busy = new Set(jobs.filter((j) => j.visitDate === date && j.visitTime === time && j.status !== 'Cancelled').map((j) => j.technician));
  return ['JM', 'Joshua'].filter((tech) => !busy.has(tech));
}

function icon(name) {
  const paths = {
    today: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2v4M13 2v4"/>',
    jobs: '<path d="M4 8l2-4h8l2 4M3 8h14v8H3z"/>',
    customers: '<circle cx="8" cy="7" r="2.2"/><circle cx="13" cy="8" r="1.7"/><path d="M3.5 15c.4-2 2.2-3 4.5-3s4.1 1 4.5 3M12 12.2c1.4-.2 2.8.3 3.5 1.8"/>',
    money: '<rect x="2" y="5" width="16" height="10" rx="2"/><circle cx="10" cy="10" r="2"/>',
    finance: '<path d="M3 4h14l-4 5v5l-6 2V9z"/>',
    parts: '<path d="M3 7l7-4 7 4v7l-7 4-7-4zM10 3v14"/>',
  };
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6">${paths[name] || ''}</svg>`;
}

function shell(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#1e1a4d">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="JMAG Ops">
  <title>JMAG's Operations</title>
  <link rel="manifest" href="/manifest.webmanifest?v=2">
  <link rel="icon" href="/icons/favicon-32.png?v=2" sizes="32x32" type="image/png">
  <link rel="icon" href="/icons/favicon-16.png?v=2" sizes="16x16" type="image/png">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png?v=2">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Barlow:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/ops.css">
</head>
<body>
${body}
<script src="/ops.js"></script>
</body>
</html>`;
}

function header(view) {
  const branch = view.branchLabel || 'ALL';
  const pill = (label, cls, value) => {
    const on = branch === label ? ' on' : '';
    return `<a class="${cls}${on}" href="${href(view, { branch: value })}">${label === 'ALL' && on ? '✓ ' : ''}${label}</a>`;
  };
  return `<header class="top"><div class="wrap">
    <div class="brand">
      <div class="logo" aria-hidden="true">JMAG</div>
      <div>
        <a class="name" href="${href(view, { tab: 'today' })}">Operations</a><br>
        <a class="videos" href="/dashboard">Videos</a>
      </div>
    </div>
    <span class="branch-label">BRANCH</span>
    <nav class="branches" aria-label="Branch">
      ${pill('ALL', 'all', 'ALL')}
      ${pill('SAN PABLO', 'sp', 'San Pablo')}
      ${pill('CAVITE', 'cv', 'Cavite')}
    </nav>
    <span class="live"><i></i> Live</span>
    <button class="refresh" type="button" data-refresh aria-label="Refresh">↻</button>
  </div></header>`;
}

function dock(view) {
  const tabs = [
    ['today', 'Today', 'today'], ['jobs', 'Jobs', 'jobs'], ['customers', 'Customers', 'customers'],
    ['money', 'Money', 'money'], ['finance', 'Finance', 'finance'], ['parts', 'Parts', 'parts'],
  ];
  return `<nav class="dock" aria-label="Sections">${tabs.map(([id, label, glyph]) => `<a class="${view.tab === id ? 'on' : ''}" href="${href(view, { tab: id })}">${icon(glyph)}${label}</a>`).join('')}</nav>`;
}

function fabs(view) {
  if (view.tab === 'today' || view.tab === 'jobs') {
    const form = view.bookingFormUrl ? `<a href="${esc(view.bookingFormUrl)}" target="_blank" rel="noopener">Customer form</a>` : '';
    return `<div class="fabs">${form}<button class="solid" type="button" data-open="job-form">+ New job</button></div>`;
  }
  if (view.tab === 'money') return '<div class="fabs"><button class="solid" type="button" data-open="expense-form">+ Add expense</button></div>';
  return '';
}

function kpi(label, value, key, sub, tone) {
  return `<div class="kpi${tone ? ` ${tone}` : ''}" data-kpi="${esc(key)}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}

function sourcePill(job) {
  const service = String(job.serviceType || '');
  if (!service || /not set/i.test(service)) return '<span class="pill dashed">? NOT SET · ask customer</span>';
  return `<span class="pill outline">${esc(service.toUpperCase())}</span>`;
}

function statusPill(status) {
  const tone = { Scheduled: 'mint', 'Under Repair': 'orange', 'For Delivery': 'mint', Completed: 'grey', Cancelled: 'red', Inquiry: 'blue', Checked: 'orange' }[status] || 'mint';
  return `<span class="pill ${tone}">● ${esc(status)}</span>`;
}

function branchPill(branch) {
  const cavite = branch === 'Cavite';
  return `<span class="pill ${cavite ? 'cv' : 'sp'}">● ${esc(branch || 'San Pablo')}</span>`;
}

function dayPill(date, view) {
  if (!date) return '';
  if (date === view.tomorrow) return '<span class="pill lime">TOMORROW</span>';
  if (date === view.today) return '<span class="pill lime">TODAY</span>';
  return `<span class="pill lime">${esc(weekday(date))}</span>`;
}

function mapLinks(job) {
  const pin = job.mapLink ? `<a class="linkish" href="${esc(job.mapLink)}" target="_blank" rel="noopener">Directions · exact pin</a>` : '';
  const query = [job.address, job.city, job.landmark].filter(Boolean).join(', ');
  const find = query ? `<a class="linkish" href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent(query)}" target="_blank" rel="noopener">Find on map · by address</a>` : '';
  return `${pin} ${find}`;
}

function addrBox(job) {
  const text = [job.address, job.landmark].filter(Boolean).join(' · ');
  if (!text) return '';
  return `<div class="addr">${esc(text)}</div>`;
}

function attention(view) {
  const items = [];
  for (const job of view.attention.past) items.push(`<li><div><b>${esc(job.customerName)} · ${esc(job.unitType || 'TV')}</b><div class="meta">Past visit, status not updated</div></div><span class="pill pink">● Fix</span></li>`);
  for (const job of view.attention.balance) items.push(`<li><div><b>${esc(job.customerName)} · ${esc(job.unitType || 'TV')}</b><div class="meta">Completed with ${peso(job.balance)} unpaid</div></div><span class="pill pink">● Fix</span></li>`);
  for (const group of view.attention.dupes) {
    const row = group[0];
    items.push(`<li><div><b>${esc(row.customerName || row.jobId)} · TV</b><div class="meta">Check: possible duplicate payment</div></div><span class="pill pink">● Fix</span></li>`);
  }
  for (const row of view.needsText) items.push(`<li data-needs="text">${esc(row.jobId)} · ${esc(row.customerName)} · ${esc(row.phone)} <span class="meta">Needs text update</span> <span class="pill pink">● Fix</span></li>`);
  for (const row of view.needsDelivery || []) items.push(`<li data-needs="delivery">${esc(row.jobId)} · ${esc(row.customerName)} · ${esc(row.phone)} <span class="meta">Needs text update (delivery)</span> <span class="pill pink">● Fix</span></li>`);
  return items.length ? `<ul class="attention">${items.join('')}</ul>` : '<p class="empty">None.</p>';
}

function bookingCard(b, view) {
  const price = Number(b.price) > 0
    ? `<div class="agree"><b>${peso(b.price)}</b> agreed price</div>`
    : '<p class="warn">No agreed price yet</p>';
  const free = freeTechs(view.jobs, b.visitDate, b.visitTime);
  return `<article class="card booking">
    <div class="row-between">
      <div><span class="who">${esc(b.name)}</span> <span class="pill orange">New</span> ${branchPill(b.branch)} <span class="pill dashed">? NOT SET · ask customer</span></div>
      <div>
        <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="convert-booking"><input type="hidden" name="id" value="${esc(b.id)}">
          <label class="field"><span>Which ad brought them</span><select name="ad">${adOptions(b.ad, view.jobs.map((j) => j.ad))}</select></label>
          <label class="field"><span>Ad area</span><select name="adArea">${areaOptions(b.adArea)}</select></label>
          <button class="btn green" type="submit">Create job</button>
        </form>
        <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="dismiss-booking"><input type="hidden" name="id" value="${esc(b.id)}"><button class="btn red" type="submit">Dismiss</button></form>
      </div>
    </div>
    <p class="pin">📍 <b>${esc(b.city || b.branch || '')}</b></p>
    ${addrBox(b)}
    ${mapLinks(b)}
    <p>${esc(b.unitType || 'TV')} · <b>${esc([b.brand, b.size].filter(Boolean).join(' '))}</b> — ${esc(b.issue || '')}</p>
    ${price}
    <p class="meta">Wants ${esc(shortDate(b.visitDate))} ${esc(b.visitTime)} · sent ${esc(ago(b.sentAt, view.now))}</p>
    ${free.length ? `<p class="ok">Free at that hour: ${esc(free.join(', '))}</p>` : ''}
  </article>`;
}

function scheduleRow(job, view) {
  const balance = Number(job.balance);
  return `<article class="card visit">
    <div class="row-between">
      <div>${dayPill(job.visitDate, view)} ${statusPill(job.status)} <span class="meta">${esc(job.id)}</span></div>
      ${balance > 0 ? `<b class="debt">${peso(balance)}</b>` : ''}
    </div>
    <p><b>${esc(job.customerName)} · ${esc(job.unitType || 'TV')}</b> ${job.brand ? `· ${esc(job.brand)} ${esc(job.size)}` : ''}</p>
    <p class="pin">📍 <b>${esc(job.city || '')}</b></p>
    ${addrBox(job)}
    ${mapLinks(job)}
    <p class="meta">${esc(job.visitTime)} · ${esc(job.technician || 'Unassigned')}</p>
    <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="done"><input type="hidden" name="id" value="${esc(job.id)}"><button class="btn green" type="submit">✓ Job done</button></form>
  </article>`;
}

function chart(view) {
  const max = Math.max(1, ...view.chart.map((d) => d.amount));
  const total = view.chart.reduce((sum, d) => sum + Number(d.amount || 0), 0);
  const bars = view.chart.map((d) => {
    const day = Number(String(d.date).slice(8));
    const today = d.date === view.today ? ' today' : '';
    return `<div class="col${today}" data-date="${esc(d.date)}" data-amount="${esc(d.amount)}"><i style="height:${Math.max(2, Math.round((d.amount / max) * 100))}%"></i><small>${day}</small></div>`;
  }).join('');
  return `<section class="card chart-card" aria-label="Collections, last 14 days">
    <header><h2>Collected, last 14 days</h2><b>${peso(total)}</b></header>
    <div class="chart" role="img">${bars}</div>
  </section>`;
}

function todayTab(view) {
  const k = view.kpis;
  const lines = lineMap(view.jobs);
  const costs = Number(view.money.costs) || 0;
  const expenseNote = (view.money.expenses || []).length ? `${peso(costs)} expenses & ad spend` : 'no expenses recorded yet';
  const bookings = view.bookings.length
    ? view.bookings.map((b) => bookingCard(b, view)).join('')
    : '<p class="empty">No new bookings.</p>';
  const full = new Map(view.jobs.map((job) => [job.id, job]));
  const todayVisits = view.visitsToday.filter((j) => j.status !== 'Cancelled').map((j) => full.get(j.id) || j);
  const tomorrow = view.visitsTomorrow.filter((j) => j.status !== 'Cancelled').map((j) => full.get(j.id) || j);
  const later = view.jobs.filter((j) => j.visitDate && j.visitDate > view.tomorrow && j.status !== 'Cancelled' && j.status !== 'Completed')
    .slice().sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.visitTime || '').localeCompare(String(b.visitTime || '')));
  const groups = new Map();
  for (const job of later) {
    const list = groups.get(job.visitDate) || [];
    list.push(job);
    groups.set(job.visitDate, list);
  }
  const ahead = [...groups.entries()].map(([date, rows]) => `<section class="card"><header><h2>Booked ahead</h2><span class="meta">${esc(weekday(date).toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))}, ${esc(shortDate(date))} · ${rows.length} visit${rows.length === 1 ? '' : 's'}</span></header>${rows.map((j) => scheduleRow(j, view)).join('')}</section>`).join('');
  const techs = view.techLoad.map((row) => {
    const width = row.open ? Math.min(100, row.visits ? 40 + row.visits * 20 : 18) : 0;
    return `<div class="tile"><strong>${esc(row.tech.toUpperCase())}</strong><div class="meta">${row.open} open</div><div class="meta">${row.visits} visits today</div><div class="bar"><span style="width:${width}%"></span></div></div>`;
  }).join('');
  const reorder = view.reorder.map((p) => `<li class="row-between"><div><b>${esc(p.name)}</b><div class="meta">${esc(p.branch)}</div></div><span class="pill pink">● ${esc(p.stock)} left</span></li>`).join('');
  const activity = view.jobs.slice().sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))).slice(0, 8);
  const feed = activity.map((job) => `<li><b>${job.status === 'Completed' ? 'Marked job done' : 'Added a job'}: ${esc(job.customerName)} · ${esc(job.unitType || 'TV')}</b><div class="meta">${esc(ago(job.updatedAt || job.createdAt, view.now))}</div></li>`).join('');
  const flags = `${view.dailyOn ? '' : '<p class="note" id="daily-flag">Daily status updates are off.</p>'}${view.deliveryOn ? '' : '<p class="note" id="delivery-flag">Delivery notifications are off.</p>'}`;
  return `<section>
    ${flags}
    <div class="kpis">
      ${kpi('Open jobs', k.open, 'open', `${k.inquiries || 0} inquiries waiting`)}
      ${kpi('Under repair', k.underRepair, 'under-repair', 'in the shop now')}
      ${kpi('For delivery', k.forDelivery || 0, 'for-delivery', 'ready to return')}
      ${kpi('Visits today', k.visitsToday, 'visits-today', todayVisits.length ? '' : 'No home-service visits scheduled today.')}
      ${kpi('Collected today', peso(k.collectedToday), 'collected-today')}
      ${kpi('Collected this month', peso(k.collectedMonth), 'collected-month', `${peso(costs)} expenses & ad spend`)}
      ${kpi('Profit this month', peso(k.profitMonth), 'profit-month', expenseNote, 'profit')}
      ${kpi('Low stock', k.lowStock, 'low-stock', 'parts at reorder level', 'low wide')}
    </div>
    <div class="layout today">
      <div>
        <section class="card">
          <header><h2>New bookings ${view.bookings.length ? `<span class="count">${view.bookings.length}</span>` : ''}</h2><span class="meta">Checked just now <button class="ghost" type="button" data-refresh>Refresh</button></span></header>
          ${bookings}
        </section>
        <section class="card">
          <header><h2>Today's visits</h2><span class="meta">${esc(shortDate(view.today))}</span></header>
          ${todayVisits.length ? todayVisits.map((j) => scheduleRow(j, view)).join('') : '<p class="empty">No home-service visits scheduled today.</p>'}
        </section>
        <section class="card">
          <header><h2>Tomorrow</h2><span class="meta">${esc(shortDate(view.tomorrow))}</span></header>
          ${tomorrow.length ? tomorrow.map((j) => scheduleRow(j, view)).join('') : '<p class="empty">None.</p>'}
        </section>
        ${ahead}
        ${chart(view)}
        <section class="card">
          <header><h2>Live activity</h2><span class="ok">Synced just now</span></header>
          <p class="note" data-device-name>This device: not named yet <button class="ghost" type="button" data-name-device>Name this device</button></p>
          ${feed ? `<ul>${feed}</ul>` : '<p class="empty">No job changes yet.</p>'}
        </section>
      </div>
      <div>
        <section class="card">
          <h2>Needs attention</h2>
          <p class="visually-hidden">Needs text update (delivery)</p>
          ${attention(view)}
        </section>
        <section class="card">
          <h2 class="visually-hidden">Technician load</h2>
          <h2>Technicians</h2>
          <div class="techs">${techs}</div>
        </section>
        <section class="card">
          <h2>Reorder soon</h2>
          ${reorder ? `<ul>${reorder}</ul>` : '<p class="empty">None.</p>'}
        </section>
      </div>
    </div>
    ${lines ? '' : ''}
  </section>${jobModal(view)}`;
}

function field(label, control) {
  return `<label class="field"><span>${label}</span>${control}</label>`;
}

function jobFields(job, view) {
  const j = job || {};
  const reviews = view.reviews || [];
  const linked = j.psid ? `Linked ••${esc(String(j.psid).slice(-4))}` : 'Not linked';
  const chatOptions = ['<option value="">Not linked</option>'].concat(reviews.slice(0, 40).map((r) => {
    const selected = j.psid && r.psid === j.psid ? ' selected' : '';
    const label = `${r.customerName || 'Customer'} ••${r.psidLast4 || String(r.psid || '').slice(-4)}`;
    return `<option value="${esc(r.id)}"${selected}>${esc(label)}</option>`;
  })).join('');
  const ads = [j.ad];
  const line = j.id && j.visitDate
    ? `${ordinal((lineMap(view.jobs).get(j.id) || {}).n || 1)} in line · ${j.branch || 'San Pablo'} (${(lineMap(view.jobs).get(j.id) || {}).ahead || 0} ahead)`
    : 'Place in line';
  const times = ['', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM'];
  if (j.visitTime && !times.includes(j.visitTime)) times.push(j.visitTime);
  const timeOptions = times.map((item) => `<option value="${esc(item)}"${item === (j.visitTime || '') ? ' selected' : ''}>${esc(item || 'Select time')}</option>`).join('');
  const province = j.province || (j.id ? '' : 'Laguna');
  return `<p class="slot">${esc(line)}</p>
    <p class="addr">Pick a date and time to check the slot</p>
    <div class="grid two">
      ${field('Customer name *', `<input name="customerName" value="${esc(j.customerName || '')}" required>`)}
      ${field('Mobile number *', `<input name="phone" value="${esc(j.phone || '')}" placeholder="09XX XXX XXXX">`)}
    </div>
    <div class="grid two">
      ${field('Address / barangay', `<input name="address" value="${esc(j.address || '')}">`)}
      ${field('Subdivision (if any)', `<input name="subdivision" value="${esc(j.subdivision || '')}" placeholder="Leave blank if none">`)}
    </div>
    ${field('Town / City *', `<input name="city" value="${esc(j.city || '')}" placeholder="e.g. Testville">`)}
    ${field('Google Maps / Waze pin (if any)', `<input name="mapLink" value="${esc(j.mapLink || '')}" placeholder="Leave blank if none">`)}
    <div class="grid two">
      ${field('Nearest landmark *', `<input name="landmark" value="${esc(j.landmark || '')}" placeholder="e.g. beside the sample store">`)}
      ${field('Province', `<select name="province"><option value="">—</option>${options(PROVINCES, province, true)}</select>`)}
    </div>
    <div class="grid two">
      ${field('Branch', `<select name="branch">${options(BRANCHES, j.branch || 'San Pablo')}</select>`)}
      ${field('Appliance', `<input name="unitType" value="${esc(j.unitType || 'TV')}">`)}
    </div>
    <div class="grid two">
      ${field('Brand *', `<input name="brand" value="${esc(j.brand || '')}" placeholder="e.g. Samsung, LG, Sharp">`)}
      ${field('Size *', `<input name="size" value="${esc(j.size || '')}" placeholder="e.g. 43, 8 kg, 1.5 HP, 20 L">`)}
    </div>
    ${field('Problem reported *', `<input name="issue" value="${esc(j.issue || '')}">`)}
    <div class="grid two">
      ${field('Status', `<select name="status">${options(STATUSES, j.status || 'Inquiry')}</select>`)}
      ${field('Technician', `<select name="technician">${options(TECHS, j.technician || 'Unassigned')}</select>`)}
    </div>
    <div class="grid two">
      ${field('Visit date', `<input type="date" name="visitDate" value="${esc(j.visitDate || '')}"><button type="button" class="text-btn" data-date-shortcut="${esc(view.today)}" data-for="visitDate">Today</button><button type="button" class="text-btn" data-date-shortcut="${esc(view.tomorrow)}" data-for="visitDate">Tomorrow</button>`)}
      ${field('Visit time', `<select name="visitTime">${timeOptions}</select>`)}
    </div>
    ${field('Date received', `<input type="date" name="date" value="${esc(j.date || view.today)}">`)}
    ${field('Service type', `<select name="serviceType">${options(SERVICE_TYPES, j.serviceType || 'Not set yet (ask the customer)')}</select>`)}
    ${field('How they found us', `<select name="leadSource">${options(LEAD_SOURCES, j.leadSource || 'Facebook')}</select>`)}
    ${field('Which ad brought them — required for Facebook (check the Messenger chat)', `<select name="ad">${adOptions(j.ad, ads)}</select>`)}
    ${field('Ad area', `<select name="adArea">${areaOptions(j.adArea)}</select>`)}
    <p class="hint">Ad area fills in from the ad name: CAVITE, LAGUNA, or BATANGAS. Cavite Page ad uses the Cavite budget. LAGUNA and BATANGAS use the San Pablo budget. Boosted posts is its own budget and is not counted on either branch. Edit the area when there is no ad.</p>
    <div class="grid two">
      ${field('Repair total (₱)', `<input name="price" inputmode="decimal" value="${esc(j.price || '')}" placeholder="Includes the ₱1,000 check-up">`)}
      ${field('Date completed', `<input type="date" name="doneDate" value="${esc(j.doneDate || '')}">`)}
    </div>
    ${field('Warranty', `<input value="3 months${j.warrantyEnd ? ` · until ${j.warrantyEnd}` : ''}" readonly>`)}
    ${field('Work done / parts replaced', `<input name="partsUsed" value="${esc(j.partsUsed || '')}">`)}
    <div class="grid two">
      ${field('Travel fee', `<input name="travelFee" inputmode="decimal" value="${esc(j.travelFee || '')}">`)}
      ${field('Parts cost', `<input name="partsCost" inputmode="decimal" value="${esc(j.partsCost || '')}">`)}
    </div>
    ${field('Status note for customer', `<textarea name="statusNote" rows="2">${esc(j.statusNote || '')}</textarea>`)}
    ${field('Notes', `<textarea name="notes" rows="2">${esc(j.notes || '')}</textarea>`)}
    ${j.id ? `<p class="meta">Messenger chat: <span data-messenger="${esc(linked)}">${linked}</span></p>
      ${field('Messenger chat', `<select name="review">${chatOptions}</select>`)}
      <input type="hidden" name="link" value="1">` : ''}`;
}

function jobModal(view) {
  const editing = view.editing;
  const title = editing ? `Edit ${editing.id}` : 'New job order';
  return `<div class="modal${editing ? ' show' : ''}" id="job-form"><form class="sheet" method="post" action="/ops/action">
    <header><h2>${esc(title)}</h2><button class="ghost" type="button" data-close>×</button></header>
    ${hidden(view)}
    <input type="hidden" name="action" value="${editing ? 'update-job' : 'create-job'}">
    ${editing ? `<input type="hidden" name="id" value="${esc(editing.id)}">` : ''}
    ${jobFields(editing, view)}
    <div class="actions"><button class="ghost" type="button" data-close>Cancel</button><button class="btn green" type="submit">Save</button></div>
  </form></div>`;
}

function jobCard(job, view, nextId) {
  const line = lineMap(view.jobs).get(job.id);
  const balance = Number(job.balance) || 0;
  return `<article class="card job${job.id === nextId ? ' next' : ''}" data-job="${esc(job.id)}">
    <div class="row-between"><span class="meta">${esc(job.id)}</span><span>${dayPill(job.visitDate, view)} ${statusPill(job.status)}</span></div>
    <p class="who">${esc(job.customerName)}</p>
    <p>${sourcePill(job)} ${line ? `<span class="pill mint">● ${ordinal(line.n)} in line</span>` : ''}</p>
    <p class="pin">📍 <b>${esc(job.city || job.branch || '')}</b></p>
    ${addrBox(job)}
    ${mapLinks(job)}
    <p>${esc(job.unitType || 'TV')} · <b class="linkish">${esc([job.brand, job.size].filter(Boolean).join(' '))}</b> — ${esc(job.issue || '')}</p>
    <p class="ok">${esc(shortDate(job.visitDate))} ${esc(job.visitTime)} · ${esc(job.technician || 'Unassigned')} · ${esc(job.branch || '')}</p>
    <p class="${job.adArea ? 'meta' : 'warn'}">Ad area: ${esc(job.adArea || 'Not checked yet')}${job.ad ? ` · ${esc(job.ad)}` : ''}</p>
    <p class="meta">Warranty ${esc(job.warrantyEnd || '')}${job.psid ? ` · Messenger ••${esc(String(job.psid).slice(-4))}` : ''}</p>
    ${job.statusNote ? `<p class="meta">${esc(job.statusNote)}</p>` : ''}
    ${balance > 0 ? `<div class="unpaid"><div><strong>${peso(job.price)}</strong> <span class="meta">Not fully paid · ${peso(balance)} balance</span></div></div>` : ''}
    <div class="row-between">
      <a class="ghost" href="${href(view, { tab: 'jobs', edit: job.id })}">Edit</a>
      <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="done"><input type="hidden" name="id" value="${esc(job.id)}"><button class="btn green" type="submit">✓ Job done</button></form>
      <form method="post" action="/ops/action" data-confirm="Delete ${esc(job.id)}?">${hidden(view)}<input type="hidden" name="action" value="delete-job"><input type="hidden" name="id" value="${esc(job.id)}"><button class="text-btn" type="submit">Delete</button></form>
    </div>
    <form method="post" action="/ops/action" class="row-between">${hidden(view)}<input type="hidden" name="action" value="status"><input type="hidden" name="id" value="${esc(job.id)}">
      <select name="status">${options(STATUSES, job.status)}</select><button class="ghost" type="submit">Update status</button>
    </form>
  </article>`;
}

function jobsTab(view) {
  const counts = view.chipCounts || {};
  const chips = [
    ['Open', 'Open'],
    ...STATUSES.map((status) => [status, status]),
    ['warranty', 'Under warranty'],
    ['ad', 'Ad area: Not checked yet'],
    ['untraced', 'No ad budget'],
    ['All', 'All'],
  ].map(([id, label]) => {
    const on = (id === 'All' ? view.statusFilter === '' : view.statusFilter === id) ? ' on' : '';
    const count = counts[id] != null ? counts[id] : counts[label];
    return `<a class="${on.trim()}" href="${href(view, { tab: 'jobs', status: id === 'All' ? 'All' : id })}">${on ? '✓ ' : ''}${esc(label)} <b>${esc(count || 0)}</b></a>`;
  }).join('');
  const nextId = nextJobId(view.jobs, view.today);
  const cards = view.jobs.map((j) => jobCard(j, view, nextId)).join('');
  return `<section>
    <div class="page-head">
      <h1>Job orders</h1>
      <input class="search grow" placeholder="Search name, phone, appliance, JO number" data-filter="[data-job]">
      <a class="ghost" href="/ops/export?kind=jobs&amp;branch=${esc(view.branchLabel)}">⤓ Export CSV</a>
    </div>
    <nav class="chips">${chips}</nav>
    <div class="jobs">${cards || '<p class="empty">No jobs.</p>'}</div>
    ${jobModal(view)}
  </section>`;
}

function customersTab(view) {
  const rows = view.customers.map((c, i) => `<div class="cust-row">
    <div><div class="person${i % 7 === 3 ? ' green' : ''}">${esc(c.name)}</div><div class="meta">${esc(c.phone)} · ${esc(c.address)}</div></div>
    <div class="right"><div>${esc(c.jobs)} job${Number(c.jobs) === 1 ? '' : 's'}</div><div class="meta">${peso(c.paid)}</div></div>
  </div>`).join('');
  return `<section>
    <div class="page-head"><h1>Customers</h1><input class="search grow" placeholder="Search name, number, address" data-filter=".cust-row"></div>
    <div class="card">${rows || '<p class="empty">No customers.</p>'}</div>
  </section>`;
}

function periodChips(view, tab) {
  return [['month', 'This month'], ['last', 'Last month'], ['all', 'All time']].map(([id, label]) => `<a class="${view.period === id ? 'on' : ''}" href="${href(view, { tab, period: id })}">${label}</a>`).join('');
}

function moneyModal(id, title, view, inner, action) {
  return `<div class="modal" id="${id}"><form class="sheet" method="post" action="/ops/action">
    <header><h2>${title}</h2><button class="ghost" type="button" data-close>×</button></header>
    ${hidden(view)}<input type="hidden" name="action" value="${action}">
    ${inner}
    <div class="actions"><button class="ghost" type="button" data-close>Cancel</button><button class="btn green" type="submit">Save</button></div>
  </form></div>`;
}

function moneyTab(view) {
  const m = view.money;
  const title = monthTitle(m.range, view.today);
  const tile = (label, value, tone) => `<div class="stat${tone ? ` ${tone}` : ''}"><span>${esc(label)}</span><strong>${peso(value)}</strong></div>`;
  const by = (obj, keys) => keys.map((key) => tile(key, obj[key] || 0)).join('');
  const profit = Number(m.collected) ? Math.round((Number(m.profit) / Number(m.collected)) * 100) : 0;
  const pays = m.payments.map((p) => `<tr>
    <td>${esc(shortDate(p.date))}</td>
    <td><span class="pill outline">${esc(p.customerName)}</span></td>
    <td><form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="update-payment">
      <input type="hidden" name="date" value="${esc(p.date)}"><input type="hidden" name="jobId" value="${esc(p.jobId)}">
      <input type="hidden" name="customerName" value="${esc(p.customerName)}"><input type="hidden" name="amount" value="${esc(p.amount)}">
      <input type="hidden" name="method" value="${esc(p.method)}"><input type="hidden" name="note" value="${esc(p.note)}">
      <input type="hidden" name="branch" value="${esc(p.branch)}"><input type="hidden" name="wasType" value="${esc(p.type)}">
      <select name="type" onchange="this.form.submit()">${options(PAY_TYPES, p.type)}</select></form></td>
    <td>${esc(p.method)}</td><td>${esc(p.branch)}</td><td>${peso(p.amount)}</td>
    <td><form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="delete-payment">
      <input type="hidden" name="date" value="${esc(p.date)}"><input type="hidden" name="jobId" value="${esc(p.jobId)}">
      <input type="hidden" name="customerName" value="${esc(p.customerName)}"><input type="hidden" name="amount" value="${esc(p.amount)}">
      <input type="hidden" name="method" value="${esc(p.method)}"><input type="hidden" name="note" value="${esc(p.note)}">
      <input type="hidden" name="branch" value="${esc(p.branch)}"><input type="hidden" name="wasType" value="${esc(p.type)}">
      <button class="text-btn danger" type="submit">Delete</button></form></td>
  </tr>`).join('');
  const expenses = m.expenses || [];
  const unpaid = m.unpaid.map((j) => `<li class="row-between"><div><b>${esc(j.customerName)} · TV</b><div class="meta">${esc(j.id)} · ${esc(j.status || '')}</div></div><b class="debt">${peso(j.balance)}</b></li>`).join('');
  const branches = ['San Pablo', 'Cavite'].map((name) => {
    const row = m.perBranch[name];
    return `<tr data-branch-profit="${esc(name)}"><td>${esc(name)}</td><td>${peso(row.collected)}</td><td>${peso(row.costs)}</td><td class="ok">${peso(row.profit)}</td></tr>`;
  }).join('');
  const noExpenses = expenses.length === 0;
  return `<section>
    <div class="page-head">
      <h1>Money</h1>
      <button class="ghost" type="button" data-open="expense-form">+ Add expense</button>
      <button class="btn green" type="button" data-open="payment-form">+ Record payment</button>
    </div>
    <nav class="chips">${periodChips(view, 'money')}</nav>
    <section class="card">
      <header><h2>${esc(title)}</h2><span class="meta">${view.branch === 'ALL' ? 'BOTH BRANCHES' : esc(view.branchLabel)}</span></header>
      <div class="stats five">${tile('Total collected', m.collected)}${by(m.byType, ['Check-up fee', 'Repair', 'Parts', 'Other'])}</div>
      <p class="eyebrow">By branch</p>
      <div class="stats">${tile('San Pablo', m.byBranch['San Pablo'] || 0)}${tile('Cavite', m.byBranch.Cavite || 0)}</div>
      <p class="eyebrow">By method</p>
      <div class="stats four">${by(m.byMethod, ['Cash', 'GCash', 'Maya', 'Bank transfer'])}</div>
    </section>
    <section class="card">
      <h2>Real profit · ${esc(title)} · month to date</h2>
      <div class="stats three">
        ${tile('Money in', m.collected)}
        <div class="stat bad"><span>Costs</span><strong>${peso(m.costs)}</strong></div>
        <div class="stat good"><span>Profit</span><strong>${peso(m.profit)}</strong></div>
      </div>
      <table class="table"><thead><tr><th>Branch</th><th>Money in</th><th>Costs</th><th>Profit</th></tr></thead>
        <tbody>${branches}<tr><td><b>Total</b></td><td><b>${peso(m.collected)}</b></td><td><b>${peso(m.costs)}</b></td><td class="ok"><b>${peso(m.profit)}</b></td></tr></tbody>
      </table>
      <p class="explain">Real profit per branch is its own collections and other income, minus its own expenses and ad spend. Money in = payments collected + other income.</p>
      <p>${profit}% of the money in is left as profit.</p>
      ${noExpenses ? '<p class="callout">No expenses recorded in this period, so this profit is not real yet. Tap “+ Add expense” for parts, fuel, pay, rent and utilities.</p>' : ''}
    </section>
    <section class="card">
      <header><h2>Investor split · ${esc(title)}</h2><span class="pill mint">● 50% to investor</span></header>
      <p>Cavite investor 50%</p>
      <div class="stats five">
        ${tile('Money in', m.perBranch.Cavite.collected)}
        ${tile('Costs', m.perBranch.Cavite.costs)}
        <div class="stat good"><span>Profit</span><strong>${peso(m.perBranch.Cavite.profit)}</strong></div>
        <div class="stat good"><span>Investor gets</span><strong>${peso(m.investor)}</strong></div>
        ${tile('You keep', m.youKeep)}
      </div>
      <p class="explain">Each branch is split on its own real profit. Nothing is shared between branches.</p>
      <p class="note">Ad spend, other income, profit by ad and the payment check are on the Finance tab.</p>
    </section>
    <section class="card">
      <header><h2>Unpaid balances</h2><b class="debt" data-unpaid="${esc(m.unpaidTotal)}">${peso(m.unpaidTotal)}</b></header>
      ${unpaid ? `<ul>${unpaid}</ul>` : '<p class="empty">None.</p>'}
    </section>
    <section class="card">
      <header><h2>Payments</h2><a class="ghost" href="/ops/export?kind=money&amp;branch=${esc(view.branchLabel)}&amp;period=${esc(view.period)}">⤓ Export CSV</a></header>
      <table class="table"><thead><tr><th>Date</th><th>Customer</th><th>Type</th><th>Method</th><th>Branch</th><th>Amount</th><th></th></tr></thead><tbody>${pays}</tbody></table>
    </section>
    <section class="card">
      <header><h2>Expenses · ${esc(title)} · month to date</h2><b>${peso(expenses.reduce((s, e) => s + Number(e.amount || 0), 0))}</b></header>
      ${expenses.length ? `<ul>${expenses.map((e) => `<li class="row-between"><span>${esc(shortDate(e.date))} · ${esc(e.category || 'Expense')} · ${esc(e.branch)} · ${esc(e.note)}</span><span><b>${peso(e.amount)}</b> <form style="display:inline" method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="delete-expense"><input type="hidden" name="date" value="${esc(e.date)}"><input type="hidden" name="branch" value="${esc(e.branch)}"><input type="hidden" name="amount" value="${esc(e.amount)}"><input type="hidden" name="note" value="${esc(e.note)}"><button class="text-btn danger" type="submit">Delete</button></form></span></li>`).join('')}</ul>` : `<div class="empty-dash"><b>No expenses yet</b><p>Record what the business spends — parts, fuel, technician pay, rent, utilities, ads. Without this the app can only show collections, not profit, and the investor split can't be computed.</p><button class="btn green" type="button" data-open="expense-form">+ Add expense</button></div>`}
    </section>
    ${moneyModal('payment-form', 'Record payment', view, `
      <div class="grid two">
        ${field('Amount (₱) *', '<input name="amount" inputmode="decimal" required>')}
        ${field('For', `<select name="type">${options(PAY_TYPES, 'Repair')}</select>`)}
        ${field('Method', `<select name="method">${options(METHODS, 'Cash')}</select>`)}
        ${field('Date', `<input type="date" name="date" value="${esc(view.today)}">`)}
        ${field('Branch', `<select name="branch">${options(BRANCHES, 'San Pablo')}</select>`)}
        ${field('Customer / description', '<input name="customerName">')}
      </div>
      ${field('JO number', '<input name="jobId">')}
      ${field('Note', '<input name="note">')}
    `, 'add-payment')}
    ${moneyModal('expense-form', 'Add expense', view, `
      <div class="grid two">
        ${field('Date', `<input type="date" name="date" value="${esc(view.today)}">`)}
        ${field('Branch', `<select name="branch">${options(BRANCHES, 'San Pablo')}</select>`)}
      </div>
      ${field('Category (Meta/ad money goes in Finance → Ad spend log)', `<select name="category">${options(EXPENSE_CATS, 'Parts')}</select>`)}
      ${field('Amount (₱) *', '<input name="amount" inputmode="decimal" required>')}
      ${field('Note — what was it for *', '<input name="note" required>')}
      <div class="grid two">
        ${field('Linked JO number (optional)', '<input name="jobId">')}
        ${field('Spent by', '<select name="spentBy"><option>Owner</option><option>Shop</option></select>')}
      </div>
    `, 'add-expense')}
  </section>`;
}

function financeCell(view, label, cavite, pablo, total, extra) {
  return `<tr><td>${label}${extra || ''}</td><td>${cavite}</td><td>${pablo}</td><td>${total}</td></tr>`;
}

function budgetRow(view, key) {
  return (view.adBudget && view.adBudget.groups && view.adBudget.groups[key]) || { collected: 0, costs: 0, profit: 0, jobs: 0, adSpend: 0 };
}

function adBudgetFunnel(view) {
  const order = [['Cavite', 'Cavite'], ['San Pablo', 'San Pablo'], ['Boosted posts', 'Boosted posts'], ['Untraced', 'Untraced (no ad)']];
  const total = (view.adBudget && view.adBudget.total) || { collected: 0, costs: 0, profit: 0, jobs: 0, adSpend: 0 };
  const cells = (pick) => order.map(([key]) => {
    const cls = key === 'Untraced' ? ' class="cream"' : '';
    return `<td${cls} data-budget="${esc(key)}">${pick(budgetRow(view, key))}</td>`;
  }).join('') + `<td>${pick(total)}</td>`;
  const count = view.adBudget ? view.adBudget.untraced : 0;
  return `<div class="table-wrap"><table class="funnel" data-group="ad-budget">
    <tr><td></td><td>Cavite <span class="subline">Cavite ads</span></td><td>San Pablo <span class="subline">Laguna + Batangas</span></td><td>Boosted posts <span class="subline">Not on either branch</span></td><td class="cream">Untraced (no ad)</td><td>Total</td></tr>
    <tr><td>Ad spend</td>${cells((row) => peso(row.adSpend))}</tr>
    <tr><td>Collected</td>${cells((row) => peso(row.collected))}</tr>
    <tr><td>Costs</td>${cells((row) => peso(row.costs))}</tr>
    <tr class="mint"><td>Profit</td>${cells((row) => peso(row.profit))}</tr>
    <tr><td>Jobs</td>${cells((row) => num(row.jobs))}</tr>
  </table></div>${untracedLink(view, count)}`;
}

function untracedLink(view, count) {
  const n = Number(count) || 0;
  return `<p class="callout" data-untraced="${esc(n)}"><a href="${href(view, { tab: 'jobs', status: 'untraced' })}">${n} job${n === 1 ? '' : 's'} not traced to an ad — tag them</a></p>`;
}

function crossBudget(view) {
  const cross = (view.adBudget && view.adBudget.cross) || {};
  const budgets = [['Cavite', 'Cavite'], ['San Pablo', 'San Pablo'], ['Boosted posts', 'Boosted posts'], ['Untraced', 'Untraced (no ad)']];
  const shops = ['Cavite', 'San Pablo'];
  const rows = budgets.map(([key, label]) => {
    const values = shops.map((shop) => (cross[key] && cross[key][shop]) || { jobs: 0, collected: 0 });
    const jobs = values.reduce((sum, row) => sum + row.jobs, 0);
    const collected = values.reduce((sum, row) => sum + row.collected, 0);
    const tds = shops.map((shop) => {
      const row = (cross[key] && cross[key][shop]) || { jobs: 0, collected: 0 };
      const cls = key === 'Untraced' ? ' class="cream"' : '';
      return `<td${cls}>${row.jobs} job${row.jobs === 1 ? '' : 's'} / ${peso(row.collected)}</td>`;
    }).join('');
    return `<tr><td>${esc(label)}</td>${tds}<td>${jobs} job${jobs === 1 ? '' : 's'} / ${peso(collected)}</td></tr>`;
  }).join('');
  return `<section class="card"><h2>Cross-branch: ad budget × branch that did the job</h2>
    <div class="table-wrap"><table class="table"><thead><tr><th>Ad budget</th><th>Cavite branch</th><th>San Pablo branch</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function financeTab(view) {
  const f = view.finance;
  const by = view.financeByBranch || { Cavite: f, 'San Pablo': f };
  const c = by.Cavite || f;
  const s = by['San Pablo'] || f;
  const title = monthTitle(view.money.range, view.today);
  const range = view.money.range;
  const rangeText = range ? `${shortDate(range.start)} – ${shortDate(range.end)}` : 'All time';
  const show = (branch, value) => (view.branch === 'ALL' || view.branch === branch ? value : '—');
  const both = (pick) => {
    const cv = view.branch === 'San Pablo' ? null : pick(c);
    const sp = view.branch === 'Cavite' ? null : pick(s);
    const total = (cv || 0) + (sp || 0);
    return [cv == null ? '—' : pick(c), sp == null ? '—' : pick(s), view.branch === 'ALL' ? pick(f) : total];
  };
  const moneyText = (n) => (n === '—' ? '—' : peso(n));
  const countText = (n) => (n === '—' || n === null || n === undefined ? '—' : num(n));
  const [cSpend, sSpend, tSpend] = both((row) => row.adSpend);
  const [cChats, sChats, tChats] = both((row) => row.chats);
  const [cBook, sBook, tBook] = both((row) => row.bookings);
  const [cIn, sIn, tIn] = both((row) => row.collected);
  const [cOther, sOther, tOther] = both((row) => row.otherIncome);
  const margin = Number(f.collected) ? Math.round((Number(view.money.profit) / Number(f.collected)) * 100) : 0;
  const expenseOf = (branchName) => {
    if (view.branch !== 'ALL' && view.branch !== branchName) return null;
    return (view.money.expenses || [])
      .filter((row) => view.branch !== 'ALL' || row.branch === branchName)
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  };
  const cExp = expenseOf('Cavite');
  const sExp = expenseOf('San Pablo');
  const tExp = (cExp || 0) + (sExp || 0);
  const profitCell = (branchName, value) => (view.branch === 'ALL' || view.branch === branchName ? peso(value) : '—');
  const ads = f.ads.map((a) => `<tr>
    <td>${esc(shortDate(a.start))} – ${esc(shortDate(a.end))}</td><td>${esc(a.branch)}</td><td>${peso(a.amount)}</td><td>${esc(a.chats)}</td><td>${a.chats ? peso(Number(a.amount) / Number(a.chats)) : '—'}</td><td>${esc(a.note)}</td>
    <td><form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="delete-ad">
      <input type="hidden" name="start" value="${esc(a.start)}"><input type="hidden" name="end" value="${esc(a.end)}">
      <input type="hidden" name="branch" value="${esc(a.branch)}"><input type="hidden" name="amount" value="${esc(a.amount)}"><input type="hidden" name="note" value="${esc(a.note)}">
      <button class="text-btn danger" type="submit">Delete</button></form></td>
  </tr>`).join('');
  const areas = new Map();
  const areaKey = (job) => {
    if (job && job.ad) return job.ad;
    if (job && job.adArea) return job.adArea;
    return 'Untraced (no ad)';
  };
  for (const job of view.jobs) {
    const key = areaKey(job);
    const row = areas.get(key) || { jobs: 0, done: 0, cancelled: 0, collected: 0, budget: adBudgetOf(job) || 'Untraced (no ad)' };
    row.jobs += 1;
    if (job.status === 'Completed') row.done += 1;
    if (job.status === 'Cancelled') row.cancelled += 1;
    areas.set(key, row);
  }
  for (const pay of view.money.payments) {
    const job = view.jobs.find((j) => j.id === pay.jobId);
    const key = areaKey(job);
    const row = areas.get(key) || { jobs: 0, done: 0, cancelled: 0, collected: 0, budget: adBudgetOf(job) || 'Untraced (no ad)' };
    row.collected += Number(pay.amount || 0);
    areas.set(key, row);
  }
  const adRows = [...areas.entries()].map(([name, row]) => `<tr class="${name === 'Untraced (no ad)' ? 'cream' : ''}"><td>${esc(name)}</td><td>${esc(row.budget)}</td><td>${row.jobs}</td><td>${row.done}</td><td>${row.cancelled}</td><td>${peso(row.collected)}</td></tr>`).join('');
  const checks = [];
  for (const job of view.jobs) {
    const pays = view.money.payments.filter((p) => p.jobId === job.id);
    const paid = pays.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const price = Number(job.price || 0) + Number(job.travelFee || 0);
    if (price && paid - price > 0.5) checks.push(`<li class="row-between"><div><b>${esc(job.id)} · ${esc(job.customerName)}</b><div class="meta">Paid ${peso(paid)} is more than the price ${peso(price)}</div></div><span class="pill pink">● Check</span></li>`);
  }
  for (const group of view.attention.dupes) {
    const row = group[0];
    checks.push(`<li class="row-between"><div><b>${esc(row.jobId)} · ${esc(row.customerName || 'Customer')}</b><div class="meta">${group.length} payments of ${peso(row.amount)} on ${esc(row.date)}</div></div><span class="pill pink">● Check</span></li>`);
  }
  const income = (f.incomeRows || []).map((row) => `<li class="row-between"><span>${esc(shortDate(row.date))} · ${esc(row.branch)} · ${esc(row.note)}</span><span>${peso(row.amount)} <form style="display:inline" method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="delete-income"><input type="hidden" name="date" value="${esc(row.date)}"><input type="hidden" name="branch" value="${esc(row.branch)}"><input type="hidden" name="amount" value="${esc(row.amount)}"><input type="hidden" name="note" value="${esc(row.note)}"><button class="text-btn danger" type="submit">Delete</button></form></span></li>`).join('');
  return `<section>
    <div class="page-head"><h1>Finance flow</h1><span class="meta">This month to date · ${esc(rangeText)}</span></div>
    <nav class="chips">${periodChips(view, 'finance')}</nav>
    <p class="eyebrow">Group by</p>
    <nav class="chips">
      <a class="${view.group === 'ad' ? '' : 'on'}" href="${href(view, { tab: 'finance', group: 'branch' })}">Profit by branch that did the job</a>
      <a class="${view.group === 'ad' ? 'on' : ''}" href="${href(view, { tab: 'finance', group: 'ad' })}">Profit by ad budget</a>
    </nav>
    ${view.group === 'ad' ? adBudgetFunnel(view) : ''}
    <div class="table-wrap"${view.group === 'ad' ? ' hidden' : ''}>
    <table class="funnel">
      ${financeCell(view, 'Ad spend', moneyText(show('Cavite', cSpend)), moneyText(show('San Pablo', sSpend)), moneyText(tSpend))}
      <tr><td>Chats <span class="subline">Cost per chat</span></td><td data-kpi="chats">${countText(cChats)}<span class="subline">${c.costPerChat == null ? '—' : peso(c.costPerChat)}</span></td><td>${countText(sChats)}<span class="subline">${s.costPerChat == null ? '—' : peso(s.costPerChat)}</span></td><td>${countText(tChats)}</td></tr>
      <tr><td>Bookings <span class="subline">From Facebook</span><span class="subline">Cost per booking</span><span class="subline">Booking rate</span></td>
        <td data-kpi="cost-per-booking">${countText(cBook)}<span class="subline">${c.costPerBooking == null ? '—' : peso(c.costPerBooking)}</span><span class="subline" data-kpi="booking-rate">${pct(c.bookingRate)}</span></td>
        <td>${countText(sBook)}<span class="subline">${s.costPerBooking == null ? '—' : peso(s.costPerBooking)}</span><span class="subline">${pct(s.bookingRate)}</span></td>
        <td data-kpi="roas">${countText(tBook)}<span class="subline">${f.roas == null ? '—' : num(f.roas)}</span></td></tr>
      <tr><td>Money collected</td><td>${moneyText(show('Cavite', cIn))}</td><td>${moneyText(show('San Pablo', sIn))}</td><td>${moneyText(tIn)}</td></tr>
      <tr><td>Expenses</td><td>${cExp == null ? '—' : `− ${peso(cExp)}`}</td><td>${sExp == null ? '—' : `− ${peso(sExp)}`}</td><td>− ${peso(tExp)}</td></tr>
      <tr><td>Other income <span class="subline" data-kpi="other-income">Kept from cancelled jobs</span></td><td>+ ${moneyText(show('Cavite', cOther))}</td><td>+ ${moneyText(show('San Pablo', sOther))}</td><td>+ ${moneyText(tOther)}</td></tr>
      <tr class="mint"><td>Real profit <span class="subline">Profit margin</span></td><td>${profitCell('Cavite', view.money.perBranch.Cavite.profit)}</td><td>${profitCell('San Pablo', view.money.perBranch['San Pablo'].profit)}</td><td>${peso(view.money.profit)} <span class="subline">${margin}%</span></td></tr>
    </table></div>
    ${view.group === 'ad' ? '' : untracedLink(view, view.adBudget ? view.adBudget.untraced : 0)}
    ${(view.money.expenses || []).length ? '' : '<p class="callout">No expenses recorded for this period, so profit is too high until they are entered (Money tab → + Add expense).</p>'}
    <details class="card"><summary>How these numbers are counted</summary><p class="explain">Ad spend and chats come from the ad spend log. Bookings are schedule forms that were not dismissed. Money collected is payments in the period. Real profit is collections minus ad spend, expenses, and parts cost. Profit by ad budget uses the ad area on each job: LAGUNA and BATANGAS count on the San Pablo budget, and CAVITE, including Cavite Page ad, counts on the Cavite budget. Boosted posts is a separate budget and is not counted on either branch. Jobs with no matching ad stay in Untraced (no ad).</p></details>
    ${crossBudget(view)}
    <section class="card">
      <h2>Profit by ad</h2>
      <div class="table-wrap"><table class="table"><thead><tr><th>Which ad brought them</th><th>Ad budget</th><th>Jobs</th><th>Completed</th><th>Cancelled</th><th>Collected</th></tr></thead><tbody>${adRows}</tbody></table></div>
    </section>
    <section class="card">
      <header><h2>Ad spend log</h2><button class="btn green" type="button" data-open="ad-form">+ Add ad spend</button></header>
      <p><a class="ghost" href="/ops/export?kind=finance&amp;branch=${esc(view.branchLabel)}&amp;period=${esc(view.period)}">⤓ Export CSV</a></p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Period</th><th>Branch</th><th>Amount</th><th>Chats</th><th>Cost/chat</th><th>Note</th><th></th></tr></thead><tbody>${ads}</tbody></table></div>
    </section>
    <section class="card">
      <header><h2>Other income</h2><button class="btn green" type="button" data-open="income-form">+ Add income</button></header>
      ${income || '<p class="empty">Nothing logged yet.</p>'}
      <p class="explain">Income that is not a repair payment. Cavite's other income stays with Cavite.</p>
    </section>
    <section class="card">
      <header><h2>Payment check</h2>${checks.length ? `<span class="pill pink">● ${checks.length} to check</span>` : ''}</header>
      ${checks.length ? `<ul>${checks.join('')}</ul>` : '<p class="empty">None.</p>'}
      <p class="explain">Flags jobs paid more than their price, or two or more payments of the same amount on the same day.</p>
    </section>
    ${moneyModal('ad-form', 'Add ad spend', view, `
      <div class="grid two">
        ${field('Period start *', `<input type="date" name="start" value="${esc(view.today)}" required>`)}
        ${field('Period end *', `<input type="date" name="end" value="${esc(view.today)}" required>`)}
      </div>
      ${field('Branch / ad budget', `<select name="branch">${options([...BRANCHES, 'Boosted posts'], 'San Pablo')}</select>`)}
      ${field('Amount spent (₱) *', '<input name="amount" inputmode="decimal" required>')}
      ${field('Chats (messaging conversations)', '<input name="chats" inputmode="numeric">')}
      ${field('Note', '<input name="note" placeholder="e.g. JUNE MESSAGING (Laguna) + Sony 65 post">')}
    `, 'add-ad')}
    ${moneyModal('income-form', 'Add income', view, `
      ${field('Date', `<input type="date" name="date" value="${esc(view.today)}">`)}
      ${field('Branch', `<select name="branch">${options(BRANCHES, 'San Pablo')}</select>`)}
      ${field('Amount (₱) *', '<input name="amount" inputmode="decimal" required>')}
      ${field('Note', '<input name="note">')}
    `, 'add-income')}
  </section>`;
}

function partsTab(view) {
  const value = view.parts.reduce((sum, p) => sum + Number(p.cost || 0) * Number(p.stock || 0), 0);
  const rows = view.parts.map((p) => {
    const stock = Number(p.stock) || 0;
    const reorder = p.reorder || stock <= Number(p.reorderAt || 0);
    const keep = `${hidden(view)}<input type="hidden" name="action" value="update-part"><input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="name" value="${esc(p.name)}"><input type="hidden" name="branch" value="${esc(p.branch)}"><input type="hidden" name="cost" value="${esc(p.cost)}"><input type="hidden" name="fits" value="${esc(p.fits || '')}"><input type="hidden" name="reorderAt" value="${esc(p.reorderAt || 0)}"><input type="hidden" name="sellPrice" value="${esc(p.sellPrice || '')}">`;
    return `<tr data-part="${esc(p.id)}">
      <td><span class="pill outline">${esc(p.name)}</span>${p.fits ? `<div class="meta">${esc(p.fits)}</div>` : ''}</td>
      <td>${esc(p.branch)}</td>
      <td>${peso(p.cost)}</td>
      <td><div class="stepper">
        <form method="post" action="/ops/action">${keep}<input type="hidden" name="stock" value="${Math.max(0, stock - 1)}"><button type="submit" aria-label="Decrease">−</button></form>
        <span>${esc(stock)}</span>
        <form method="post" action="/ops/action">${keep}<input type="hidden" name="stock" value="${stock + 1}"><button type="submit" aria-label="Increase">+</button></form>
      </div>${reorder ? '<div><span class="pill pink">● Reorder</span></div>' : ''}</td>
    </tr>`;
  }).join('');
  return `<section>
    <div class="page-head"><h1>Parts &amp; stock</h1><button class="btn green" type="button" data-open="part-form">+ Add part</button></div>
    <section class="card">
      <header><span>${view.parts.length} item${view.parts.length === 1 ? '' : 's'}</span><b>Stock value at cost: ${peso(value)}</b></header>
      <table class="table"><thead><tr><th>Part</th><th>Branch</th><th>Price</th><th>In stock</th></tr></thead><tbody>${rows}</tbody></table>
    </section>
    ${moneyModal('part-form', 'Add part', view, `
      ${field('Part name *', '<input name="name" required>')}
      ${field('Fits / used for', '<input name="fits" placeholder="e.g. LED TV backlight 32&quot;">')}
      <div class="grid two">
        ${field('Branch', `<select name="branch">${options(BRANCHES, 'San Pablo')}</select>`)}
        ${field('In stock', '<input name="stock" inputmode="numeric" value="0">')}
      </div>
      <div class="grid two">
        ${field('Reorder when at or below', '<input name="reorderAt" inputmode="numeric" value="2">')}
        ${field('Cost each (₱)', '<input name="cost" inputmode="decimal">')}
      </div>
      ${field('Selling price (₱)', '<input name="sellPrice" inputmode="decimal">')}
    `, 'add-part')}
  </section>`;
}

function opsPage(view) {
  const body = {
    today: todayTab,
    jobs: jobsTab,
    customers: customersTab,
    money: moneyTab,
    finance: financeTab,
    parts: partsTab,
  }[view.tab] || todayTab;
  return shell(`${header(view)}<main><div class="wrap">${body(view)}</div></main>${dock(view)}${fabs(view)}`);
}

module.exports = { opsPage, esc };
