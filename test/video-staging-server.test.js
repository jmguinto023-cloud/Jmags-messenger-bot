'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStagingServer } = require('../src/video-staging-server');
const { runSyntheticVideoSelfTest } = require('../src/video-staging-self-test');

async function withServer(options, fn) {
  const server = createStagingServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('staging service rejects API calls without a configured secret', async () => {
  await withServer({ token: '' }, async base => {
    const health = await (await fetch(base+'/health')).json();
    assert.equal(health.messengerMessagingEnabled, false);
    assert.equal(health.enabled, false);
    const res = await fetch(base+'/api/self-test', { method:'POST' });
    assert.equal(res.status, 503);
  });
});

test('only a bearer-authenticated staff member can run synthetic test', async () => {
  let calls = 0;
  const secret = 'this-is-a-very-long-32-character-staging-token';
  await withServer({token:secret,selfTest:async()=>{calls++;return {status:'passed'}},clock:()=>1000}, async base => {
    assert.equal((await fetch(base+'/api/self-test',{method:'POST'})).status,401);
    assert.equal(calls,0);
    const ok = await fetch(base+'/api/self-test',{method:'POST',headers:{Authorization:'Bearer '+secret}});
    assert.equal(ok.status,200);
    assert.deepEqual(await ok.json(),{status:'passed'});
    assert.equal((await fetch(base+'/api/self-test',{method:'POST',headers:{Authorization:'Bearer '+secret}})).status,429);
    assert.equal(calls,1);
    assert.equal((await fetch(base+'/unknown',{method:'POST'})).status,404);
  });
});

test('synthetic self-test runs FFmpeg and mock AI without accessing customer videos',async()=>{
  const result=await runSyntheticVideoSelfTest();
  assert.equal(result.status,'passed');
  assert.equal(result.realMessengerDownload,false);
  assert.equal(result.realAiCall,false);
  assert.equal(result.customerRepliesSent,0);
  assert.ok(result.frames>=1);
});
