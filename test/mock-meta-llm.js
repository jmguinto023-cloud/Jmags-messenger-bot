'use strict';
// One local HTTP server that pretends to be BOTH Meta's Graph API and an OpenAI-compatible LLM.
// Used by the automated tests and the end-to-end simulation. Nothing goes to the internet.
const http = require('node:http');

function startMock({ llmResponder } = {}) {
  const calls = { messages: [], typing: [], pass: [], take: [], labels: [], labelCreates: [], llm: [], alerts: [], conversations: [], lookups: [] };
  const state = { llmResponder: llmResponder || (() => 'Noted po maam/sir 😊 Taga saan po sila?'), llmFail: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch {}
      const json = (code, obj, extraHeaders) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...(extraHeaders || {}) });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname.endsWith('/alert')) { calls.alerts.push(body); return json(200, { ok: true }); }
      if (url.pathname.endsWith('/chat/completions')) {
        calls.llm.push({ body, auth: req.headers.authorization });
        if (typeof state.llmGate === 'function') {
          const gate = state.llmGate(body);
          if (gate) {
            const headers = gate.retryAfter != null ? { 'Retry-After': String(gate.retryAfter) } : {};
            const error = { message: gate.message || 'boom' };
            if (gate.retryDelay) error.details = [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: gate.retryDelay }];
            return json(gate.status || 500, { error }, headers);
          }
        }
        if (state.llmFail) return json(state.llmStatus || 500, { error: { message: state.llmError || 'boom' } });
        const content = await state.llmResponder(body);
        return json(200, { choices: [{ message: { role: 'assistant', content } }] });
      }
      if (!url.searchParams.get('access_token')) return json(400, { error: { message: 'no token' } });
      if (url.pathname.endsWith('/messages') && req.method === 'GET') {
        calls.threadMessages = calls.threadMessages || [];
        const parts = url.pathname.split('/').filter(Boolean);
        const convoId = decodeURIComponent(parts[parts.length - 2] || '');
        calls.threadMessages.push({ id: convoId, limit: url.searchParams.get('limit') });
        const rows = (state.threadMessages && state.threadMessages[convoId]) || [];
        return json(200, { data: rows });
      }
      if (url.pathname.endsWith('/messages')) {
        if (body.sender_action) { calls.typing.push(body); return json(200, { recipient_id: body.recipient.id }); }
        calls.messages.push(body);
        return json(200, { recipient_id: body.recipient.id, message_id: `m_${calls.messages.length}` });
      }
      if (url.pathname.endsWith('/pass_thread_control')) { calls.pass.push(body); return json(200, { success: true }); }
      if (url.pathname.endsWith('/take_thread_control')) {
        calls.take.push(body);
        if (state.takeFail) return json(400, { error: { message: state.takeFail } });
        return json(200, { success: true });
      }
      if (url.pathname.endsWith('/custom_labels') && req.method === 'GET') return json(200, { data: state.customLabels || [] });
      if (url.pathname.endsWith('/custom_labels') && req.method === 'POST') {
        calls.labelCreates.push(body);
        return json(200, { id: state.labelId || 'label123' });
      }
      if (url.pathname.endsWith('/label')) {
        calls.labels.push({ user: body.user || url.searchParams.get('user'), path: url.pathname });
        if (state.labelStatus) return json(state.labelStatus, { error: { message: state.labelError || 'label rejected', code: state.labelStatus } });
        return json(200, { success: true });
      }
      if (url.pathname.endsWith('/conversations') && req.method === 'GET') {
        const userId = url.searchParams.get('user_id');
        calls.conversations.push({
          user_id: userId,
          platform: url.searchParams.get('platform'),
          fields: url.searchParams.get('fields'),
        });
        if (state.conversationFail) return json(400, { error: { message: state.conversationFail } });
        const row = state.conversations && state.conversations[userId];
        return json(200, { data: row ? [row] : [] });
      }
      if (req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.split('/').pop() || '');
        const fields = url.searchParams.get('fields') || '';
        if (id && fields) calls.lookups.push({ id, fields });
        if (state.profiles && state.profiles[id]) return json(200, state.profiles[id]);
        if (state.profileStatus) return json(state.profileStatus, { error: { message: 'profile lookup denied' } });
      }
      return json(404, { error: { message: 'mock: unknown path ' + url.pathname } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, calls, state, close: () => new Promise((r) => server.close(r)) });
  }));
}
module.exports = { startMock };
