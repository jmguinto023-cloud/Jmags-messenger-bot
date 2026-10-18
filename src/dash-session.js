'use strict';
// HttpOnly session cookie for the Ivan dashboard. Signed with the app secret (or the password if that is unset).
const crypto = require('node:crypto');

const COOKIE = 'jmags_dash';
const MAX_AGE_SEC = 14 * 24 * 3600;

function passwordOk(cfg, given) {
  const expect = String(cfg.dashboardPassword || '');
  if (!expect) return false;
  const a = crypto.createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(expect, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function sign(cfg, exp) {
  const secret = cfg.appSecret || cfg.dashboardPassword;
  const mac = crypto.createHmac('sha256', secret).update(`${exp}|${cfg.dashboardPassword}`).digest('base64url');
  return `${exp}.${mac}`;
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)jmags_dash=([^;]+)/);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function validSession(cfg, token, now = Date.now()) {
  if (!cfg.dashboardPassword || !token) return false;
  const i = String(token).lastIndexOf('.');
  if (i <= 0) return false;
  const exp = token.slice(0, i);
  const mac = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = sign(cfg, exp).slice(exp.length + 1);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sessionCookie(cfg, req, now = Date.now()) {
  const exp = now + MAX_AGE_SEC * 1000;
  const value = sign(cfg, exp);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SEC}${secure}`;
}

function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

module.exports = { passwordOk, readCookie, validSession, sessionCookie, clearCookie, COOKIE };
