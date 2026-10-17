'use strict';
// One local HTTP server that pretends to be BOTH Meta's Graph API and an OpenAI-compatible LLM.
// Used by the automated tests and the end-to-end simulation. Nothing goes to the internet.
const http = require('node:http');

function startMock({ llmResponder } = {}) {
  const calls = { messages: [], typing: [], pass: [], labels: [], llm: [] };
  const state = { llmResponder: llmResponder || (() => 'Noted po maam/sir 😊 Taga saan po sila?'), llmFail: false };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      let body = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch {}
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

      if (url.pathname.endsWith('/chat/completions')) {
        calls.llm.push({ body, auth: req.headers.authorization });
        if (state.llmFail) return json(500, { error: 'boom' });
        const content = await state.llmResponder(body);
        return json(200, { choices: [{ message: { role: 'assistant', content } }] });
      }
      if (!url.searchParams.get('access_token')) return json(400, { error: { message: 'no token' } });
      if (url.pathname.endsWith('/messages')) {
        if (body.sender_action) { calls.typing.push(body); return json(200, { recipient_id: body.recipient.id }); }
        calls.messages.push(body);
        return json(200, { recipient_id: body.recipient.id, message_id: `m_${calls.messages.length}` });
      }
      if (url.pathname.endsWith('/pass_thread_control')) { calls.pass.push(body); return json(200, { success: true }); }
      if (url.pathname.endsWith('/custom_labels') && req.method === 'GET') return json(200, { data: [] });
      if (url.pathname.endsWith('/custom_labels')) return json(200, { id: 'label123' });
      if (url.pathname.endsWith('/label')) { calls.labels.push(body); return json(200, { success: true }); }
      return json(404, { error: { message: 'mock: unknown path ' + url.pathname } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ base, calls, state, close: () => new Promise((r) => server.close(r)) });
  }));
}
module.exports = { startMock };
