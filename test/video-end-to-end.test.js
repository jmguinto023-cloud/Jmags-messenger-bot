'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepareVideoReview } = require('../src/video-review');
const { extractMessengerVideoFrames } = require('../src/video-frame-extractor');
const { draftVideoDiagnosis } = require('../src/video-diagnosis');

const media = 'https://video.xx.fbcdn.net/test-signed-url.mp4';

test('end-to-end: four-second MP4 -> real FFmpeg JPEGs -> vision request -> human-only draft', async (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('ffmpeg not installed'); return; }

  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jmags-vision-integration-'));
  try {
    const fixture = path.join(fixtureDir, 'test-tv.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-f', 'lavfi',
      '-i', 'testsrc=size=320x180:rate=3', '-t', '4', '-pix_fmt', 'yuv420p',
      '-c:v', 'mpeg4', fixture], { timeout: 15000 });

    let calls = 0;
    let request;
    const aiRouter = {
      complete: async (payload) => {
        calls++;
        request = payload;
        return 'Nakikita sa frames: test pattern. Posibleng sanhi (hindi kumpirmado): unknown. Next questions: brand, size, issue. Staff review needed: Yes.';
      },
    };
    const download = async (_url, destination) => {
      await fs.copyFile(fixture, destination);
      return (await fs.stat(destination)).size;
    };
    const extractor = opts => extractMessengerVideoFrames({ ...opts, download });

    const result = await prepareVideoReview({ url: media, customerConsented: true,
      staffRequested: true, featureEnabled: true, externalAiAllowed: true,
      aiRouter, extractor, drafter: draftVideoDiagnosis });

    assert.equal(calls, 1);
    assert.equal(result.status, 'needs_staff_approval');
    assert.equal(result.autoSent, false);
    assert.equal(result.audioAnalyzed, false);
    assert.ok(result.framesAnalyzed >= 1 && result.framesAnalyzed <= 4);
    assert.ok(result.sourceBytes > 0);
    assert.equal(request.messages[1].content.length, result.framesAnalyzed + 1);
    for (const part of request.messages[1].content.slice(1)) {
      assert.equal(part.type, 'image_url');
      assert.match(part.image_url.url, /^data:image\/jpeg;base64,/);
    }
    assert.match(result.draft, /Staff review needed/);
  } finally {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  }
});
