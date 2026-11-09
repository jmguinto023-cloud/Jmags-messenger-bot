# Step 2: Video frame extraction — staged, not deployed

## Scope and current verification

The active JMAGS Render Messenger bot receives Messenger video attachments and forwards review metadata to the existing Supabase messenger-videos Edge Function. Existing bot customer replies use media acknowledgments, not actual video visual inspection. Review-code changes are only in GitHub draft PR #45.

On 2026-11-10, aggregated Supabase host checks showed video media on:
- video.xx.fbcdn.net
- video-atl3-1.xx.fbcdn.net
- One non-production test-style URL on cdn.example (rejected intentionally)

No customer video was downloaded or analyzed to prepare this branch.

## Components

- src/video-frame-extractor.js: HTTPS-only Meta CDN allowlist for the verified JMAGS host pattern; DNS public IPv4 pinning; no HTTP redirects; MIME check; 20 MiB streaming cap; 12-second fetch timeout.
- FFmpeg: analyzes up to the first 12 seconds, extracts up to four JPEG frames at 512px width, with 15-second process timeout, no shell, protocol_whitelist=file,pipe, no audio. JPEG size limit 160 KB each.
- An automatically deleted restrictive temporary directory is used. Neither the original video nor raw frames are stored permanently by this module.
- src/video-review.js: calls the extractor and the existing src/video-diagnosis.js draft-only AI helper when all four conditions are true: customer consent, staff request, feature flag, and external AI permission.
- No Meta Send API calls, no automatic reply, no live webhook handler modification. Return value is only an internal staff draft.

## Local test results

2026-11-10: 8/8 passing using Node.js 22 and FFmpeg 7:
node --test test/video-frame-extractor.test.js test/video-review.test.js

These are unit tests and one synthetic local video FFmpeg smoke test. They do not prove remote signed Meta attachments are currently downloadable or that live Gemini/Groq image input works.

## Render preparation

1. Current render.yaml and existing Dockerfile are untouched. The new separate Dockerfile.video-vision adds FFmpeg for a future, isolated staging service only; it defaults JMAGS_VIDEO_VISION_ENABLED=false.
2. Do not change the existing production jmags-messenger-bot service, environment variables, deployments, or routing while testing.
3. After Render workspace confirmation, create a staging environment using the draft branch and Dockerfile.video-vision, with no Meta webhook subscription and no Page Send API permission. Staging can run unit tests and simulate frame extraction independently.
4. A future authenticated staff-only handler must explicitly map process.env.JMAGS_VIDEO_VISION_ENABLED === 'true' into the featureEnabled argument. The current branch has no such handler so environment toggles alone do nothing.
5. Store third-party AI credentials only in Render secrets. The chosen provider must explicitly support image inputs. Keep externalAiAllowed false until privacy notice, consent storage, data-retention policy, daily AI caps and cost ceiling are approved.
6. Only after authorized testing, add an Operations staff control to request an internal draft. Human approval remains required before any customer-facing reply.
7. Confirm Meta native Business Agent and Render bot won't send duplicate replies. Test with a consented test account within Meta's messaging-window requirements.

## Validation gates before go-live

- Explicit per-video consent recorded before download or third-party transfer
- Authenticated JMAGS employee action; audit log; no customer-controlled feature flags
- Real video URL format and status-code test using a new consented test video
- Safe handling of missing/expired CDN URLs and unsupported codecs
- Paid provider image-input compatibility check and tight budget controls
- Data retention/deletion and rate limits
- Operations UI preview and employee-approval workflow
- No live customer replies changed during rollout

Current state: source committed to draft PR #45, not merged or deployed.
