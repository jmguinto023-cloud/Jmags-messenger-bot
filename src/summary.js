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
  };
}

module.exports = { summarizeConversation };
