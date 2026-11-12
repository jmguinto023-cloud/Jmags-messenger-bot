'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { validateMetaVideoUrl, isPublicIPv4, downloadMetaVideo,
  extractJpegFrames, extractMessengerVideoFrames } = require('../src/video-frame-extractor');

const good = 'https://video.xx.fbcdn.net/video.mp4?sig=abc';

test('strict Meta HTTPS host allowlist rejects SSRF, redirects and credentials', () => {
  assert.equal(validateMetaVideoUrl(good).hostname, 'video.xx.fbcdn.net');
  assert.equal(validateMetaVideoUrl('https://video-atl3-1.xx.fbcdn.net/file').hostname, 'video-atl3-1.xx.fbcdn.net');
  for (const u of [
    'http://video.xx.fbcdn.net/x',
    'https://video.xx.fbcdn.net.evil.test/x',
    'https://cdn.example/x',
    'https://video.xx.fbcdn.net@localhost/private',
    'https://127.0.0.1/video.mp4',
    'https://video.xx.fbcdn.net:8443/video.mp4',
    'https://video.xx.fbcdn.net/video.mp4#frag',
    'https://lookaside.facebook.com/x',
    'file:///etc/passwd',
  ]) assert.throws(() => validateMetaVideoUrl(u), u);
});

test('DNS lookup address check rejects private and reserved ranges', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.2.3','192.168.1.2','100.64.0.1','198.51.100.1','203.0.113.1']) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
  assert.equal(isPublicIPv4('8.8.8.8'), true);
});

test('consent, staff approval and feature flag block without any side effects', async () => {
  let calls = 0;
  const download = async () => { calls++; return 10; };
  const transcode = async () => { calls++; return ['abc']; };
  for (const opts of [{}, {customerConsented:true}, {customerConsented:true,staffRequested:true}]) {
    const res = await extractMessengerVideoFrames({ url:good, download, transcode, ...opts });
    assert.equal(res.status, 'blocked');
  }
  assert.equal(calls, 0);
});

test('isolated successful extraction deletes temporary files and never messages a customer', async () => {
  let file;
  let folder;
  const res = await extractMessengerVideoFrames({url:good,customerConsented:true,staffRequested:true,featureEnabled:true,
    download: async (url, dest) => { file = dest; await fs.writeFile(dest,'dummy'); return 5; },
    transcode: async (input, outputDir) => { folder = outputDir; return ['abcd']; },
  });
  assert.equal(res.status,'frames_ready_for_staff_review');
  assert.equal(res.count,1);
  assert.equal(res.autoSent,false);
  await assert.rejects(fs.stat(file));
  await assert.rejects(fs.stat(folder));
});

test('download fails closed on redirects, content-type mismatch, and oversized bodies', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jmags-extract-test-'));
  try {
    function fakeRequest(statusCode, headers, chunks) {
      return (_u, _opts, callback) => {
        const req=new EventEmitter();
        req.end=()=>{
          const res=Readable.from(chunks);
          res.statusCode=statusCode;
          res.headers=headers;
          res.resume=res.resume.bind(res);
          callback(res);
        };
        req.destroy=()=>{};
        return req;
      };
    }
    await assert.rejects(downloadMetaVideo(good,path.join(dir,'redirect.bin'),{
      request:fakeRequest(302,{location:'http://127.0.0.1/x'},[])}),/HTTP 302/);
    await assert.rejects(downloadMetaVideo(good,path.join(dir,'html.bin'),{
      request:fakeRequest(200,{'content-type':'text/html'},[Buffer.from('html')])}),/Unsupported/);
    await assert.rejects(downloadMetaVideo(good,path.join(dir,'big.bin'),{
      request:fakeRequest(200,{'content-type':'video/mp4'},[Buffer.alloc(1024)]),maxBytes:100}),/exceeds/);
    const bytes=await downloadMetaVideo(good,path.join(dir,'small.bin'),{
      request:fakeRequest(200,{'content-type':'video/mp4'},[Buffer.from('hello')]),maxBytes:100});
    assert.equal(bytes,5);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('real ffmpeg smoke test extracts JPEGs from a generated local video', async (t) => {
  try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); }
  catch { t.skip('FFmpeg not installed'); return; }
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'jmags-ffmpeg-test-'));
  try {
    const inFile=path.join(dir,'sample.mp4');
    const outDir=path.join(dir,'frames');
    await fs.mkdir(outDir);
    execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc=size=160x120:rate=2',
      '-t','4','-pix_fmt','yuv420p','-c:v','mpeg4',inFile],{timeout:15000});
    const frames=await extractJpegFrames(inFile,outDir);
    assert.ok(frames.length>=1 && frames.length<=4);
    assert.equal(Buffer.from(frames[0],'base64')[0],0xff);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
