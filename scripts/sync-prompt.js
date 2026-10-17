'use strict';
// Copies the system prompt (text below the first '---' line) from ../ivan-bot-system-prompt.md
// into prompts/system-prompt.md. Run after editing the prompt or the price table: npm run sync-prompt
const fs = require('node:fs');
const path = require('node:path');
const src = process.argv[2] || path.join(__dirname, '..', '..', 'ivan-bot-system-prompt.md');
const lines = fs.readFileSync(src, 'utf8').split('\n');
const i = lines.findIndex((l) => l.trim() === '---');
if (i < 0) { console.error('No --- line found in', src); process.exit(1); }
const out = path.join(__dirname, '..', 'prompts', 'system-prompt.md');
fs.writeFileSync(out, lines.slice(i + 1).join('\n').trim() + '\n');
console.log(`Wrote ${out}`);
