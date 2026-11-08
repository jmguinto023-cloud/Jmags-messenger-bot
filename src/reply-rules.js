'use strict';
// Reply rules from Jm's handover. Check-up fees in the doc are not repeated here.

const PUBLIC_COMMENT_REPLY = 'Salamat po. I-message niyo po kami sa Messenger para sa booking: brand, size, sira, at city.';
const STAFF_HANDOFF_LINE = 'Sige po. Si Jm o Ivan na po ang sasagot dito.';

function optOutReason(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/\bayaw ko na\b/i.test(t)) return 'ayaw ko na';
  if (/\bunsubscribe\b/i.test(t)) return 'unsubscribe';
  if (/\bopt[ -]?out\b/i.test(t)) return 'opt out';
  if (/(^|[^a-z0-9])stop([^a-z0-9]|$)/i.test(t)) return 'stop';
  return '';
}

// A reason to flag the chat for Jm or Ivan, or '' when the bot can still answer.
function staffEscalation(text) {
  const t = String(text || '');
  if (/\breklamo\b|\bcomplaint\b|\bscam\b|nang-?scam/i.test(t)) return 'complaint';
  if (/\bback-?job\b/i.test(t)) return 'backjob dispute';
  if (/warranty|garantiya/i.test(t) && /\b(ayaw|dispute|reklamo|scam|back-?job|hindi covered)\b/i.test(t)) return 'warranty dispute';
  if (/\brefund\b|ibalik ang bayad|mali ang (?:singil|bayad)|sobra ang (?:singil|bayad)|overcharge/i.test(t)) return 'payment disagreement';
  if (/hindi (?:po )?(?:kami|kayo|niyo|nyo) sure|\bguarantee\b|garantisado|siguradong (?:maayos|aayos|gagana)/i.test(t)) return 'technical uncertainty';
  if (/\bsi jm\b|\bkausapin\b.{0,24}\b(jm|ivan|tao|human)\b|\breal person\b|\btotoong tao\b/i.test(t)) return 'asked for a person';
  return '';
}

function publicCommentReply(text) {
  return staffEscalation(text) ? STAFF_HANDOFF_LINE : PUBLIC_COMMENT_REPLY;
}

module.exports = {
  PUBLIC_COMMENT_REPLY,
  STAFF_HANDOFF_LINE,
  optOutReason,
  staffEscalation,
  publicCommentReply,
};
