# Booking confirmation on Messenger

When a customer submits the booking form, this bot sends **one** Messenger message
that says Regular or Priority and asks them to reply `AGREE`. It does not send SMS.
JMAG's Operations still reads the Netlify submission the same way as now. Do not
change that. The `jmags-website` repo is not this form; leave it alone.

The live form is https://jmagscutomerform.netlify.app (`name="booking"`). It already
asks willing-to-wait and posts the fields to Netlify Forms. It also tries the
Supabase `ops-booking-intake` function, but that call has no API key, and the
Messenger ping only runs when Supabase returns a booking id. The reliable trigger
is a Netlify form-notification webhook to this bot.

## Why the link is signed

The form does not know the customer's PSID or which Page they came from. A raw
`?psid=` could be edited to message someone else. Every link the bot sends, and
any link staff generate, carries three query fields:

- `psid` — the Page-scoped id of the person who was just chatting
- `page` — `sanpablo` (JMAG's Appliances) or `cavite` (Jmag's Appliances Cavite)
- `token` — HMAC of that pair. A swapped PSID or Page does not verify.
- `ref` — the older signed PSID, still there so the form's existing browser call keeps working

Example:

```text
https://jmagscutomerform.netlify.app/?psid=1234567890&page=sanpablo&token=v1.sanpablo.1234567890.SIGNATURE&ref=1234567890.SIGNATURE
```

The bot adds these whenever it sends `BOOKING_FORM_URL`. Staff who need a link for
one known PSID, while logged into the dashboard or with the admin token:

```text
GET /admin/booking-link?psid=PSID&page=sanpablo
Authorization: Bearer ADMIN_TOKEN
```

`page=cavite` uses the Cavite Page token. A plain link with no token is not a
promise to message whoever typed a PSID into the form.

If the submission has no valid token, the bot may match `mobile` to a number it
already stored: a mobile the customer themselves typed in that Messenger chat, or
exactly one job/booking row that has both that phone and a PSID. Zero matches or
more than one match: nobody is messaged, and staff get a flag. Set
`BOOKING_PHONE_MATCH=false` to turn this fallback off. A bad token never falls
through to the phone match.

## What the customer receives

Regular (`willingToWait=yes`, or service REGULAR):

> Salamat po sa booking, [Name]! 😊 Regular service po kayo sa [date]. Tatawag po ang staff namin anytime 9AM-5PM sa araw na iyon. Paki-reply po ng AGREE para ma-confirm.

Priority (`willingToWait=no`, or service `PRIORITY` / `PRIORITY (+P1,000)`):

> Salamat po sa booking, [Name]! 😊 Priority service po kayo (+P1,000) sa [date], mauuna po kayo sa line-up. Paki-reply po ng AGREE para ma-confirm.

`willingToWait` wins when both fields are present. The message says "staff po namin"
and never names a technician. It is sent even when that Page's on/off switch is OFF
and when `BOT_ENABLED` is off.

After the message goes out, the bot stops chatting in that thread. `AGREE` is
recorded and answered once with "Salamat po, confirmed na po ang booking ninyo."
Anything else is left for staff. `GET /admin/booking-confirms` (dashboard login or
admin token) lists sends, AGREEs, and staff flags.

The same Netlify submission is never sent twice (retries included). The same
person, Page, date, and service type is not messaged again for 36 hours. A browser
confirm and the webhook for that same booking collapse into one message. A later
booking on a different date is a new message.

## 24-hour window

The send uses `messaging_type: RESPONSE` and no message tag. If the customer's last
Messenger message is older than `REPLY_WINDOW_HOURS` (default 23.5, inside Meta's
24 hours), the bot does **not** send. It logs a warning and flags staff
(`bookingNeedsStaff` on the chat, or an unmatched row on `/admin/booking-confirms`).
A Netlify retry of that same submission is checked again, so a customer who messages
the Page and is back inside the window can still get the confirm.

An approved tag, later, would look like this and only after Meta App Review grants it:

```json
{
  "messaging_type": "MESSAGE_TAG",
  "tag": "CONFIRMED_EVENT_UPDATE",
  "recipient": { "id": "PSID" },
  "message": { "text": "..." }
}
```

