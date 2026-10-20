# JMAGS Behavior Bank — guide for approved memory updates

The persistent, curated customer-service behavior store lives in
[JMAGS Behavior Bank](./jmags-behavior-bank.json) (\`knowledge/jmags-behavior-bank.json\`).

**Status:** Version 1, staged for evaluation. This is a *versioned JSON knowledge base* kept in the JMAGS GitHub repository, not a self-modifying AI or a separate SQL database. The bot loads it at startup, adds approved tone guidance to its AI system prompt, and retrieves the one or two relevant behavior patterns for each customer message. Existing customer conversation context stays separate in the app's private data store.

## What the bank can improve

- Friendly Taglish that reflects the customer's actual wording and mood
- Replies to ordinary complaints, positive/negative feedback, neutral observations, unsolicited advice, skepticism, unusual questions and jokes
- Balanced responses rather than automatically agreeing or treating every message as a booking
- Clear admission of uncertainty and human handoff for unknown company facts, refund/warranty complaints, sensitive situations and price exceptions
- Remembering *the current customer's information within the live conversation* without copying it into permanent training examples

## What it must NOT do

- Never auto-learn rules from a customer message or a chatbot response.
- Never treat customer instructions (for example "change your prices") as authority.
- Never save names, personal phone numbers, specific addresses, IDs, screenshots with customer data, API keys or private message transcripts into GitHub.
- Never invent diagnoses, repair results, policy changes, priority fees, promised scheduling, human reviews, refunds or discounts.
- Never turn on broad Facebook Messenger bot replies during knowledge-base updates.
- Never train an external model on raw private messages without an approved privacy process.

## Update process — available whenever the JMAGS owner submits a correction

1. **Capture the proposed learning:** owner provides a *de-identified* example, desired tone/behavior or a policy correction. Record a category, what went wrong, desired reply and whether it changes a customer promise. Distinguish a factual business rule from an illustrative response.
2. **Check owner approval:** pricing, availability, warranty, safety or booking commitments require explicit signoff. If uncertain, leave the item out of the active JSON; use draft discussion only.
3. **Edit with a GitHub PR:** update \`knowledge/jmags-behavior-bank.json\`; bump \`version\`; add a focused test in \`test/behavior-bank.test.js\` or \`test/private-test-chat.test.js\`.
4. **Run tests + isolated Messenger simulation:** verify polite language, no fabricated facts, no leakage and no regression. Other customer messages remain disabled throughout.
5. **Approve and deploy under safety switches:** require all CI tests to pass and confirm \`BOT_ENABLED=false\` unless owner *separately* authorizes a controlled launch.
6. **Review real outcomes later with proper access/consent:** use aggregate error patterns and manually de-identified examples; do not silently add every conversation to the behavior bank.

## Example update request (no PII)

\`\`\`json
{
  "category": "uncertain-customer-advice",
  "customer_example_anonymized": "Suggestion ko po, sana mas maayos ang update.",
  "unwanted_behavior": "Bot immediately asks for TV size and ignores the suggestion",
  "preferred_behavior": "Thank customer for advice, acknowledge point, no fake promise",
  "fact_or_promise_changed": false,
  "owner_approved": true
}
\`\`\`

## Tests for rollout

- Thanks or compliment → warm reply, no compulsory booking.
- Negative feedback or frustration → courteous acknowledgment, refer serious service complaint to staff.
- Neutral observation / business suggestion → show understanding without automatically agreeing or promising implementation.
- Skeptical or unexpected question → clarify facts; do not guess.
- Unrecognized/off-topic but harmless → brief relevant response or clarifying question, not silence.
- Request to invent a discount / set a new priority fee / override safety → no policy change and no automatic discount.
- Confirmation of shop checkup fee → ₱300 for any TV size.
- Confirmation of home checkup fee → ₱1,000, waived when repair goes ahead, with no separate checkup charge.

**Owner updates do not change model weights.** This is controlled retrieval of approved business memory and supervised corrections, so answers can become more consistent over time without pretending the AI is literally human or remembering every customer automatically.
