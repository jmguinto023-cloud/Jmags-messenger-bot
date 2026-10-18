'use strict';
// HTTP server: webhook verification (GET), signed event delivery (POST), health, admin, and the video-review PWA.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const FILES = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/dashboard.css': ['dashboard.css', 'text/css; charset=utf-8'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
};

function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

function authorized(cfg, rq) {
  const auth = rq.headers.authorization || '';
  return Boolean(cfg.adminToken) && auth === `Bearer ${cfg.adminToken}`;
}

function createServer({ cfg, bot, log }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body = '', type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    const sendJson = (code, obj) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(200, { ok: true, botEnabled: cfg.botEnabled, testMode: cfg.testPsids.length > 0 });
    }

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      return sendFile(res, 'dashboard.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      return sendFile(res, file, type);
    }

    if (req.method === 'GET' && url.pathname === '/admin/conversations') {
      if (!authorized(cfg, req)) return send(403, 'Forbidden');
      const since = url.searchParams.get('since');
      if (since && Number.isNaN(Date.parse(since))) return send(400, 'bad since');
      const rows = bot.store.readConversations(since ? Date.parse(since) : null);
      return sendJson(200, rows);
    }
    if (req.method === 'GET' && url.pathname === '/dashboard/api/reviews') {
      if (!authorized(cfg, req)) return send(403, 'Forbidden');
      return sendJson(200, bot.store.data.reviews || []);
    }
    if (req.method === 'GET' && url.pathname === '/dashboard/api/push-status') {
      if (!authorized(cfg, req)) return send(403, 'Forbidden');
      const enabled = Boolean(bot.push && bot.push.configured());
      return sendJson(200, { enabled, publicKey: enabled ? cfg.vapidPublicKey : '' });
    }

    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && cfg.verifyToken && token === cfg.verifyToken) {
        log.info('WEBHOOK_VERIFIED');
        return send(200, challenge || '');
      }
      return send(403, 'Forbidden');
    }

    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/admin/') || url.pathname === '/dashboard/api/subscribe')) {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (url.pathname === '/dashboard/api/subscribe') return subscribe(req, raw);
        if (url.pathname.startsWith('/admin/')) return admin(url, req, raw);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], cfg.appSecret)) {
          log.warn('Rejected webhook: bad or missing X-Hub-Signature-256');
          return send(401, 'Invalid signature');
        }
        let body;
        try { body = JSON.parse(raw.toString('utf8')); } catch { return send(400, 'Bad JSON'); }
        if (body.object !== 'page') return send(404, 'Not a page event');
        send(200, 'EVENT_RECEIVED'); // answer Meta right away, work continues in background
        setImmediate(() => bot.handleWebhook(body));
      });
      return;
    }
    return send(404, 'Not found');

    function subscribe(rq, raw) {
      if (!authorized(cfg, rq)) return send(403, 'Forbidden');
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return send(400, 'Bad JSON'); }
      if (!body || !body.endpoint) return send(400, 'endpoint required');
      bot.store.addSubscription(body);
      const enabled = Boolean(bot.push && bot.push.configured());
      return sendJson(200, { ok: true, enabled });
    }

    function admin(u, rq, raw) {
      // POST /admin/resume?psid=...  with header Authorization: Bearer <ADMIN_TOKEN>
      void raw;
      if (!authorized(cfg, rq)) return send(403, 'Forbidden');
      if (u.pathname === '/admin/resume') {
        const psid = u.searchParams.get('psid');
        if (!psid) return send(400, 'psid required');
        bot.resume(psid);
        return send(200, 'resumed');
      }
      if (u.pathname === '/admin/forget') {
        const psid = u.searchParams.get('psid');
        if (!psid) return send(400, 'psid required');
        bot.store.forget(psid);
        return send(200, 'deleted');
      }
      return send(404, 'Not found');
    }
  });
}

function sendFile(res, name, type) {
  const file = path.join(PUBLIC, name);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}
module.exports = { createServer, verifySignature };
