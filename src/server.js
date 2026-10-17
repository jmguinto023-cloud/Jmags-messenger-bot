'use strict';
// HTTP server: webhook verification (GET), signed event delivery (POST), health and admin.
const http = require('node:http');
const crypto = require('node:crypto');

function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

function createServer({ cfg, bot, log }) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body = '', type = 'text/plain') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, JSON.stringify({ ok: true, botEnabled: cfg.botEnabled, testMode: cfg.testPsids.length > 0 }), 'application/json');
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

    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/admin/'))) {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
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

    function admin(u, rq, raw) {
      // POST /admin/resume?psid=...  with header Authorization: Bearer <ADMIN_TOKEN>
      const auth = rq.headers.authorization || '';
      if (!cfg.adminToken || auth !== `Bearer ${cfg.adminToken}`) return send(403, 'Forbidden');
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
module.exports = { createServer, verifySignature };
