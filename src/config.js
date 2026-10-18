'use strict';
// All settings come from environment variables. See .env.example for explanations.
const path = require('node:path');
const { DEFAULT_TIPS } = require('./messages');

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function num(v, def) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? def : n;
}
function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function loadConfig(env = process.env) {
  return {
    port: num(env.PORT, 3000),
    // Meta
    verifyToken: env.VERIFY_TOKEN || '',
    appSecret: env.APP_SECRET || '',
    appId: String(env.APP_ID || ''),
    pageId: String(env.PAGE_ID || ''),
    pageAccessToken: env.PAGE_ACCESS_TOKEN || '',
    graphBase: (env.GRAPH_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, ''),
    graphVersion: env.GRAPH_API_VERSION || 'v26.0',
    pageInboxAppId: String(env.PAGE_INBOX_APP_ID || '263902037430900'),
    ignoreEchoAppIds: list(env.IGNORE_ECHO_APP_IDS),
    // Echoes from these app ids are Meta automations, not a person in Page Inbox.
    // They are logged and do not start the human pause. Empty = no ids ignored.
    pageAiAppIds: list(env.PAGE_AI_APP_IDS),
    // Page Inbox echoes that look automated (saved/instant reply, greeting, away message,
    // Meta AI) never start the human pause. Extra regexes: AUTOMATED_ECHO_PATTERNS, separated by "||".
    automatedEchoPatterns: (env.AUTOMATED_ECHO_PATTERNS || '').split('||').map((x) => x.trim()).filter(Boolean),
    // An inbox echo this soon after the customer's message is an automation, not Ivan typing.
    automatedEchoWindowMs: num(env.AUTOMATED_ECHO_WINDOW_MS, 10000),
    needsIvanLabel: env.NEEDS_IVAN_LABEL || '', // empty = don't label on handoff; photo/video uses "Video for review"
    alertWebhookUrl: env.ALERT_WEBHOOK_URL || '',
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || 'mailto:bot@jmags.local',
    // LLM (any OpenAI-compatible chat completions API)
    llmBaseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    llmApiKey: env.LLM_API_KEY || '',
    llmModel: env.LLM_MODEL || '',
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 20000),
    llmTemperature: /^off$/i.test(env.LLM_TEMPERATURE || '') ? null : num(env.LLM_TEMPERATURE, 0.4),
    llmMaxTokens: num(env.LLM_MAX_TOKENS, 400),
    // Spelling "cutomer" is the live Netlify site. Override with BOOKING_FORM_URL.
    bookingFormUrl: ((env.BOOKING_FORM_URL || '').trim()) || 'https://jmagscutomerform.netlify.app/',
    systemPromptFile: env.SYSTEM_PROMPT_FILE || path.join(__dirname, '..', 'prompts', 'system-prompt.md'),
    // Safety switches
    botEnabled: bool(env.BOT_ENABLED, false),
    testPsids: list(env.BOT_TEST_PSIDS),
    activeHours: env.BOT_ACTIVE_HOURS || '', // e.g. "18:00-08:00" (empty = 24/7)
    alwaysOnDays: list(env.BOT_ALWAYS_ON_DAYS).map((d) => d.toLowerCase().slice(0, 3)), // e.g. "sat,sun"
    timezone: env.BOT_TIMEZONE || 'Asia/Manila',
    // Behaviour
    historyTurns: num(env.HISTORY_TURNS, 20),
    humanPauseHours: num(env.HUMAN_PAUSE_HOURS, 12),
    // Safety: a human pause ends early when Ivan has not replied for this long (0 = off).
    humanIdleResumeHours: num(env.HUMAN_IDLE_RESUME_HOURS, 2),
    handoffResumeHours: num(env.HANDOFF_RESUME_HOURS, 72),
    batchWindowMs: num(env.BATCH_WINDOW_MS, 3000),
    followupAfterMin: num(env.FOLLOWUP_AFTER_MIN, 120),
    followupMax: num(env.FOLLOWUP_MAX, 2),
    replyWindowHours: num(env.REPLY_WINDOW_HOURS, 23.5), // stay safely inside Meta's 24h window
    handoffKeywords: env.HANDOFF_KEYWORDS
      ? list(env.HANDOFF_KEYWORDS)
      : ['tao', 'agent', 'tawag', 'tawagan', 'tumawag', 'call', 'ivan', 'human', 'real person', 'totoong tao', 'makausap', 'customer service'],
    dataRetentionDays: num(env.DATA_RETENTION_DAYS, 90),
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    adminToken: env.ADMIN_TOKEN || '',
    dashboardPassword: env.DASHBOARD_PASSWORD || '',
    // Optional full replacement. Empty keeps the built-in free-tips text. Literal \n becomes a line break.
    tipsMessage: env.TIPS_MESSAGE ? String(env.TIPS_MESSAGE).replace(/\\n/g, '\n') : DEFAULT_TIPS,
    logLevel: env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig };
