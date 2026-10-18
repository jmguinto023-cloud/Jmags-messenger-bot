'use strict';
// End-to-end simulation: starts a MOCK Meta Graph API + MOCK LLM, starts the real bot server
// as a separate process pointed at the mocks, posts signed webhook payloads, and prints
// exactly what the bot would have sent. Nothing touches Facebook or any AI provider.
//   Run:  npm run simulate
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMock } = require('../test/mock-meta-llm');

const SECRET = 'sim_secret';
const PAGE = '102622881557025';
const APP = '123456789';

// Stand-in for the real AI: canned Ivan-style answers keyed on the customer's words.
function mockLLM(body) {
  const last = body.messages.at(-1).content.toLowerCase();
  if (/schedule|ipa sched|book/.test(last)) {
    return 'Noted po maam/sir 🙏 Si Ivan na po ang tutuloy sa inyo dito para ma-confirm ang schedule nyo. Saglit lang po.\n[HANDOFF: customer wants to book]';
  }
  if (/65/.test(last) && /lcd|basag/.test(last)) {
    return 'Para sa TCL 65" nyo po maam/sir, palit brand new LCD po:\n💰 ₱27,000 all-in + travel fee (₱500 within 50 km)\n✅ Brand new panel ✅ Home service ✅ Full testing\n🛡️ 6 months warranty\nAfter repair na po ang bayad, wala pong hidden charges. Bukas po ba, umaga o hapon mas ok sa inyo?';
  }
  if (/backlight|no visual|walang display/.test(last)) {
    return 'Pwde po iservice maam/sir 😊 Possible backlight po yan. Para sa 40" smart TV nyo po:\n💰 ₱4,000 all-in + ₱500 travel fee\n✅ Brand new LED strips ✅ Home service ✅ Full testing\n🛡️ 6 months warranty\nBukas po ba, umaga o hapon mas ok sa inyo?';
  }
  return 'Hi po maam/sir 😊 Paki-send lang po ng brand at size ng TV, issue, at taga saan po sila 🙏';
}

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
let n = 0;
const textEvent = (psid, text) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `sim.${++n}`, text } }] }] });
const photoEvent = (psid) => ({ object: 'page', entry: [{ id: PAGE, time: Date.now(), messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: Date.now(), message: { mid: `sim.${++n}`, attachments: [{ type: 'image', payload: { url: 'https://example.com/tv.jpg' } }] } }] }] });

async function main() {
  const mock = await startMock({ llmResponder: mockLLM });
  const port = 3900 + Math.floor(Math.random() * 90);
  const env = {
    ...process.env, PORT: String(port), VERIFY_TOKEN: 'sim_verify', APP_SECRET: SECRET, APP_ID: APP, PAGE_ID: PAGE,
    PAGE_ACCESS_TOKEN: 'SIM_PAGE_TOKEN', GRAPH_API_BASE: mock.base, LLM_BASE_URL: `${mock.base}/v1`, LLM_API_KEY: 'sim', LLM_MODEL: 'mock',
    BOT_ENABLED: 'true', BOT_TEST_PSIDS: '', BOT_ACTIVE_HOURS: '', BATCH_WINDOW_MS: '500',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'jmags-sim-')), LOG_LEVEL: 'info',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`   [server] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`   [server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

  const v = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=sim_verify&hub.challenge=4242`);
  console.log(`\n1) Webhook verification -> ${v.status} body="${await v.text()}"`);

  const cases = [
    ['psid_joi', 'Hm po magpa gawa backlight ang prob. Good sound no visual on screen, 40\' smart tv. Biñan Laguna po'],
    ['psid_joseph', 'magkano po palit lcd 65 inch tcl basag po'],
    ['psid_gemma', 'good morning, Ipa schedule ko na po. TCL Android TV 65 inches basag ang LCD, Sabang Dasmariñas Cavite'],
  ];
  let step = 2;
  for (const [psid, text] of cases) {
    const before = mock.calls.messages.length;
    const passBefore = mock.calls.pass.length;
    const raw = JSON.stringify(textEvent(psid, text));
    const t0 = Date.now();
    const res = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw });
    const ackMs = Date.now() - t0;
    for (let i = 0; i < 100 && mock.calls.messages.length === before; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    console.log(`\n${step++}) Customer (${psid}): "${text}"\n   webhook ack: ${res.status} in ${ackMs} ms, reply after ${Date.now() - t0} ms`);
    for (const m of mock.calls.messages.slice(before)) console.log(`   BOT → ${m.message.text.replace(/\n/g, '\n         ')}`);
    for (const p of mock.calls.pass.slice(passBefore)) console.log(`   HANDOFF → pass_thread_control to app ${p.target_app_id} (${p.metadata})`);
  }

  // Extra: a photo is acknowledged and the bot stays in the chat (no pass_thread_control).
  const before = mock.calls.messages.length;
  const raw = JSON.stringify(photoEvent('psid_photo'));
  await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw });
  for (let i = 0; i < 60 && mock.calls.messages.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  console.log(`\n${step++}) Customer (psid_photo) sends a photo`);
  for (const m of mock.calls.messages.slice(before)) console.log(`   BOT → ${m.message.text}`);
  console.log(`   HANDOFF calls so far: ${mock.calls.pass.length}`);

  // Bad signature must be refused.
  const bad = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' }, body: raw });
  console.log(`\n${step++}) Forged request (bad signature) -> ${bad.status}`);
  console.log(`\nSummary: ${mock.calls.messages.length} messages sent, ${mock.calls.typing.length} typing indicators, ${mock.calls.pass.length} handoffs, ${mock.calls.llm.length} AI calls.`);

  child.kill('SIGTERM');
  await mock.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
