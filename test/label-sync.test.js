'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { Bot } = require('../src/bot');
const { LabelSync, configured, metaLabelFor } = require('../src/label-sync');
const { buildView, DESK_MARKS } = require('../src/ops');
const { opsPage } = require('../src/ops-page');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-labelsync-'));
  return { store: new Store(dir), dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const quietLog = { info() {}, warn() {}, error() {} };

// A mocked Graph: never hits the network. labelsByPsid maps a PSID to the Messenger
// labels on it; addLabel/removeLabel record calls so a test can assert them.
function fakeGraph(labelsByPsid = {}) {
  return {
    calls: { add: [], remove: [] },
    async listUserLabels(psid) {
      return (labelsByPsid[String(psid)] || []).map((name, i) => ({ id: `L${i}`, name }));
    },
    async addLabel(psid, name) { this.calls.add.push({ psid: String(psid), name }); return {}; },
    async removeLabel(psid, name) { this.calls.remove.push({ psid: String(psid), name }); return {}; },
  };
}

test('configured() is off without a Page token and on with one', () => {
  assert.equal(configured({ labelSyncEnabled: true }), false);
  assert.equal(configured({ labelSyncEnabled: true, pageAccessToken: 'tok' }), true);
  assert.equal(configured({ labelSyncEnabled: true, pages: [{ token: 'tok' }] }), true);
  assert.equal(configured({ labelSyncEnabled: false, pageAccessToken: 'tok' }), false);
});

test('metaLabelFor maps followUp to BOOKED_LABEL and others to their metaLabel', () => {
  const hp = DESK_MARKS.find((m) => m.id === 'highPotential');
  const fu = DESK_MARKS.find((m) => m.id === 'followUp');
  assert.equal(metaLabelFor(hp, {}), 'High Potential');
  assert.equal(metaLabelFor(fu, { bookedLabel: 'Sunduin' }), 'Sunduin');
  assert.equal(metaLabelFor(fu, {}), 'Follow up');
});

test('reconcile sets a mark on when the Messenger label is present', async () => {
  const { store, dir } = freshStore();
  try {
    store.thread('100000000000001');
    const graph = fakeGraph({ 100000000000001: ['High Potential'] });
    const sync = new LabelSync({ cfg: {}, store, graph, log: quietLog, now: () => 1700000000000 });
    const res = await sync.run();
    assert.equal(res.changed, 1);
    assert.equal(store.data.threads['100000000000001'].marks.highPotential.on, true);
    assert.ok(store.data.lastLabelSyncAt, 'records lastLabelSyncAt');
  } finally {
    cleanup(dir);
  }
});

test('reconcile clears a mark when the Messenger label is absent (Messenger is authoritative)', async () => {
  const { store, dir } = freshStore();
  try {
    store.thread('200000000000002');
    store.setMark('200000000000002', 'highPotential', true, '', 1699999999000);
    // Messenger no longer has the label -> the mark must be cleared this cycle.
    const graph = fakeGraph({ 200000000000002: ['Qualified'] });
    const sync = new LabelSync({ cfg: {}, store, graph, log: quietLog, now: () => 1700000000000 });
    await sync.run();
    assert.equal(store.data.threads['200000000000002'].marks.highPotential, undefined);
    assert.equal(store.data.threads['200000000000002'].marks.qualified.on, true);
  } finally {
    cleanup(dir);
  }
});

test('reconcile skips threads idle beyond the lookback window', async () => {
  const { store, dir } = freshStore();
  try {
    const old = store.thread('300000000000003');
    old.lastUserTs = 1700000000000 - (40 * 86400000); // 40 days ago, outside 30-day lookback
    const graph = fakeGraph({ 300000000000003: ['High Potential'] });
    const sync = new LabelSync({ cfg: { labelSyncLookbackDays: 30 }, store, graph, log: quietLog, now: () => 1700000000000 });
    const res = await sync.run();
    assert.equal(res.considered, 0);
    const marks = store.data.threads['300000000000003'].marks || {};
    assert.ok(!marks.highPotential, 'idle thread left unmarked');
  } finally {
    cleanup(dir);
  }
});

test('clearing a dashboard mark calls graph.removeLabel (write-through to Messenger)', async () => {
  const { store, dir } = freshStore();
  try {
    store.thread('400000000000004');
    const graph = fakeGraph();
    const cfg = { bookedLabel: 'Follow up', pages: [] };
    const bot = new Bot({ cfg, store, graph, llm: {}, log: quietLog });

    await bot.syncMarkLabel('400000000000004', 'highPotential', true);
    assert.deepEqual(graph.calls.add, [{ psid: '400000000000004', name: 'High Potential' }]);

    await bot.syncMarkLabel('400000000000004', 'highPotential', false);
    assert.deepEqual(graph.calls.remove, [{ psid: '400000000000004', name: 'High Potential' }]);
  } finally {
    cleanup(dir);
  }
});

test('buildView surfaces a High-Potential thread in the headline Desk dataset and the page renders the line-up + legend', () => {
  const { store, dir } = freshStore();
  try {
    const t = store.thread('500000000000005');
    t.history = [{ role: 'user', content: 'My name is Maria Santos. 65 inch, interested, may budget', ts: 1000 }];
    t.lastUserTs = 1000;
    store.setMark('500000000000005', 'highPotential', true, '', 1700000000000);

    const view = buildView(store, { tab: 'desk', threads: store.data.threads, reviews: [], cfg: {}, now: 1700000600000 });
    assert.equal(view.desk.highPotential.length, 1);
    assert.equal(view.desk.highPotential[0].last4, '0005');
    assert.equal(view.desk.highPotential[0].name, 'Maria Santos');

    const html = opsPage(view);
    assert.match(html, /High Potential/);
    assert.match(html, /Maria Santos/);
    assert.match(html, /line-up/);
    // Count badge for the headline section.
    assert.match(html, /<span class="count">1<\/span> in the line-up/);
    // The legend shows every mark's label and colour, driven by DESK_MARKS.
    for (const mark of DESK_MARKS) {
      assert.ok(html.includes(mark.label), `legend/section shows ${mark.label}`);
      assert.ok(html.includes(mark.color), `legend/section shows colour ${mark.color}`);
    }
    assert.match(html, /mark-legend/);
    assert.match(html, /mirror your Messenger Page Inbox labels/);
  } finally {
    cleanup(dir);
  }
});
