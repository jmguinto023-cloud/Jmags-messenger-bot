# JMAGS Appliances — Customer Service Playbook (knowledge-transfer draft)

**Status: Review draft, not approved for customer-facing deployment.**  
**Compiled:** 21 October 2026 from the owner-provided Claude knowledge-transfer report plus direct read of the current \`prompts/system-prompt.md\`, \`src/config.js\`, \`src/messages.js\`, \`src/bot.js\`, and \`src/home-visit-fee.js\`.  
**Source of truth for currently configured behaviors:** the checked-in code and Render environment, not historic summaries.  
**No customer data or secrets should be committed to this repository.**

## Evidence and decision labels

- **Owner confirmed** — directly instructed by JMAGS owner in this ChatGPT project.
- **Code-confirmed** — appears in checked-in source, but this does **not** mean it is currently approved, legally compliant, or effective in production.
- **Report claim / needs owner review** — from the owner-provided Claude summary, not independently verified against the original conversation, recording, or inbox message.
- **Proposed** — useful practice to test; not authorized pricing, schedule, warranty, or dispatch policy.
- **Unresolved** — conflicting evidence; **do not use** as the basis for new promises until settled.

The Claude report labels ten replies as verified but also states it edited some names and had no full customer transcripts. Therefore examples in this playbook are **adapted examples**, not ten independently authenticated verbatim customer messages.

## Voice — report-supported, consistent with system prompt

1. Friendly human Taglish / Tagalog; mirror the customer's language. Keep English for technical terms the customer uses, such as backlight, LED, LCD, warranty, and home service.
2. Respectful \`po\`, optional \`maam/sir\`; **one useful question per message**. Most replies one to three short sentences; price/booking replies may require more words.
3. Start with a relevant empathetic acknowledgment for damage, frustration, or expense, then the next practical step. Do not repeat \`Noted po\` mechanically.
4. Address the latest question first. Extract and remember TV brand, model/size, symptom, city, age, history of previous repairs. **Never repeat a detail/question already answered**.
5. Do not claim to have seen or diagnosed a photo/video unless an authorized technician actually has. When Meta webhook reports an attachment, acknowledge receipt; do not invent a human review or promise a response time.
6. Never invent repair price, diagnosis, parts availability, technician availability, warranty, repair success, branch location, or confirmed appointment. If unknown: \`Iche-check ko po sa staff namin.\` Then use a real human handoff mechanism.
7. Customer-facing role should be described as JMAGS's automated assistant, not as the employee. The report claims the owner wants **\`staff po namin\`**, not a named technician; this wording is pending owner confirmation for all templates.
8. Emojis sparingly (e.g. 😊 🙏 💰 🛡️), generally no more than two. Messenger text is plain text, not Markdown.

## Intake and conversational memory

- Intake from current prompt: brand/size, TV age, general city/location, prior outside-shop repair, and actual issue/symptom as needed.
- For a bare \`magkano po\` with no details, ask the **next genuinely missing** detail; don't produce a firm quote.
- The Claude report claims location first, then brand/size, then fault for a bare price inquiry. Existing prompt contains both this special-case order and a different general intake order. **Do not unify these without testing.**
- When multiple TVs are mentioned, ask which of the already-listed units needs service rather than restarting intake.
- When video is received, use the real attachment/event timestamp only when reliable; otherwise say \`Natanggap po namin ang video.\` No invented technician activity.
- A human takeover or existing-job update requires human workflow; do not repeat quotes or historic booking promises.

## Booking and fee disclosure

**Owner confirmed (21 October conversation):** An agreed technician **home visit/checkup is ₱1,000**, disclosed before any booking can be represented as confirmed. Applies to home visits regardless of size unless the owner later approves an exception.

**Code-confirmed but disputed treatment:** Existing code says the ₱1,000 checkup charge is *waived when repair proceeds*. The Claude report points out \`waived\` vs \`deducted from repair total\` ambiguity. **Resolve before teaching a new financial statement**. The current software may still say waived until corrected.

**Unresolved size exception:** The old code and FAQ still say \`₱500 for 32" and 40" TVs\` for some general check-ups, although the confirmed home-visit rule is ₱1,000. Do not offer ₱500 for home visits.

**Current prompt/bookings:** Customer requests a booking or a slot; app provides the booking form. Staff must verify availability and confirm the appointment. No automatic dispatch, technician allocation, date/time promise or collection based only on a chat.

**Repair quotes:** If quoting an approved repair package, one all-in price with included services, warranty only when applicable, and after-repair payment under current company policy. A **home-service diagnostic/checkup fee must not be confused with the final repair price**. Check price tables, service area and job type against the current source of truth.

**Unresolved priority fee:** Claude report claims \`+₱1,000\`; current \`prompts/system-prompt.md\` still says \`+₱800\`. Do not quote or collect a priority surcharge until owner approves a single amount.

## Human routing, complaints, price uncertainty

Handoff (existing system prompt):
- Customer expressly requests staff or calls.
- Warranty/backjob/complaint or refund request.
- Discount/tawad request (do not negotiate a lower amount automatically).
- Second-hand LCD option or other repair/part/stock question not in the approved source.
- A previous outside shop opened or worked on the unit and a human quote is needed.
- Job status request, unclear service area, refrigerator/aircon pricing, or a booking form submitted.
- AI outage or repeated unanswered question.

Use a **real handoff** or staff queue; never claim a human has reviewed a specific asset until that review actually occurred. One fallback holding reply per thread; suppress duplicates and alert operators when many AI failures occur.

The report praises direct but courteous corrections of customer misconceptions: say what the verified record shows (only when that record exists) and avoid sounding accusatory.

## Illustrative replies — adapted, not claimed as verbatim transcripts

1. General inquiry: \`Hello po! Nagre-repair po kami ng TV. Ano pong brand at size ng unit?\`
2. Symptom already known: \`Samsung 65-inch, may sound pero black screen po—noted. Taga-saang city po kayo para ma-check ang home-service area?\`
3. Price depends on issue: \`Depende po sa actual sira at inspection. Iche-check muna ng technician bago magbigay ng exact price. Ano pong model ng TV?\`
4. Agreed home visit: \`Bago po magpa-home service, ₱1,000 po ang check-up fee kapag pupunta ang technician sa bahay. Iko-confirm pa po ng staff ang schedule.\` **Fee treatment after repair remains under review.**
5. Video received: \`Natanggap po namin ang video. Staff po namin ang magre-review; paki-hintay po sa update.\` Only say this once the webhook actually confirms receipt. Do not claim it was forwarded unless that action completed.
6. Unsupported part / uncertain repair option: \`Sa brand-new replacement po kami may approved offer. Iche-check ko po kung may ibang option; staff po namin ang sasagot sa inyo.\`
7. Warranty/backjob: \`Pasensya po sa abala. Para ma-review nang tama ang warranty concern, ipapasa ko po ito sa staff namin.\`
8. Discount: \`Iche-check po namin ang request ninyo. Staff po namin ang makakausap ninyo tungkol sa presyo.\`
9. Schedule: \`Pwede po kayong mag-request ng schedule sa form. Iko-confirm po ng staff ang available slot; hindi pa po final ang appointment.\`
10. Temporary AI outage: \`Noted po, salamat sa paghihintay. Staff po namin ang tutuloy sa concern ninyo.\` Use at most once per thread and alert on rising frequency.

**These are draft review examples; never represent them as actual quoted customer transcripts, approved specific price offers, or confirmed bookings.**

## Operational findings to validate before go-live

The Claude report attributes these issues to 20 October 2026 logs; independent evidence should be retained for audit:
- Repeated identical fallback messages during LLM outages. Add a fallback-count and threshold alert.
- Empty model replies and rejected request parameters; require nonempty answers and a tested provider/model token budget.
- Excessively low RPM throttle; check actual per-provider quotas rather than assuming a higher limit is safe.
- Bot scheduled only at night; audit the Render \`BOT_SCHEDULE\` and business-hours expectations.
- Multiple Meta apps taking thread control; audit and explicitly select messaging owner before customer-wide activation.
- Proactive follow-ups require Meta-policy review and strict 24-hour messaging-window enforcement.
- Existing \`src/config.js\` **defaults** differ from the report: \`HANDOFF_RESUME_HOURS=72\` vs claimed 6, \`FOLLOWUP_MAX=2\` vs claimed 1, second video follow-up enabled by default vs claimed disabled. Render overrides may differ from defaults; no definitive live value was obtained here.

## Do not import unapproved draft rules

The reported reserved backjob slot, 48-hour backjob SLA, 6 PM cutoff, 10 km insertion radius, two-hour ETA windows and SMS campaign templates are only **proposals** unless explicitly approved by the owner.

## Outstanding decisions for JMAGS owner

1. For home service: is ₱1,000 **credited/deducted from the final repair price**, or **waived** if the repair proceeds? How is this calculated at the point of billing?
2. Is the ₱500 32"/40" checkup rate still offered for any **non-home-service** scenario?
3. Priority booking: ₱800, ₱1,000 or disabled?
4. Confirm customer-facing \`staff po namin\` everywhere; keep actual internal agent/technician assignment names only in staff tools.
5. Which staff role approves/communicates the confirmed service date and booking? Is confirmation recorded through the form, dispatcher, or CRM?
6. Confirm the intended 6-hour handoff reset, 1 generic follow-up, disabled second video follow-up, and Page thread-control owner.

**Go-live gate:** do not enable \`BOT_ENABLED\` or customer external-AI routing merely because this document exists. Use separate test accounts, privacy notice/consent where needed, validated prices, appropriate Meta messaging permissions and a human fallback.
