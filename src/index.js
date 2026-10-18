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
  const missing = ['VERIFY_TOKEN', 'APP_SECRET', 'APP_ID', 'PAGE_ACCESS_TOKEN', 'LLM_BASE_URL', 'LLM_MODEL'].filter((k) => !process.env[k]);
  if (missing.length) log.warn(`Missing env: ${missing.join(', ')} – bot will not work fully until set.`);
  app.llm.systemPrompt(); // fail fast if prompt file is missing
  const purge = () => { const n = app.store.purge(cfg.dataRetentionDays); if (n) log.info(`purged ${n} inactive chats (> ${cfg.dataRetentionDays} days)`); };
  purge(); setInterval(purge, 24 * 3600e3).unref();
  app.bot.startFollowups();
  app.server.listen(cfg.port, () => log.info(`JMAG's Messenger bot listening on :${cfg.port} | BOT_ENABLED=${cfg.botEnabled} | allowlist=${cfg.testPsids.length} | hours=${cfg.activeHours || '24/7'}`));
  const stop = async () => { log.info('shutting down'); app.server.close(); await app.bot.idle(); app.store.flush(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { build };
