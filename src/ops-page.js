'use strict';
// Server-rendered JMAG's Operations page. Same login as the video dashboard.
const { STATUSES, TECHS, BRANCHES, PAY_TYPES, METHODS, branchLabel } = require('./ops');

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

function href(view, extra) {
  const q = new URLSearchParams();
  q.set('tab', extra.tab || view.tab || 'today');
  q.set('branch', branchLabel(extra.branch || view.branch || 'ALL'));
  if ((extra.period || view.period) && (extra.tab || view.tab) !== 'today') q.set('period', extra.period || view.period);
  if (extra.status) q.set('status', extra.status);
  if (extra.edit) q.set('edit', extra.edit);
  return `/ops?${q.toString()}`;
}

function shell(body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#10243f">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="JMAG Ops">
  <title>JMAG's Operations</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/icon-192.png" type="image/png">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="stylesheet" href="/ops.css">
</head>
<body>
${body}
<script src="/ops.js"></script>
</body>
</html>`;
}

function hidden(view) {
  return `<input type="hidden" name="returnBranch" value="${esc(branchLabel(view.branch))}"><input type="hidden" name="returnTab" value="${esc(view.tab)}"><input type="hidden" name="returnPeriod" value="${esc(view.period)}">`;
}

function options(list, selected) {
  return list.map((item) => `<option${item === selected ? ' selected' : ''}>${esc(item)}</option>`).join('');
}

function chips(view) {
  const branches = ['ALL', 'SAN PABLO', 'CAVITE'].map((label) => {
    const on = label === view.branchLabel ? ' on' : '';
    return `<a class="${on.trim()}" href="${href(view, { branch: label === 'SAN PABLO' ? 'San Pablo' : label === 'CAVITE' ? 'Cavite' : 'ALL' })}">${label}</a>`;
  }).join('');
  const tabs = [
    ['today', 'Today'], ['jobs', 'Jobs'], ['customers', 'Customers'],
    ['money', 'Money'], ['finance', 'Finance'], ['parts', 'Parts'],
  ].map(([id, label]) => `<a class="${view.tab === id ? 'on' : ''}" href="${href(view, { tab: id })}">${label}</a>`).join('');
  return `<nav class="chips" aria-label="Branch">${branches}</nav>
<nav class="chips" aria-label="Sections">${tabs}</nav>`;
}

function header(view) {
  return `<header>
  <h1>JMAG's Operations</h1>
  <p class="lede"><a href="/dashboard">Videos</a> · ${esc(view.today)} · ${esc(view.branchLabel)}</p>
  ${chips(view)}
</header>`;
}

function kpi(label, value, key) {
  return `<div class="kpi" data-kpi="${esc(key)}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
}

function jobLine(job) {
  return `${esc(job.id)} · ${esc(job.customerName)} · ${esc(job.city || job.branch || '')}`;
}