`CONFIRMED_EVENT_UPDATE` is for a non-promotional update about an event the person
registered for. It is not for promos. This build does not send that tag.

## 1. Render environment

On the `jmags-messenger-bot` service, set these and redeploy only after this PR is
reviewed. Do not deploy from this change by itself.

| Variable | Purpose |
|---|---|
| `NETLIFY_WEBHOOK_SECRET` | Shared with Netlify. Required. Empty rejects every webhook. `GET /health` shows `bookingWebhook: "configured"` or `"missing"` and does not reveal the value. |
| `BOOKING_REF_SECRET` | Signs `token` and `ref`. Empty uses `APP_SECRET`. Rotating it invalidates links already sent. |
| `BOOKING_CONFIRM_ENABLED` | Empty keeps the confirm on. `false` stops sends. |
| `BOOKING_PHONE_MATCH` | Empty keeps the phone fallback on. `false` requires a signed link. |
| `BOOKING_FORM_URL` | `https://jmagscutomerform.netlify.app/` |
| `CAVITE_PAGE_ACCESS_TOKEN` | Required for Cavite confirms. Without it, a Cavite booking is flagged and is not sent with the San Pablo token. |

`BOOKING_BOT_KEY` is unused. Page is `page=sanpablo` or `page=cavite` on the one bot.

## 2. Netlify webhook

In the form site: **Forms → Submission notifications → Add notification → Outgoing webhook**.

- Event: new (verified) form submission, form **booking**
- URL: `https://jmags-messenger-bot.onrender.com/booking/netlify`
- JWS secret token: the same string as `NETLIFY_WEBHOOK_SECRET`

The bot checks `X-Webhook-Signature`: HS256, `iss` = `netlify`, and `sha256` equal to
the hex SHA-256 of the **raw** body.

If that screen has no JWS field, use one of these instead of putting the secret in
the URL when you can:

- Header `Authorization: Bearer <NETLIFY_WEBHOOK_SECRET>`
- Header `X-Webhook-Secret: <NETLIFY_WEBHOOK_SECRET>`
- Last resort: `https://jmags-messenger-bot.onrender.com/booking/netlify?key=<NETLIFY_WEBHOOK_SECRET>`

A query secret can show up in access logs. Prefer the JWS field.

A bad signature returns 401. A Graph outage returns 502 so Netlify retries. A
deliberate skip (duplicate, outside 24h, no identity) returns 200 so Netlify does
not retry forever.

## 3. Hidden fields on the form

The form source is not in this repo. Paste this inside `<form id="f">`, next to the
other hidden inputs:

```html
<input type="hidden" name="psid" id="jmags-psid" value="">
<input type="hidden" name="page" id="jmags-page" value="">
<input type="hidden" name="token" id="jmags-token" value="">
<input type="hidden" name="ref" id="jmags-ref" value="">
```

Paste this script so it runs on load (before the customer can submit). It copies the
signed query into those fields. Netlify then includes them in `data` because submit
already posts `new FormData(form)`.

```html
<script>
(function () {
  var q = new URLSearchParams(location.search);
  [['jmags-psid', 'psid'], ['jmags-page', 'page'], ['jmags-token', 'token'], ['jmags-ref', 'ref']]
    .forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      var value = q.get(pair[1]) || '';
      if (el && value) el.value = value;
    });
})();
</script>
```

The in-app browser rebuilds the URL in `chromeURL()` and would drop these on the
jump to Chrome. Inside `chromeURL()`, after the existing `bookingRef` line, add:

```js
for (const k of ['psid', 'page', 'token', 'ref']) {
  const v = new URLSearchParams(location.search).get(k);
  if (v) u.searchParams.set(k, v);
}
```

Do not remove the Netlify `fetch('/')` or the Operations dashboard. The webhook
fires when Netlify accepts the submission, including when the Supabase call fails.

## What stays quiet

- No SMS from this path.
- No second chat after the confirm, including when the Page switch is on.
- No untagged send outside 24 hours.
- No message to a PSID that did not come from a valid token, a legacy `ref`, or one unique stored mobile.
