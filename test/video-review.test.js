'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {prepareVideoReview}=require('../src/video-review');

test('no extraction or external AI without four gates',async()=>{
 let extractCalls=0,draftCalls=0;
 const extractor=async()=>{extractCalls++;return {status:'frames_ready_for_staff_review',frames:['a'],sourceBytes:5}};
 const drafter=async()=>{draftCalls++;return {status:'needs_staff_approval',draft:'draft'}};
 const configs=[{}, {customerConsented:true},{customerConsented:true,staffRequested:true},{customerConsented:true,staffRequested:true,featureEnabled:true}];
 for(const config of configs){const res=await prepareVideoReview({...config,extractor,drafter});assert.equal(res.status,'blocked');}
 assert.equal(extractCalls,0);assert.equal(draftCalls,0);
});

test('only internal draft, no Messenger sends',async()=>{
 const res=await prepareVideoReview({url:'https://video.xx.fbcdn.net/foo',customerConsented:true,
  staffRequested:true,featureEnabled:true,externalAiAllowed:true,
  extractor:async()=>({status:'frames_ready_for_staff_review',frames:['sample'],sourceBytes:43}),
  drafter:async({frames})=>({status:'needs_staff_approval',draft:'possible display issue',framesAnalyzed:frames.length})});
 assert.equal(res.status,'needs_staff_approval');assert.equal(res.autoSent,false);
 assert.equal(res.sourceBytes,43);assert.equal(res.framesAnalyzed,1);
});
