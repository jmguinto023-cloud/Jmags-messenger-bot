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
function smsSenderSetting(value) {
  const name = String(value || '').trim();
  if (!name) return 'JMAGS';
  if (/^(default|none)$/i.test(name)) return '';
  return name;
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
    // Hybrid AI: opt-in only. Never send customer data externally by default.
    aiRouterEnabled: bool(env.AI_ROUTER_ENABLED, false),
    aiSmartRulesEnabled: bool(env.AI_SMART_RULES_ENABLED, false),
    aiAllowExternalData: bool(env.AI_EXTERNAL_DATA_ALLOWED, false),
    aiProviderOrder: env.AI_PROVIDER_ORDER || 'gemini,groq',
    aiMaxDailyCalls: num(env.AI_MAX_DAILY_CALLS, 100),
    aiProviderTimeoutMs: num(env.AI_PROVIDER_TIMEOUT_MS, 12000),
    aiRedactPII: bool(env.AI_REDACT_PII, true),
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    groqApiKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    // LLM (any OpenAI-compatible chat completions API)
    llmBaseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    llmApiKey: env.LLM_API_KEY || '',
    llmModel: env.LLM_MODEL || '',
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 20000),
    llmTemperature: /^off$/i.test(env.LLM_TEMPERATURE || '') ? null : num(env.LLM_TEMPERATURE, 0.4),
    llmMaxTokens: num(env.LLM_MAX_TOKENS, 400),
    // Global cap so a restart or a 429 retry loop cannot burst the free-tier quota. 0 disables the gap.
    llmMaxRpm: num(env.LLM_MAX_RPM, 8),
    // Spelling "cutomer" is the live Netlify site. Override with BOOKING_FORM_URL.
    bookingFormUrl: ((env.BOOKING_FORM_URL || '').trim()) || 'https://jmagscutomerform.netlify.app/',
    systemPromptFile: env.SYSTEM_PROMPT_FILE || path.join(__dirname, '..', 'prompts', 'system-prompt.md'),
    brandNewReferenceFile: env.BRAND_NEW_REFERENCE_FILE || path.join(__dirname, '..', 'prompts', 'brand-new-reference.md'),
    // Safety switches
    botTestChallenge: env.BOT_TEST_CHALLENGE || '', // one-time synthetic test only
    botTestChatEnabled: bool(env.BOT_TEST_CHAT_ENABLED, false),
    botTestChatCode: env.BOT_TEST_CHAT_CODE || '', // private simulation code; Render only
    botEnabled: bool(env.BOT_ENABLED, false),
    testPsids: list(env.BOT_TEST_PSIDS),
    activeHours: env.BOT_ACTIVE_HOURS || '', // e.g. "18:00-08:00" (empty = 24/7)
    alwaysOnDays: list(env.BOT_ALWAYS_ON_DAYS).map((d) => d.toLowerCase().slice(0, 3)), // e.g. "sat,sun"
    // Reply window that replaces an outside cron. Empty = on whenever BOT_ENABLED is on.
    // "22:00-07:00" is Asia/Manila and may cross midnight. Outside it, no auto replies or follow-ups.
    schedule: String(env.BOT_SCHEDULE || '').trim(),
    timezone: env.BOT_TIMEZONE || 'Asia/Manila',
    // Behaviour
    historyTurns: num(env.HISTORY_TURNS, 20),
    // Legacy offset only. Startup still recognises pauses saved as hours. The live pause length is minutes.
    humanPauseHours: num(env.HUMAN_PAUSE_HOURS, 12),
    humanPauseMinutes: num(env.HUMAN_PAUSE_MINUTES, 30),
    // After a human reply, a new customer message is answered once staff has been quiet this long.
    staffGraceMinutes: num(env.STAFF_GRACE_MINUTES, 5),
    // Safety: a human pause ends early when Ivan has not replied for this long (0 = off).
    humanIdleResumeHours: num(env.HUMAN_IDLE_RESUME_HOURS, 2),
    handoffResumeHours: num(env.HANDOFF_RESUME_HOURS, 72),
    batchWindowMs: num(env.BATCH_WINDOW_MS, 3000),
    followupAfterMin: num(env.FOLLOWUP_AFTER_MIN, 120),
    followupMax: num(env.FOLLOWUP_MAX, 2),
    // No quiet-customer nudge when their last message is older than this. Stops an overnight burst.
    followupMaxAgeHours: num(env.FOLLOWUP_MAX_AGE_HOURS, 6),
    // After a video reply, one nudge, then an optional gentler one. 0 disables the second.
    videoFollowupMinutes: num(env.VIDEO_FOLLOWUP_MINUTES, 30),
    videoFollowup2Minutes: num(env.VIDEO_FOLLOWUP2_MINUTES, 240),
    // One morning status text for Under Repair jobs, from 8:00 Manila. Off until the sample is approved.
    dailyStatusUpdates: bool(env.DAILY_STATUS_UPDATES, false),
    // One "ready for delivery" text when a job changes to For Delivery. Off until approved.
    deliveryNotifications: bool(env.DELIVERY_NOTIFICATIONS, false),
    // Schedule confirmation texts. Off until a Semaphore key is set. Never sent without a button press.
    smsEnabled: bool(env.SMS_ENABLED, false),
    semaphoreApiKey: env.SEMAPHORE_API_KEY || '',
    // Empty stays JMAGS. DEFAULT or none omits sendername so Semaphore can use its own sender before JMAGS is approved.
    smsSenderName: smsSenderSetting(env.SMS_SENDER_NAME),
    smsConfirmTemplate: env.SMS_CONFIRM_TEMPLATE ? String(env.SMS_CONFIRM_TEMPLATE).replace(/\\n/g, '\n') : '',
    smsInboundToken: env.SMS_INBOUND_TOKEN || '',
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
