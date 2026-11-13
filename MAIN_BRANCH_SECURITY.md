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
