'use strict';
// Minimal client for Meta's official Graph API (Messenger Send API + Conversation Routing).
const crypto = require('node:crypto');

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
    this.conversationCache = new Map(); // psid -> { at, value }
  }
  url(pathPart, params = {}) {
    const u = new URL(`${this.cfg.graphBase}/${this.cfg.graphVersion}/${pathPart}`);
    u.searchParams.set('access_token', this.cfg.pageAccessToken);
    if (this.cfg.appSecret && this.cfg.pageAccessToken) {
      // appsecret_proof proves the call comes from our server (works with "Require App Secret").
      u.searchParams.set('appsecret_proof', crypto.createHmac('sha256', this.cfg.appSecret).update(this.cfg.pageAccessToken).digest('hex'));
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
  pageNode() { return this.cfg.pageId || 'me'; }

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
    const key = String(psid || '');
    if (!key) return null;
    const hit = this.conversationCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    const base = { platform: 'messenger', user_id: key };
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
        name: participantName(row, this.cfg.pageId),
        participants: participantRows(row),
      };
    }
    this.conversationCache.set(key, { at: Date.now(), value });
    return value;
  }
  // Business Manager id for this Page, if the token can read it. Cached 10 minutes.
  // The desktop inbox redirect calls this id bpn_id. Null when the field is missing.
  async pageBusiness() {
    if (this.businessCache && Date.now() - this.businessCache.at < 10 * 60 * 1000) return this.businessCache.value;
    let value = null;
    try {
      const json = await this.call('GET', this.pageNode(), { params: { fields: 'business' } });
      const b = json && json.business;
      if (b && b.id) value = { id: String(b.id), name: String(b.name || '') };
    } catch (e) {
      this.log.warn('page business lookup failed', e.message);
    }
    this.businessCache = { at: Date.now(), value };
    return value;
  }
  // Best-effort public name. Missing permission or a failed lookup just returns ''.
  async userName(psid) {
    try {
      const json = await this.call('GET', encodeURIComponent(psid), { params: { fields: 'name' } });
      return String(json.name || '').trim();
    } catch (e) {
      this.log.warn('profile lookup failed', e.message);
      return '';
    }
  }
  // Tag the customer with a Page Inbox label.
  // Find or create via /{page-id}/custom_labels, then POST /{label-id}/label?user={psid}.
  // Never POST /{psid}/label — that node rejects the method with "Unsupported request".
  async addLabel(psid, labelName) {
    const name = String(labelName || '').trim();
    const user = String(psid || '').trim();
    if (!name || !user) return null;
    let labelId = this.labelIds.get(name);
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
      if (labelId && labelId !== user) this.labelIds.set(name, labelId);
    }
    if (!labelId || labelId === user) {
      throw new Error(`refusing to POST /${user}/label; no custom label id`);
    }
    return this.call('POST', `${labelId}/label`, { params: { user } });
  }
}
module.exports = { Graph };
