# Recorded listing fixtures

Spec: docs/05-evals.md, "Fixtures" and suite eval:grounding. These files let
eval:grounding run deterministically, on every PR, without spending SerpApi
quota.

## Status: synthetic, and kept that way on purpose

Every file here is hand written to the shape SerpApi's documented google_shopping
and google_maps responses use. None of them came off the wire. Each file says so
in its own `_aurum_fixture` key, which the provider's zod schema strips, so the
note cannot change how the fixture parses.

Real recordings now exist, in
`src/lib/server/profile/recorded-listings`, because the demo profile serves them
at runtime and a deployed server must not read the data it renders out of
`evals`. `eval:grounding` runs over both sets and says which is which. These
hand written ones stay because they cover states a real recording rarely holds
all at once: an empty result, a provider error, a blocked aggregator that is
also the cheapest, a base64 thumbnail, a price with no parsed number, and an
injected title.

What that means for a reader of a passing eval:grounding run: it is evidence
about our normalizer, our blocked host list, our ranking rule, and our cache
freshness rule. It is not evidence about SerpApi's field names. Those are read
from the engine pages recorded in
`src/lib/server/providers/serpapi/endpoints.ts`.

## How a response is stripped before it may be committed

The rules any recording follows, here or under `src`. `scripts/record-serpapi.ts`
applies them in code (`stripResponse` and `assertNoSecret`), which is the only
way a response should ever reach the repository:

1. Delete `search_parameters`, in full.
2. Delete every `serpapi_*` account field and any `api_key`, at every depth.
3. Cut `search_metadata` down to `id` and `status`.
4. In a hand written file here, keep the `_aurum_fixture` key and leave
   `"synthetic": true`. In a real recording, there is no such key and the
   manifest says `"synthetic": false` with `"recordedOn"` filled in.

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
