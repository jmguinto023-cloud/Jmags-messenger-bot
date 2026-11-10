'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const {createServer}=require('../server');

async function withServer(fn){
 const server=createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {await fn('http://127.0.0.1:'+server.address().port);}
 finally {await new Promise(resolve=>server.close(resolve));}
}

test('server is isolated and does not import Messenger production bot',async()=>{
 const source=await fs.readFile(path.join(__dirname,'..','server.js'),'utf8');
 assert.doesNotMatch(source,/require\(['"]\.\.\/src\/(index|server|bot)/);
 assert.match(source,/JMAGS private AI training depot web server/);
});

test('private dashboard loads responsive HTML without sending customer messages',async()=>{
 await withServer(async base=>{
  const res=await fetch(base+'/?utm_source=chatgpt.com');
  assert.equal(res.status,200);
  const html=await res.text();
  assert.match(html,/JMAGS · AI Video Training Depot/);
  assert.match(html,/Sign in to training depot/);
  assert.match(html,/Mark verified & save knowledge/);
  assert.match(html,/repairable/);
  assert.match(html,/src="\/app.js"/);
  assert.match(res.headers.get('content-security-policy'),/script-src 'self'/);
  const health=await(await fetch(base+'/health')).json();
  assert.equal(health.messengerSendingEnabled,false);
  assert.equal(health.aiDiagnosisEnabled,false);
 });
});

test('dashboard browser JavaScript is syntax-valid and never sends Messenger API messages',async()=>{
 const script=await fs.readFile(path.join(__dirname,'..','app.js'),'utf8');
 assert.doesNotThrow(()=>new vm.Script(script));
 assert.doesNotMatch(script,/graph\.facebook\.com|\/me\/messages|PAGE_ACCESS_TOKEN|service_role/i);
 assert.match(script,/jmags_video_training_cases/);
 assert.match(script,/jmags_video_training_history/);
 const css=await fs.readFile(path.join(__dirname,'..','styles.css'),'utf8');
 assert.match(css,/@media\(max-width:480px\)/);
});

test('no secret key or sensitive Supabase role is served via static HTML',async()=>{
 await withServer(async base=>{
  for(const asset of ['/', '/app.js', '/styles.css']){
   const res=await fetch(base+asset);
   assert.equal(res.status,200);
   const body=await res.text();
   assert.doesNotMatch(body,/sb_secret_|service_role/i);
  }
  const traversal=await fetch(base+'/anything-private');
  assert.equal(traversal.status,404);
  const method=await fetch(base+'/app.js',{method:'POST'});
  assert.equal(method.status,405);
 });
});

test('configuration endpoint fails closed when no publishable key is configured',async()=>{
 await withServer(async base=>{
  const response=await fetch(base+'/config.json');
  assert.equal(response.status,503);
  assert.match((await response.json()).error,/not configured/i);
 });
});
