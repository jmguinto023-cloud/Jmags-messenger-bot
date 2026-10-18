'use strict';
// HTTP server: webhook verification (GET), signed event delivery (POST), health, admin, and the video-review PWA.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { passwordOk, readCookie, validSession, sessionCookie, clearCookie } = require('./dash-session');
const { loginPage, listPage, publicReview } = require('./dashboard-page');
const { parseSignedRequest } = require('./signed-request');

const PUBLIC_ORIGIN = 'https://jmags-messenger-bot.onrender.com';

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

function dashOk(cfg, rq) {
  return authorized(cfg, rq) || validSession(cfg, readCookie(rq));
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

    if (req.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/data-deletion')) {
      const file = url.pathname === '/privacy' ? 'privacy.html' : 'data-deletion.html';
      return send(200, legalHtml(file, url.searchParams.get('code') || ''), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      if (!validSession(cfg, readCookie(req))) return send(200, loginPage(), 'text/html; charset=utf-8');
      const ua = req.headers['user-agent'];
      bot.hydrateReviewConversations().then(() => {
        send(200, listPage(cfg, bot.store.data.reviews || [], ua), 'text/html; charset=utf-8');
      }, (e) => {
        log.warn('conversation hydrate failed', e.message);
        send(200, listPage(cfg, bot.store.data.reviews || [], ua), 'text/html; charset=utf-8');
      });
      return;
    }
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      return sendFile(res, file, type);
    }

    if (req.method === 'GET' && url.pathname === '/admin/inbox-candidates') {
      if (!authorized(cfg, req)) return send(403, 'Forbidden');
      const psid = String(url.searchParams.get('psid') || '').trim();
      if (!psid) return send(400, 'psid required');
      bot.inboxCandidates(psid).then(
        (body) => sendJson(200, body),
        (e) => sendJson(500, { error: e.message }),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/conversations') {
      if (!authorized(cfg, req)) return send(403, 'Forbidden');
      const since = url.searchParams.get('since');
      if (since && Number.isNaN(Date.parse(since))) return send(400, 'bad since');
      const rows = bot.store.readConversations(since ? Date.parse(since) : null);
      return sendJson(200, rows);
    }
    if (req.method === 'GET' && url.pathname === '/dashboard/api/reviews') {
      if (!dashOk(cfg, req)) return send(403, 'Forbidden');
      return sendJson(200, (bot.store.data.reviews || []).map(publicReview));
    }
    if (req.method === 'GET' && url.pathname === '/dashboard/api/push-status') {
      if (!dashOk(cfg, req)) return send(403, 'Forbidden');
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

    const dashPost = req.method === 'POST' && (url.pathname === '/dashboard/login' || url.pathname === '/dashboard/logout' || url.pathname === '/dashboard/reviewed');
    if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/admin/') || url.pathname === '/dashboard/api/subscribe' || url.pathname === '/data-deletion-callback' || dashPost)) {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        if (url.pathname === '/dashboard/login') return dashboardLogin(req, raw);
        if (url.pathname === '/dashboard/logout') return dashboardLogout();
        if (url.pathname === '/dashboard/reviewed') return dashboardReviewed(req, raw);
        if (url.pathname === '/dashboard/api/subscribe') return subscribe(req, raw);
        if (url.pathname === '/data-deletion-callback') return dataDeletionCallback(raw);
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

    function dashboardLogin(rq, raw) {
      const password = new URLSearchParams(raw.toString('utf8')).get('password') || '';
      if (!cfg.dashboardPassword) return send(401, loginPage('missing'), 'text/html; charset=utf-8');
      if (!passwordOk(cfg, password)) return send(401, loginPage('bad'), 'text/html; charset=utf-8');
      res.writeHead(303, { Location: '/dashboard', 'Set-Cookie': sessionCookie(cfg, rq) });
      res.end('');
    }

    function dashboardLogout() {
      res.writeHead(303, { Location: '/dashboard', 'Set-Cookie': clearCookie() });
      res.end('');
    }

    function dashboardReviewed(rq, raw) {
      if (!validSession(cfg, readCookie(rq))) {
        res.writeHead(303, { Location: '/dashboard' });
        res.end('');
        return;
      }
      const id = new URLSearchParams(raw.toString('utf8')).get('id') || '';
      bot.store.markReviewed(id, bot.now());
      res.writeHead(303, { Location: '/dashboard' });
      res.end('');
    }

    function subscribe(rq, raw) {
      if (!dashOk(cfg, rq)) return send(403, 'Forbidden');
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
        return sendJson(200, bot.forgetCustomer(psid));
      }
      return send(404, 'Not found');
    }

    function legalHtml(file, code) {
      let html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
      if (file !== 'data-deletion.html') return html;
      let status = '';
      if (code) {
        const row = bot.store.deletionStatus(code);
        if (row) {
          const counts = row.deleted || {};
          status = `<p class="status"><strong>Request ${escHtml(code)}</strong> was received on ${escHtml(row.receivedAt || '')}. We deleted ${Number(counts.threads) || 0} conversation record(s), ${Number(counts.reviews) || 0} photo or video record(s), and ${Number(counts.conversations) || 0} log line(s) from our server.</p>`;
        } else {
          status = `<p class="status">We could not find confirmation code <strong>${escHtml(code)}</strong>. Message the JMAG's Appliances Facebook Page or call/text 09386369374 (Smart) / 09267229506 (Globe).</p>`;
        }
      }
      return html.replace('<!--STATUS-->', status);
    }

    function dataDeletionCallback(raw) {
      const text = raw.toString('utf8');
      let signed = new URLSearchParams(text).get('signed_request') || '';
      if (!signed) {
        try { signed = JSON.parse(text).signed_request || ''; } catch { signed = ''; }
      }
      const data = parseSignedRequest(signed, cfg.appSecret);
      const userId = data && data.user_id ? String(data.user_id) : '';
      if (!userId) return send(400, 'Invalid signed_request');
      const deleted = bot.forgetCustomer(userId);
      const code = crypto.randomBytes(8).toString('hex');
      bot.store.rememberDeletion(code, { receivedAt: new Date().toISOString(), deleted });
      return sendJson(200, {
        url: `${PUBLIC_ORIGIN}/data-deletion?code=${code}`,
        confirmation_code: code,
      });
    }
  });
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
