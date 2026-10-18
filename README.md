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
- Automated echoes never pause: a Page Inbox echo that matches a saved/instant-reply template ("Welcome sa JMAG",
  "Unit/Brand:", ...; add more with `AUTOMATED_ECHO_PATTERNS`, separated by `||`), arrives within
  `AUTOMATED_ECHO_WINDOW_MS` (default 10000) of the customer's message, or follows another automated echo that fast is
  logged as `automated echo ... not pausing`. A real human pause also ends after `HUMAN_IDLE_RESUME_HOURS` (default 2)
  with no new human reply. On startup, old pauses caused by automated echoes are cleared. `GET /admin/paused`
  (Bearer ADMIN_TOKEN) lists chats where the bot is silent.
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
  `POST /admin/forget?psid=` deletes that customer's thread, follow-up state, dashboard photo/video
  cards, `conversations.jsonl` lines, and any push subscription stored for that PSID, and returns the counts.
- `GET /` is a public page (no login) for JMAG's Appliances: home-service TV and appliance repair,
  service areas Cavite, Laguna, and Batangas, branches in San Pablo City, Laguna and General Trias, Cavite,
  the two shop phones, and a Messenger link to the Facebook Page. The page states that JMAG's Appliances is operated by JMAG ELECTRONIC SERVICE CENTER. The footer links to `/privacy` and `/data-deletion`.
- `GET /privacy` and `GET /data-deletion` are public (no login). Meta's data-deletion callback is
  `POST /data-deletion-callback` (`signed_request` checked with APP_SECRET). A valid request deletes that
  user id and returns `{url, confirmation_code}`. The status is shown at `/data-deletion?code=`.
  Live URLs: https://jmags-messenger-bot.onrender.com/privacy and
  https://jmags-messenger-bot.onrender.com/data-deletion.
  Conversation threads are purged after DATA_RETENTION_DAYS (default 90). Photo and video review cards
  are pruned after 60 days. A deletion request is completed within 30 days.
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
- After the standard reply to a customer video, if they send nothing more, a separate follow-up goes out
  VIDEO_FOLLOWUP_MINUTES later (default 30). A second, gentler one goes out VIDEO_FOLLOWUP2_MINUTES after the first
  (default 240; 0 disables it). At most two per video. The line asks only for the brand, size, issue, or location
  still missing, and offers to book a check-up when those are already known. No discount. It is not sent while
  BOT_ENABLED is off, while Ivan has the thread (human pause, handoff, or standby), after the customer replies,
  or outside the messaging window. From 9:00 PM to 7:00 AM Manila it waits until 7:00 AM if that is still inside
  the window. The schedule is stored on the thread, so a restart does not forget it. Each send, skip, and deferral
  is logged. The older quiet-customer follow-up stays off while this video follow-up is still open, and also
  if it was dropped because 7:00 AM would fall outside the messaging window.
- Each turn is appended to `DATA_DIR/conversations.jsonl` (timestamp, sha256 prefix and last 4 of the PSID,
  role, text, handoff reason). Lines older than 60 days are dropped. `GET /admin/conversations?since=ISO`
  with `Authorization: Bearer ADMIN_TOKEN` returns them as JSON.
- Safety: BOT_ENABLED (default false), BOT_TEST_PSIDS allowlist, BOT_ACTIVE_HOURS / BOT_ALWAYS_ON_DAYS (Asia/Manila).
  An empty BOT_ACTIVE_HOURS is 24/7.
- Storage: `DATA_DIR/state.json` (atomic writes); chats purged after DATA_RETENTION_DAYS of inactivity.
  Job orders, payments, parts, and ad spend live in the same file (`data.ops`) and are not purged with chats.
  `render.yaml` mounts a 1 GB disk at `/data` and sets `DATA_DIR=/data`, so this file survives restarts and deploys when that disk is attached to the service. The container disk by itself is ephemeral. There is no Postgres.
