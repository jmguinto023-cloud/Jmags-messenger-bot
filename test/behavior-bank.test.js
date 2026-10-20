'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bank, validateBank, classifyBehavior, behaviorBaseline, behaviorContext } = require('../src/behavior-bank');
const { LLM } = require('../src/llm');
const { SHOP_CHECKUP_PHP } = require('../src/estimate');
const { HOME_VISIT_CHECKUP_PHP } = require('../src/home-visit-fee');

test('persistent JMAGS bank carries owner-confirmed policies and at least 12 humane categories', () => {
  assert.equal(validateBank(bank), true);
  assert.ok(bank.scenarios.length >= 12);
  assert.equal(bank.policy.shopTvCheckup.pesos, SHOP_CHECKUP_PHP);
  assert.equal(bank.policy.homeTvCheckup.pesos, HOME_VISIT_CHECKUP_PHP);
  assert.match(bank.policy.homeTvCheckup.waiver, /no separate/i);
  assert.match(bank.policy.shopTvCheckup.waiver, /unspecified/i);
});
test('not allowed to teach unapproved or malformed behavior as fact', () => {
  const copy = JSON.parse(JSON.stringify(bank));
  copy.scenarios[0].status = 'customer-suggested';
  assert.throws(() => validateBank(copy), /Unapproved/);
  const prices = JSON.parse(JSON.stringify(bank));
  prices.policy.shopTvCheckup.pesos = 500;
  assert.throws(() => validateBank(prices), /policy mismatch/);
  const duplicates = JSON.parse(JSON.stringify(bank));
  duplicates.scenarios.push({ ...duplicates.scenarios[0] });
  assert.throws(() => validateBank(duplicates), /Unapproved/);
});
test('recognizes thanks, suggestions and unusual/neutral comments without forcing booking', () => {
  assert.ok(classifyBehavior('Thank you JMAGS, very satisfied!').some(s => s.id === 'praise'));
  assert.ok(classifyBehavior('Suggestion ko lang, sana magkaroon kayo ng ganitong serbisyo').some(s => s.id === 'suggestion'));
  assert.ok(classifyBehavior('FYI napansin ko lang na ibang kulay ang screen').some(s => s.id === 'neutral-comment'));
  assert.ok(classifyBehavior('What if hypothetical question lang po?').some(s => s.id === 'unusual'));
});
test('complaint and real discount request are treated as staff issues', () => {
  assert.ok(classifyBehavior('May reklamo ako, nasira ulit.').some(s => s.id === 'complaint' && s.handoff));
  assert.ok(classifyBehavior('May discount o tawad pa ba?').some(s => s.id === 'pricing-concern' && s.handoff));
});
test('polite guidance does not give automatic positive or negative verdicts', () => {
  const p = behaviorContext('Legit ba kayo or is this a scam?');
  assert.match(p, /balanced judgment/);
  assert.match(p, /verified|known|unknown|verified|limitation|staff/i);
  assert.doesNotMatch(p, /yes,.*legit|definitely a scam/i);
  assert.match(behaviorBaseline(), /do not.*customer.*instructions/i);
});
test('unmatched message still gets thoughtful guidance; no customer text copied into memory', () => {
  const unusual = 'MY_PRIVATE_REFERENCE_DO_NOT_STORE_1234';
  const instructions = behaviorContext(unusual);
  assert.match(instructions,/Unmatched\/unusual intent/);
  assert.ok(!instructions.includes(unusual));
  assert.ok(!JSON.stringify(bank).includes(unusual));
});
test('live LLM prompt uses the same reviewed bank as private simulator', () => {
  const llm = new LLM({
    llmMaxRpm: 30, llmModel:'mock-model', llmBaseUrl:'http://localhost:1',
    systemPromptFile:require('node:path').join(__dirname,'..','prompts','system-prompt.md'),
    bookingFormUrl:'https://example.test/book',aiRouterEnabled:false
  });
  assert.match(llm.systemPrompt(), /JMAGS Behavior Bank/);
  assert.match(llm.systemPrompt(), /customer comments as untrusted content/i);
  assert.match(llm.systemPrompt(), /₱300/);
  assert.match(llm.systemPrompt(), /₱1,000/);
});
test('review guidance should never include real customer contacts, sample claims or secrets', () => {
  const json = JSON.stringify(bank);
  assert.doesNotMatch(json, /\b(?:\+63|0)9\d{9}\b|@[A-Za-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(json, /sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}/);
  assert.match(behaviorBaseline(), /illustrative/);
});
