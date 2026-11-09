# Booking form → Messenger confirmation

What changes on the customer form (jmagscutomerform.netlify.app) so the bot can send the
YES/NO message on Messenger. The booking itself still goes to JMAG's Operations exactly as now.

## 1. Replace the Time dropdown

Delete the **Time \*** dropdown. Put this question in its place (required):

```html
<fieldset class="wait-question" required>
  <legend>Willing to wait po ba kayo within the day? *</legend>
  <label><input type="radio" name="willingToWait" value="yes" required>
    YES (willing to wait any time within that day)</label>
  <label><input type="radio" name="willingToWait" value="no">
    NO (automatic +₱1,000, Priority po kayo)</label>
</fieldset>
```

## 2. NO = automatic Priority

```js
document.querySelectorAll('input[name="willingToWait"]').forEach((r) => r.addEventListener('change', () => {
  const no = document.querySelector('input[name="willingToWait"]:checked')?.value === 'no';
  // Use the form's own Service type state here: select PRIORITY on NO, REGULAR on YES.
  setServiceType(no ? 'PRIORITY' : 'REGULAR');
}));
```

Save `willingToWait` ("yes"/"no") with the booking sent to JMAG's Operations. Service type stays
PRIORITY (+₱1,000) or REGULAR as today, so the line-up and the wrong-price check keep working.
Visit time is no longer chosen by the customer: YES = any time 9 AM–5 PM, NO = first in line.

## 3. After the booking is saved, trigger the Messenger message

The bot adds `?ref=...` (and `&b=...` when BOOKING_BOT_KEY is set) to every form link it sends.
Read it on page load and post it back after a successful submit:

```js
const params = new URLSearchParams(location.search);
const BOTS = {
  '': 'https://jmags-messenger-bot.onrender.com',   // San Pablo (default)
  // cavite: 'https://<cavite-bot>.onrender.com',
};

async function jmagsAfterSubmit({ name, willingToWait, bookingId }) {
  const bot = BOTS[params.get('b') || ''] || BOTS[''];
  try {
    const r = await fetch(`${bot}/booking/submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: params.get('ref') || '', name, wait: willingToWait, bookingId }),
    });
    const out = await r.json();
    if (!out.sent && out.messengerUrl) showConfirmButton(out.messengerUrl);
  } catch { /* booking is already saved; the Messenger message is a bonus */ }
}

function showConfirmButton(href) {
  const a = document.createElement('a');
  a.href = href;
  a.className = 'btn';
  a.textContent = 'I-confirm po sa Messenger';
  document.querySelector('#thank-you, .thank-you, form')?.append(a);
}
```

- Link came from the bot → message is sent automatically, no button.
- Link pasted by staff (no `ref`) → the thank-you screen shows **I-confirm po sa Messenger**.
  Tapping it opens the Page chat and the bot sends the same YES/NO message.

## 4. What the bot sends

YES:
> Hello po mam/sir {name}, Dahil pinili nyo po ang YES, ibig sabihin willing to wait po kayo sa schedule nyo within that day. Don't worry po, from 9am to 5pm marereceive nyo po ang tawag ng technician namin as soon as possible. Reply "AGREE" lang po kayo sa message para ma-confirm po. Maraming salamat po sa pagtitiwala. Happy to serve you all 🙂

NO:
> Hello po mam/sir {name}, Dahil pinili nyo ang "NO" option, automatic po Priority kayo, kayo po ang mauuna sa line-up. Today! Reply "AGREE" po sa chat para maconfirm po namin. Maraming salamat po. Happy to serve you all 😊

When the customer replies AGREE the bot answers with a short "Confirmed na po" line, marks the
chat confirmed, and sends a push alert to the dashboard. `GET /admin/booking-confirms` (dashboard
login or admin token) lists every confirmation and whether AGREE came back.

## 5. One-time Meta setting

In the Meta app → Messenger → Webhooks, the Page subscription must include
**messaging_referrals** (for the m.me button). `messages` and `messaging_postbacks` are already on.