- `GET /dashboard` is an installable PWA ("JMAG's Video Review" / "JMAG Videos") for phones and desktop
  Chrome or Edge. It asks for `DASHBOARD_PASSWORD` and sets an HttpOnly cookie. The list is newest first:
  name, Manila time, size, brand, problem, location, and the photo or video.
  Under each card are the last 10 messages (customer, bot, or Ivan, Manila time) and a reply box.
  **Send** posts to `POST /dashboard/api/reply` (same dashboard cookie or admin token; unauthenticated requests are rejected).
  The send uses Messenger `messaging_type: RESPONSE` and no `HUMAN_AGENT` tag. Outside the reply window
  (`REPLY_WINDOW_HOURS`, default 23.5, inside Meta's 24 hours) the page shows
  `Lampas na sa 24 oras, i-reply sa Business Suite` and nothing is sent. Text over 2000 characters is rejected.
  A dashboard reply pauses that chat like Ivan typing in the inbox (`HUMAN_PAUSE_HOURS`, idle auto-resume),
  cancels a pending video follow-up, marks the card **Sinagot ni Ivan**, and is stored in the conversation.
  The echo of our own app id is ignored so the line is not saved twice. A double-tap sends once.
  Enter sends on a computer; a phone uses the button. Success or the error shows on the card.
  While the tab is visible the card history refreshes about every 15 seconds.
  **Kopyahin ang pangalan** copies the customer name for the inbox search.
  If the profile lookup fails, the card and the push say `Customer ••` plus the last 4 digits of the PSID.
  That label is not copied. **Kopyahin ang mensahe** copies the customer's first message instead.
  A name the customer states in chat (`ako si`, `pangalan ko si`, `my name is`) is used when the profile has no name.
  **Buksan ang Inbox** is only the inbox list,
  `https://business.facebook.com/latest/inbox/all?asset_id={PAGE_ID}`.
  Thread deep links (`selected_item_id`, the Android package intent, and `facebook.com/{page}/inbox/{thread}`)
  are not on the card. `GET /admin/inbox-candidates?psid=` (Bearer `ADMIN_TOKEN`) still lists those candidate URLs.
  The Graph id and `link` come from
  `GET /{page-id}/conversations?platform=messenger&user_id={PSID}&fields=id,link,updated_time,participants`
  and are cached. The business id comes from `GET /{page-id}?fields=business`.
  The service worker is network-first for the dashboard page, script, and stylesheet, and reloads once when a new worker takes control.
  Mark reviewed drops it from the New count.
  The shell is cached by the service worker; the review list is network-first.
  New photos and videos can send a Web Push if `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set.
  Generate a pair with `npx web-push generate-vapid-keys` and put both values in the host env (never commit
  the private key). Subscriptions are stored in `/data/push-subscriptions.json`. The page has an
  **Enable notifications** button. If the keys are missing, the dashboard still loads and says notifications
  are not set up. Optional `ALERT_WEBHOOK_URL` receives `POST {psid, type, url, snippet, timestamp}` as well.
- `GET /ops` is JMAG's Operations (same dashboard password and cookie as `/dashboard`). It is a mobile-first
  page with branch filters ALL / SAN PABLO / CAVITE and tabs Today, Jobs, Customers, Money, Finance, and Parts.
  The video page links to Operations, and Operations links back to Videos. Each video card has **Link to job**.
  Each job has a **Messenger chat** field and a **Status note for customer**.
  Real shop rows are not in git. After deploy, `POST /admin/ops/import` with `Authorization: Bearer ADMIN_TOKEN`
  accepts JSON `{ jobsCsv, paymentsCsv, adSpendCsv, customers, parts, bookings, expenses, otherIncome }`
  or `text/csv` with `?type=jobs|payments|ads`. The dashboard cookie cannot call import.
- A linked customer who asks `ano na status`, `kumusta na TV ko`, or `tapos na po ba` is answered from that job
  (status + the status note) in Taglish. With no link, the bot asks for the booking name and phone and answers
  only when both match the same customer. Anything unsure is handed to Ivan. Another customer's name, phone,
  and address are never sent. A problem reported again while the unit is inside warranty (job date + 3 months)
  gets the warranty end date, a request for the issue and a video, and a handoff, with no promise of coverage.
- `DAILY_STATUS_UPDATES` defaults off. When on, Under Repair jobs with a linked chat get one short Taglish
  update per Manila day from about 10:00 until 19:00, and only inside `REPLY_WINDOW_HOURS`. It opens with
  "Hello po 😊 Under repair pa din po ang status ng TV niyo." Repair work is "technician namin", not Ivan.
  A status answer labels the shop note "Note:". Outside the reply window the send is skipped and Today lists
  **Needs text update** with the phone. Paused and handed-off chats are skipped. Nothing is sent until the flag is turned on.

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
