'use strict';
// Published JMAGS policy for an accepted at-home technician checkup.
// A request is NEVER an appointment or payment authorization.
const HOME_VISIT_CHECKUP_PHP = 1000;
const HOME_VISIT_FEE_LINE =
  'Bago po magpa-home service: ₱1,000 ang check-up fee kapag pupunta ang technician sa bahay. ' +
  'Waived po ito kapag itinuloy ang repair—walang hiwalay na ₱1,000 check-up charge. ' +
  'Staff pa rin po ang magko-confirm ng schedule.';

function homeTerms(text) {
  return /home[\s-]*(?:service|visit|check[\s-]*up)|house\s+visit|sa\s+bahay|bahay\s+(?:ko|namin|natin|po)|on[\s-]*site|puntahan\s+(?:niyo|nyo|po)|pumunta\s+(?:kayo|po)|punta\s+(?:kayo|po)/i.test(String(text || ''));
}

function homeVisitIntent(input, previousAssistant = '') {
  const msg = String(input || '').trim();
  if (!msg) return false;
  if (/\b(?:cancel|never|no thanks|not now|huwag|wag|ayoko)\b|hindi\s+(?:muna\s+)?(?:po\s+)?(?:kami|ako|kayo|pupunta|magpa)/i.test(msg)) return false;

  // Asking the home-service checkup fee should also get the home-service rate.
  if (homeTerms(msg) && /magkano|how much|price|fee|bayad|gastos|cost|check[\s-]*up|checkup|tsekap/i.test(msg)) return true;

  // An explicit request/agreement for a home visit.
  if (/(?:pa[\s-]*home[\s-]*service|magpa[\s-]*home[\s-]*service|book\s+(?:a\s+)?home[\s-]*service|schedule\s+(?:a\s+)?home[\s-]*service|paki[\s-]*(?:punta|punthan|dalaw|visit)|puntahan\s+(?:niyo|nyo|po)|pumunta\s+(?:kayo|po)|punta\s+(?:na\s+)?(?:kayo|po)|(?:come|visit)\s+(?:to\s+)?(?:my|our)\s+(?:house|home))/i.test(msg)
      && !/^\s*(?:pwede|pede|can you|do you|available|meron)\b.*\?\s*$/i.test(msg)) return true;
  if (homeTerms(msg) && /\b(?:sige|yes|opo|oo|okay|ok|gusto|agree|proceed|go ahead|book|pa-?schedule|confirm|ipunta|papuntahin)\b/i.test(msg)
      && !/^\s*(?:pwede|pede|can you|do you)\b.*\?\s*$/i.test(msg)) return true;

  // Short confirmation in context of a home-service invitation.
  if (/^(?:yes|oo|opo|sige|sige po|okay|ok|ok po|go ahead|paki[- ]?schedule)(?:[.! ])*$/i.test(msg)
      && homeTerms(previousAssistant)) return true;
  return false;
}

function lastAssistantText(history) {
  const assistant = (history || []).filter((h) => h && h.role === 'assistant');
  return assistant.length ? String(assistant[assistant.length - 1].content || '') : '';
}

function ensureHomeVisitFee(reply, latestUser, history = []) {
  const text = String(reply || '').trim();
  if (!text || !homeVisitIntent(latestUser, lastAssistantText(history))) return text;
  if (/₱\s*1,?000|PHP\s*1,?000/i.test(text) && /check[\s-]*up|checkup/i.test(text)) return text;
  return HOME_VISIT_FEE_LINE + '\n' + text;
}

module.exports = {
  HOME_VISIT_CHECKUP_PHP, HOME_VISIT_FEE_LINE,
  homeTerms, homeVisitIntent, lastAssistantText, ensureHomeVisitFee,
};
