'use strict';
// Staff verdict on a customer video -> the one message the bot sends back.
// Staff never type into Messenger; they pick a verdict (and a price) on the dashboard.
// Never names the technician and never confirms a schedule: the bot asks for availability.

const VERDICTS = ['repairable', 'not_repairable', 'need_video'];
const MAX_PRICE = 200000;
const MAX_NOTE = 200;

function peso(n) {
  return `₱${Number(n).toLocaleString('en-US')}`;
}

function cleanNote(note) {
  return String(note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
}

function parsePrice(price) {
  const n = Number(String(price == null ? '' : price).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PRICE) return 0;
  return Math.round(n);
}

// Returns { ok: true, text, price } or { ok: false, error }.
function composeVerdict({ verdict, price, note } = {}) {
  const kind = String(verdict || '');
  if (!VERDICTS.includes(kind)) return { ok: false, error: 'Pumili muna ng verdict.' };
  const extra = cleanNote(note);
  const tail = extra ? ` ${extra}` : '';
  if (kind === 'repairable') {
    const amount = parsePrice(price);
    if (!amount) return { ok: false, error: 'Ilagay ang presyo (₱).' };
    return {
      ok: true,
      price: amount,
      text: `Good news po! Na-review na po ng staff namin ang video at pwede pa po itong maayos 😊 `
        + `${peso(amount)} po ang total ng repair, all in na po. `
        + `Mas mainam po na maagapan agad dahil ang pagpapaliban ay maaaring makadagdag sa sira ng TV.${tail} `
        + 'Kailan po kayo available para ma-check namin ang schedule?',
    };
  }
  if (kind === 'not_repairable') {
    return {
      ok: true,
      price: 0,
      text: 'Pasensya na po, na-review na po ng staff namin ang video at sa kasamaang palad hindi na po ito maaayos '
        + `ng technician namin.${tail} Salamat po sa pagpapadala, at nandito pa rin po kami kung may iba pa kayong kailangan 🙏`,
    };
  }
  return {
    ok: true,
    price: 0,
    text: 'Salamat po sa video! Para makasiguro po ang staff namin, pakisend po ulit ng mas malinaw na video '
      + `habang nakabukas ang TV.${tail}`,
  };
}

module.exports = { composeVerdict, parsePrice, cleanNote, VERDICTS, MAX_PRICE, MAX_NOTE };
