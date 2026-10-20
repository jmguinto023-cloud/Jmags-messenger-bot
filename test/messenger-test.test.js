'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { eligible, maybeReplyToTestChallenge } = require('../src/messenger-test');

const CODE = 'JMAGS_TEST_2026_0e97c313c70be1b4';
const NOW = Date.parse('2026-10-20T15:00:00Z');
const cfg = {
  botTestChallenge: CODE, botEnabled: false, aiRouterEnabled: false,
  aiSmartRulesEnabled: false, aiAllowExternalData: false,
  geminiApiKey: 'test-gemini', groqApiKey: 'test-groq',
  geminiModel: 'gemini-3.1-flash-lite', groqModel: 'openai/gpt-oss-20b',
  aiProviderOrder: 'gemini,groq', aiProviderTimeoutMs: 12000,
};
function harness(changes={}) {
  const sent=[], requests=[], logs=[], state={};
  const store = { data: state, saves:0, save(){this.saves++;} };
  const graph = { async sendText(psid, text){sent.push({psid,text});} };
  const log = { info:(m)=>logs.push(m),warn:(m)=>logs.push(m) };
  const fetcher = async (url,options)=> {
    requests.push({url,payload:JSON.parse(options.body)});
    return {ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content:'hello po'}}]})};
  };
  return {
    params:{cfg:{...cfg,...changes},store,graph,log,psid:'only-test-psid',
      text:CODE,ts:NOW,now:NOW,fetcher},sent,requests,logs,store,
  };
}
test('only active for valid test code with ALL customer switches disabled',()=>{
  assert.equal(eligible(cfg),true);
  for(const key of ['botEnabled','aiRouterEnabled','aiAllowExternalData','aiSmartRulesEnabled']) {
    assert.equal(eligible({...cfg,[key]:true}),false);
  }
  assert.equal(eligible({...cfg,botTestChallenge:'short'}),false);
});
test('wrong token or normal message never sends anything',async()=>{
  const h=harness();
  assert.equal(await maybeReplyToTestChallenge({...h.params,text:'what is checkup fee'}),false);
  assert.equal(h.sent.length,0); assert.equal(h.requests.length,0);
});
test('only the exact challenge triggers a one-time AI + Meta test',async()=>{
  const h=harness();
  assert.equal(await maybeReplyToTestChallenge(h.params),true);
  assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].psid,'only-test-psid');
  assert.match(h.sent[0].text,/test: SUCCESS/);
  assert.equal(h.requests.length,1);
  assert.match(h.requests[0].url,/generativelanguage/);
  assert.doesNotMatch(JSON.stringify(h.requests),/only-test-psid|JMAGS_TEST_2026_/);
  assert.doesNotMatch(h.logs.join(' '),/only-test-psid|JMAGS_TEST_2026_/);
  assert.equal(h.store.saves,1);
  assert.equal(await maybeReplyToTestChallenge(h.params),true);
  assert.equal(h.sent.length,1);
});
test('challenge is blocked in standby, stale or with media',async()=>{
  for(const state of [{isStandby:true},{ts:NOW-3600000},{hasMedia:true},
    {forceReason:'customer sent file'}]) {
    const h=harness();
    assert.equal(await maybeReplyToTestChallenge({...h.params,...state}),true);
    assert.equal(h.sent.length,0);
  }
});
test('no AI keys means Meta delivery test runs without customer data',async()=>{
  const h=harness({geminiApiKey:'',groqApiKey:''});
  await maybeReplyToTestChallenge(h.params);
  assert.equal(h.requests.length,0);
  assert.match(h.sent[0].text,/AI connection needs review/);
});
test('disabled bot refuses to run if AI safety gate is enabled',async()=>{
  const h=harness({aiAllowExternalData:true});
  assert.equal(await maybeReplyToTestChallenge(h.params),false);
  assert.equal(h.sent.length,0);
});
test('delivery failure never marks a challenge used',async()=>{
  const h=harness();
  h.params.graph.sendText=async()=>{throw Error('Do not log sensitive message');};
  assert.equal(await maybeReplyToTestChallenge(h.params),true);
  assert.equal(Object.keys(h.store.data.messengerTestUsed||{}).length,0);
  assert.doesNotMatch(h.logs.join(' '),/sensitive message/);
});
