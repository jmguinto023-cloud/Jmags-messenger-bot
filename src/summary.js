'use strict';
// Pull TV size, brand, problem, and location out of the chat at the moment a photo or video arrives.

const BRANDS = ['samsung', 'tcl', 'lg', 'sony', 'panasonic', 'skyworth', 'hisense', 'konka', 'haier', 'sharp', 'xiaomi', 'philips', 'devant', 'coocaa'];

function brandLabel(b) {
  return b.length <= 3 ? b.toUpperCase() : b.charAt(0).toUpperCase() + b.slice(1);
}

function summarizeConversation(history) {
  const text = (history || []).map((h) => h.content || '').join('\n');
  const sizeM = text.match(/\b(\d{2})\s*(?:["”]|inch(?:es)?|in\b)/i);
  const brand = BRANDS.find((b) => new RegExp(`\\b${b}\\b`, 'i').test(text));
  let problem = '';
  if (/backlight|no visual|walang display|no display|black screen|walang ilaw/i.test(text)) problem = 'no display / backlight';
  else if (/basag|cracked|smashed|broken lcd|\blcd\b/i.test(text)) problem = 'cracked or LCD';
  else if (/gumuguhit|flicker|bar line|\blines\b/i.test(text)) problem = 'lines / flicker';
  const loc = text.match(/\b(biñan|binan|cabuyao|san pablo|imus|dasmariñas|dasmarinas|manila|laguna|cavite|batangas|general trias|sta\.?\s*rosa|santa rosa|calamba|lipa|quezon city|makati|pasig|taguig|parañaque|paranaque)\b[^.\n]{0,20}/i);
  return {
    size: sizeM ? `${sizeM[1]}"` : '',
    brand: brand ? brandLabel(brand) : '',
    problem,
    location: loc ? loc[0].replace(/\s+/g, ' ').trim() : '',
    name: chatCustomerName(history),
  };
}

const NAME_STOP = new Set([
  'po', 'opo', 'sir', 'maam', 'mam', 'lang', 'dito', 'from', 'taga', 'sa', 'ng', 'na',
  'and', 'at', 'the', 'my', 'yung', 'ang', 'naman', 'rin', 'din', 'ito', 'iyan', 'yan',
]);

// A name the customer stated themselves. Profile lookup is separate.
function chatCustomerName(history) {
  const text = (history || [])
    .filter((h) => h && h.role === 'user')
    .map((h) => String(h.content || ''))
    .join('\n');
  const m = text.match(/(?:pangalan ko(?: po)?(?: ay)?(?: si)?|ako(?: po)? si|my name is|name\s*[:\-])\s+([^\n]{2,80})/i);
  if (!m) return '';
  const chunk = m[1].split(/[,.|]/)[0];
  const kept = [];
  for (const raw of chunk.trim().split(/\s+/)) {
    const word = raw.replace(/[^A-Za-zÀ-ÿ.'-]/g, '');
    if (!word) break;
    const low = word.toLowerCase();
    if (NAME_STOP.has(low) || BRANDS.includes(low)) break;
    kept.push(word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    if (kept.length === 4) break;
  }
  if (!kept.length || kept[0].length < 2) return '';
  return kept.join(' ');
}

function firstCustomerSnippet(history) {
  for (const h of history || []) {
    if (!h || h.role !== 'user') continue;
    const text = String(h.content || '')
      .replace(/\[Customer sent a (?:video|photo)[^\]]*\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

function customerLabel(name, last4) {
  const named = String(name || '').trim();
  if (named) return named;
  const tail = String(last4 || '').slice(-4);
  return tail ? `Customer ••${tail}` : 'Customer';
}

module.exports = { summarizeConversation, chatCustomerName, firstCustomerSnippet, customerLabel };
