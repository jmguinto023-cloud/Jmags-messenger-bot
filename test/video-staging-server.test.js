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

test('shared staging links with tracking parameters do not return 404', async () => {
  let calls = 0;
  const token = 'shared-link-token-long-enough-for-internal-tests';
  await withServer({token, selfTest: async () => {calls++; return {status:'passed'};}}, async base => {
    const home = await fetch(base + '/?utm_source=chatgpt.com');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /JMAGS Video AI/);
    const testHome = await fetch(base + '/test?source=pwa');
    assert.equal(testHome.status, 200);
    const health = await fetch(base + '/health?utm_source=chatgpt.com');
    assert.equal(health.status, 200);
    const apiHelp = await fetch(base + '/api/self-test?utm_source=chatgpt.com');
    assert.equal(apiHelp.status, 405);
    assert.match((await apiHelp.json()).home, /jmags-video-ai-staging/);
    const api = await fetch(base + '/api/self-test?source=chatgpt', {
      method:'POST', headers:{Authorization:'Bearer '+token}
    });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).status, 'passed');
    assert.equal(calls, 1);
  });
});


test('public demo works without a token and caches safe synthetic output', async () => {
  let calls = 0;
  let now = 1000;
  const mockResult = {
    test:'synthetic_frame_extraction_and_mock_vision',
    status:'passed', frames:1, realAiCall:false,
    realMessengerDownload:false, customerRepliesSent:0
  };
  await withServer({token:'', clock:()=>now, selfTest:async()=>{calls++;return mockResult;}},async base=>{
    const html = await (await fetch(base+'/')).text();
    assert.match(html, /Run free demo test/);
    assert.doesNotMatch(html, /Staging admin token/);
    const health=await (await fetch(base+'/health')).json();
    assert.equal(health.publicDemoAvailable,true);
    assert.equal(health.messengerMessagingEnabled,false);
    const first=await fetch(base+'/api/demo',{method:'POST'});
    assert.equal(first.status,200);
    const data=await first.json();
    assert.equal(data.status,'passed');
    assert.equal(data.syntheticOnly,true);
    assert.equal(data.cached,false);
    assert.equal(data.customerRepliesSent,0);
    assert.equal(calls,1);
    const second=await fetch(base+'/api/demo',{method:'POST'});
    assert.equal(second.status,200);
    assert.equal((await second.json()).cached,true);
    assert.equal(calls,1,'cached demo must not run FFmpeg again');
    now+=5*60*1000+1;
    const third=await fetch(base+'/api/demo',{method:'POST'});
    assert.equal(third.status,200);
    assert.equal(calls,2);
    const get=await fetch(base+'/api/demo');
    assert.equal(get.status,405);
    assert.match((await get.json()).error,/Run free demo/);
    // The original admin path is intentionally still protected.
    assert.equal((await fetch(base+'/api/self-test',{method:'POST'})).status,503);
  });
});

test('public demo fails closed for unsafe or failed simulated results', async () => {
  let now=1000;
  await withServer({
    token:'',
    clock:()=>now,
    selfTest:async()=>({status:'passed',realAiCall:true,realMessengerDownload:false,customerRepliesSent:0})
  },async base=>{
    const response=await fetch(base+'/api/demo',{method:'POST'});
    assert.equal(response.status,500);
    assert.match((await response.json()).error,/no customer data/);
    const retry=await fetch(base+'/api/demo',{method:'POST'});
    assert.equal(retry.status,429,'abuse or failure must be throttled');
  });
});

test('parallel public demo requests share one synthetic run', async () => {
  let calls=0;
  await withServer({token:'',selfTest:async()=>{
    calls++;
    await new Promise(resolve=>setTimeout(resolve,25));
    return {status:'passed',realAiCall:false,realMessengerDownload:false,customerRepliesSent:0};
  }},async base=>{
    const responses=await Promise.all(Array.from({length:4},()=>fetch(base+'/api/demo',{method:'POST'})));
    assert.ok(responses.every(r=>r.status===200));
    assert.equal(calls,1);
  });
});
