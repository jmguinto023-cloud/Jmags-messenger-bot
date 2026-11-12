'use strict';

const { summarizeConversation } = require('./summary');

const REMINDER = 'Hello Mam/Sir Nakapag send na po ba kayo ng Video at details na kailangan namin? Kailangan po ito para mabigyan na namin kayo ng estimation. At Kung meron na po kayo naisend disregard this messages. 🙂';

// A plain follow-up can trigger the reminder. Treat unfamiliar free-form answers
// as possible intake details, so a customer typing their answers isn't interrupted.
const FOLLOWUP_WORDS = new Set((
  'hey good day morning afternoon evening magandang umaga hapon gabi kumusta kamusta any update updates news ' +
  'follow following up again still here waiting may tao nandiyan andyan nandyan jan dyan kayo available open ' +
  'magkano mag kano how much hm estimate estimation quotation quote price presyo singil cost repair pagpapaayos ' +
  'paayos pagawa paestimate parepair inquire inquiry ask question tanong magtanong maginquire mag mayroong ' +
  'pwede puwede pede pwedeng magpa home service services po opo ba na pa kaya kayong lang ng ang yung tv ' +
  'sa ako ko namin ninyo nyo niyo pong bang for can i do you my your get a an what is it the to ' +
  'please pls sir maam ma am mam admin boss ulit waiting reply paki pakireply pasagot wala hindi nakasend'
).split(' '));

function plainFollowup(text) {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!words) return /^\s*\?+\s*$/.test(text);
  return words.split(' ').every(word => FOLLOWUP_WORDS.has(word) || /^(?:hello+|hi+)$/.test(word));
}

function recordEvidence(t, history) {
  const facts = t.firstInquiryFacts ||= {};
  const customerText = history.filter(h => h.role === 'user').map(h => h.content).join('\n');
  const text = customerText.replace(/\[Customer sent a (?:video|photo)[^\]]*\]/gi, '');
  // Honor an explicit customer statement that both items were already sent.
  if (text.split('\n').some(line => /\b(?:nasend|naisend|na-send|pinadala|sinend|sent)\b/i.test(line)
      && /\bvideo\b/i.test(line) && /\bdetails\b/i.test(line)
      && !/\?|\b(?:hindi|di|wala|not|haven.t|paano)\b/i.test(line))) return true;
  const summary = summarizeConversation([{ content: text }]);
  facts.video ||= /\[Customer sent a video\b/i.test(customerText);
  facts.size ||= Boolean(summary.size) || /\bsize(?: ng tv)?\s*:\s*\d/i.test(text);
  facts.brand ||= Boolean(summary.brand) || /\bbrand(?: ng tv)?\s*:[ \t]*[a-z0-9]/i.test(text);
  facts.issue ||= Boolean(summary.problem) || /(?:issue|problem)(?: ng tv)?\s*:[ \t]*\w|ayaw|won.t turn|walang|no power|no sound|stuck|may tunog|patay|nabasag/i.test(text);
  facts.repaired ||= /(?:^|\n)\s*(?:yes|no|oo|hindi pa|di pa)\s*(?:po)?\s*(?:$|\n)|(?:repaired|repair history|repaired o hindi pa)[^\n:]*:[ \t]*(?:yes|no|oo|hindi)|(?:na[ -]?repair|pinaayos|napaayos|naayos|naipaayos|never repaired|never been repaired)/i.test(text);
  facts.when ||= /\b(?:ngayon|kahapon|kanina|kagabi|kamakalawa|today|yesterday|last (?:night|week|month|year)|(?:days?|weeks?|months?|years?) ago|noong|nung)\b|kailan nasira\??\s*:[ \t]*[a-z0-9]|\b\d{1,4}[-/]\d{1,2}[-/]\d{1,4}\b/i.test(text);
  return facts.video && facts.size && facts.brand && facts.issue && facts.repaired && facts.when;
}

module.exports = { REMINDER, plainFollowup, recordEvidence };
