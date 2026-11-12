# JMAGS video-assisted diagnosis — foundation only (NOT LIVE)

Current production receives Messenger video attachment cards and stores them through the messenger-videos Supabase Edge Function.
At inspection on November 10, 2026 there were 686 video cards, 1,342 photo cards, and zero populated frames_at entries.
The Messenger bot code currently sends text notes about video to the LLM; it does not actually inspect video frames.

## New draft-only module
- src/video-diagnosis.js accepts 1–4 small JPEG stills and submits them to an existing OpenAI-compatible AiRouter only after explicit customer consent, a staff request, and an external-AI permission flag.
- Returns an internal Taglish review draft; never sends a Messenger message or automatically claims a confirmed diagnosis.
- test/video-diagnosis.test.js verifies gating, image payload, no automatic messages, malformed inputs.

## Still required before customer rollout
1. Implement secure extraction of 2–4 JPEG frames from short Messenger videos using verified Meta-only media URLs and bounded download size; consider separately transcribing audio with customer consent.
2. Obtain explicit customer consent and provide a privacy/retention notice before external AI analysis.
3. Wire a staff-authenticated Analyze video button into JMAGS Operations; require staff approval for any customer-facing result.
4. Limit daily AI calls/spend, log failures without storing credentials or unnecessarily retaining customer videos.
5. Test a consented real Messenger video with the selected multimodal AI provider; confirm single reply and Meta 24-hour policy.
6. Prevent duplicate replies from Meta native Business Agent and the Render bot via appropriate app handover/routing.

Nothing in this branch has been deployed or enabled in production. Native Meta Business Agent cannot be modified by this repository.