'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { buildView, applyAction, DESK_MARKS } = require('../src/ops');
const { threadCardId } = require('../src/form-link-card');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-desk-'));
  return { store: new Store(dir), dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('DESK_MARKS leads with highPotential (amber), then qualified (green) and followUp (blue)', () => {
  assert.deepEqual(DESK_MARKS.map((m) => m.id), ['highPotential', 'qualified', 'followUp']);
  assert.equal(DESK_MARKS[0].color, '#e8a200');
  assert.equal(DESK_MARKS[1].color, '#2e9e4f');
  assert.equal(DESK_MARKS[2].color, '#3b82f6');
  // Each mark carries its exact Messenger label text.
  assert.deepEqual(DESK_MARKS.map((m) => m.metaLabel), ['High Potential', 'Qualified', 'Follow up']);
  // Visually distinct colours (no two marks share a colour).
  assert.equal(new Set(DESK_MARKS.map((m) => m.color)).size, DESK_MARKS.length);
});

test('setMark sets a mark, stores note/time, and clears it', () => {
  const { store, dir } = freshStore();
  try {
    store.thread('555000111222');
    const marked = store.setMark('555000111222', 'followUp', true, 'Tawagan bukas', 1700000000000);
    assert.equal(marked.marks.followUp.on, true);
    assert.equal(marked.marks.followUp.at, 1700000000000);
    assert.equal(marked.marks.followUp.note, 'Tawagan bukas');

    const cleared = store.setMark('555000111222', 'followUp', false);
    assert.equal(cleared.marks.followUp, undefined);
  } finally {
    cleanup(dir);
  }
});

test('a thread can carry more than one mark at once', () => {
  const { store, dir } = freshStore();
  try {
    store.thread('777000111222');
    store.setMark('777000111222', 'followUp', true, '', 1700000000000);
    store.setMark('777000111222', 'qualified', true, 'Has budget', 1700000001000);
    const t = store.data.threads['777000111222'];
    assert.equal(t.marks.followUp.on, true);
    assert.equal(t.marks.qualified.on, true);
    assert.equal(t.marks.qualified.note, 'Has budget');
  } finally {
    cleanup(dir);
  }
});

test('buildView surfaces each mark under its own Desk category and excludes unmarked threads', () => {
  const { store, dir } = freshStore();
  try {
    const a = store.thread('100000000000001');
    a.history = [{ role: 'user', content: 'My name is Juan Dela Cruz. 55 inch no display po', ts: 1000 }];
    a.lastUserTs = 1000;
    const b = store.thread('200000000000002');
    b.history = [{ role: 'user', content: 'May budget na po ako', ts: 2000 }];
    const c = store.thread('300000000000003');
    c.history = [{ role: 'user', content: 'Magkano po?', ts: 3000 }];

    store.setMark('100000000000001', 'followUp', true, 'Call after lunch', 1700000000000);
    store.setMark('200000000000002', 'qualified', true, '', 1700000002000);
    // thread c stays unmarked

    const view = buildView(store, { tab: 'desk', threads: store.data.threads, reviews: [], cfg: {}, now: 1700000600000 });
    assert.equal(view.desk.followUp.length, 1);
    assert.equal(view.desk.qualified.length, 1);

    const follow = view.desk.followUp[0];
    assert.equal(follow.last4, '0001');
    assert.equal(follow.name, 'Juan Dela Cruz');
    assert.equal(follow.note, 'Call after lunch');
    assert.equal(follow.cardId, threadCardId('100000000000001'));

    assert.equal(view.desk.qualified[0].last4, '0002');
    // thread c appears in neither category
    assert.ok(!view.desk.followUp.some((r) => r.last4 === '0003'));
    assert.ok(!view.desk.qualified.some((r) => r.last4 === '0003'));
  } finally {
    cleanup(dir);
  }
});

test('applyAction mark toggles a mark on and off via the card id', () => {
  const { store, dir } = freshStore();
  try {
    const t = store.thread('300000000000003');
    t.history = [{ role: 'user', content: 'sira po tv ko', ts: 1000 }];
    store.flushNow();
    const card = threadCardId('300000000000003');

    const on = applyAction(store, new URLSearchParams({ action: 'mark', card, mark: 'qualified', on: '1', note: 'Priority' }), 1700000000000);
    assert.equal(on.ok, true);
    assert.equal(on.mark, 'qualified');
    assert.equal(on.on, true);
    assert.equal(on.psid, '300000000000003');
    assert.equal(store.data.threads['300000000000003'].marks.qualified.on, true);
    assert.equal(store.data.threads['300000000000003'].marks.qualified.note, 'Priority');

    let view = buildView(store, { tab: 'desk', threads: store.data.threads, reviews: [], cfg: {}, now: 1700000600000 });
    assert.equal(view.desk.qualified.length, 1);

    const off = applyAction(store, new URLSearchParams({ action: 'mark', card, mark: 'qualified', on: '0' }), 1700000600000);
    assert.equal(off.ok, true);
    assert.equal(off.on, false);
    assert.equal(store.data.threads['300000000000003'].marks.qualified, undefined);

    view = buildView(store, { tab: 'desk', threads: store.data.threads, reviews: [], cfg: {}, now: 1700000600000 });
    assert.equal(view.desk.qualified.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('customer rows carry a card id and per-mark state for the chip buttons', () => {
  const { store, dir } = freshStore();
  try {
    const ops = store.data.ops = store.data.ops || {};
    ops.jobs = [{ id: 'JO-1', customerName: 'Ana Reyes', phone: '09170001122', branch: 'San Pablo', psid: '900000000000009', status: 'Inquiry' }];
    store.thread('900000000000009');
    store.setMark('900000000000009', 'followUp', true, '', 1700000000000);

    const view = buildView(store, { tab: 'customers', threads: store.data.threads, reviews: [], cfg: {}, now: 1700000600000 });
    const row = view.customers.find((c) => c.name === 'Ana Reyes');
    assert.ok(row, 'customer row present');
    assert.equal(row.cardId, threadCardId('900000000000009'));
    assert.equal(row.marks.followUp, true);
    assert.equal(row.marks.qualified, false);
  } finally {
    cleanup(dir);
  }
});

test('applyAction mark with an unknown mark id or unknown card fails cleanly', () => {
  const { store, dir } = freshStore();
  try {
    store.thread('300000000000003');
    const card = threadCardId('300000000000003');
    assert.equal(applyAction(store, new URLSearchParams({ action: 'mark', card, mark: 'nope', on: '1' }), Date.now()).ok, false);
    assert.equal(applyAction(store, new URLSearchParams({ action: 'mark', card: 'deadbeef', mark: 'followUp', on: '1' }), Date.now()).ok, false);
  } finally {
    cleanup(dir);
  }
});
