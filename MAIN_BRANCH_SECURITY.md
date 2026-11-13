# JMAGS Main Branch protection & Cavite deployment policy

**Production Main Branch Render service**: `srv-db9urle1egvs738n7gs0` (`jmags-messenger-bot`).  
**Main Facebook Page**: `102622881557025`.  
**Cavite Facebook Page**: `1237499962773846`.

## Main Branch production lock

Set `JMAGS_MAIN_PROTECTED=true` on the **Main Branch service only**. With this lock enabled, code must:

- Pin Main's Page ID to `102622881557025`, even if an operator accidentally changes `PAGE_ID`.
- Read Main's credential **only** from `PAGE_ACCESS_TOKEN`. Never borrow Cavite's token or read it from `PAGES`.
- Ignore every Cavite webhook, its supplied token, and all extra Pages in `PAGES` without touching customer state.
- Preserve Main's historical bare-PSID storage keys; never migrate/reset `/data` or customer history.
- Leave `BOT_ENABLED=false`; the approved one-time welcome/FAQs and booking confirmations remain independently configured.
- Print a short non-secret startup marker: `Main Branch protection: ON`.

The application prevents `PAGES` from overriding the primary Page even when this lock is not set. If Cavite and Main tokens are accidentally identical, the secondary token is ignored. Webhook replay IDs are Page-scoped.

**This protects against accidental branch-configuration interference, not against deliberate administrator changes.** A Render admin can still overwrite `PAGE_ACCESS_TOKEN` or disable the lock. Use restricted service access, credential change approval, version control and backups for additional operational protection.

## Cavite isolation: do NOT deploy Cavite onto the Main service

Cavite requires its own Render service with:

1. A separate environment variable namespace and a distinct **Cavite Page access token** validated against Page `1237499962773846`.
2. Its own persistent disk / customer-data storage and no Mount or credential access to Main's `/data`.
3. Its own webhook subscription / independently authorized Meta app or a verified secure routing layer that directs events to isolated services; never change the existing Main webhook before a tested handoff.
4. No shared `PAGE_ACCESS_TOKEN`, `PAGE_ID`, or staff/customer secrets. An optional shared OpenAI billing account does not grant access to Main customer data.
5. Independent build/deploy/rollback, tests and access controls. Do not point the Cavite service at Main's database, `/data`, or Messenger App settings unless independently scoped and approved.

Before releasing Cavite, verify that Main continues to deliver a welcome from a new account and a one-time FAQ, then verify Cavite sends with its own token. Check Main's live logs after Cavite is enabled. Never use `replace=true` when changing Render environment variables without an explicit full review.

## Main Branch recovery baseline

Previously verified Main welcome log: November 13, 2026 10:37 AM Philippine time. Main API token and first-inquiry greetings were working. Preserve the last healthy Main deployment and stored user data for rapid rollback.

**Rollback guidance:** If protection deployment causes Main to stop sending, redeploy the last healthy code revision after verifying the deployed Main token still belongs to Page `102622881557025`; do not roll back by overwriting customer state. If a Page token is wrong, fix just the credential securely, then redeploy.

## Release checklist

- [ ] GitHub branch-protection/security regression suite passes, including mixed-page webhook isolation.
- [ ] Main Render startup reports protection ON and `BOT_ENABLED=false`.
- [ ] Meta Send API success or bot send logs for Main after protected deployment.
- [ ] Cavite webhook not stored or answered by Main, even with a Cavite credential present.
- [ ] Main booking webhook still configured; existing customer threads intact.
- [ ] Changes classified as Completed, In Progress, Not Executed, or Failed based on evidence.

Never publish actual access tokens, app secrets, customer PSIDs, or conversation records in GitHub, screenshots, logs or chat.

## Owner-approved permanent JMAGS Main Branch bot standard (November 13, 2026)

**This section records the owner's standing instructions. Do not change this baseline unless the owner explicitly approves a revision.** Keep it in effect across maintenance, token rotation, deployment, code refactoring, future agents, and Cavite setup.

1. **Saved reply remains exactly as approved.** Staff sends:

   > Hello Mam/Sir eto po ang schedule form niyo para ma book na po kayo paki click ng link sa ibaba at fill upan para sa details salamat po 😊

   Do not require staff to paste a plain booking URL or replace this with a link-bearing saved-reply template.

2. **Automatic follow-up link is separate.** Detect the staff/Page Inbox `message_echoes` event for that saved reply. Send **one signed, customer-specific Main Branch booking URL in a separate Messenger message** addressed to the same PSID: `https://jmagscutomerform.netlify.app/` with signed page/customer parameters. Maintain 10-minute anti-duplicate protection and Meta's permitted messaging window. Do not interpret the bot's own outbound echo as another staff saved reply.

