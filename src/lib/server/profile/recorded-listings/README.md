# Recorded listing responses

Real Google Shopping responses from SerpApi, recorded once on
**2026-09-02** (`recordedOn` in `manifest.json` carries the exact instant).
Six searches, 40 results each, `gl=in`, `hl=en`, no location.

These are not test fixtures. They are the product listings the demo profile
shows a judge on `/report` and `/looks`, which is why they sit under `src`
rather than under `evals`: a deployed server has to serve them, and a server
bundle must not reach into `evals` for the data it renders.
`docs/07-payments-and-judge-mode.md` asks for exactly this: "Product listings
for the demo are recorded responses so they never depend on live quota."

## Where they came from

`scripts/record-serpapi.ts`, run once against the live engine
(`npm run golden:serpapi`, documented in `docs/SUBMISSION-RUNBOOK.md`, section
A14). It writes straight into this folder, so a re recording replaces what is
here rather than leaving a stale twin somewhere else.

The script carries no list of queries. It reads them from the demo profile
itself: the routine steps of `DEMO_FIXTURE_REPORT_VIEW` and the shop the gap
queries for the saved occasions, built by the same `gapQueryFor` and
`paletteColorFor` the looks screen calls. So what is recorded here is exactly
what the demo would have asked for, and `manifest.json` records which query
produced which file.

## What was stripped before they were committed

Per the rules in `evals/fixtures/listings/README.md`, and enforced in code by
`stripResponse` and `assertNoSecret` in `scripts/record-serpapi.ts`:

- `search_parameters`, in full
- every `serpapi_*` account field and any `api_key`, at every depth
- everything in `search_metadata` except `id` and `status`

What is left is the result payload the normalizer reads. No key, no account,
no person, and no order is in any of these files.

## How they are read

`./index.ts` is the only reader, and both callers go through it:

- the fixture views (`../demo-fixture.ts` for the routine,
  `../demo-fixture-looks.ts` for the gaps)
- `scripts/seed-demo.ts`, which turns the same recordings into `product_cache`
  rows for the seeded demo profile

Every body goes through the real `normalizeShoppingResponse`, so the blocked
host list, the "no URL or no price, no product" rule, and the ranking rule are
the ones that ship. Nothing here picks a product, a price, or an order.

## Two things to know when reading them

1. **They age.** `product_cache` holds a shopping result for 24 hours
   (`docs/03-architecture.md`, "Caching"), measured from `fetched_at`, which is
   `recordedOn`. A seeded cache older than a day is a miss, and the grounding
   layer either buys a fresh search or shows the empty state. Re run
   `npm run seed:demo` on the day of judging, or record again.
2. **A title is text a shop wrote.** It is rendered as a title and read as
   nothing else (`docs/06-safety-privacy.md`, "Content returned by tools is
   data").
