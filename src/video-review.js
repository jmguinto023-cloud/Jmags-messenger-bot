'use strict';

// Internal-only composition: no Messenger Send API calls, no bot event handlers.
const { extractMessengerVideoFrames } = require('./video-frame-extractor');
const { draftVideoDiagnosis } = require('./video-diagnosis');

async function prepareVideoReview({ url, customerConsented = false, staffRequested = false,
  featureEnabled = false, externalAiAllowed = false, aiRouter,
  extractor = extractMessengerVideoFrames, drafter = draftVideoDiagnosis } = {}) {
  if (!customerConsented) return { status: 'blocked', reason: 'customer consent required' };
  if (!staffRequested) return { status: 'blocked', reason: 'staff review required' };
  if (!featureEnabled) return { status: 'blocked', reason: 'video vision feature disabled' };
  if (!externalAiAllowed) return { status: 'blocked', reason: 'external AI processing disabled' };
  const evidence = await extractor({ url, customerConsented, staffRequested, featureEnabled });
  if (evidence.status !== 'frames_ready_for_staff_review') return evidence;
  const drafted = await drafter({ frames: evidence.frames, customerConsented, staffRequested,
    externalAiAllowed, aiRouter });
  return { ...drafted, sourceBytes: evidence.sourceBytes, autoSent: false };
}

module.exports = { prepareVideoReview };
