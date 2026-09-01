# Synthetic analysis sets

Twelve analysis sets, `a01` to `a12`, spanning Fitzpatrick I to VI with two sets
per type, warm and cool undertones, and a range of skin types and top concerns.
`index.ts` loads and validates them.

## What these are, and what they are not

They are **synthetic**. Not one of them came from a person or from Perfect Corp.
Every file says so in its own `note` field, and the loader refuses a file whose
`synthetic` flag is missing.

They exist because there is no Supabase project and no provider key yet, and
because the profile layer still has to be proved before either arrives. Each file
holds exactly what `src/lib/server/jobs/analysis.ts` writes to
`analyses.summary`, so `eval:synthesis` can run the whole deterministic path,
capture analyses to reading to routine, with no key, no network, and no database.

They are **not** the recorded provider responses docs/05-evals.md asks for. Those
need a Perfect Corp key and the consented fixture faces in `evals/fixtures/faces`
(see the consent rule in `evals/fixtures/README.md`). When the key exists:

1. Run the capture set against the fixture faces once.
2. Replace the `summaries` blocks here with what the provider actually returned.
3. Fix the concern names, and fix
   `UNVERIFIED_PERFECT_CORP_CONCERN_MAP` in `src/lib/shared/concerns.ts` with
   them.
4. Keep the `expected` blocks honest: they are the assertions, so they change
   only when the input does, and every change is explained in the PR.

## Two names in here are guesses, on purpose

`pigmentation` is used as a provider concern name even though the published SD
concern list in `src/lib/server/providers/perfectcorp/schemas.ts` does not carry
it. The real name for the pigmentation output is not verified yet
(docs/04-integrations.md, "Verify first"), and the internal key is what the
profile layer consumes, so the fixtures use the internal name and this paragraph
records the debt.

`a12` carries two names that are meant to be awkward:

- `droopy_lower_eyelid`, which the map in `src/lib/shared/concerns.ts` does not
  cover, so it arrives with a null key. It must be counted and dropped, never
  guessed into some other concern.
- `skin_type`, which is the provider's skin type output rather than a concern,
  and which that same map currently sends to `uneven_tone`. The profile layer
  drops it by provider name. Without that guard the report would show a tone
  concern whose score means something else entirely.

## Shape

    id          a01 to a12
    synthetic   always true
    label       one line a person can read in a test report
    note        where the numbers came from, which is nowhere real
    expected    fitzpatrick, undertone, topConcernKey, skinType
    summaries   one entry per analysis kind, null when that kind did not run

`hair_type` is null in every set, because hair type detection takes three photos
of the same size and the capture flow has one selfie
(`src/lib/server/jobs/analysis.ts`, `requiresMorePhotos`).

`expected.topConcernKey` is the concern after the tone first ranking, not the
highest raw score. `a07` and `a11` are the two sets where those differ, which is
the whole point of the rule.
