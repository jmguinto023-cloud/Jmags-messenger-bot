'use strict';

// Staff-reviewed vision draft only. Never sends a customer reply or downloads video.
const MAX_FRAMES = 4;
const MAX_FRAME_BYTES = 160000;
const MAX_NOTE_CHARS = 900;
const SYSTEM_PROMPT = [
  "You assist JMAG's Appliances technicians reviewing a customer-submitted TV/appliance video.",
  'Look ONLY at the supplied video still frames. They are samples, not the entire video.',
  'Do not claim to hear audio, observe movement, or know unseen frames.',
  'Never give a confirmed repair diagnosis, exact fault component, repair price, warranty, or guaranteed repair time.',
  'Do not guess customer name, address, phone number, or any sensitive personal details.',
  'If a hazardous condition may exist (smoke, sparks, exposed wiring, water damage), advise avoiding use and a qualified technician review.',
  'Write a concise Taglish INTERNAL DRAFT for a JMAGS technician to approve, not a message to the customer.',
  'Use exactly these headings: Nakikita sa frames:, Posibleng sanhi (hindi kumpirmado):, Next questions:, Staff review needed:.'
].join(' ');

function normalizeFrames(frames) {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  if (frames.length < 1 || frames.length > MAX_FRAMES) throw new RangeError('1–4 frames required');
  return frames.map((value) => {
    if (typeof value !== 'string') throw new TypeError('frame must be base64 JPEG');
    const s = value.replace(/^data:image\/jpeg;base64,/i, '').trim();
    if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
      throw new TypeError('invalid base64 JPEG');
    }
    const bytes = Buffer.from(s, 'base64');
    if (bytes.length < 4 || bytes.length > MAX_FRAME_BYTES) throw new RangeError('frame too large or empty');
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new TypeError('frame is not JPEG');
    }
    return 'data:image/jpeg;base64,' + s;
  });
}

async function draftVideoDiagnosis({ frames, customerConsented = false, staffRequested = false,
  externalAiAllowed = false, aiRouter } = {}) {
  if (!customerConsented) return { status: 'blocked', reason: 'customer consent required' };
  if (!staffRequested) return { status: 'blocked', reason: 'staff review required' };
  if (!externalAiAllowed) return { status: 'blocked', reason: 'external AI processing disabled' };
  if (!aiRouter || typeof aiRouter.complete !== 'function') throw new TypeError('AI router required');
  const images = normalizeFrames(frames);
  const content = [
    { type: 'text', text: 'Review these still frames from a customer-submitted repair video. No audio is provided.' },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
  ];
  const raw = await aiRouter.complete({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
    max_tokens: 350,
  });
  const draft = String(raw || '').trim().slice(0, MAX_NOTE_CHARS);
  if (!draft) throw new Error('empty video review draft');
  return { status: 'needs_staff_approval', draft, framesAnalyzed: images.length,
    audioAnalyzed: false, autoSent: false };
}

module.exports = { draftVideoDiagnosis, normalizeFrames, MAX_FRAMES };