function todayTab(view) {
  const k = view.kpis;
  const bookings = view.bookings.length
    ? view.bookings.map((b) => `<article class="card">
        <h2>${esc(b.name)}</h2>
        <p>${esc(b.branch)} · ${esc(b.unitType || 'TV')} ${esc(b.brand)} ${esc(b.size)}</p>
        <p>${esc(b.city)} ${esc(b.address)} ${esc(b.landmark)}</p>
        <p>${esc(b.issue)} · ${peso(b.price)} · ${esc(b.visitDate)} ${esc(b.visitTime)}</p>
        <div class="row">
          <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="convert-booking"><input type="hidden" name="id" value="${esc(b.id)}"><button type="submit">Create job</button></form>
          <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="dismiss-booking"><input type="hidden" name="id" value="${esc(b.id)}"><button class="ghost" type="submit">Dismiss</button></form>
        </div>
      </article>`).join('')
    : '<p class="empty">No new bookings.</p>';
  const visit = (rows) => rows.length
    ? `<ul>${rows.map((j) => `<li>${jobLine(j)} · ${esc(j.visitTime)} · ${esc(j.technician)} · ${esc(j.status)}</li>`).join('')}</ul>`
    : '<p class="empty">None.</p>';
  const max = Math.max(1, ...view.chart.map((d) => d.amount));
  const chart = `<div class="chart" role="img" aria-label="Collections, last 14 days">${view.chart.map((d) => `<div class="bar" data-date="${esc(d.date)}" data-amount="${esc(d.amount)}"><span style="height:${Math.max(2, Math.round((d.amount / max) * 100))}%"></span><small>${esc(d.date.slice(5))}</small></div>`).join('')}</div>`;
  const past = view.attention.past.map((j) => `<li>${jobLine(j)} · visit ${esc(j.visitDate)} · ${esc(j.status)}</li>`).join('');
  const bal = view.attention.balance.map((j) => `<li>${jobLine(j)} · balance ${peso(j.balance)}</li>`).join('');
  const dupes = view.attention.dupes.map((group) => `<li>${esc(group[0].jobId)} · ${esc(group[0].date)} · ${peso(group[0].amount)} · ${esc(group[0].type)} × ${group.length}</li>`).join('');
  const texts = view.needsText.map((row) => `<li data-needs="text">${esc(row.jobId)} · ${esc(row.customerName)} · ${esc(row.phone)}</li>`).join('');
  const load = view.techLoad.map((row) => `<li>${esc(row.tech)} · ${row.open} open · ${row.visits} today</li>`).join('');
  const reorder = view.reorder.map((p) => `<li>${esc(p.name)} · ${esc(p.branch)} · stock ${esc(p.stock)}</li>`).join('');
  const daily = view.dailyOn ? '' : '<p class="note" id="daily-flag">Daily status updates are off.</p>';
  return `<section>
    ${daily}
    <div class="kpis">
      ${kpi('Open jobs', k.open, 'open')}
      ${kpi('Under repair', k.underRepair, 'under-repair')}
      ${kpi('Visits today', k.visitsToday, 'visits-today')}
      ${kpi('Collected today', peso(k.collectedToday), 'collected-today')}
      ${kpi('Collected this month', peso(k.collectedMonth), 'collected-month')}
      ${kpi('Profit this month', peso(k.profitMonth), 'profit-month')}
      ${kpi('Low stock', k.lowStock, 'low-stock')}
    </div>
    <h2>New bookings</h2>
    ${bookings}
    <h2>Today's visits</h2>${visit(view.visitsToday)}
    <h2>Tomorrow's visits</h2>${visit(view.visitsTomorrow)}
    <h2>Collections, 14 days</h2>${chart}
    <h2>Needs attention</h2>
    <h3>Past visit, no status update</h3>${past ? `<ul>${past}</ul>` : '<p class="empty">None.</p>'}
    <h3>Completed with balance</h3>${bal ? `<ul>${bal}</ul>` : '<p class="empty">None.</p>'}
    <h3>Possible duplicate payments</h3>${dupes ? `<ul>${dupes}</ul>` : '<p class="empty">None.</p>'}
    <h3>Needs text update</h3>${texts ? `<ul>${texts}</ul>` : '<p class="empty">None.</p>'}
    <h2>Technician load</h2><ul>${load}</ul>
    <h2>Reorder soon</h2>${reorder ? `<ul>${reorder}</ul>` : '<p class="empty">None.</p>'}
  </section>`;
}