3. **Keep independent automations independent.** Main's one-time welcome/repeat-inquiry rules, fixed FAQ and location/home-service/monitor replies, optional video reminders, booking acknowledgements, and staff handoff remain separately controlled. **`BOT_ENABLED=false` is the approved setting for the continuous AI chatter**; do not turn it on to fix a booking-link issue. A legitimate staff answer may pause conversational automation but must not remove the independently approved saved-reply link function.

4. **Strict Main/Cavite isolation.** Keep `JMAGS_MAIN_PROTECTED=true`, Main Page ID `102622881557025`, Main's `PAGE_ACCESS_TOKEN`, its webhook and its persistent `/data` intact. Reject/ignore Cavite traffic in Main. Cavite Page ID `1237499962773846` and credentials, message rules, deploys, webhook configuration, and customer records must be managed independently. No cross-branch credential fallback, token overwrite, shared customer state, or unapproved webhook repointing.

5. **Credentials should be durable, not assumed immortal.** Prefer a securely held authorized Main Page token without a scheduled expiration when Meta supports it. Meta can still revoke tokens, permissions can change, and app settings can become invalid. Verify `/health` exposes `messengerAuth: valid` and use read-only monitoring to alert on failures. Never commit tokens, transmit secrets in chat, or silently replace the working token. Rotate/repair only the relevant Main credential with explicit owner authorization.

6. **Owner approval required for behavior changes.** Do not modify the saved reply, trigger phrases, reply templates, messaging windows, booking URLs, throttles, page mappings, secrets, automation switches, or user data unless the owner specifically approves that change. Bug repairs must be minimal, tested and reported with exact results; do not represent a proposed, untested, or unverified change as completed.

7. **Release regression gates.** Before any production behavior change, run the existing `npm test` suite, including `test/booking-confirm.test.js` and `test/main-branch-protection.test.js`. Preserve tests for: exact saved-reply trigger, separately delivered signed Main link, duplicate suppression, no send outside the Messenger window, no auto-trigger from bot echoes, Main/Cavite isolation, and continuous AI remaining off. After an authorized deploy, check Render health, Page token validity, and a real opt-in customer test. No live customer messages solely for testing without owner consent.

**Verification limit:** Source-code safeguards and monitoring cannot make a Meta token genuinely non-revocable or prevent every possible outage. They do prevent accidental code/config regressions and enable prompt detection. Maintain honest status labels: Completed only with execution and evidence; otherwise In progress, Not executed, or Failed.

## Cavite copied-bot rollout: owner's approved clone standard

- Separate Render service: `srv-dbr7sretlv9c73fnjkrg`, branch `feature/cavite-isolated-bot-20261113`; **never deploy to Main**.
- Enable `JMAGS_CAVITE_ONLY=true` and never enable `JMAGS_MAIN_PROTECTED` on Cavite. The Cavite-only lock pins Page `1237499962773846`, excludes Main Page `102622881557025`, and never uses `PAGE_ACCESS_TOKEN` as a Cavite fallback.
- Match Main's fixed one-time welcome, repeat-inquiry rules, keyword FAQs, video reminders, staff saved-reply trigger, 10-minute deduplication, signed personalized booking link, and booking confirmation logic; customize only Cavite Page identity and Cavite shop location. Keep the staff saved-reply phrase intact. Keep continuous `BOT_ENABLED=false`.
- Main and Cavite must use separate Meta Page credentials and preferably separate Meta Developer apps/webhook callback URLs; **do not change the existing Main app's webhook callback** during Cavite setup.
- Main and Cavite should have separate OpenAI project API keys under the same billing organization; never copy the Main API key into Cavite if a distinct key can be created. The AI account can be shared for billing only, with rate-limit/spend impact understood.
- Cavite requires dedicated persistent disk mounted to `/data` and `DATA_DIR=/data`, never Main's disk; ensure state survives redeploy before activating live replies.
- Store Cavite secrets only in Cavite Render settings, not in GitHub or chat: `APP_ID`, `APP_SECRET`, `VERIFY_TOKEN`, `CAVITE_PAGE_ACCESS_TOKEN`, optional AI credentials, and booking notification secret. Do not send a live customer message until correct Cavite Page identity and Meta webhook subscription are verified.
- Cavite Docker image must pass `npm test` at build time; if this fails, do not release. Verify Cavite Messenger auth, Page-scoped messaging, signed booking link and Main health **before and after** Cavite goes live.
- Do not claim completion until Main and Cavite tests show independent incoming webhook events and successful user-authorized replies. No automatic behavior changes without owner's explicit approval.
