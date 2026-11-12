'use strict';

// Separate, deterministic Messenger replies. This never calls the continuous AI,
// booking form, intake reminder, or follow-up flows.
const REPLIES = Object.freeze({
  monitor: 'Yes po gumagawa kami ng monitor basta po kayo po ang magdadala sa shop 😊',
  other: 'Yes po gumagawa din po ang may iba kaming team sa ref at oven po nakafocus. Pero mas focus po kami sa TV 🙂',
});

const REPAIR_QUESTION = /\b(?:gumagawa|nagagawa|nagawa(?:[\s-]+gawa)?|gawa|pagawa|pa[\s-]?gawa|repair|repaired|nagrerepair|nag[\s-]?rerepair|nag[\s-]?repair|aayos|nag[\s-]?aayos|nag-aayos|paayos|pa[\s-]?ayos|fix|pwede|puwede|pede|kaya|tumatanggap|service)\b/i;
const MONITOR = /\b(?:monitor|monitors)\b/i;
const OTHER = /\b(?:microwave|micro[\s-]?wave|oven|ref|refrigerator|refrigerators|fridge|freezer|pridyider|pridyeder)\b/i;

function match(text) {
  const s = String(text || '').trim();
  if (!s || !REPAIR_QUESTION.test(s)) return [];
  // "Nagawa na ba ang ref ko?" asks for the status of an existing repair.
  if (/\b(?:nagawa|naayos|ayos)\s+na\s+ba\b/i.test(s) && /\b(?:ko|namin|natin)\b/i.test(s)) return [];
  const out = [];
  if (MONITOR.test(s)) out.push('monitor');
  if (OTHER.test(s)) out.push('other');
  return out;
}
function response(types) {
  return types.filter(t => Object.hasOwn(REPLIES, t)).map(t => REPLIES[t]).join('\n\n');
}
module.exports = { match, response, REPLIES };
