'use strict';
// Minimal client for Meta's official Graph API (Messenger Send API + Conversation Routing).
const crypto = require('node:crypto');
const { currentPage } = require('./pages');

function participantRows(row) {
  const people = (row && row.participants && row.participants.data) || [];
  return people.map((p) => ({
    id: String((p && p.id) || ''),
    name: String((p && p.name) || '').trim(),
  })).filter((p) => p.id || p.name);
}

function participantName(row, pageId) {
  const other = participantRows(row).find((p) => p.name && p.id !== String(pageId || ''));
  return other ? other.name : '';
}

class Graph {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.labelIds = new Map();
    this.labelFailed = new Set();
    this.labelErrorLogged = false;
    this.conversationCache = new Map(); // psid -> { at, value }
    this.messageCache = new Map(); // psid -> { at, value }
  }
  accessToken() {
    const page = currentPage();
    if (page && page.token) return page.token;
    return this.cfg.pageAccessToken || '';
  }
  pageNode() {
    const page = currentPage();
    if (page && page.id) return page.id;
    return this.cfg.pageId || 'me';
  }
  url(pathPart, params = {}) {
    const token = this.accessToken();
    const u = new URL(`${this.cfg.graphBase}/${this.cfg.graphVersion}/${pathPart}`);
    u.searchParams.set('access_token', token);
    if (this.cfg.appSecret && token) {
      // appsecret_proof proves the call comes from our server (works with "Require App Secret").
      u.searchParams.set('appsecret_proof', crypto.createHmac('sha256', this.cfg.appSecret).update(token).digest('hex'));
    }
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return u;
  }
  async call(method, pathPart, { body, params } = {}) {
    const res = await fetch(this.url(pathPart, params), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`Graph ${method} ${pathPart} failed: ${res.status} ${json?.error?.message || text.slice(0, 200)}`);
      err.status = res.status; err.body = json;
      throw err;
    }
    return json;
  }
  typingOn(psid) {
    return this.call('POST', `${this.pageNode()}/messages`, { body: { recipient: { id: psid }, sender_action: 'typing_on' } });
  }
  async sendText(psid, text) {
    // Messenger text limit is 2000 characters; split long replies on line breaks.
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if ((cur + '\n' + line).length > 1900 && cur) { chunks.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
    }
    if (cur) chunks.push(cur);
    const results = [];
    for (const c of chunks) {
      results.push(await this.call('POST', `${this.pageNode()}/messages`, {
        body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: c, metadata: 'jmags-bot' } },
      }));
    }
    return results;
  }
  // One Messenger text, messaging_type RESPONSE. No HUMAN_AGENT tag. Max 2000 characters.
  async sendPageText(psid, text) {
    const c = String(text || '');
    if (c.length > 2000) throw new Error('Messenger text limit is 2000 characters');
    return this.call('POST', `${this.pageNode()}/messages`, {
      body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: c, metadata: 'jmags-ivan' } },
    });
  }
  replyToComment(commentId, message) {
    const id = String(commentId || '').trim();
    if (!id) throw new Error('missing comment id');
    return this.call('POST', `${id}/comments`, { body: { message: String(message || '').slice(0, 8000) } });
  }
  passThreadControl(psid, targetAppId, metadata = '') {
    return this.call('POST', `${this.pageNode()}/pass_thread_control`, {
      body: { recipient: { id: psid }, target_app_id: targetAppId, metadata: metadata.slice(0, 1000) },
    });
  }
  takeThreadControl(psid, metadata = '') {
    return this.call('POST', `${this.pageNode()}/take_thread_control`, {
      body: { recipient: { id: psid }, metadata: String(metadata || '').slice(0, 1000) },
    });
  }
  // Page conversation for one PSID. Cached for 10 minutes, including a miss, so the
  // dashboard refresh does not call Graph again. Null on error or an empty list.
  // participants is requested so a missing profile name can still be shown. If that
  // field is rejected, the lookup is repeated without it.
  async findConversation(psid) {
    const id = String(psid || '');
    if (!id) return null;
    const key = `${this.pageNode()}:${id}`;
    const hit = this.conversationCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const base = { platform: 'messenger', user_id: id };
    let json = null;
    try {
      json = await this.call('GET', `${this.pageNode()}/conversations`, {
        params: { ...base, fields: 'id,link,updated_time,participants' },
      });
    } catch (e) {
      this.log.warn('conversation lookup with participants failed', e.message);
      try {
        json = await this.call('GET', `${this.pageNode()}/conversations`, {
          params: { ...base, fields: 'id,link,updated_time' },
        });
      } catch (e2) {
        this.log.warn('conversation lookup failed', e2.message);
      }
    }
    let value = null;
    const row = json && (json.data || [])[0];
    if (row && row.id) {
      value = {
        id: String(row.id),
        link: String(row.link || ''),
        updatedTime: String(row.updated_time || ''),
        name: participantName(row, this.pageNode()),
        participants: participantRows(row),
      };
    }
    this.conversationCache.set(key, { at: Date.now(), value });
    return value;
  }
  // Business Manager id for this Page, if the token can read it. Cached 10 minutes.
  // The desktop inbox redirect calls this id bpn_id. Null when the field is missing.
  async pageBusiness() {
    const node = this.pageNode();
    this.businesses ||= new Map();
    const hit = this.businesses.get(node);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    let value = null;
    try {
      const json = await this.call('GET', node, { params: { fields: 'business' } });
      const b = json && json.business;
      if (b && b.id) value = { id: String(b.id), name: String(b.name || '') };
    } catch (e) {
      this.log.warn('page business lookup failed', e.message);
    }
    this.businesses.set(node, { at: Date.now(), value });
    return value;
  }
  // Best-effort public name. Missing permission (often HTTP 400 until Advanced Access)
  // or a failed lookup just returns ''. Only the name field is requested. A photo is not.
  async userName(psid) {
    try {
      const json = await this.call('GET', encodeURIComponent(psid), { params: { fields: 'name' } });
      return String(json.name || '').trim();
    } catch (e) {
      this.log.warn('profile lookup failed', e.message);
      return '';
    }
  }
  // Page Inbox history, including messages human staff sent. Up to 100, paging
  // through /{conversation-id}/messages, across the last 90 days.
  // Cached for a minute. A miss or a Graph error returns [] and does not throw.
  async recentMessages(psid, { limit = 100, withinMs = 90 * 86400e3 } = {}) {
    const id = String(psid || '');
    if (!id) return [];
    const key = `${this.pageNode()}:${id}`;
    const hit = this.messageCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
    const convo = await this.findConversation(id);
    let value = [];
    if (convo && convo.id) {
      try {
        const rawRows = [];
        let nextUrl = '';
        let first = true;
        while (rawRows.length < limit && (first || nextUrl)) {
          let json = null;
          if (first) {
            json = await this.call('GET', `${encodeURIComponent(convo.id)}/messages`, {
              params: { fields: 'message,from,created_time', limit: String(Math.min(50, limit)) },
            });
          } else {
            const res = await fetch(nextUrl);
            if (!res.ok) break;
            json = await res.json();
          }
          first = false;
          rawRows.push(...((json && json.data) || []));
          nextUrl = (json && json.paging && json.paging.next) || '';
          if (!nextUrl) break;
        }
        const pageId = String(this.pageNode() || '');
        const cutoff = Date.now() - withinMs;
        for (const row of rawRows) {
          const raw = row && row.message;
          const text = String(raw && typeof raw === 'object' ? raw.text || raw.message || '' : raw || '').trim();
          const ts = Date.parse(row && row.created_time) || 0;
          if (!text || !ts || ts < cutoff) continue;
          const fromId = String((row.from && row.from.id) || '');
          const fromPage = Boolean(pageId && fromId === pageId);
          value.push({ role: fromPage ? 'assistant' : 'user', content: text, ts, via: fromPage ? 'ivan' : '' });
        }
        value.sort((a, b) => a.ts - b.ts);
        if (value.length > limit) value = value.slice(-limit);
      } catch (e) {
        this.log.warn('inbox history lookup failed', e.message);
        value = [];
      }
    }
    this.messageCache.set(key, { at: Date.now(), value });
    return value;
  }

  // Tag the customer with a Page Inbox label.
  // Find or create via /{page-id}/custom_labels, then POST /{label-id}/label?user={psid}.
  // Never POST /{psid}/label — that node rejects the method with "Unsupported request".
  async addLabel(psid, labelName) {
    const name = String(labelName || '').trim();
    const user = String(psid || '').trim();
    if (!name || !user) return null;
    const failKey = `${this.pageNode()}:${user}`;
    if (this.labelFailed.has(failKey)) return null;
    try {
      return await this._addLabel(user, name);
    } catch (e) {
      const status = Number(e.status) || 0;
      if (status === 400) {
        this.labelFailed.add(failKey);
        if (!this.labelErrorLogged) {
          this.labelErrorLogged = true;
          const body = e.body ? JSON.stringify(e.body).slice(0, 500) : '';
          this.log.warn(`label failed once: ${e.message}${body ? ` ${body}` : ''}`);
        }
        return null;
      }
      throw e;
    }
  }

  async _addLabel(user, name) {
    const cacheName = `${this.pageNode()}::${name}`;
    let labelId = this.labelIds.get(cacheName);
    if (!labelId) {
      const page = this.pageNode();
      if (/^\d+$/.test(name) && name !== user) labelId = name;
      else if (!/^\d+$/.test(name)) {
        const list = await this.call('GET', `${page}/custom_labels`, { params: { fields: 'id,name,page_label_name', limit: '100' } });
        const found = (list.data || []).find((l) => l && (l.page_label_name === name || l.name === name) && l.id && String(l.id) !== user);
        if (found) labelId = String(found.id);
        else {
          const created = await this.call('POST', `${page}/custom_labels`, { body: { page_label_name: name, name } });
          labelId = created && created.id ? String(created.id) : '';
        }
      }
      if (labelId && labelId !== user) this.labelIds.set(cacheName, labelId);
    }
    if (!labelId || labelId === user) {
      throw new Error(`refusing to POST /${user}/label; no custom label id`);
    }
    return this.call('POST', `${labelId}/label`, { params: { user } });
  }
}
module.exports = { Graph };
