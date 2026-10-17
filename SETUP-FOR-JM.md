# Setting up the JMAG's Messenger bot: your steps only

Only you can do these steps, because Meta needs the owner of the JMAG's Page and business. Goji handles everything else (the code, hosting setup and testing).

- Use a computer, not a phone. Log in to Facebook with the account that has **full control** of the JMAG's Page and Business portfolio (ID **623731785816608**).
- Menu names were checked on Oct 17, 2026, against Meta's docs and recent setup guides. Meta renames buttons often. If something looks a little different, pick the closest match. Items marked **(not 100% sure)** are ones that couldn't be confirmed from Meta's official pages.
- **Never paste the App Secret or the Page token into Messenger, a chat or an email.** Put them straight into the hosting dashboard (Part E), or use the secure form Goji sends you.

---

## Part A: Developer account (about 5 minutes)
1. Go to **developers.facebook.com** and click **Get Started** (or **Log in**).
2. Follow the steps: accept Meta's terms, confirm your phone or email, and pick a role (any role is fine).

## Part B: Create the app (about 10 minutes)
3. Go to **developers.facebook.com/apps/creation/**.
4. **App details:** for the name, type `JMAGs Messenger Assistant`. For the contact email, use `jmguinto023@gmail.com`. Click **Next**.
5. **Use cases:** choose **"Engage with customers on Messenger from Meta"**. Click **Next**.
   - Meta now asks for a "use case" instead of the old "Business" app type. This use case is the Messenger one.
6. **Business:** choose **JMAG's** (your Business portfolio, ID 623731785816608). Click **Next**, then **Next**, then **Go to dashboard**.
7. In the left menu, open **App settings → Basic**:
   - Write down the **App ID**.
   - Leave the **App Secret** hidden for now. You'll copy it in Part E.
   - Fill in **Privacy Policy URL** (see Part F) and **Category**. Click **Save changes**.

## Part C: Connect the JMAG's Page and get the Page token (about 5 minutes)
8. In the left menu, open **Use cases**. Next to Messenger, click **Customize**, then **Messenger API Settings**. **(not 100% sure of the exact labels)**
9. Under **"Generate access tokens"**, click **Connect** / **Add Page**, pick the **JMAG's** Page, and allow everything Meta asks for. The list should include `pages_messaging`, `pages_manage_metadata` and `pages_show_list`.
10. Next to the Page, click **Generate**, tick **I understand**, and copy the token (it starts with `EAA…`). Treat it like a password.

## Part D: Webhook (do this when Goji says the server is live)
Goji will send you two things: the **Callback URL** (like `https://jmags-messenger-bot.onrender.com/webhook`) and the **Verify token**.
11. In the same **Messenger API Settings** page, find **"Configure webhooks"**. Paste in the **Callback URL** and the **Verify token**, then click **Verify and save**.
12. On the JMAG's Page row, click **Add subscriptions** (or **Edit**). Tick these fields, then click **Confirm**:
    - `messages`
    - `messaging_postbacks`
    - `message_echoes`
    - `messaging_handovers`
    - `standby`

    The row must show the number of fields, not "0 fields".
    *(`messaging_handovers` and `standby` are the ones Meta's Conversation Routing guide asks for. They let the bot know when Ivan takes over a chat.)*

## Part E: Hosting and AI accounts (in JMAG's name, you pay)
13. Make an account at **render.com**. Goji connects the code and picks the **Starter** plan (US$7/month, plus about US$0.25/month for storage).
14. Make an account with the AI provider you choose. Goji will suggest one and the costs aren't set yet. Create an **API key** there.
15. In Render, open the service, then **Environment**, and paste in the values from the table at the bottom of this page. Leave `BOT_ENABLED` set to `false`.

## Part F: Privacy policy page
16. Meta needs a public web page with your privacy policy. Goji drafted it in `privacy-policy.md`. Read it and correct anything wrong. Then publish it on the JMAG's website (the GoDaddy domain has to be renewed first) or on any free page you control. Put the link into **App settings → Basic → Privacy Policy URL**.

## Part G: Test with your own accounts (no approval needed yet)
17. In the app, open **App roles → Roles** and add **Ivan** as a **Tester**. He has to accept the invite at developers.facebook.com.
18. Message the JMAG's Page from your personal account and from Ivan's. Goji will put your IDs into `BOT_TEST_PSIDS` so the bot answers only you two. Run the test chats in the playbook (price, "mahal", photo, "bot ka ba?", booking).
19. **Turn the Meta Business Agent off and keep it off.** Also turn off the Business Suite instant reply and keyword replies before the bot goes live, or customers will get two answers.

## Part H: Business Verification (start early, it can take days)
20. Go to **business.facebook.com**, then **Settings**, then **Security Center** (sometimes listed under **Business info**). Click **Start verification**. **(not 100% sure. Meta moves this menu sometimes.)**
21. Enter the business name, address, phone and website **exactly** as they appear on your documents, such as a DTI or business permit, or a utility bill in the business name. Then upload the documents.
22. Confirm with the code Meta sends to your email or phone. A decision usually takes a few minutes to about 2 weeks.

## Part I: App Review for `pages_messaging` (after verification is approved)
23. In the app dashboard, open **App Review** (or **Publish / Review** in the left menu). Request **Advanced Access** for **`pages_messaging`**, plus anything else Meta lists with it (`pages_manage_metadata`, `pages_show_list`, `business_management`).
24. For each permission, write in one or two sentences what the bot does. Goji will give you the text. Then upload the **screen recording**: a video, because screenshots aren't accepted. It should show (a) logging in with Facebook and allowing the permission, and (b) a message sent to the Page and the bot's reply showing up in Messenger. Goji will give you a script to follow while you record.
25. Submit, and wait for Meta's email. Review time varies.
26. When it's approved, **publish** the app (the app's mode switch / **Publish** button). Meta only sends real customers' messages to apps that are published and have Advanced Access.

## Part J: Conversation routing (one setting)
27. Go to **Business Suite**, then **Settings**, then **Integrations**, then **Conversation routing**, and pick the **JMAG's** Page. Another way in: Facebook Page, then **Settings & privacy**, **Settings**, **Page setup**, **Messenger conversation routing**.
28. Set the **Default routing app** to **JMAGs Messenger Assistant (the bot)**, **not** "Inbox".
    - Why: Meta only lets the default app answer new chats. If the Inbox is the default, the bot can't reply at all.
    - The handoff still works: when the bot hands a chat to Ivan, the Inbox takes over, and as soon as Ivan replies from the Inbox, the bot goes quiet in that chat.
29. On the **Routing** tab, check that no **Campaign / Link / Social** route sends chats to another app (like Meta Business Agent), unless you want that.

**Go-live switch:** Goji sets `BOT_TEST_PSIDS` to empty and `BOT_ENABLED` to `true`, starting after-hours only (`BOT_ACTIVE_HOURS=18:00-08:00`) for the first week.

---

## Values Goji needs from you
| Name | Where you get it | Secret? |
|---|---|---|
| `APP_ID` | App settings → Basic | no |
| `APP_SECRET` | App settings → Basic → Show | **YES** |
| `PAGE_ACCESS_TOKEN` | Messenger API Settings → Generate (step 10) | **YES** |
| `PAGE_ID` | Already known: 102622881557025. Check that it matches the number under the Page name in step 10. | no |
| `LLM_BASE_URL`, `LLM_MODEL` | AI provider's docs (Goji can fill these in) | no |
| `LLM_API_KEY` | AI provider dashboard | **YES** |
| `VERIFY_TOKEN` | Render makes it automatically. Goji tells you what it is for step 11. | low |
| Your and Ivan's test IDs | They show up automatically after you each message the Page (step 18) | no |
| Business hours for soft launch | Your decision (for example 18:00–08:00, plus Sundays) | no |
