'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
function makeLogger(level = 'info') {
  const min = LEVELS[level] ?? 20;
  const out = (lvl) => (...args) => {
    if (LEVELS[lvl] < min) return;
    const line = `[${new Date().toISOString()}] ${lvl.toUpperCase()} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return { debug: out('debug'), info: out('info'), warn: out('warn'), error: out('error') };
}
// Shorten a PSID for logs so customer IDs are not written in full.
const short = (id) => (id ? `…${String(id).slice(-4)}` : '?');
module.exports = { makeLogger, short };
