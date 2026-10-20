'use strict';
const { loadConfig } = require('./config');
const { makeLogger } = require('./log');
const { Store } = require('./store');
const { Graph } = require('./graph');
const { LLM } = require('./llm');
const { Bot } = require('./bot');
const { Push } = require('./push');
const { createServer } = require('./server');

function build(env = process.env) {
  const cfg = loadConfig(env);
  const log = makeLogger(cfg.logLevel);
  const store = new Store(cfg.dataDir, { historyTurns: cfg.historyTurns });
  const graph = new Graph(cfg, log);
  const llm = new LLM(cfg);
  const push = new Push(cfg, store, log);
  const bot = new Bot({ cfg, store, graph, llm, log, push });
  const server = createServer({ cfg, bot, log });
  return { cfg, log, store, graph, llm, bot, push, server };
}

if (require.main === module) {
  const app = build();
  const { cfg, log } = app;
  const aiConfigured = cfg.aiRouterEnabled && app.llm.configured();
  const mandatory = ['VERIFY_TOKEN', 'APP_SECRET', 'APP_ID', 'PAGE_ACCESS_TOKEN'];
  const missing = mandatory.filter((k) => !process.env[k]);
  if (!aiConfigured) missing.push(...['LLM_BASE_URL', 'LLM_MODEL'].filter((k) => !process.env[k]));
  if (missing.length) log.warn(`Missing env: ${missing.join(', ')} – bot will not work fully until set.`);
  app.llm.systemPrompt(); // fail fast if prompt file is missing
  const purge = () => { const n = app.store.purge(cfg.dataRetentionDays); if (n) log.info(`purged ${n} inactive chats (> ${cfg.dataRetentionDays} days)`); };
  purge(); setInterval(purge, 24 * 3600e3).unref();
  const unpaused = app.bot.clearAutomatedPauses();
  if (unpaused.length) log.info(`resumed ${unpaused.length} chat(s) paused by automated Page echoes`);
  app.bot.startFollowups();
  app.server.listen(cfg.port, () => log.info(`JMAG's Messenger bot listening on :${cfg.port} | BOT_ENABLED=${cfg.botEnabled} | allowlist=${cfg.testPsids.length} | hours=${cfg.activeHours || '24/7'} | schedule=${cfg.schedule || 'always'}`));
  if (process.env.AI_SMOKE_TEST_ON_STARTUP === 'true') {
    // Synthetic-only connectivity check. Its own guard refuses to run if
    // customer replies or external customer routing are enabled.
    const { runProviderSmokeTest } = require('./ai-smoke-test');
    runProviderSmokeTest({ cfg, env: process.env, log }).catch(() =>
      log.warn('AI_SMOKE_FAILED: internal error (details suppressed)'));
  }
  const stop = async () => { log.info('shutting down'); app.server.close(); await app.bot.idle(); app.store.flush(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { build };
