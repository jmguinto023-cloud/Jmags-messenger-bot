'use strict';

// Isolated, opt-in Messenger video frame extraction. Never runs in the live bot by default.
const https = require('node:https');
const dns = require('node:dns');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_JPEG_BYTES = 160000;
const MAX_FRAMES = 4;
const FETCH_TIMEOUT_MS = 12000;
const FFMPEG_TIMEOUT_MS = 15000;

function validateMetaVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid media URL');
  let u;
  try { u = new URL(value); } catch { throw new Error('Invalid media URL'); }
  // Known actual JMAGS video attachment domains, not a wildcard for all Facebook URLs.
  if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port ||
      !/^video(?:-[a-z0-9-]+)?\.xx\.fbcdn\.net$/.test(u.hostname)) {
    throw new Error('Media host is not allowlisted');
  }
  return u;
}

function isPublicIPv4(ip) {
  const octets = String(ip).split('.').map(Number);
  if (octets.length !== 4 || octets.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a,b,c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: 4 }, (err, records) => {
    if (err) return callback(err);
    const safe = (records || []).find(r => r.family === 4 && isPublicIPv4(r.address));
    if (!safe) return callback(new Error('Media host has no public IPv4 address'));
    callback(null, safe.address, 4);
  });
}

async function downloadMetaVideo(url, outputFile, { request = https.request, maxBytes = MAX_VIDEO_BYTES } = {}) {
  const u = validateMetaVideoUrl(url);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_VIDEO_BYTES) throw new Error('Invalid video size limit');
  return new Promise((resolve, reject) => {
    let finished = false;
    function fail(err) { if (!finished) { finished = true; reject(err); } }
    const req = request(u, {
      method: 'GET', redirect: 'manual', lookup: publicOnlyLookup,
      timeout: FETCH_TIMEOUT_MS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), maxHeaderSize: 8192,
      headers: { Accept: 'video/mp4,video/quicktime,video/webm,application/octet-stream' },
    }, async (res) => {
      try {
        if (res.statusCode !== 200) { res.resume(); throw new Error('Media download rejected: HTTP ' + res.statusCode); }
        const mime = String(res.headers['content-type'] || '').split(';',1)[0].trim().toLowerCase();
        if (!['video/mp4','video/quicktime','video/webm','application/octet-stream'].includes(mime)) {
          res.resume(); throw new Error('Unsupported media content type');
        }
        const declared = Number(res.headers['content-length']);
        if (res.headers['content-length'] && (!Number.isFinite(declared) || declared > maxBytes)) {
          res.resume(); throw new Error('Video exceeds size limit');
        }
        let length = 0;
        const limiter = new Transform({
          transform(chunk, enc, callback) {
            length += chunk.length;
            callback(length > maxBytes ? new Error('Video exceeds size limit') : null, chunk);
          },
        });
        await pipeline(res, limiter, createWriteStream(outputFile, { flags: 'wx', mode: 0o600 }));
        if (!length) throw new Error('Empty video');
        if (!finished) { finished = true; resolve(length); }
      } catch (err) { fail(err); req.destroy(); }
    });
    req.on('timeout', () => req.destroy(new Error('Video download timed out')));
    req.on('error', fail);
    req.end();
  });
}

async function extractJpegFrames(inputFile, outputDir, { run = execFileAsync } = {}) {
  const pattern = path.join(outputDir, 'frame-%02d.jpg');
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', '1', '-protocol_whitelist', 'file,pipe',
    '-probesize', '1048576', '-analyzeduration', '5000000',
    '-i', inputFile, '-t', '12', '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', 'fps=1/3,scale=512:-2', '-frames:v', String(MAX_FRAMES),
    '-q:v', '7', '-f', 'image2', pattern,
  ];
  await run('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true, shell: false });
  const names = (await fs.readdir(outputDir)).filter(n => /^frame-\d{2}\.jpg$/.test(n)).sort().slice(0, MAX_FRAMES);
  const frames = [];
  for (const name of names) {
    const data = await fs.readFile(path.join(outputDir, name));
    if (data.length < 4 || data.length > MAX_JPEG_BYTES || data[0] !== 0xff ||
        data[1] !== 0xd8 || data[data.length-2] !== 0xff || data[data.length-1] !== 0xd9) {
      throw new Error('Invalid or oversized JPEG output');
    }
    frames.push(data.toString('base64'));
  }
  if (!frames.length) throw new Error('No video frames extracted');
  return frames;
}

async function extractMessengerVideoFrames({ url, customerConsented = false, staffRequested = false,
  featureEnabled = false, download = downloadMetaVideo, transcode = extractJpegFrames } = {}) {
  // Consent and staff-gating happen BEFORE any URL resolution, disk activity or network use.
  if (!customerConsented) return { status: 'blocked', reason: 'customer consent required' };
  if (!staffRequested) return { status: 'blocked', reason: 'staff review required' };
  if (!featureEnabled) return { status: 'blocked', reason: 'video vision feature disabled' };
  const media = validateMetaVideoUrl(url);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmags-video-'));
  const videoFile = path.join(dir, 'input-video.bin');
  const frameDir = path.join(dir, 'frames');
  try {
    await fs.chmod(dir, 0o700);
    await fs.mkdir(frameDir, { mode: 0o700 });
    const bytes = await download(media.toString(), videoFile);
    const frames = await transcode(videoFile, frameDir);
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > MAX_FRAMES) {
      throw new Error('Invalid extracted frame count');
    }
    return { status: 'frames_ready_for_staff_review', frames, count: frames.length,
      sourceBytes: bytes, audioAnalyzed: false, autoSent: false };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { validateMetaVideoUrl, isPublicIPv4, publicOnlyLookup,
  downloadMetaVideo, extractJpegFrames, extractMessengerVideoFrames,
  MAX_VIDEO_BYTES, MAX_JPEG_BYTES, MAX_FRAMES };
