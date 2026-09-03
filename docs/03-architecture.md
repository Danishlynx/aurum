# 03. Architecture

## Shape of the system

    ┌────────────────────────────┐
    │  Phone browser (PWA)        │
    │  Next.js client components  │
    │  camera, quality gate,      │
    │  downscale, hash, poll      │
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

1. Client runs the quality gate (face detection, sharpness, exposure). On pass, it downscales to a 1024px long edge, strips EXIF, computes SHA 256, and calls POST /api/captures with the hash.
2. Server checks captures for the hash. If it exists and belongs to this person, it returns the existing capture and its analyses (cache hit, zero credits). Otherwise it returns a signed upload URL for the private captures bucket.
3. Client uploads. Client calls POST /api/captures/{id}/analyze.
4. Server fans out the independent analyses as jobs in parallel: skin analysis, Fitzpatrick, face attributes (skin tone, eye and hair color), face shape, hair type. Each job records its provider task id. Credits are reserved in the ledger before the calls and reconciled after.
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
      quality            jsonb            (sharpness, exposure, face_coverage)
      deleted_at         timestamptz
      unique (user_id, sha256)

    analyses
      id                 uuid pk
      capture_id         uuid references captures
      user_id            uuid
      kind               text check in (skin, fitzpatrick, attributes, face_shape, hair_type)
      status             text check in (pending, running, succeeded, failed)
      provider_task_id   text
      raw                jsonb            (validated provider response, no image bytes)
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

- create: reserve credits, call the provider to start the task, store provider_task_id, status running.
- poll: called from GET /api/jobs. For each running job whose last_polled_at is older than 1 second, query the provider. On success, validate with zod, store the normalized result and any mask or render files, mark succeeded, reconcile credits. On provider failure, mark failed with a human readable error and refund reserved credits.
- retry: a failed job can be retried once automatically if the error is transient (timeout, 5xx). Attempts are capped at 2. Beyond that the UI shows the partial state.
- idempotency: creating a job for the same subject while one is running returns the running job.
- timeout: a job running longer than 120 seconds is marked failed with "Perfect Corp did not respond in time. Your photo is safe. Try again in a moment."

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
- A person has a daily cap (config, default 40 Perfect Corp units, 30 SerpApi searches). A judge session has a hard cap (3 full analyses, credits_cap units). Requests beyond a cap return 429 with the copy from the flow doc, and the UI switches to demo mode where relevant.
- A global kill switch (env PROVIDER_CALLS_ENABLED=false) makes every provider route serve from cache or the demo profile. Flip it if credits are nearly exhausted before judging ends.

## Judge mode

- POST /api/judge/session compares the submitted code against a hash in env (JUDGE_ACCESS_CODE_HASH), creates a judge_sessions row, and sets an httpOnly, secure, sameSite strict cookie with the session id for 24 hours.
- Judge requests are authenticated by that cookie on the server. Data written during a judge session is owned by the session id and purged by a scheduled job 7 days after expiry.
- The demo profile is a fixture set: a consented fixture capture, its real analyses, renders, a small wardrobe, and two saved looks, loaded by a seed script. When a judge session exceeds its cap, every read route serves the demo profile and every write route returns the "session has used its analyses" copy.

## Deployment

- Vercel project with production on main and previews on every PR.
- Environment variables set in Vercel, never committed. See .env.example.
- Region: pick the Vercel region closest to the Supabase project.
- Images: the browser downscales before upload. The server never decodes images except to store mask and render outputs from providers.
- Next.js image optimization is used only for product thumbnails and renders through signed URLs with a short cache.

## Observability

- Every route logs a structured line: request id, route, user or judge session id, duration, provider calls made, credits spent, outcome. No image bytes, no signed URLs, no prompt text with personal data.
- Provider errors log status, provider error code, and the zod issue path if validation failed.
- A simple /api/health returns build sha, provider kill switch state, and cache hit rates for the last hour.
- Optional Sentry for exceptions, with PII scrubbing on by default.

## Failure modes and what the person sees

- Perfect Corp down: jobs fail with the timed out copy; the report renders whatever succeeded; judge sessions fall back to the demo profile.
- SerpApi quota exhausted: routine rows show the product type and "No listing found near you yet"; the app never invents a listing.
- Claude API error: the reading block shows a deterministic fallback built from the ranked concerns ("Main concern: pigmentation on the cheekbones. Skin type: combination.") and the stylist ranks looks by the rules alone with a one line rule based rationale.
- Supabase storage error on upload: capture screen shows "Upload did not complete. Your photo was not saved. Try again."
- Credits nearly out during judging: flip the kill switch; the app keeps working from cache and the demo profile.

## Security boundaries in code

- src/lib/server/* imports "server-only". The ESLint import rule blocks client imports.
- Service role key is used only inside server modules and only for judge sessions and scheduled jobs. Signed in people use RLS with their own JWT.
- All route inputs are parsed with zod; unknown fields are stripped.
- All provider responses are parsed with zod before use.
- Rate limiting per IP and per session on capture, analyze, render, and product routes (a Postgres backed token bucket is fine at this scale).
