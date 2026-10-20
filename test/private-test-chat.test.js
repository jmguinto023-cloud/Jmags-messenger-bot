'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configured, maybeHandlePrivateChat, MAX_TURNS } = require('../src/private-test-chat');
const code = 'JMAGSCHAT_xF9cA5jD2sL8pK4qT7zR6bN1';
function harness() {
  const replies=[], queries=[], logs=[];
  const cfg={
    botEnabled:false, aiRouterEnabled:false, aiSmartRulesEnabled:false,
    aiAllowExternalData:false, botTestChatEnabled:true, botTestChatCode:code,
    geminiApiKey:'fake-gemini', groqApiKey:'fake-groq',
    geminiModel:'gemini-3.1-flash-lite', groqModel:'openai/gpt-oss-20b',
    aiProviderOrder:'gemini,groq', aiProviderTimeoutMs:6000,
  };
  const store={data:{},save(){}};
  const graph={sendText: async(psid,body)=>{replies.push({psid,body});}};
  const log={info:m=>logs.push(m),warn:m=>logs.push(m)};
  const fetcher=async(url,opts)=>{
    queries.push({url,payload:JSON.parse(opts.body)});
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'We can check your Samsung 65 TV. Ano pong issue?'}}]})};
  };
  const send=async(text,psid='owner',additional={})=>maybeHandlePrivateChat({
    cfg,store,graph,log,psid,text,ts:Date.now(),now:Date.now(),fetcher,...additional,
  });
  return {cfg,store,replies,queries,logs,send,graph};
}
test('simulation requires bot and external customer routing to be off',()=>{
  const h=harness();
  assert.equal(configured(h.cfg),true);
  for(const key of ['botEnabled','aiRouterEnabled','aiSmartRulesEnabled','aiAllowExternalData']){
    assert.equal(configured({...h.cfg,[key]:true}),false);
  }
  assert.equal(configured({...h.cfg,botTestChatCode:'short'}),false);
  assert.equal(configured({...h.cfg,botTestChatEnabled:false}),false);
});
test('no ordinary customer messages handled before code',async()=>{
  const h=harness();
  assert.equal(await h.send('Magkano po ang repair?','customer'),false);
  assert.equal(h.queries.length,0);
  assert.equal(h.replies.length,0);
});
test('secret test code enrolls a single account and makes no external AI calls',async()=>{
  const h=harness();
  assert.equal(await h.send(code),true);
  assert.equal(h.replies.length,1);
  assert.equal(h.replies[0].psid,'owner');
  assert.equal(h.queries.length,0);
  assert.ok(!JSON.stringify(h.replies).includes(code));
  assert.ok(!JSON.stringify(h.store.data).includes(code));
  assert.ok(!h.logs.join(' ').includes(code));
});
test('tester gets a Taglish AI reply and only synthetic test turns sent to provider',async()=>{
  const h=harness();
  await h.send(code);
  assert.equal(await h.send('Samsung 65 po, may sound pero black screen'),true);
  assert.equal(h.queries.length,1);
  assert.match(h.queries[0].url,/generativelanguage/);
  assert.match(h.replies.at(-1).body,/\[JMAGS TEST/);
  assert.equal(h.store.data.privateChat.turnsRemaining,MAX_TURNS-1);
  assert.ok(h.queries[0].payload.messages.every(m=>!m.content.includes(code)));
  assert.equal(h.store.data.privateChat.history.length,2);
});
test('other customers cannot enter the simulator after someone enrolls',async()=>{
  const h=harness();
  await h.send(code);
  assert.equal(await h.send('Hi po','customer'),false);
  assert.equal(await h.send(code,'customer'),true);
  assert.equal(h.replies.length,1);
  assert.equal(h.queries.length,0);
});
test('stop closes simulation and does not enable customer messages',async()=>{
  const h=harness();
  await h.send(code);
  assert.equal(await h.send('JMAGS STOP'),true);
  assert.equal(h.store.data.privateChat,undefined);
  assert.equal(await h.send('Magkano?'),false);
  assert.match(h.replies.at(-1).body,/ended/);
});
test('PII input is rejected and never sent to providers',async()=>{
  const h=harness();
  await h.send(code);
  assert.equal(await h.send('my mobile 09171234567'),true);
  assert.equal(await h.send('my email test@example.com'),true);
  assert.equal(h.queries.length,0);
  assert.match(h.replies.at(-1).body,/no name, number, or address/);
});
test('stale and standby events are ignored',async()=>{
  const h=harness();
  assert.equal(await h.send(code,'owner',{isStandby:true}),false);
  assert.equal(await h.send(code,'owner',{ts:Date.now()-400000}),false);
  assert.equal(h.replies.length,0);
});
test('expired session never replies or sends the code to AI',async()=>{
  const h=harness();
  await h.send(code);
  const before=h.replies.length;
  h.store.data.privateChat.expiresAt=Date.now()-1;
  assert.equal(await h.send('Saan location niyo?'),false);
  assert.equal(h.replies.length,before);
});
test('test turn cap prevents additional external AI calls',async()=>{
  const h=harness();
  await h.send(code);
  h.store.data.privateChat.turnsRemaining=0;
  assert.equal(await h.send('Magkano?'),true);
  assert.equal(h.queries.length,0);
  assert.match(h.replies.at(-1).body,/8 test turns/);
});
test('no providers never replies with invented price or booking',async()=>{
  const h=harness();
  await h.send(code);
  h.cfg.geminiApiKey='';h.cfg.groqApiKey='';
  assert.equal(await h.send('magkano po?'),true);
  assert.equal(h.queries.length,0);
  assert.match(h.replies.at(-1).body,/unavailable/);
});
