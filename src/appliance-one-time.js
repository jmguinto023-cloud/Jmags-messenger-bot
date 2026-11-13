'use strict';

// Separate, deterministic Messenger replies. This never calls the continuous AI,
// booking form, intake reminder, or follow-up flows.
const REPLIES = Object.freeze({
  location: 'We are located at Brgy 2F, San Pablo City, Laguna. We have also a branch in General Trias, Cavite 😊',
  monitor: 'Yes po gumagawa kami ng monitor basta po kayo po ang magdadala sa shop 😊',
  homeservice: 'YES po Mam/Sir nag-Homeservice po talaga kami Pwede po ba malaman kung tagasaan sila?  Para malaman namin kung abot ng range ng service namin. 🙂',
  price: 'Good day po Mam/Sir! Para po mabigyan kayo ng tamang estimate sa service o repair, kailangan po muna naming malaman ang TV brand, size (inches), issue at location ninyo. Pakisend din po ang VIDEO ng actual problema para ma-check ng aming admin. Hindi po kami magbibigay ng final presyo nang hindi pa na-aassess ang unit. Salamat po! 🙂',
  other: 'Yes po gumagawa din po ang may iba kaming team sa ref at oven po nakafocus. Pero mas focus po kami sa TV 🙂',
});

const REPAIR_QUESTION = /\b(?:gumagawa|nagagawa|nagawa(?:[\s-]+gawa)?|gawa|pagawa|pa[\s-]?gawa|repair|repaired|nagrerepair|nag[\s-]?rerepair|nag[\s-]?repair|aayos|nag[\s-]?aayos|nag-aayos|paayos|pa[\s-]?ayos|fix|pwede|puwede|pwde|pede|kaya|tumatanggap|service)\b/i;
const LOCATION = /\b(?:location|loc|address|adress|directions?|lokasyon|located)\b|\b(?:saan|san|asan|nasaan|nasan)\b.{0,65}\b(?:kayo|shop|store|branch|pwesto|puwesto|ninyo|nyo|inyo|tindahan)\b|\bwhere\b.{0,65}\b(?:located|shop|store|branch|you)\b|\b(?:paano|pano)\b.{0,65}\b(?:pumunta|puntahan|makarating)\b/i;
// Availability/scheduling questions (for example "pwede bukas home service") follow
// the established booking path, not the generic "do you offer home service" reply.
const SCHEDULING = /\b(?:bukas|tomorrow|today|ngayon|mamaya|schedule|sched|booking|book|appointment|oras|anong time|what time|available|availability|next week|sa monday|sa tuesday)\b/i;
const HOMESERVICE = /\b(?:home[\s-]?service|homeservice|home[\s-]?visit|bahay|house)\b.{0,70}\b(?:kayo|nyo|ninyo|pwede|puwede|pwde|pede|kaya|gawa|service|repair|pupunta|pumunta)\b|\b(?:kayo|nyo|ninyo|pwede|puwede|pwde|pede|kaya|gawa|service|repair|pupunta|pumunta)\b.{0,70}\b(?:home[\s-]?service|homeservice|home[\s-]?visit|bahay|house)\b|\b(?:nag[\s-]*ho[\s-]*home[\s-]*service|nag[\s-]*home[\s-]*service|nagseservice|nag[\s-]?se[\s-]?service)\b|\b(?:pwede|puwede|pwde|pede|kaya)\b.{0,48}\b(?:kayo|nyo|ninyo)\b.{0,48}\b(?:mag[\s-]?service|mag[\s-]?repair|dito|diyan|dyan|d2)\b|\b(?:kaya)\b.{0,48}\b(?:dito|diyan|dyan|d2)\b|\b(?:gusto)\b.{0,48}\b(?:nyo|ninyo|kayo)\b.{0,48}\b(?:guma|gawa|gumawa)\b.{0,48}\b(?:dito|diyan|dyan)\b/i;
const PRICE_QUESTION = /^(?:(?:magkano|hm|how much|presyo|price)\s+(?:(?:po|poh|ba|ang|yung|ung|sa|ng|for|the|is|your|ninyo|nyo|kayo)\s+){0,4}(?:serbisyo|service|home[\s-]?service|service fee)|(?:serbisyo|service fee|home[\s-]?service)\s+(?:po\s+)?(?:magkano|hm|how much|price|presyo))\s*[?!. ]*$/i;
const MONITOR = /\b(?:monitor|monitors)\b/i;
const OTHER = /\b(?:microwave|micro[\s-]?wave|oven|ref|refrigerator|refrigerators|fridge|freezer|pridyider|pridyeder)\b/i;

function match(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  // Location is an independent priority reply, also in an existing conversation.
  const out = LOCATION.test(s) ? ['location'] : [];
  if (HOMESERVICE.test(s) && !SCHEDULING.test(s)) out.push('homeservice');
  // Price inquiries receive one approved fixed answer even when the AI bot is OFF.
  // Do not guess repair rates or home-service charges.
  if (PRICE_QUESTION.test(s)) out.push('price');
  if (!REPAIR_QUESTION.test(s)) return out;
  // "Nagawa na ba ang ref ko?" asks for the status of an existing repair.
  if (/\b(?:nagawa|naayos|ayos)\s+na\s+ba\b/i.test(s) && /\b(?:ko|namin|natin)\b/i.test(s)) return out;
  if (MONITOR.test(s)) out.push('monitor');
  if (OTHER.test(s)) out.push('other');
  return out;
}
function response(types) {
  return types.filter(t => Object.hasOwn(REPLIES, t)).map(t => REPLIES[t]).join('\n\n');
}
module.exports = { match, response, REPLIES };