function jobFields(job, view) {
  const j = job || {};
  const reviews = view.reviews || [];
  const linked = j.psid ? `Linked ••${esc(String(j.psid).slice(-4))}` : 'Not linked';
  const chatOptions = [`<option value="">Not linked</option>`].concat(reviews.slice(0, 40).map((r) => {
    const selected = j.psid && r.psid === j.psid ? ' selected' : '';
    const label = `${r.customerName || 'Customer'} ••${r.psidLast4 || String(r.psid || '').slice(-4)}`;
    return `<option value="${esc(r.id)}"${selected}>${esc(label)}</option>`;
  })).join('');
  return `<label>Customer<input name="customerName" value="${esc(j.customerName || '')}" required></label>
    <label>Phone<input name="phone" value="${esc(j.phone || '')}"></label>
    <label>City<input name="city" value="${esc(j.city || '')}"></label>
    <label>Address<input name="address" value="${esc(j.address || '')}"></label>
    <label>Landmark<input name="landmark" value="${esc(j.landmark || '')}"></label>
    <label>Map link<input name="mapLink" value="${esc(j.mapLink || '')}"></label>
    <label>Unit type<input name="unitType" value="${esc(j.unitType || 'TV')}"></label>
    <label>Brand<input name="brand" value="${esc(j.brand || '')}"></label>
    <label>Size<input name="size" value="${esc(j.size || '')}"></label>
    <label>Issue<input name="issue" value="${esc(j.issue || '')}"></label>
    <label>Date received<input type="date" name="date" value="${esc(j.date || view.today)}"></label>
    <label>Visit date<input type="date" name="visitDate" value="${esc(j.visitDate || '')}"></label>
    <label>Visit time<input name="visitTime" value="${esc(j.visitTime || '')}"></label>
    <label>Technician<select name="technician">${options(TECHS, j.technician || 'Unassigned')}</select></label>
    <label>Branch<select name="branch">${options(BRANCHES, j.branch || 'San Pablo')}</select></label>
    <label>Ad area<input name="adArea" value="${esc(j.adArea || '')}"></label>
    <label>Price<input name="price" inputmode="decimal" value="${esc(j.price || '')}"></label>
    <label>Travel fee<input name="travelFee" inputmode="decimal" value="${esc(j.travelFee || '')}"></label>
    <label>Status<select name="status">${options(STATUSES, j.status || 'Inquiry')}</select></label>
    <label>Status note for customer<textarea name="statusNote" rows="2">${esc(j.statusNote || '')}</textarea></label>
    <label>Notes<textarea name="notes" rows="2">${esc(j.notes || '')}</textarea></label>
    <label>Parts used<input name="partsUsed" value="${esc(j.partsUsed || '')}"></label>
    <label>Parts cost<input name="partsCost" inputmode="decimal" value="${esc(j.partsCost || '')}"></label>
    ${j.id ? `<p class="meta">Messenger chat: <span data-messenger="${esc(linked)}">${linked}</span></p>
      <label>Messenger chat<select name="review">${chatOptions}</select></label>
      <input type="hidden" name="link" value="1">` : ''}`;
}

function jobsTab(view) {
  const filters = ['', ...STATUSES].map((status) => {
    const label = status || 'All';
    const on = (view.statusFilter || '') === status ? ' on' : '';
    return `<a class="${on.trim()}" href="${href(view, { tab: 'jobs', status })}">${esc(label)}</a>`;
  }).join('');
  const cards = view.jobs.map((j) => `<article class="card" data-job="${esc(j.id)}">
      <h2>${esc(j.id)}</h2>
      <p>${esc(j.customerName)} · ${esc(j.phone)}</p>
      <p>${esc(j.city)} · ${esc(j.address)} ${j.landmark ? `· ${esc(j.landmark)}` : ''} ${j.mapLink ? `· <a href="${esc(j.mapLink)}">Map</a>` : ''}</p>
      <p>${esc(j.unitType)} ${esc(j.brand)} ${esc(j.size)} · ${esc(j.issue)}</p>
      <p>${esc(j.visitDate)} ${esc(j.visitTime)} · ${esc(j.technician)} · ${esc(j.branch)} · ${esc(j.adArea)}</p>
      <p>${peso(j.price)} · balance ${peso(j.balance)} · warranty ${esc(j.warrantyEnd)}</p>
      <p class="pill">${esc(j.status)}</p>
      ${j.statusNote ? `<p class="meta">${esc(j.statusNote)}</p>` : ''}
      <div class="row">
        <a class="ghost" href="${href(view, { tab: 'jobs', edit: j.id })}">Edit</a>
        <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="done"><input type="hidden" name="id" value="${esc(j.id)}"><button type="submit">Job done</button></form>
        <form method="post" action="/ops/action" data-confirm="Delete ${esc(j.id)}?">${hidden(view)}<input type="hidden" name="action" value="delete-job"><input type="hidden" name="id" value="${esc(j.id)}"><button class="ghost" type="submit">Delete</button></form>
      </div>
      <form method="post" action="/ops/action" class="row">${hidden(view)}<input type="hidden" name="action" value="status"><input type="hidden" name="id" value="${esc(j.id)}">
        <select name="status">${options(STATUSES, j.status)}</select><button type="submit">Update status</button>
      </form>
    </article>`).join('');
  const editing = view.editing;
  const form = editing
    ? `<form method="post" action="/ops/action" class="card"><h2>Edit ${esc(editing.id)}</h2>${hidden(view)}<input type="hidden" name="action" value="update-job"><input type="hidden" name="id" value="${esc(editing.id)}">${jobFields(editing, view)}<div class="row"><button type="submit">Save job</button></div></form>`
    : `<details class="card"><summary>Add job</summary><form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="create-job">${jobFields(null, view)}<div class="row"><button type="submit">Save job</button></div></form></details>`;
  return `<section>
    <p><a href="/ops/export?kind=jobs&amp;branch=${esc(view.branchLabel)}">Export CSV</a></p>
    <nav class="chips">${filters}</nav>
    ${form}
    ${cards || '<p class="empty">No jobs.</p>'}
  </section>`;
}

