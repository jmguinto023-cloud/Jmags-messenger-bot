'use strict';

// This service is staging-only. It deliberately NEVER imports src/index.js,
// src/server.js, src/bot.js or Messenger Send API logic.
const http = require('node:http');
const crypto = require('node:crypto');
const { runSyntheticVideoSelfTest } = require('./video-staging-self-test');

function safeEqual(input, expected) {
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JMAGS Video AI · Staging Test</title>
<style>body{font-family:system-ui,sans-serif;max-width:620px;margin:3rem auto;padding:1rem;color:#152419;background:#f5f8f5}h1{color:#206e36}input,button{font:inherit;padding:12px;border-radius:8px}input{width:95%;border:1px solid #98ac98}button{border:0;background:#23773c;color:white;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#e4eae4;padding:12px;border-radius:8px}</style></head>
<body><h1>JMAGS Video AI — Safe Test</h1><p>This staging page runs a synthetic video through FFmpeg and a simulated AI reply. No customers, Meta credentials, or production messages are involved.</p>
<label for="token">Staging admin token</label><p><input id="token" type="password" autocomplete="off" placeholder="Token from staging deployment"></p>
<button id="run">Run synthetic video test</button><pre id="result">Ready. Requires staging admin token.</pre>
<script>document.getElementById('run').onclick=async()=>{const result=document.getElementById('result');result.textContent='Running synthetic test…';try{const r=await fetch('/api/self-test',{method:'POST',headers:{Authorization:'Bearer '+document.getElementById('token').value}});result.textContent=JSON.stringify(await r.json(),null,2)}catch(e){result.textContent='Test failed: '+e.message}}</script></body></html>`;

function createStagingServer({ token = process.env.VIDEO_STAGING_ADMIN_TOKEN || '',
  selfTest = runSyntheticVideoSelfTest, clock = () => Date.now(), cooldownMs = 10000 } = {}) {
  let inProgress = false;
  let lastStarted = -Infinity;
  return http.createServer(async (req, res) => {
    // Route by pathname, so share-link tracking parameters cannot break the home page.
    // Still do not accept arbitrary URLs, media uploads, cookies or customer files.
    let route;
    try {
      const url = new URL(req.url, 'http://localhost');
      route = url.pathname.length > 1 ? url.pathname.replace(/\\/+$/g, '') : url.pathname;
    } catch {
      return json(res, 400, { error: 'invalid address' });
    }
    if (req.method === 'GET' && route === '/health') {
      return json(res, 200, { service: 'jmags-video-ai-staging',
        syntheticOnly: true, messengerMessagingEnabled: false, enabled: token.length >= 32 });
    }
    if (req.method === 'GET' && (route === '/' || route === '/test')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
      return res.end(INDEX);
    }
    if (route === '/api/self-test' && req.method === 'GET') {
      return json(res, 405, {
        error: 'Open the JMAGS Video AI home page and use the test button. This endpoint accepts authenticated POST only.',
        home: 'https://jmags-video-ai-staging.onrender.com/'
      });
    }
    if (req.method !== 'POST' || route !== '/api/self-test') {
      return json(res, 404, {
        error: 'Page not found. Open the JMAGS Video AI home page.',
        home: 'https://jmags-video-ai-staging.onrender.com/'
      });
    }
    if (token.length < 32) return json(res, 503, { error: 'staging token not configured' });
    if (!safeEqual(req.headers.authorization, 'Bearer ' + token)) return json(res, 401, { error: 'unauthorized' });
    if (inProgress || clock() - lastStarted < cooldownMs) return json(res, 429, { error: 'test busy; rate limited' });
    inProgress = true;
    lastStarted = clock();
    try { json(res, 200, await selfTest()); }
    catch (err) { json(res, 500, { error: 'synthetic test failed', type: err?.code || 'execution_error' }); }
    finally { inProgress = false; }
  });
}

if (require.main === module) {
  const server = createStagingServer();
  server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
    console.log('JMAGS synthetic-only video test server started');
  });
}

module.exports = { createStagingServer, safeEqual };
