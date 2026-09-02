# Recorded Perfect Corp responses

Real bodies from the live YouCam API, sanitized so they can be committed. They
exist so the provider schemas and the normalizer are tested against what the API
actually sends, not against what a reference page implied it would send.

Nothing here costs a credit to use. Everything here cost a credit to record.

## The files

### skin-analysis-status.json

`GET /s2s/v2.0/task/skin-analysis/<taskId>`, HTTP 200, recorded 2026-09-02 from
the first live task on the account. One selfie, all 16 SD concern keys, 16 units.

The envelope:

    { "status": 200,
      "data": {
        "error": null,
        "results": { "output": [ ... ] },
        "task_status": "success"
      } }

`data.error` is present and null on success. That single detail is why this file
exists: the first version of `taskStatusResponseSchema` declared
`error: z.string().optional()`, which accepts `undefined` and rejects `null`, so
the poll on a task that had succeeded and been charged threw `invalid_response`
and the golden run recorded it as failed.

`data.results.output` is not a homogeneous list. It mixes four kinds of entry,
all sharing only `type`:

| Entry | Carries | Example |
| --- | --- | --- |
| a scored concern | `ui_score`, `raw_score`, `mask_urls` | `eye_bag`, `dark_circle_v2`, `age_spot` |
| `skin_type`, once per zone | `region`, `skin_type`, `mask_urls` | `whole`, `t_zone`, `u_zone`, all "Normal" |
| `all` and `skin_age` | `score`, no mask | 85.4 overall, 28 years |
| `resize_image` | `mask_urls` only | the frame the engine worked from |

`ui_score` is a condition score on the provider's scale: higher is healthier.
The 99 on redness in this file means clear skin, not severe redness, and the 70
on `dark_circle_v2` is the lowest score on this face and therefore its most
present concern.

Our scale runs the other way, so `presenceScoreFor` in
`src/lib/shared/concerns.ts` inverts every concern once, at the normalization
boundary: `presence = 100 - ui_score`, rounded, clamped 1 to 100. moisture and
radiance are not inverted, because they are read as levels rather than as
problems and `skin-type.ts` reads moisture as hydration. The numbers in this
file are the provider's, untouched: the inversion is tested against them in
`evals/golden/perfectcorp-envelope.test.ts`.

## Sanitizing, and the rule behind it

The raw recording lives at `evals/fixtures/golden/raw/skin/result.json`, which is
gitignored, because every `mask_urls` entry is a signed S3 link carrying the
account's bucket, key id, and signature, and because the mask PNGs beside it are
of a real face.

The committed copy is produced by a script, never by hand:

    npm run fixtures:sanitize -- --in evals/fixtures/golden/raw/skin/result.json --out evals/fixtures/perfectcorp/skin-analysis-status.json

`scripts/sanitize-perfectcorp-fixture.ts` replaces every http or https string
with `https://example.invalid/mask.png` and changes nothing else: scores, types,
regions, and the envelope stay exactly what came back. It then scans the text it
is about to write for an amazonaws host, an `X-Amz-` parameter, a provider host
name, a bearer token, or any URL that is not `example.invalid`, and refuses to
write when it finds one. `evals/golden/perfectcorp-envelope.test.ts` runs the
same scan over the committed file, so a leak fails the suite rather than being
noticed later.

## Adding a recording

1. Record it with a real run. Never fabricate a response: a made up body proves
   nothing about the API and would quietly become the thing the code is written
   against.
2. Keep the raw file under `evals/fixtures/golden/raw/`, which is gitignored.
3. Sanitize it with the command above into this folder.
4. Add a row to "The files" saying what call produced it, when, and what it cost.
5. If the recording changes what we believe about the API, update
   `src/lib/server/providers/perfectcorp/endpoints.ts` and the credit table in
   `docs/04-integrations.md` in the same PR.