function customersTab(view) {
  const rows = view.customers.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td>${esc(c.jobs)}</td><td>${peso(c.paid)}</td></tr>`).join('');
  return `<section><table><thead><tr><th>Name</th><th>Phone</th><th>Address</th><th>Jobs</th><th>Total paid</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function moneyTab(view) {
  const m = view.money;
  const periods = [['month', 'This month'], ['last', 'Last month'], ['all', 'All time']].map(([id, label]) => `<a class="${view.period === id ? 'on' : ''}" href="${href(view, { tab: 'money', period: id })}">${label}</a>`).join('');
  const list = (obj) => Object.entries(obj).map(([k, v]) => `<li>${esc(k)} · ${peso(v)}</li>`).join('') || '<li>None</li>';
  const pays = m.payments.map((p) => `<li>${esc(p.date)} · ${esc(p.customerName)} · ${esc(p.type)} · ${esc(p.method)} · ${esc(p.branch)} · ${peso(p.amount)}</li>`).join('');
  const expenses = m.expenses.map((e) => `<li>${esc(e.date)} · ${esc(e.branch)} · ${peso(e.amount)} · ${esc(e.note)}</li>`).join('');
  const branches = ['San Pablo', 'Cavite'].map((name) => {
    const row = m.perBranch[name];
    return `<li data-branch-profit="${esc(name)}">${esc(name)} · in ${peso(row.collected)} · costs ${peso(row.costs)} · profit ${peso(row.profit)}</li>`;
  }).join('');
  const unpaid = m.unpaid.map((j) => `<li>${esc(j.id)} · ${esc(j.customerName)} · ${peso(j.balance)}</li>`).join('');
  return `<section>
    <nav class="chips">${periods}</nav>
    <p><a href="/ops/export?kind=money&amp;branch=${esc(view.branchLabel)}&amp;period=${esc(view.period)}">Export CSV</a></p>
    <div class="kpis">
      ${kpi('Collected', peso(m.collected), 'money-in')}
      ${kpi('Costs', peso(m.costs), 'costs')}
      ${kpi('Profit', peso(m.profit), 'profit')}
      ${kpi('You keep', peso(m.youKeep), 'you-keep')}
    </div>
    <h2>By type</h2><ul>${list(m.byType)}</ul>
    <h2>By branch</h2><ul>${list(m.byBranch)}</ul>
    <h2>By method</h2><ul>${list(m.byMethod)}</ul>
    <h2>Real profit per branch</h2><ul>${branches}</ul>
    <p data-investor="cavite">Cavite investor 50%: ${peso(m.investor)}. You keep ${peso(m.perBranch.Cavite.profit - m.investor)} of Cavite.</p>
    <h2>Payments</h2>${pays ? `<ul>${pays}</ul>` : '<p class="empty">None.</p>'}
    <form method="post" action="/ops/action" class="card"><h3>Add payment</h3>${hidden(view)}<input type="hidden" name="action" value="add-payment">
      <label>Date<input type="date" name="date" value="${esc(view.today)}"></label>
      <label>JO number<input name="jobId"></label>
      <label>Customer<input name="customerName"></label>
      <label>Type<select name="type">${options(PAY_TYPES, 'Check-up fee')}</select></label>
      <label>Method<select name="method">${options(METHODS, 'Cash')}</select></label>
      <label>Branch<select name="branch">${options(BRANCHES, 'San Pablo')}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" required></label>
      <label>Note<input name="note"></label>
      <button type="submit">Save payment</button>
    </form>
    <h2>Expenses</h2>${expenses ? `<ul>${expenses}</ul>` : '<p class="empty">None.</p>'}
    <form method="post" action="/ops/action" class="card"><h3>Add expense</h3>${hidden(view)}<input type="hidden" name="action" value="add-expense">
      <label>Date<input type="date" name="date" value="${esc(view.today)}"></label>
      <label>Branch<select name="branch">${options(BRANCHES, 'San Pablo')}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" required></label>
      <label>Note<input name="note"></label>
      <button type="submit">Save expense</button>
    </form>
    <h2>Unpaid balances</h2><p data-unpaid="${esc(m.unpaidTotal)}">${peso(m.unpaidTotal)} · ${m.unpaid.length} jobs</p>${unpaid ? `<ul>${unpaid}</ul>` : ''}
  </section>`;
}

function financeTab(view) {
  const f = view.finance;
  const periods = [['month', 'This month'], ['last', 'Last month'], ['all', 'All time']].map(([id, label]) => `<a class="${view.period === id ? 'on' : ''}" href="${href(view, { tab: 'finance', period: id })}">${label}</a>`).join('');
  const ads = f.ads.map((a) => `<li>${esc(a.start)} – ${esc(a.end)} · ${esc(a.branch)} · ${peso(a.amount)} · ${esc(a.chats)} chats · ${esc(a.note)}</li>`).join('');
  return `<section>
    <nav class="chips">${periods}</nav>
    <p><a href="/ops/export?kind=finance&amp;branch=${esc(view.branchLabel)}&amp;period=${esc(view.period)}">Export CSV</a></p>
    <div class="kpis">
      ${kpi('Ad spend', peso(f.adSpend), 'ad-spend')}
      ${kpi('Chats', num(f.chats), 'chats')}
      ${kpi('Bookings', num(f.bookings), 'bookings')}
      ${kpi('Cost per booking', f.costPerBooking === null ? '—' : peso(f.costPerBooking), 'cost-per-booking')}
      ${kpi('Booking rate', f.bookingRate === null ? '—' : num(f.bookingRate), 'booking-rate')}
      ${kpi('ROAS', f.roas === null ? '—' : num(f.roas), 'roas')}
      ${kpi('Other income', peso(f.otherIncome), 'other-income')}
    </div>
    <h2>Ad spend log</h2>${ads ? `<ul>${ads}</ul>` : '<p class="empty">None.</p>'}
    <form method="post" action="/ops/action" class="card"><h3>Add ad spend</h3>${hidden(view)}<input type="hidden" name="action" value="add-ad">
      <label>Period start<input type="date" name="start" value="${esc(view.today)}"></label>
      <label>Period end<input type="date" name="end" value="${esc(view.today)}"></label>
      <label>Branch<select name="branch">${options(BRANCHES, 'San Pablo')}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" required></label>
      <label>Chats<input name="chats" inputmode="numeric"></label>
      <label>Note<input name="note"></label>
      <button type="submit">Save ad spend</button>
    </form>
    <form method="post" action="/ops/action" class="card"><h3>Other income</h3>${hidden(view)}<input type="hidden" name="action" value="add-income">
      <label>Date<input type="date" name="date" value="${esc(view.today)}"></label>
      <label>Branch<select name="branch">${options(BRANCHES, 'San Pablo')}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" required></label>
      <label>Note<input name="note"></label>
      <button type="submit">Save income</button>
    </form>
  </section>`;
}

function partsTab(view) {
  const rows = view.parts.map((p) => `<article class="card" data-part="${esc(p.id)}"><h2>${esc(p.name)}</h2><p>${esc(p.branch)} · cost ${peso(p.cost)} · stock ${esc(p.stock)} ${p.reorder ? '· Reorder' : ''}</p>
    <form method="post" action="/ops/action">${hidden(view)}<input type="hidden" name="action" value="update-part"><input type="hidden" name="id" value="${esc(p.id)}">
      <label>Stock<input name="stock" value="${esc(p.stock)}"></label>
      <input type="hidden" name="name" value="${esc(p.name)}">
      <input type="hidden" name="branch" value="${esc(p.branch)}">
      <input type="hidden" name="cost" value="${esc(p.cost)}">
      <label>Reorder<input type="checkbox" name="reorder" ${p.reorder ? 'checked' : ''}></label>
      <button type="submit">Save part</button>
    </form></article>`).join('');
  return `<section>
    ${rows || '<p class="empty">No parts.</p>'}
    <form method="post" action="/ops/action" class="card"><h2>Add part</h2>${hidden(view)}<input type="hidden" name="action" value="add-part">
      <label>Item<input name="name" required></label>
      <label>Branch<select name="branch">${options(BRANCHES, 'San Pablo')}</select></label>
      <label>Cost<input name="cost" inputmode="decimal"></label>
      <label>Stock<input name="stock" inputmode="numeric" value="0"></label>
      <label>Reorder<input type="checkbox" name="reorder"></label>
      <button type="submit">Save part</button>
    </form>
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
  return shell(`${header(view)}<main>${body(view)}</main>`);
}

module.exports = { opsPage, esc };
