'use strict';
// Minimal client for Meta's official Graph API (Messenger Send API + Conversation Routing).
const crypto = require('node:crypto');

class Graph {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.labelId = null;
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
  // Optional: tag the customer with a Page Inbox label (Custom Labels API).
  async addLabel(psid, labelName) {
    if (!this.labelId) {
      const list = await this.call('GET', `${this.pageNode()}/custom_labels`, { params: { fields: 'page_label_name', limit: '100' } });
      const found = (list.data || []).find((l) => l.page_label_name === labelName);
      this.labelId = found ? found.id : (await this.call('POST', `${this.pageNode()}/custom_labels`, { body: { page_label_name: labelName } })).id;
    }
    return this.call('POST', `${this.labelId}/label`, { body: { user: psid } });
  }
}
module.exports = { Graph };
