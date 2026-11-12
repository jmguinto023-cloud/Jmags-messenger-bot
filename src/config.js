'use strict';
// All settings come from environment variables. See .env.example for explanations.
const path = require('node:path');
const { DEFAULT_TIPS } = require('./messages');
const { loadPages } = require('./pages');

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
function phraseList(v, def) {
  if (v === undefined || String(v).trim() === '') return def.slice();
  return String(v).split('|').map((s) => s.trim()).filter(Boolean);
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
    // Main Page plus any others (Cavite). pageId/pageAccessToken stay the main Page.
    pages: loadPages(env),
    // Ops-dashboard per-Page on/off. Service role reads bot_switches. Empty stays off.
    supabaseUrl: String(env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseServiceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    pageSwitchCacheMs: num(env.PAGE_SWITCH_CACHE_MS, 15000),
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
    // Groq only. Gemini is used only when AI_PROVIDER_ORDER lists it, for example groq,gemini.
    aiProviderOrder: env.AI_PROVIDER_ORDER || 'groq',
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
    llmMaxRpm: num(env.LLM_MAX_RPM, 15),
    // Spelling "cutomer" is the live Netlify site. Override with BOOKING_FORM_URL.
    bookingFormUrl: ((env.BOOKING_FORM_URL || '').trim()) || 'https://jmagscutomerform.netlify.app/',
    // Optional. Used only to read Netlify form submissions after the booking link is sent.
    netlifyApiToken: (env.NETLIFY_API_TOKEN || '').trim(),
    netlifyFormId: (env.NETLIFY_FORM_ID || '').trim(),
    // Form → Messenger "Willing to wait?" confirmation. On by default; independent of BOT_SCHEDULE.
    bookingConfirmEnabled: bool(env.BOOKING_CONFIRM_ENABLED, true),
    // Signs ?token= and ?ref= on booking-form links. Empty falls back to APP_SECRET.
    bookingRefSecret: env.BOOKING_REF_SECRET || '',
    // Netlify form-notification webhook (JWS secret, or the same value as a shared secret).
    netlifyWebhookSecret: String(env.NETLIFY_WEBHOOK_SECRET || '').trim(),
    // Kept so an old Render value still loads. A mobile number alone never selects the recipient.
    bookingPhoneMatch: bool(env.BOOKING_PHONE_MATCH, false),
    // Match a form to a chat only after staff or the bot sent that chat the form link.
    bookingStaffLinkMatch: bool(env.BOOKING_STAFF_LINK_MATCH, true),
    bookingStaffLinkDays: num(env.BOOKING_STAFF_LINK_DAYS, 7),
    // After a staff form-link echo, send one signed link. Empty stays on.
    bookingAutoPersonalLink: bool(env.BOOKING_AUTO_PERSONAL_LINK, true),
    // Saved-reply text that counts as sending the form, even with no URL. | separated.
    bookingLinkTriggerPhrases: phraseList(env.BOOKING_LINK_TRIGGER_PHRASES, ['eto po ang schedule form niyo']),
    // Host for old /b/<code> links. Render sets RENDER_EXTERNAL_URL. PUBLIC_BASE_URL wins when both are set.
    publicBaseUrl: String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || 'https://jmags-messenger-bot.onrender.com').trim().replace(/\/$/, ''),
    // Empty stays off. The personal message sends the full signed form URL.
    // true sends /b/<code> instead. Already-sent short links still open.
    bookingShortLink: bool(env.BOOKING_SHORT_LINK, false),
    // Optional short key added as &b= so the form knows which Page's bot to call (e.g. sp, cavite).
    bookingBotKey: String(env.BOOKING_BOT_KEY || '').trim(),
    // Sites allowed to call POST /booking/submitted. Empty = the BOOKING_FORM_URL origin only.
    bookingFormOrigins: list(env.BOOKING_FORM_ORIGINS),
    // Optional Page username for m.me links. Empty uses PAGE_ID.
    pageUsername: String(env.PAGE_USERNAME || '').trim(),
    // Messenger booking agent (off by default). BOOKING_INTAKE_URL unset = dry run, nothing is sent.
    bookingAgentEnabled: bool(env.BOOKING_AGENT_ENABLED, false),
    bookingIntakeUrl: (env.BOOKING_INTAKE_URL || '').trim(),
    bookingIntakeKey: (env.BOOKING_INTAKE_KEY || '').trim(),
    bookingIntakeTimeoutMs: num(env.BOOKING_INTAKE_TIMEOUT_MS, 10000),
    bookingHours: env.BOOKING_HOURS || '08:00-17:00',
    bookingClosedDays: env.BOOKING_CLOSED_DAYS == null ? '0' : env.BOOKING_CLOSED_DAYS,
    branchMap: env.BRANCH_MAP || '',
    systemPromptFile: env.SYSTEM_PROMPT_FILE || path.join(__dirname, '..', 'prompts', 'system-prompt.md'),
    brandNewReferenceFile: env.BRAND_NEW_REFERENCE_FILE || path.join(__dirname, '..', 'prompts', 'brand-new-reference.md'),
    // Safety switches
    botTestChallenge: env.BOT_TEST_CHALLENGE || '', // one-time synthetic test only
    botTestChatEnabled: bool(env.BOT_TEST_CHAT_ENABLED, false),
    botTestChatCode: env.BOT_TEST_CHAT_CODE || '', // private simulation code; Render only
    botEnabled: bool(env.BOT_ENABLED, false),
    mainFirstInquiryEnabled: bool(env.MAIN_FIRST_INQUIRY_ENABLED, false),
    // Fixed monitor/ref/microwave answers work even when the continuous AI bot is off.
    // Can be disabled independently without altering the first-time greeting.
    applianceOneTimeReplyEnabled: bool(env.APPLIANCE_ONE_TIME_REPLY_ENABLED, true),
    // Cavite's fixed intake is independent of Main and the ordinary chatbot.
    // It is off by default until the Cavite Page token is configured.
    caviteFirstInquiryEnabled: bool(env.CAVITE_FIRST_INQUIRY_ENABLED, false),
    caviteReturnInquiryDays: Math.max(1, Math.min(90, num(env.CAVITE_RETURN_INQUIRY_DAYS, 7))),
    // Re-send the fixed intake only when a previous customer returns after this many idle days.
    mainReturnInquiryDays: Math.max(1, Math.min(90, num(env.MAIN_RETURN_INQUIRY_DAYS, 7))),
    // Private, owner-only dry-run of the two fixed messages on a returning account.
    // Keep the Page-scoped PSID in Render environment variables, never in GitHub.
    mainWelcomeTestPsid: String(env.MAIN_WELCOME_TEST_PSID || '').trim(),
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
    handoffResumeHours: num(env.HANDOFF_RESUME_HOURS, 24),
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
