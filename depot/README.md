# JMAGS AI Video Training Depot

## What was implemented, November 10, 2026
- Live Primary Supabase project: `fhjarnogglakehaztbbj`.
- Source table: `public.messenger_videos`, filtering `type = 'video'`.
- New private, RLS-protected case table: `public.jmags_video_training_cases`.
- New approved-member table: `public.jmags_video_depot_members`; initial owner is the sole preexisting Supabase Auth user.
- New audited training edits: `public.jmags_video_training_history`.
- Existing Messenger video records backfilled as private metadata references: **729 of 729 source videos** at initial migration. All initially unlabeled.
- Existing source table gets an isolated AFTER INSERT / UPDATE trigger that automatically queues future video metadata in the depot. It returns the original record unmodified. Source text bot, existing Supabase edge function, Render production service, Messenger sending, and stored payments are untouched.
- Mobile-first depot served by `node depot/server.js` in a separate Render service, with production services untouched.

## Important truth about data and AI learning
- 729 records are metadata and Meta-hosted URL references, **not video files backed up into JMAGS storage**.
- Original Meta CDN links may expire, so old cases might need a fresh video provided with customer permission.
- Videos are **not automatically sent to an AI provider**.
- New videos are continuously catalogued through the database trigger; the page refreshes counts and queue every 60 seconds while open.
- Teaching labels are saved permanently in Supabase; no ChatGPT foundation-model retraining occurs simply because an employee labels a case.
- Future AI integration must retrieve only technician-verified labels with privacy, consent, access controls, budgets, safety checks, and owner approval before enabling customer replies.

## How to use
1. Open the deployed depot URL and sign in with an existing approved JMAGS Supabase Auth credential. A new public account cannot view any videos.
2. Choose an unlabeled video.
3. Open the original attachment if it is still accessible, then specify the TV brand/model, visible symptoms, actual confirmed fault, repairable yes/no, repair work/outcome, and trainer notes.
4. Save Draft or Mark Verified. Verified cases require a nonempty confirmed fault and repairability decision; the database enforces this.
5. Review training history to see later corrections.

## Security
- Browser uses an intended-public Supabase **publishable** key.
- No service-role or secret Supabase key is exposed to the browser.
- `anon` has no table SELECT privilege; only authenticated approved JMAGS depot members can access records via restrictive RLS policies.
- Existing private source table `messenger_videos` remains inaccessible to anonymous users.
- Only approved members may label entries. Users cannot spoof or update source IDs, source video URLs, or archival status through the app's table grants.
- Every label edit is recorded in a separate history table, which has no client INSERT privilege.
- No customer names, phone numbers, PSIDs, conversation transcripts or chat messages were copied to the depot.
- The depot does not have or use Facebook Page secrets or Messenger Send API access.

## Existing limitations
- There is no durable original-video archive or frame extraction for the 729 historical media URLs; consent + retention + storage plan required.
- Customer consent for storage and processing is not inferred from Messenger submission. It begins as `not_recorded`.
- Video issue recognition model and AI sales/chatbot are separate future steps, not activated by this depot.
- Private dashboard access requires the preexisting Supabase Auth user's credentials. New staff accounts need explicit approval in `public.jmags_video_depot_members` and appropriate Ops access management.

## Deployment
- Repo: `jmguinto023-cloud/Jmags-messenger-bot`
- Branch: `feature/ai-video-training-depot-20261110`
- Runtime: Node.js, `node depot/server.js`
- Build: `echo No-build-required`
- Env: `SUPABASE_URL` = verified project API URL; `SUPABASE_PUBLISHABLE_KEY` = public frontend key only (never a secret or service role).
- Auto-deploy disabled, isolated service.
