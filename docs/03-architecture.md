# 03. Architecture

## Shape of the system

    ┌────────────────────────────┐
    │  Phone browser (PWA)        │
    │  Next.js client components  │
    │  camera, master frame,      │
    │  quality gate, hash, poll   │
    └──────────────┬─────────────┘
                   │ https, JSON, signed upload URLs
    ┌──────────────▼─────────────┐
    │  Next.js on Vercel          │
    │  route handlers (server)    │
    │  src/lib/server/*           │
    │   providers/perfectcorp     │──── Perfect Corp YouCam API (async tasks)
    │   providers/serpapi         │──── SerpApi (Shopping, Maps, Local)
    │   providers/anthropic       │──── Claude API (synthesis, stylist, classifier)
    │   jobs, credits, judge      │
    └──────────────┬─────────────┘
                   │ service role, server only
    ┌──────────────▼─────────────┐
    │  Supabase                   │
    │  Postgres with RLS          │
    │  Auth (magic link)          │
    │  Storage (private buckets)  │
    └────────────────────────────┘

Principles

- The browser never talks to a provider. Every provider call goes through a server route holding the keys.
- Anything slow is a job. The client creates a job, gets an id, and polls our own endpoint. Our endpoint checks the provider's task status, stores the result, and returns it. No request ever waits on a provider for more than a few seconds, so Vercel function timeouts do not matter.
- Everything derived from a capture is cached by the capture's content hash. The same photo never costs a second credit.
- Deterministic logic is pure and shared. Palette derivation, concern ranking, formality rules, and credit math live in src/lib/shared with unit tests and no I/O.

## Request flow for a capture

1. Client draws the master frame (docs/01-user-flow.md section D: the largest centred 3:4 crop of the camera track, at native size with the long edge capped at 1440 and the short edge floored at 480; an uploaded photo is composed into the same geometry around its face) and runs the quality gate on it (a face reading from the landmarker, framing, pose and light; sharpness is recorded and decides nothing). On pass, it encodes that frame as JPEG, which strips EXIF, computes SHA 256, and calls POST /api/captures with the hash, the frame's size and every number the gate measured.
2. Server checks captures for the hash. If it exists and belongs to this person, it returns the existing capture and its analyses (cache hit, zero credits). Otherwise it returns a signed upload URL for the private captures bucket.
3. Client uploads. Client calls POST /api/captures/{id}/analyze.
4. Before anything is reserved, the server reads the stored object and validates its bytes: a JPEG, header dimensions equal to the registered ones, at least 480 px on the short side, at most 2560 px on the long side, at most 10 MB, and a digest equal to the row. A failure is a 409 capture_unreadable with no reservation and no task. Then the server fans out the independent analyses as jobs in parallel: skin analysis, Fitzpatrick, face attributes (skin tone, eye and hair color), face shape, hair type. Each job records its provider task id. Credits are reserved in the ledger before the calls and reconciled after.
5. Client polls GET /api/jobs?capture={id} every 1.5 seconds. Each poll checks pending provider tasks, stores completed results, and returns the set. The reveal screen advances as results arrive.
6. When the core set is complete (skin plus at least one of Fitzpatrick or attributes), the server builds the aesthetic profile: deterministic fields directly from results, palette from the pure mapping, and the synthesis text from one Claude call with structured output. The profile row is written and the client routes to the report.
7. Nothing is deleted at the end of processing. If retention is default, the original object in the captures bucket is deleted when the session ends, by the scheduled purge, because every try on renders on it (founder's decision of 2026-09-03, docs/06-safety-privacy.md, "Retention"). Masks and renders are kept.

## Data model

All tables have id (uuid), created_at, updated_at. All tables with user_id have RLS: a row is visible only to auth.uid() = user_id, or to a judge session through the service role on the server (judge sessions never get a client side Supabase session).

    profiles
      user_id            uuid pk references auth.users
      display_name       text
      consent_at         timestamptz not null
      is_adult_confirmed boolean not null
      keep_originals     boolean not null default false
      location_consent   boolean not null default false
      approx_location    jsonb            (city, lat, lng rounded to 2 decimals)

    captures
      id                 uuid pk
      user_id            uuid
      sha256             text not null
      storage_path       text             (null after deletion)
      width, height      int
      quality            jsonb            (every number the client gate measured, snake case: verdict, reason, sharpness, blown_fraction, crushed_fraction, face_width_ratio, pose {yaw_degrees, pitch_degrees, roll_degrees}, measured, platform, path, attempt, frame sizes, face_bbox_ratio, face_center, face_luma, face_luma_uneven, blink, burst_losers, landmarker_ms, frame_geometry_version; exposure, mean_luminance, face_coverage and face_source are written only by builds before 2026-09-23, whose rows carry them instead of face_luma and measured; older rows carry fewer keys; never a pixel, never a landmark. Written by src/lib/shared/capture-quality-stored.ts, read back by the capture_outcomes view in migration 0015 and by the calibration export.)
      deleted_at         timestamptz
      unique (user_id, sha256)

    analyses
      id                 uuid pk
      capture_id         uuid references captures
      user_id            uuid
      kind               text check in (skin, fitzpatrick, attributes, face_shape, hair_type)
      status             text check in (pending, running, succeeded, failed)
      provider_task_id   text
      raw                jsonb            (validated provider response, no image bytes; keeps the engine's free face_quality block on the face family; for a refused task it holds {refusal: {reason, code, elapsed_ms}} instead)
      summary            jsonb            (normalized: scores, labels)
      mask_paths         jsonb            (storage paths of mask images)
      credits_used       int not null default 0
      error              text
      unique (capture_id, kind)

    aesthetic_profiles
      user_id            uuid pk
      capture_id         uuid
      skin_type_zones    jsonb            (t_zone, cheeks, etc)
      concerns           jsonb            ([{key, score, rank, mask_path}])
      skin_age           int
      fitzpatrick        int              (1 to 6, nullable)
      skin_tone_hex      text
      undertone          text check in (warm, cool, neutral)
      undertone_source   text check in (detected, confirmed_by_user)
      eye_color_hex      text
      hair_color_hex     text
      face_shape         text
      hair_type          jsonb            (texture, curl, density)
      season             text
      palette            jsonb            ({wear: [...], avoid: [...]})
      reading            text             (the synthesis paragraph)
      reading_model      text
      version            int not null default 1

    garments
      id                 uuid pk
      user_id            uuid
      storage_path       text not null
      type               text
      colors             jsonb            ([{name, hex}])
      pattern            text
      formality          text check in (casual, smart, formal)
      classification     jsonb            (model output, confidence)
      user_edited        boolean not null default false

    looks
      id                 uuid pk
      user_id            uuid
      occasion           text
      garments           jsonb            ([garment_id or listing])
      rationale          text
      render_path        text             (try on of the hero garment)
      is_saved           boolean not null default false

    renders
      id                 uuid pk
      user_id            uuid
      kind               text check in (makeup, hairstyle, hair_color, cloth, accessory)
      params             jsonb
      storage_path       text
      provider_task_id   text
      credits_used       int
      status             text
      unique (user_id, kind, params_hash)

    product_cache
      query_hash         text pk
      engine             text
      query              jsonb
      results            jsonb            (normalized listings)
      fetched_at         timestamptz not null

    jobs
      id                 uuid pk
      user_id            uuid
      subject_type       text             (analysis, render, classification)
      subject_id         uuid
      status             text
      provider_task_id   text
      attempts           int not null default 0
      last_polled_at     timestamptz
      error              text

    credit_ledger
      id                 uuid pk
      owner_type         text check in (user, judge_session)
      owner_id           uuid
      provider           text
      units              int not null      (positive spend, negative refund)
      subject_id         uuid
      note               text

    judge_sessions
      id                 uuid pk
      code_hash          text not null
      expires_at         timestamptz not null
      analyses_allowed   int not null default 3
      analyses_used      int not null default 0
      credits_cap        int not null
      credits_used       int not null default 0
      last_seen_at       timestamptz

Storage buckets, all private, all accessed through short lived signed URLs (60 seconds for upload, 10 minutes for read):

- captures: original selfies (deleted when the session ends unless keep_originals)
- masks: per concern mask images
- renders: try on outputs
- garments: garment photos

Never store an image as base64 in Postgres. Never log an image or a signed URL.

## Jobs

A job wraps one provider task.

- create: reserve credits, call the provider to start the task, store provider_task_id on the job row first and on the analysis row second, status running. The job row is what every poll starts from, so it is the one that must never be missing while a task exists.
- poll: called from GET /api/jobs while a tab is watching, and from POST /api/jobs/reconcile for every open job nobody is watching. For each running job whose last_polled_at is older than 1 second, query the provider. On success, validate with zod, store the normalized result and any mask or render files, mark succeeded, reconcile credits. On provider failure, mark failed with a human readable error and refund reserved credits.
- retry: a failed job can be retried once automatically if the error is transient (timeout, 5xx). Attempts are capped at 2. Beyond that the UI shows the partial state.
- idempotency: creating a job for the same subject while one is running returns the running job.
- timeout: a job running longer than 120 seconds is read one last time. A result that landed is stored and reconciled exactly as an ordinary poll stores it; a refusal is refunded; only a task still running at the provider is marked failed with "Perfect Corp did not respond in time. Your photo is safe. Try again in a moment.", and that one is not refunded, because the provider charges for it whether or not the answer is ever read.
- reconcile: a scheduled call every minute to POST /api/jobs/reconcile polls every open analysis job nobody is polling, so a backgrounded tab never strands a paid task, which the provider's mandatory polling rule would otherwise charge for nothing (docs/04-integrations.md). The driver is pg_cron in the Supabase project (migration 0016): a database function returns at once when no analysis job is pending or running, and otherwise reads the deployment URL and a bearer from Vault and calls the route through pg_net. The route is bearer protected (a constant time compare against JOBS_RECONCILE_SECRET, no session, no cookie), answers 503 while the secret is unset and 401 to a wrong or missing bearer without reading a row, and does nothing under the kill switch. A pass lists open analysis jobs with last_polled_at null or older than 2 seconds (the client stamps it every 1.5 seconds, so a job a tab is watching is left to that tab), oldest stamp first, 25 captures at most, and stops taking captures after 45 seconds. For each capture it rebuilds the owner's session from the row (a live judge session, otherwise the user shape) and runs the same pollCaptureJobs the client would have: results stored and reconciled, refusals refunded, followers started, the lifetime branch read once more, the profile built. It is safe beside a client poll because every primitive is already a compare and set (the poll claim, the follower start claim, refund by reservation id, reconcile at equal units). The report page still runs its catch up pass on its way in and the reveal still polls at once on return to the foreground; those are latency, the schedule is the guarantee. Vercel's own cron runs once a day on the Hobby plan and is not a driver for a 120 second lifetime.
- one go rate: the capture_outcomes view (migration 0015) gives one row per capture with the client verdict, whether all four runnable readings succeeded, whether a provider failure touched it, whether the profile points at the capture, whether the last reading landed within 120 seconds, and the units charged. one_go is the conjunction of the three: all readings succeeded, profile points at the capture, last reading within 120 seconds. Rows a provider failure touched are excluded by the reader, not by the view. /api/judge/stats reports the rate over the last seven days from it, leaving out captures younger than 120 seconds, which are still being read.

## Caching

- Capture hash: (user_id, sha256) is unique. Re uploading the same photo returns the stored analyses.
- Render params: (user_id, kind, params_hash) is unique. Re selecting a shade or style returns the stored render.
- Product cache: query_hash covers engine, query text, location, and gl or hl. Shopping results are cached 24 hours, local results 6 hours.
- Palette: derived by a pure function from profile fields; not cached, it is microseconds.
- Synthesis: stored on the profile; regenerated only when the underlying analyses change or the person adjusts undertone.

## Concurrency

The five capture analyses run in parallel from the same uploaded object. Perfect Corp accepts independent tasks; do not serialize them. The reveal is designed to show results as they land in any order. Try on renders are sequential per person (one pending render at a time) to keep credit spend predictable.

## Credits and caps

- Every provider call reserves credits in credit_ledger before it starts and reconciles after. Reservation uses the cost table in docs/04-integrations.md, which must be filled from the live docs on day one.
- A person has a daily cap (config, default 280 Perfect Corp units, 120 SerpApi searches). The Perfect Corp default is five capture sets: one set is 56 units (tone 20, skin 16, Fitzpatrick 10, face shape 10), and a default below one set is not a conservative setting but one that charges for a leader and then refuses the rest. A judge session has a hard cap (3 full analyses, credits_cap units). Requests beyond a cap return 429 with the copy from the flow doc, and the UI switches to demo mode where relevant.
- A global kill switch (env PROVIDER_CALLS_ENABLED=false) makes every provider route serve from cache or the demo profile. Flip it if credits are nearly exhausted before judging ends.

## Judge mode

- POST /api/judge/session compares the submitted code against a hash in env (JUDGE_ACCESS_CODE_HASH), creates a judge_sessions row, and sets an httpOnly, secure, sameSite strict cookie with the session id for 24 hours.
- Judge requests are authenticated by that cookie on the server. Data written during a judge session is owned by the session id and purged by a scheduled job 7 days after expiry.
- The demo profile is a fixture set: a consented fixture capture, its real analyses, renders, a small wardrobe, and two saved looks, loaded by a seed script. When a judge session exceeds its cap, every read route serves the demo profile and every write route returns the "session has used its analyses" copy.

## Deployment

- Vercel project with production on main and previews on every PR.
- Environment variables set in Vercel, never committed. See .env.example.
- Region: pick the Vercel region closest to the Supabase project.
- Images: the browser cuts the master frame before upload (3:4, long edge at most 1440, short edge at least 480; nothing is downscaled to 1024 any more). The server never decodes images except to validate a capture's JPEG header before analyze and to store mask and render outputs from providers.
- Next.js image optimization is used only for product thumbnails and renders through signed URLs with a short cache.

## Observability

- Every route logs a structured line: request id, route, user or judge session id, duration, provider calls made, credits spent, outcome. No image bytes, no signed URLs, no prompt text with personal data.
- Provider errors log status, provider error code, and the zod issue path if validation failed.
- An upload the analyze route would not send logs aurum.capture_unreadable with the capture id, the failing check (size, format, dimensions, short_side, long_side, digest) and the numbers it measured against the limits. Never the bytes, never the digest.
- Every scheduled reconcile pass logs one aurum.reconcile_pass line: captures (distinct captures with an open, unpolled analysis job), polled (captures the pass reached inside its budget), settled (listed jobs that were terminal when their poll returned), providerCalls, errors, and source "cron". A pass that finds nothing logs zeros. Beside it, aurum.reconcile_not_configured when the route is called with no secret set, aurum.reconcile_owner_fallback when an owner is neither a live judge session nor a profile (an expired judge, settled as a user), and aurum.analysis_start_superseded when a poll stored a result before the start that made it was recorded.
- A simple /api/health returns build sha, provider kill switch state, and cache hit rates for the last hour.
- Optional Sentry for exceptions, with PII scrubbing on by default.

## Failure modes and what the person sees

- Perfect Corp down: jobs fail with the timed out copy; the report renders whatever succeeded; judge sessions fall back to the demo profile.
- A reading that lands after the 120 second job lifetime: stored, not dropped. The lifetime branch reads the task once more before closing it, so a result that arrived at 115 seconds and was first polled at 125 is stored and reconciled as the reading it was paid for; a refusal found at that read is refunded. A task still running at that read, or a read that fails for any reason (the task's state is then unknown), is closed as charged with the timeout line and never refunded. A late leader does not become a report on its own: every job of a capture is created at analyze time, so its followers are as old as it is, and in the same pass they are closed unstarted with the timeout line and credits_used 0. The person keeps the leader's reading and takes a new photo for the rest.
- A tab backgrounded on /analyzing: its timers are throttled or paused by the browser, and the scheduled reconcile pass (Jobs, reconcile) polls the capture within a minute or two of the tab going quiet, so the reading finishes and the profile is built whether or not the tab comes back. On return to the foreground the screen polls immediately and finds whatever the pass stored. If the poll gave up because the server could not be reached, the screen offers "Check again", which resumes polling the same capture, beside "Retake photo". The readings are never bought twice for a connection that dropped.
- The analyze request's answer is lost in transit: the client asks once more. The route is idempotent for a capture that already has jobs, so the second ask finds the first one's work or does it, and nothing is charged twice. That holds once the first request has written its jobs; a retry that arrives while the first request is still creating them can race it up to the unique index on open jobs per subject, which is the same window the reframe path has always had. The reconcile pass does not close that window (it reads jobs, it does not create them); a start once claim on the analysis row would, and is a follow up.
- A process killed mid start: the task id is written to the job row first, so a kill between the two writes leaves a running job the next poll or the reconcile pass settles by reading the task. What no ordering closes is the moment between the provider accepting the task and the first write: a kill there leaves a reservation, a pending analysis, and a task whose id nobody holds. It is the one shape the reconcile pass cannot reach, and it is why the ledger orphan sweep the plan asked for is not built: a reservation settled as charged writes no ledger row (reconcile at equal units is a no op), and "no task was created" and "a task was created and its id lost" look the same in every table, so refunding such a reservation on age alone would invent credit for a task the provider may have charged. It is left standing in the conservative direction, where it counts against the caps, and every occurrence is logged (aurum.reservation_unrefunded, aurum.fan_out_stalled). Making the sweep safe needs a settlement row at equal units or the task id on the ledger row, either of which is its own small PR.
- SerpApi quota exhausted: routine rows show the product type and "No listing found near you yet"; the app never invents a listing.
- Claude API error: the reading block shows a deterministic fallback built from the ranked concerns ("Main concern: pigmentation on the cheekbones. Skin type: combination.") and the stylist ranks looks by the rules alone with a one line rule based rationale.
- Face model did not load: the frame is offered as unmeasured and the engine gates it for free. The capture screen says so under the oval ("The face check did not load. You can still take the photo."), the tap lands on the review screen with the unmeasured line and "Use it anyway", the row stores measured false and no face numbers, and the engine's own input gate refuses a bad frame for 0 units. Nothing guesses at a face in the model's absence; the only refusal an unmeasured frame can still meet is light over the whole frame at the extremes (black or white over its whole area), which needs no face to read.
- Supabase storage error on upload: capture screen shows "Upload did not complete. Your photo was not saved. Try again.", with a second line naming the step and the status ("Stopped while saving the photo. The server answered 500.").
- Unreadable upload at analyze: the stored object is not a JPEG, is not the registered size, is outside the engine's limits, or does not hash to the row (docs/04-integrations.md, "Implementation rules"). The route answers 409 capture_unreadable before any task is created or any unit reserved, and the capture screen names the step: "Upload did not complete. Your photo was not saved. Try again." with "Stopped while starting the reading. The server answered 409." under it, so the person retakes.
- No session, or no consent, at the register or analyze call (401 or 403): the capture screen goes to /welcome, which records consent and, with open access on, mints the session. It is not an upload failure and is not shown as one. With open access on, /capture itself sends a device without a consented session there before a photo is framed.
- Credits nearly out during judging: flip the kill switch; the app keeps working from cache and the demo profile.

## Security boundaries in code

- src/lib/server/* imports "server-only". The ESLint import rule blocks client imports.
- Service role key is used only inside server modules and only for judge sessions and scheduled jobs. Signed in people use RLS with their own JWT.
- All route inputs are parsed with zod; unknown fields are stripped.
- All provider responses are parsed with zod before use.
- Rate limiting per IP and per session on capture, analyze, render, and product routes (a Postgres backed token bucket is fine at this scale).
