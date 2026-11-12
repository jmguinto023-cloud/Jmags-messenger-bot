'use strict';

// Synthetic-only test. No Messenger credentials, customer videos, or paid AI calls.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareVideoReview } = require('./video-review');
const { extractMessengerVideoFrames } = require('./video-frame-extractor');
const { draftVideoDiagnosis } = require('./video-diagnosis');

const run = promisify(execFile);
const MOCK_REPLY = [
  'Nakikita sa frames: synthetic test pattern lang.',
  'Posibleng sanhi (hindi kumpirmado): walang totoong appliance sa sample.',
  'Next questions: brand, size, at actual symptoms.',
  'Staff review needed: oo, bago mag-message.'
].join('\n');

async function runSyntheticVideoSelfTest() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmags-vision-self-test-'));
  const file = path.join(dir, 'sample.mp4');
  try {
    await fs.chmod(dir, 0o700);
    await run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=3', '-t', '4',
      '-pix_fmt', 'yuv420p', '-c:v', 'mpeg4', file,
    ], { timeout: 15000, maxBuffer: 2048, shell: false });
    let providerRequests = 0;
    const aiRouter = { complete: async payload => {
      providerRequests += 1;
      if (!Array.isArray(payload.messages?.[1]?.content)) throw new Error('Missing vision content');
      if (!payload.messages[1].content.some(c => c.type === 'image_url')) throw new Error('No image attached');
      return MOCK_REPLY;
    } };
    const extractor = opts => extractMessengerVideoFrames({ ...opts,
      download: async (_url, destination) => {
        await fs.copyFile(file, destination);
        return (await fs.stat(file)).size;
      },
    });
    const result = await prepareVideoReview({
      url: 'https://video.xx.fbcdn.net/synthetic-self-test.mp4',
      customerConsented: true, staffRequested: true,
      featureEnabled: true, externalAiAllowed: true,
      aiRouter, extractor, drafter: draftVideoDiagnosis,
    });
    if (result.status !== 'needs_staff_approval' || result.autoSent !== false || providerRequests !== 1) {
      throw new Error('Synthetic test failed its safety expectations');
    }
    return {
      test: 'synthetic_frame_extraction_and_mock_vision',
      status: 'passed', frames: result.framesAnalyzed,
      artificialVideo: true, realMessengerDownload: false, realAiCall: false,
      audioAnalyzed: false, customerRepliesSent: 0,
      draft: result.draft,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { runSyntheticVideoSelfTest };
