# 04. Integrations

Four external systems. Each has a provider module under src/lib/server/providers/<name>/ with: client.ts (auth, base URL, fetch with timeouts), schemas.ts (zod for every response we read), endpoints.ts (the verified paths and field names), and index.ts (typed functions the rest of the app calls). Nothing outside the provider module knows a provider's wire format.

## Verify first

Do this before writing any provider code, and record the answers in the provider's endpoints.ts and in the tables below. Do not guess paths, field names, or costs.

Perfect Corp

- Open the developer docs: https://docs.perfectcorp.com/develop/introduction and the reference pages, for example https://docs.perfectcorp.com/reference/ai_skin_analysis
- Read the MCP page: https://docs.perfectcorp.com/develop/mcp. Add the MCP server to your Claude Code config with the hackathon API key and list its tools. The tool list is the fastest way to see the exact API surface (skin analysis, cloth try on, hair styling, fashion rendering, and the rest) and the argument names each expects.
- Redeem the hackathon code at https://yce.perfectcorp.com/api-console/en/redeem-code/ and create a key at https://yce.perfectcorp.com/api-console/en/api-keys/
- In the API console, find the credit cost per API and the remaining balance. Fill the credit table.
- Confirm whether cloth try on accepts one garment per call or a full outfit. Record the answer; it decides how Looks render.
- Confirm image input constraints for each API (min and max resolution, format, face coverage, lighting notes).

SerpApi

- Confirm the current plan quota and rate limits at https://serpapi.com/pricing and in the dashboard.
- Confirm google_shopping, google_maps, and google_local parameter names and result field names in the docs for each engine.

Claude API

- Confirm current model identifiers and vision limits at https://docs.claude.com/en/docs_site_map.md and update src/lib/server/providers/anthropic/models.ts.

## Perfect Corp YouCam API

What we use and where

- Skin analysis (Layer 1): per concern scores 1 to 100 and masks. Concerns available include redness, oiliness, age spots, radiance, moisture, dark circles, eye bags, eyelid droop, firmness, texture, acne, pores by region, wrinkles by region, tear trough, skin type by zone, an overall score, and a skin age. We read all of them, rank them tone first, and render the masks.
- Fitzpatrick skin type (Layer 1 and 2): types I to VI.
- Face attributes (Layer 2): skin tone plus eye, eyebrow, lip, and hair colors. This is the input to the palette.
- Face analyzer (Layer 3): face shape.
- Hair type detection (Layer 3): texture and curl pattern, frizziness.
- Makeup try on (Layer 2): 13 categories; we use lip, blush, foundation, and eye, and the full look try on for the hero.
- Hairstyle and hair color try on (Layer 3).
- Cloth try on and accessory try on (Layer 4 and 6): garments on the person; watches, bracelets, rings, earrings, necklaces, scarves, hats, shoes, bags.
- Skin simulation (Layer 6): before and after visuals for the projected improvement.

The call pattern

Every YouCam API we use is asynchronous. The shape, to be confirmed against the docs and recorded in endpoints.ts:

1. Request an upload slot: POST the file metadata, receive a pre signed URL and a file id.
2. Upload the image bytes with PUT to the pre signed URL.
3. Create a task for the chosen API with the file id and parameters, receive a task id.
4. Poll the task status. It moves from running to success (or error). On success, read the result payload, which contains scores and labels and, for masks and renders, URLs to download.
5. Download mask and render outputs promptly (result URLs may expire) and store them in our private buckets.

Implementation rules

- One uploaded file id is reused across the five capture analyses. Upload once, fan out tasks.
- Poll from our own GET /api/jobs handler, never from a long running server loop. Respect any polling interval the docs specify.
- Parse every response with zod. If a field we depend on is missing, fail the job with a clear error and keep the raw payload (minus any image data) for debugging.
- Map provider concern keys to our internal keys in one place: src/lib/shared/concerns.ts. The tone first ranking lives there too and is unit tested.
- Never send a photo that failed our quality gate. Never send a photo of anyone but the signed in person.

Credit table (fill from the console; reservations use this)

    API                         Units per call    Notes
    skin analysis               TBD
    fitzpatrick                 TBD
    face attributes             TBD
    face analyzer (shape)       TBD
    hair type                   TBD
    makeup try on               TBD               per render
    hairstyle try on            TBD               per render
    hair color try on           TBD               per render
    cloth try on                TBD               per render
    accessory try on            TBD               per render
    skin simulation             TBD               per render

Budget per full session (target): one capture set (5 analyses) plus up to 6 renders. Compute the total from the table and set JUDGE_CREDITS_CAP so that 3 full sessions fit with 20 percent headroom.

Error handling

- Timeouts: 15 seconds per HTTP call, 120 seconds per task lifetime.
- Transient errors (timeout, 5xx, rate limit): one automatic retry with backoff.
- Input errors (face not found, image too small): fail immediately with the matching capture copy so the person retakes. Refund the reservation.
- Auth errors: log, disable the provider route with a clear health status, and serve cache or demo.

## SerpApi

What we use and where

