# Demo wardrobe silhouettes

Six SVG files. **None of them is a photograph.** Each one is a flat outline
filled with a single colour, drawn by code, standing in for a garment photo in
the checked in demo profile.

## What they are for

`docs/07-payments-and-judge-mode.md` says the demo profile includes "a six
garment wardrobe". With `AURUM_DEMO_FIXTURE=true` there is no Supabase project
and no bucket, so `/wardrobe` and the flat lay on `/looks` would have nothing to
draw. These are what they draw instead.

They exist so a screen can be built and screenshotted before any real photograph
exists. They are a representation of the person's own wardrobe, not product data
and not a try on:

- A product is only ever shown from a real listing with a URL and a price
  (`docs/06-safety-privacy.md`, "Grounding and honesty"). Nothing here is a
  product.
- A try on is never faked. The demo profile shows no render at all, and adding a
  drawn one would be a claim about a face.
- A drawn shape labelled "the navy blazer you own" claims nothing about the
  world that the fixture has not already declared.

## Source of truth

The markup lives in `src/lib/server/profile/demo-fixture-wardrobe.ts`, in
`buildGarmentSilhouette`. The files here are copies of what that function
returns, checked in so a human can open one and see what the demo shows without
running the app.

`src/lib/shared/wardrobe-view.test.ts` compares every file byte for byte against
the function's output, so the two cannot drift. If you change a shape, change it
in the module and update these files from the test failure.

## The six

| File | Garment | Colour | Type | Pattern | Formality |
| --- | --- | --- | --- | --- | --- |
| `g01-navy-blazer.svg` | Navy blazer | Navy | blazer | solid | formal |
| `g02-cream-shirt.svg` | Cream shirt | Cream | shirt | solid | smart |
| `g03-olive-chinos.svg` | Olive chinos | Olive | trousers | solid | smart |
| `g04-dark-denim.svg` | Dark denim | Dark denim | jeans | solid | casual |
| `g05-brown-loafers.svg` | Brown loafers | Brown | shoes | solid | smart |
| `g06-rust-knit.svg` | Rust knit | Rust | sweater | texture | smart |

Cream, olive, and rust are wear colours in the fixture profile's own Deep Autumn
palette, so the rules engine has a wardrobe a person with this coloring would
plausibly own.

## Not the classifier fixtures

`evals/fixtures/garments/labels.json` and the 20 real garment photos beside it
are a different thing: they are what `eval:safety` and the classifier evals run
against, including the sticky note prompt injection fixture. See
`evals/fixtures/README.md`. Nothing in this folder is used by an eval that tests
the classifier, because a drawn shape proves nothing about reading a photograph.

## Open item for the human

Replace these with photographs of six real garments once there are ones we can
use, keeping the same ids (`fixture-g01` to `fixture-g06`) so the looks fixtures
do not move.
