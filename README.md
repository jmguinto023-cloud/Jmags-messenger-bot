# JMAG's Messenger bot (developer notes)

Ivan-style auto-reply for the JMAG's Appliances Facebook Page, built only on Meta's official
Messenger Platform (webhooks + Send API + Conversation Routing). Node.js 20. The only npm dependency
is `web-push`, used by the video-review app.

```
npm test            # 51 automated tests (mock Graph API + mock LLM, no internet)
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
- Handoff when: model prints `[HANDOFF: reason]` (stripped before sending), customer sends audio/file
  (stickers are not handoffs), or keywords (tao, agent, tawag, call, ivan…; "bot ka ba / tao ka ba" goes to the AI).
  Sends one holding line → `POST /{page}/pass_thread_control` to Page Inbox `263902037430900` → optional
  `NEEDS_IVAN_LABEL` custom label → silent in that chat.
- A photo or video does **not** pass thread control. The bot replies with a short acknowledgement
  (technician will review, then the next useful question), applies the inbox label
  (`NEEDS_IVAN_LABEL`, or creates "Video for review" when that is empty), and logs the attachment URL at WARN.
  Later text in the same chat is still answered. Every later model call still includes
  `[Customer sent a video at HH:MM - RECEIVED, forwarded to technician Ivan for review. You cannot view it, but it WAS received.]`.
  The bot must not say the file was missing or ask for a resend. A review-status question gets "Ivan is reviewing it, all-in price soon",
  plus the price-list range when brand and size are known. If the problem is only in the video and they ask for an estimate, that range is the answer.
  Any preliminary range also says a personal home-service check-up is more exact and names the check-up fee.
- If they ask how much the check-up is, the reply is only: ₱1,000 check-up fee (₱500 for 32" and 40" TVs), waived if they proceed with the repair.
- Once a video is in and they have given location and TV age, intake stops. One thank-you says Ivan is reviewing the video and will send the all-in price,
  then the free-tips message goes out once (`TIPS_MESSAGE` can replace it). After that the bot only answers what they ask.
- Chat messages sent to the model are merged when the same role speaks twice in a row, and trailing
  assistant turns (bot reply, echo, or a human reply recorded after the customer) are dropped so the
  request always ends on a user message. An attachment with no caption is sent as a received-media note
  (`[Customer sent a video at HH:MM - RECEIVED, ...]`, or photo).
- Human takeover: a `message_echo` whose `app_id` is not ours (or missing) pauses that chat for HUMAN_PAUSE_HOURS.
  The log line includes `app_id=...`. `PAGE_AI_APP_IDS` (comma-separated, default empty) lists Meta automation
  app ids. An echo from one of those ids is logged as `page AI echo ... app_id=... – not pausing` and does not
  start the pause. `IGNORE_ECHO_APP_IDS` still drops an echo before that check.
- A photo or video is saved to the dashboard and push even when the bot is not replying: standby (another app
  owns the thread), a human pause, or a handoff. The card says `bot not replying, standby/paused`. The same
  message mid is not saved twice. Standby never sends a Messenger reply.
- While a video is waiting on Ivan, "Ok na ba?", "Kamusta na?", "Wala pa ba?", and "Ano na?" are answered about
  that review (all-in price soon, and 09386369374 / 09267229506 if urgent). Bookings, cancellations, and slot
  facts older than 12 hours, or from before the latest video, are left out of the model context unless the
  customer brings them up. The bot never says "kayo po mismo nagsabi". An unclear line gets one question about
  the video under review.
- Resume: `messaging_handovers` with `new_owner_app_id` = our app, or HANDOFF_RESUME_HOURS later, or
  `POST /admin/resume?psid=` (Bearer ADMIN_TOKEN).
- Replies stay inside the 24 h window (REPLY_WINDOW_HOURS=23.5). A separate follow-up may go out when the
  bot's last message was a real reply and the customer has been quiet for FOLLOWUP_AFTER_MIN (default 120).
  At most FOLLOWUP_MAX (default 2) per conversation. The second is about 24 hours after the first, and only
  if the customer's last message is still within 23 hours. The line is one short Taglish note from the model
  (limited slots this week, no discount). If a video was requested and not sent, the follow-up reminds them.
  Nothing is sent when the thread is handed off, paused for a human, the bot is disabled, the PSID is outside
  BOT_TEST_PSIDS, or the customer already sent the booking form and said they filled it in.
  Blank BOT_ACTIVE_HOURS means the bot is always on (the process logs `hours=24/7`). Follow-ups are not
  limited by those hours. The check runs in-process every minute and the counters live in `/data`, so a
  restart does not send a second copy.
- Each turn is appended to `DATA_DIR/conversations.jsonl` (timestamp, sha256 prefix and last 4 of the PSID,
  role, text, handoff reason). Lines older than 60 days are dropped. `GET /admin/conversations?since=ISO`
  with `Authorization: Bearer ADMIN_TOKEN` returns them as JSON.
- Safety: BOT_ENABLED (default false), BOT_TEST_PSIDS allowlist, BOT_ACTIVE_HOURS / BOT_ALWAYS_ON_DAYS (Asia/Manila).
  An empty BOT_ACTIVE_HOURS is 24/7.
- Storage: `DATA_DIR/state.json` (atomic writes); chats purged after DATA_RETENTION_DAYS of inactivity.
- `GET /dashboard` is an installable PWA ("JMAG's Video Review" / "JMAG Videos") for phones and desktop
  Chrome or Edge. It asks for `DASHBOARD_PASSWORD` and sets an HttpOnly cookie. The list is newest first:
  name (or last 4 of the PSID), Manila time, size, brand, problem, location, the photo or video, and a link to
  the Page inbox. On a computer and on iPhone the button is the inbox list,
  `https://business.facebook.com/latest/inbox/all?asset_id={PAGE_ID}`.
  Putting the thread number in `selected_item_id` redirects to facebook.com
  (`bpn_id`, `asset_id`, `nav_ref=manage_page_ap_plus_default`) and shows
  "Sorry, this content isn't available right now", so that deep link is not the button.
  The card shows the customer name and **Kopyahin ang pangalan**, which copies it for the inbox search.
  `GET /admin/inbox-candidates?psid=` (Bearer `ADMIN_TOKEN`) returns the PSID, Graph conversation id,
  `/inbox/{digits}/` thread number, participant ids, the Page business id, and candidate URLs
  (`latest/inbox/all`, `latest/inbox/messenger`, with and without `bpn_id`, `facebook.com/messages/t/`).
  The Graph id and `link` come from
  `GET /{page-id}/conversations?platform=messenger&user_id={PSID}&fields=id,link,updated_time,participants`
  and are cached. The business id comes from `GET /{page-id}?fields=business`.
  On Android the button is a real link, chosen from the phone's User-Agent:
  `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.facebook.pages.app;end`.
  Package `com.facebook.pages.app` is the Meta Business Suite app. Tapping it copies the customer's name and shows
  `Nakopya ang pangalan ni {name} — i-paste sa search ng inbox`. A **Kopyahin ang pangalan** button does the same
  without leaving the page. The same button is on the desktop card. The name comes from the profile, or from the conversation participants when the profile
  has none. The phone does not show `facebook.com/{page}/inbox/{thread}`: that URL opens the personal Facebook feed.
  An intent whose data is `https://business.facebook.com/latest/inbox/...?selected_item_id=...` is also omitted.
  Samsung Internet unwraps that into the mobile site, whose thread pane fails, even with no `browser_fallback_url`.
  On iPhone and iPad the button stays the https Business Suite URL. On a computer, **Open in Messenger** remains.
  Each card has a small line with the thread id and the exact button URL. `m.me` is not used.
  The service worker is network-first for the dashboard page, script, and stylesheet, and reloads once when a new worker takes control.
  Mark reviewed drops it from the New count. The page refreshes every 30 seconds.
  The shell is cached by the service worker; the review list is network-first.
  New photos and videos can send a Web Push if `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set.
  Generate a pair with `npx web-push generate-vapid-keys` and put both values in the host env (never commit
  the private key). Subscriptions are stored in `/data/push-subscriptions.json`. The page has an
  **Enable notifications** button. If the keys are missing, the dashboard still loads and says notifications
  are not set up. Optional `ALERT_WEBHOOK_URL` receives `POST {psid, type, url, snippet, timestamp}` as well.

## Deploy (Render)
`render.yaml` = Docker web service, Starter plan, Singapore, `/health` check, 1 GB disk at `/data`, `autoDeploy: false`.
Secrets are `sync: false` (typed into the dashboard). See `SETUP-FOR-JM.md` for Meta-side steps.

## Known limits / to verify in live testing
- Echo `app_id` value for replies Ivan types in Business Suite (expected: Inbox app id or absent – both pause the bot).
- Business Suite automations (instant reply etc.) also produce echoes not from our app and would pause the bot:
  turn them off at go-live or add their app id to IGNORE_ECHO_APP_IDS.
- Set this bot as the Primary Receiver in Page Conversation Routing. If a standby message arrives and the chat
  was not just handed to the Page Inbox, the bot calls `take_thread_control` and logs the result. Error #27 means
  routing is not enabled yet; that is logged and the process keeps running.
- Mark as done often does not send a handover webhook. A later customer message arrives as a normal `messaging`
  event (not standby); if this bot was the one that passed thread control, that message clears the handoff and the bot replies.
  A human reply from the Page Inbox still pauses the chat. HANDOFF_RESUME_HOURS still covers a handoff this bot did not start.
- Custom Labels API permission list in Meta's docs is unclear; label is optional and failures are only logged.
