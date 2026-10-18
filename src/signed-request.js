'use strict';
// Meta signed_request: base64url(HMAC-SHA256(payload, app_secret)) + '.' + base64url(json).
const crypto = require('node:crypto');

function b64urlDecode(input) {
  const s = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

function parseSignedRequest(signed, secret) {
  if (!signed || !secret) return null;
  const parts = String(signed).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let sig;
  let expected;
  try {
    sig = b64urlDecode(parts[0]);
    expected = crypto.createHmac('sha256', secret).update(parts[1]).digest();
  } catch {
    return null;
  }
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  let data;
  try {
    data = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
  return data;
}

module.exports = { parseSignedRequest, b64urlDecode };
