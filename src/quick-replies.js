'use strict';
// Narrow zero-token answers. Never invent a diagnosis or confirmed appointment.
const { CHECKUP_FEE_PLAIN } = require('./estimate');

function quickReply(userText, cfg, thread = {}) {
  const text = String(userText || '').trim().toLowerCase();
  if (!text || text.length > 180 || /\[customer sent|\[video|\[photo/i.test(text)) return '';
  if (/(?:complain|reklamo|warranty|garantiya|refund|backjob|broken again|nasira ulit|scam|urgent)/i.test(text)) return '';
  if (/\b(?:at saka|pero|however|also|tsaka)\b/i.test(text)) return '';
  if (/^(?:hello|hi|hey|good (?:morning|afternoon|evening)|kumusta|magandang (?:umaga|hapon|gabi))(?: po|!|\.|\?)?$/i.test(text)) {
    return 'Hello po! JMAGS Appliances po ito 😊 Ano pong concern nila sa TV?';
  }
  // No hours/address claims until those business details are independently approved.
  if (/^(?:paano (?:po )?mag(?:book|pa-book)|(?:pwede|pede) (?:ba |po )?mag(?:book|pa-book)|how (?:to|can i) book|booking form|pa-book po)[\s?!.,]*$/i.test(text)) {
    const url = String(cfg.bookingFormUrl || '').trim();
    if (!url) return '';
    return 'Pwede po mag-request ng home service dito: ' + url +
      ' Iko-confirm po ng JMAGS staff ang schedule bago maging final ang booking.';
  }
  if (/^(?:magkano|hm|how much) (?:po )?(?:ang )?(?:checkup|check-up)(?: fee)?[\s?!.,]*$/i.test(text)) {
    return CHECKUP_FEE_PLAIN;
  }
  void thread;
  return '';
}

module.exports = { quickReply };
