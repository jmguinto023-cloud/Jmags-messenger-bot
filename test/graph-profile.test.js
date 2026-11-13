'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Graph } = require('../src/graph');
const { withPage } = require('../src/pages');

const MAIN = '102622881557025';
const CAVITE = '1237499962773846';
function setup() {
  const warnings = [];
  const g = new Graph({ pageId: MAIN, pageAccessToken: 'test-token' }, {
    warn: (s) => warnings.push(String(s)),
  });
  return { g, warnings };
}

test('Main: profile lookup succeeds and is cached without exposing identifiers to logs', async () => {
  const { g, warnings } = setup();
  let direct = 0;
  g.call = async () => { direct++; return { name: 'Test Customer' }; };
  assert.equal(await g.userName('test-psid'), 'Test Customer');
  assert.equal(await g.userName('test-psid'), 'Test Customer');
  assert.equal(direct, 1);
  assert.equal(warnings.length, 0);
});

test('Main: 400 missing profile access falls back to conversation participant and coalesces concurrent lookups', async () => {
  const { g, warnings } = setup();
  let direct = 0; let fallback = 0;
  g.call = async () => { direct++; const e = new Error('sensitive Graph response'); e.status = 400; throw e; };
  g.findConversation = async (id) => {
    fallback++;
    assert.equal(id, 'private-psid');
    return { name: 'Inbox Participant' };
  };
  const names = await Promise.all([g.userName('private-psid'), g.userName('private-psid')]);
  assert.deepEqual(names, ['Inbox Participant', 'Inbox Participant']);
  assert.equal(await g.userName('private-psid'), 'Inbox Participant');
  assert.equal(direct, 1);
  assert.equal(fallback, 1);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private-psid|sensitive Graph response|test-token/);
});

test('Main: absent optional profile and inbox name are cached as empty; no customer reply exception', async () => {
  const { g } = setup();
  let direct = 0;
  g.call = async () => { direct++; const e = new Error('not available'); e.status = 403; throw e; };
  g.findConversation = async () => null;
  assert.equal(await g.userName('someone'), '');
  assert.equal(await g.userName('someone'), '');
  assert.equal(direct, 1);
});

test('Main/Cavite: profile cache keys remain Page-scoped', async () => {
  const { g } = setup();
  let direct = 0;
  g.call = async () => ({ name: 'Name ' + ++direct });
  const main = { id: MAIN, primary: true, token: 'test-main', key: 'main' };
  const cavite = { id: CAVITE, primary: false, token: 'test-cavite', key: 'cavite' };
  assert.equal(await withPage(main, () => g.userName('same-psid')), 'Name 1');
  assert.equal(await withPage(cavite, () => g.userName('same-psid')), 'Name 2');
  assert.equal(await withPage(main, () => g.userName('same-psid')), 'Name 1');
  assert.equal(direct, 2);
});

test('Transient Graph failures do not permanently suppress a later successful lookup', async () => {
  const { g } = setup();
  let direct = 0;
  g.call = async () => {
    direct++;
    if (direct === 1) { const e = new Error('temporary'); e.status = 503; throw e; }
    return { name: 'Recovered' };
  };
  assert.equal(await g.userName('recent-user'), '');
  assert.equal(await g.userName('recent-user'), 'Recovered');
  assert.equal(direct, 2);
});
