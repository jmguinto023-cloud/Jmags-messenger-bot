'use strict';
// Isolated JMAGS video training dashboard. Never imports or runs the Messenger bot.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const ROOT = __dirname;
const URL = process.env.SUPABASE_URL || 'https://fhjarnogglakehaztbbj.supabase.co';
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const ORIGIN = new URL(URL).origin;
const FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
});
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self' " + ORIGIN,
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};
function reply(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { ...HEADERS, 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'method not allowed' });
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return reply(res, 400, { error: 'invalid path' }); }
    if (pathname === '/health') return reply(res, 200, {
      service: 'jmags-ai-video-training-depot',
      mode: 'owner-authenticated-labeling',
      messengerSendingEnabled: false,
      aiDiagnosisEnabled: false,
      configured: !!KEY,
    });
    if (pathname === '/config.json') {
      if (!KEY) return reply(res, 503, { error: 'Supabase publishable key not configured' });
      // A Supabase publishable key is intended for browser usage. Data is protected by RLS.
      return reply(res, 200, { supabaseUrl: ORIGIN, publishableKey: KEY });
    }
    const file = FILES[pathname];
    if (!file) return reply(res, 404, { error: 'Page not found', home: '/' });
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...HEADERS, 'Content-Type': file[1] });
      return res.end();
    }
    try { return reply(res, 200, await fs.readFile(path.join(ROOT, file[0]), 'utf8'), file[1]); }
    catch { return reply(res, 500, { error: 'Site asset unavailable' }); }
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 10000);
  createServer().listen(port, '0.0.0.0', () => {
    console.log('JMAGS private AI training depot web server listening on port', port);
  });
}
module.exports = { createServer };