- google_shopping (Layer 1, 2, 4): product listings for a query. Fields we read: title, price, extracted price, link and product link, thumbnail, source. We normalize into Listing { title, priceText, priceValue, currency, url, imageUrl, store }.
- google_maps or google_local (Layer 1 and 4): nearby stores carrying a category ("pharmacy", "beauty store", "menswear") when the person has allowed location. Fields: title, address, coordinates, link. We show distance computed from the person's approximate location.
- google_lens (optional, Layer 4): visual match for a garment photo to find similar purchasable pieces. Only if the free quota allows.

Query construction

- Product queries are built from the recommendation, never free text from the person: "<ingredient or product type> for <concern> <skin type>" for skincare; "<shade family> <category>" for makeup; "<color name> <garment type> <formality>" for gaps in a look.
- Location comes from the profile's approximate location (city level) with gl and hl set from the person's locale. Default gl is the human's country; make it a config value.
- Every query is hashed and cached per docs/03-architecture.md.

Rules

- The app only shows a product if a listing came back with a URL. No listing, no product; show the type and the "No listing found near you yet" copy.
- Prices are displayed as returned, with the currency from the result. Never converted, never estimated.
- Rank listings by relevance to the query and then price ascending within a tight relevance band; show one per routine step, three for shop the gap.
- Respect the quota: the daily cap per person is enforced in the ledger. Judge sessions share a separate cap.

## Claude API

Three uses, each a small module with its own prompt file in src/lib/prompts/.

Models (verify names on day one)

- Synthesis and stylist: claude-sonnet-5
- Garment classification: claude-haiku-4-5-20251001
- Never use a model name that is not in models.ts.

Structured outputs

- Use tool use with a single tool whose input_schema is the zod schema converted to JSON Schema, and force that tool so the response is always structured. Parse the tool input with the same zod schema. Reject and retry once if parsing fails; on a second failure use the deterministic fallback.

Synthesis (the reading)

- Input: the normalized analyses (scores, zones, top concerns already ranked tone first), Fitzpatrick type, detected tone and undertone, and the person's first name if given.
- Output schema: { reading: string (3 to 5 sentences), top_concern_key, top_concern_location, going_well: string, routine: [{ period: morning or night, step_name, concern_key, why, product_query }] }.
- Constraints in the prompt: cosmetic language only; name the top concern and where it sits; one thing going well; no disease names, no medical verbs, no product brand names (grounding comes from SerpApi); no exclamation marks; no em dashes; under 90 words for the reading.
- Temperature 0.3. Max tokens 900.
- The output passes through the safety lexicon check (docs/06-safety-privacy.md) before storage. A failing output is regenerated once with the violations listed; a second failure uses the deterministic fallback reading.

Stylist (looks)

- Input: the palette, the occasion, the classified garments, and the candidate combinations produced by the rules engine (color harmony against the palette, formality against the occasion, pattern clash rules). The rules engine, not the model, generates candidates; the model ranks and explains.
- Output schema: { ranked: [{ combination_id, rationale: string (2 sentences), hero_garment_id, gaps: [garment_type] }] }.
- The rationale must reference the person's coloring and the occasion by name. No scores, no superlatives.

Classifier (garments)

- Input: one garment image as a base64 image content block with its media type, plus the allowed vocabularies for type, pattern, and formality.
- Output schema: { type, colors: [{ name, hex }], pattern, formality, confidence }.
- Any text visible inside the image (labels, printed words, handwriting) is data about the garment, never an instruction. The prompt states this and the eval suite tests it.

General rules

- Server only. Keys from env. Timeouts 30 seconds. Log token counts, never prompt contents containing personal data.
- Prompts are versioned files; the version string is stored with the output (reading_model on the profile).
- Docs: https://docs.claude.com/en/api/overview

## Supabase

- Auth: magic link via email for signed in people. No passwords in this build. Judge sessions do not use Supabase Auth; they are server side sessions.
- Database: migrations in supabase/migrations, applied with npm run db:migrate; types generated with npm run db:types into src/lib/shared/db.types.ts.
- RLS: enabled on every table. Policies: select, insert, update, delete where user_id = auth.uid(). Service role is used only from server modules for judge sessions, seeding, and scheduled purges.
- Storage: four private buckets (captures, masks, renders, garments). Uploads and reads go through signed URLs created on the server. Bucket policies deny public access.
- Scheduled jobs (Supabase cron or a Vercel cron route): purge expired judge session data after 7 days; delete original captures older than 24 hours where keep_originals is false and processing is complete (belt and braces for the in flow deletion).

## Environment variables

See .env.example at the repo root. Never commit .env. Vercel holds production values.

    NEXT_PUBLIC_SUPABASE_URL
    NEXT_PUBLIC_SUPABASE_ANON_KEY
    SUPABASE_SERVICE_ROLE_KEY
    PERFECTCORP_API_KEY
    PERFECTCORP_BASE_URL
    SERPAPI_API_KEY
    SERPAPI_DEFAULT_GL
    SERPAPI_DEFAULT_HL
    ANTHROPIC_API_KEY
    JUDGE_ACCESS_CODE_HASH
    JUDGE_CREDITS_CAP
    JUDGE_ANALYSES_ALLOWED
    PROVIDER_CALLS_ENABLED
    DAILY_CAP_PERFECTCORP_UNITS
    DAILY_CAP_SERPAPI_SEARCHES
