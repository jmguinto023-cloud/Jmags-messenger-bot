'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { draftVideoDiagnosis, normalizeFrames } = require('../src/video-diagnosis');
const jpeg = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]).toString('base64');

test('requires consent, staff request, and an explicit external-AI flag', async () => {
  let calls = 0;
  const aiRouter = { complete: async () => { calls++; return 'draft'; } };
  for (const options of [
    {},
    { customerConsented: true },
    { customerConsented: true, staffRequested: true },
  ]) {
    const result = await draftVideoDiagnosis({ frames: [jpeg], aiRouter, ...options });
    assert.equal(result.status, 'blocked');
  }
  assert.equal(calls, 0);
});

test('produces a draft, but never sends it to a customer', async () => {
  let request;
  const aiRouter = { complete: async (body) => { request = body; return 'Nakikita sa frames: standby light'; } };
  const out = await draftVideoDiagnosis({ frames: [jpeg], aiRouter,
    customerConsented: true, staffRequested: true, externalAiAllowed: true });
  assert.equal(out.status, 'needs_staff_approval');
  assert.equal(out.autoSent, false);
  assert.equal(out.audioAnalyzed, false);
  assert.equal(out.framesAnalyzed, 1);
  assert.equal(request.messages[1].content[1].type, 'image_url');
  assert.match(request.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('rejects malformed, oversized, or non-JPEG media', () => {
  assert.throws(() => normalizeFrames([]));
  assert.throws(() => normalizeFrames([jpeg, jpeg, jpeg, jpeg, jpeg]));
  assert.throws(() => normalizeFrames(['not a frame']));
  assert.throws(() => normalizeFrames([Buffer.from('not jpeg').toString('base64')]));
  const tooBig = Buffer.concat([Buffer.from([0xff,0xd8]), Buffer.alloc(160001), Buffer.from([0xff,0xd9])]).toString('base64');
  assert.throws(() => normalizeFrames([tooBig]));
});
