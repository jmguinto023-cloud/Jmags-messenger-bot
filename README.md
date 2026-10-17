# JMAG's Messenger bot (developer notes)

Ivan-style auto-reply for the JMAG's Appliances Facebook Page, built only on Meta's official
Messenger Platform (webhooks + Send API + Conversation Routing). Node.js 20, **zero npm dependencies**.

```
npm test            # 27 automated tests (mock Graph API + mock LLM, no internet)
npm run simulate    # end-to-end: real server process + mocks + 3 Taglish customer messages
npm run sync-prompt # refresh prompts/system-prompt.md from ../ivan-bot-system-prompt.md
npm start           # run (needs env, see .env.example)
```

## How it works
- `GET /webhook` – Meta verification (hub.mode / hub.verify_token / hub.challenge).
- `POST /webhook` – checks `X-Hub-Signature-256` (HMAC-SHA256 with APP_SECRET), answers 200 at once,
  then processes in the background. Ignores delivery/read/reaction events and Meta retries (dedupe by mid).
- Customer text → 3 s batching → `typing_on` → LLM (OpenAI-compatible `/chat/completions`, system prompt from file
  + Manila date/time) → Send API `messaging_type: RESPONSE`. Outgoing text is plain (Markdown markers stripped).
  A timeout or 5xx sends a canned fallback that is not written into the history sent back to the model; a second
  failure in a row hands off to the Page Inbox. An HTTP 4xx from the LLM is logged at ERROR and does not hand off.
  A 400 that says temperature is rejected is retried once without temperature, then omitted for the process.
- Schedule form (`BOOKING_FORM_URL`, default the Netlify form) is injected into the system prompt. The model sends it
  in the same reply when the customer agrees, asks to be scheduled, or gives a date/time — not on a first price question,
  and not with a `[HANDOFF]` tag. A reply that contains the form URL is delivered and does not pass thread control.
- Handoff when: model prints `[HANDOFF: reason]` (stripped before sending), customer sends image/video/audio/file
  (stickers are not handoffs), or keywords (tao, agent, tawag, call, ivan…; "bot ka ba / tao ka ba" goes to the AI).
  Sends one holding line → `POST /{page}/pass_thread_control` to Page Inbox `263902037430900` → optional
  "Needs Ivan" custom label → silent in that chat.
- Human takeover: a `message_echo` whose `app_id` is not ours (or missing) pauses that chat for HUMAN_PAUSE_HOURS.
- Resume: `messaging_handovers` with `new_owner_app_id` = our app, or HANDOFF_RESUME_HOURS later, or
  `POST /admin/resume?psid=` (Bearer ADMIN_TOKEN).
- Never sends outside the 24 h window (REPLY_WINDOW_HOURS=23.5). No proactive follow-ups at all.
- Safety: BOT_ENABLED (default false), BOT_TEST_PSIDS allowlist, BOT_ACTIVE_HOURS / BOT_ALWAYS_ON_DAYS (Asia/Manila).
- Storage: `DATA_DIR/state.json` (atomic writes); chats purged after DATA_RETENTION_DAYS of inactivity.

## Deploy (Render)
`render.yaml` = Docker web service, Starter plan, Singapore, `/health` check, 1 GB disk at `/data`, `autoDeploy: false`.
Secrets are `sync: false` (typed into the dashboard). See `SETUP-FOR-JM.md` for Meta-side steps.

## Known limits / to verify in live testing
- Echo `app_id` value for replies Ivan types in Business Suite (expected: Inbox app id or absent – both pause the bot).
- Business Suite automations (instant reply etc.) also produce echoes not from our app and would pause the bot:
  turn them off at go-live or add their app id to IGNORE_ECHO_APP_IDS.
- Mark as done often does not send a handover webhook. A later customer message arrives as a normal `messaging`
  event (not standby); if this bot was the one that passed thread control, that message clears the handoff and the bot replies.
  A human reply from the Page Inbox still pauses the chat. HANDOFF_RESUME_HOURS still covers a handoff this bot did not start.
- Custom Labels API permission list in Meta's docs is unclear; label is optional and failures are only logged.
