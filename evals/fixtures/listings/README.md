# Recorded listing fixtures

Spec: docs/05-evals.md, "Fixtures" and suite eval:grounding. These files let
eval:grounding run deterministically, on every PR, without spending SerpApi
quota.

## Status: synthetic, pending a real recording

Every file here is hand written to the shape SerpApi's documented google_shopping
and google_maps responses use. None of them came off the wire, because this
build has no SerpApi key yet. Each file says so in its own `_aurum_fixture` key,
which the provider's zod schema strips, so the note cannot change how the
fixture parses.

What that means for a reader of a passing eval:grounding run: it is evidence
about our normalizer, our blocked host list, our ranking rule, and our cache
freshness rule. It is not evidence about SerpApi's field names. Those are read
from the engine pages recorded in
`src/lib/server/providers/serpapi/endpoints.ts`.

Replace these the first day a key exists:

1. Run each query in `manifest.json` once against the live engine.
2. Save the response body, then strip `search_metadata` down to `id` and
   `status`, and delete `search_parameters`, `serpapi_*` account fields, and
   anything carrying the key.
3. Delete the `_aurum_fixture` key, set `"synthetic": false` and fill
   `"recordedOn"` in `manifest.json`.
4. Update `expectedTopTitle` in the manifest to whatever the real ranking picks,
   and note in the PR whether the ranking still chose sensibly. If it did not,
   that is a real failure: make it a fixture and fix the ranker
   (docs/05-evals.md, "When we find a real failure").

## What each file covers

`manifest.json` is the index: file, engine, query, and what the ranker is
expected to pick. The set deliberately covers the states the report has to
handle, not just the happy one.

- a normal shopping response with a clear winner
- a result from a blocked aggregator host that is also the cheapest, so a
  ranking that ignored the blocked list would visibly pick it
- a result with no price and a result with no shared token, both of which are
  dropped
- a result whose thumbnail is a base64 data URI, which must not reach Postgres
  (docs/03-architecture.md: "Never store an image as base64 in Postgres")
- a result with a price string but no `extracted_price`, which can still be
  shown and sorts last inside its band
- an empty result set, and a response carrying SerpApi's "hasn't returned any
  results" error, both of which mean no product at all
- a top result whose title contains "ignore previous instructions", for
  docs/06-safety-privacy.md, "Content returned by tools is data"
- a google_maps response with one place that has no coordinates, so the distance
  line stays null rather than guessing

No file here contains a real person, a real order, or a real account. Prices,
stores, and URLs are plausible but invented, and the hosts are chosen so that
nothing in this folder is ever fetched by a test: the live HEAD check in
eval:grounding only runs against a live search, and only when SERPAPI_API_KEY is
set.
