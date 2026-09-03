# AURUM

One selfie. Every decision.

AURUM turns one selfie into a personal aesthetic profile: skin concerns with masks, skin tone and undertone, eye and hair color, face shape, and hair type. Every screen is a lens on that one profile, from a tone first skin report with a grounded routine, to makeup shades and hairstyles previewed on the person's own face, to a wardrobe composed into occasion ready looks. Every product it recommends is a real listing with a live price and a source URL, never an invented one.

Built for the DevNetwork API + Cloud + AI Hackathon 2026. The project page content is in [DEVPOST.md](DEVPOST.md). The steps from here to submitted are in [docs/SUBMISSION-RUNBOOK.md](docs/SUBMISSION-RUNBOOK.md).

## Screenshots

All at 390px, all from the demo profile.

| Screen | File | Status |
| --- | --- | --- |
| Capture | `docs/screenshots/capture.png` | TODO-human |
| Reveal | `docs/screenshots/reveal.png` | TODO-human |
| Report | `docs/screenshots/report.png` | TODO-human |
| Color identity | `docs/screenshots/color.png` | TODO-human |
| Makeup | `docs/screenshots/makeup.png` | TODO-human |
| Hair | `docs/screenshots/hair.png` | TODO-human |
| Looks | `docs/screenshots/looks.png` | TODO-human |
| Profile | `docs/screenshots/profile.png` | TODO-human |

`npm run shots` takes the whole set. Build, start the server with `AURUM_DEMO_FIXTURE=true`, then run it; it walks all twelve screens at 390px, saves a full page frame and a fold frame of each, and writes `review.json` with the six anti slop items a browser can answer. Point it at a deployment with `AURUM_SHOTS_BASE_URL`, which is where the submission set comes from. It exits non zero if anything is flagged, and it lists the seven checklist items that still need a person to look.

Working screenshots are taken into `evals/results/screenshots/<layer>/`, which `.gitignore` excludes (`evals/results/*`), because that folder is regenerated on every run. A README in a public repository cannot point at an ignored folder, so the final set is copied into `docs/screenshots/` and committed at submission time:

    # PowerShell
    New-Item -ItemType Directory -Force docs/screenshots
    Copy-Item evals/results/screenshots/*/*.png docs/screenshots/

    # bash
    mkdir -p docs/screenshots && cp evals/results/screenshots/*/*.png docs/screenshots/

Rename each copied file to the name in the table above, review it against the anti slop checklist in `docs/02-design-system.md`, then commit. Nothing in `docs/screenshots/` may contain a face without a written consent record (`evals/fixtures/README.md`).

## Live URL and judge access

Live URL: https://aurum-danishlynxs-projects.vercel.app

Judge access code: AURUM-FU625S (the plain code, published here and on the project page; only its bcrypt hash is ever stored, in `JUDGE_ACCESS_CODE_HASH`).

Enter the code at `/judge`, or follow "Judging this build? Enter your access code" from the landing screen. Your session includes 3 full analyses. The app keeps working from a saved demo profile after that. A session lasts 24 hours and carries a hard credit cap, so a capped session falls back to cached and demo data rather than to a dead screen. `/api/health` reports the build sha, the kill switch state, and which providers are configured, as booleans only.

## Setup from a clean clone

Node 20 or newer. Every command below is a script in `package.json`.

    git clone <repository-url>
    cd aurum
    npm ci

Copy the environment template. Nothing in `.env.local` is committed.

    # PowerShell
    Copy-Item .env.example .env.local

    # bash
    cp .env.example .env.local

### Run it with no keys and no database

Set `AURUM_DEMO_FIXTURE=true` in `.env.local`, then:

    npm run dev

Open http://localhost:3000 at a 390px wide viewport. Landing, judge access, consent, capture, report, color, makeup, hair, wardrobe, looks, and profile all render from the checked in fixture in `src/lib/server/profile/`. The fixture is read only and honest about its gaps: no product card appears, because no listing has been fetched, and no try on appears, because nothing has been rendered. This is the mode the end to end tests and the screenshots run in.

### The landing hero face

The landing hero is a one time reveal over a consented fixture face (`docs/01-user-flow.md` section A). That photograph is not in this repository, because it is a picture of a real person who has to agree to it being published, so the hero currently draws a quiet Basalt frame at exactly the size the reveal will take.

To turn the reveal on, save the image as `public/fixtures/landing-face.jpg` and rebuild. Nothing else changes: `src/components/landing/LandingHero.tsx` checks the server side for that exact path, and with the file present the masks bloom over the face for 600ms, settle over 300ms, and play once, with the settled state shown and no animation under `prefers-reduced-motion`. The rules for the image, including that it may never be a stock model and needs a written consent record, are in `public/fixtures/README.md`.

### Run it for real

1. Create a Supabase project, link it, apply the schema, and regenerate the types. `supabase/README.md` has the exact commands, including the linked form of the type generator and the one migration that can need a permissions workaround.

        npm run db:migrate

2. Fill the Supabase values in `.env.local`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
3. Add the provider keys: `PERFECTCORP_API_KEY` and `PERFECTCORP_BASE_URL` from the YouCam API console, `SERPAPI_API_KEY`, `ANTHROPIC_API_KEY`.
4. Set the judge access code. This prints a bcrypt hash for `JUDGE_ACCESS_CODE_HASH`; the code itself is never stored.

        node scripts/hash-code.js "your-code"

5. Seed the demo profile that judge sessions fall back to. It prints its plan and refuses to write anything until the recorded fixture set exists.

        npx tsx scripts/seed-demo.ts

6. Unset `AURUM_DEMO_FIXTURE` and start the server.

        npm run dev

`docs/SUBMISSION-RUNBOOK.md` turns steps 1 to 6 into an ordered list with the credit arithmetic, the endpoint verification pass, and the deploy.

### Checks

These are the gates. The first five run in CI on every pull request to `develop` and `main`.

    npm run lint        # ESLint, plus the dash rule, the no hex in components rule, and the server only rules
    npm run typecheck   # tsc, no emit
    npm run build       # production build
    npm run test        # unit tests and every eval suite that does not spend credits
    npm run eval:smoke  # eval:capture, eval:palette, eval:grounding, eval:budget, eval:safety
    npm run e2e         # Playwright, 390px, fixture mode, including the accessibility passes
    npm run shots       # the screenshot set at 390px, against a running server

The individual suites are `eval:capture`, `eval:consistency`, `eval:palette`, `eval:synthesis`, `eval:grounding`, `eval:stylist`, `eval:budget`, and `eval:safety`. `eval:consistency` and the live listing check inside `eval:grounding` spend provider credits and never run on a pull request; they run from `.github/workflows/nightly.yml` on a schedule or on demand. Results are written to `evals/results/`.

### Eval results on the submission commit

| Suite | Result |
| --- | --- |
| Commit | TODO-human (the sha tagged `hackathon-submission`) |
| `eval:smoke` | TODO-human (pass or fail per suite) |
| `eval:consistency` | TODO-human (median top concern difference, undertone agreement out of 12, Fitzpatrick agreement) |
| `eval:synthesis` | TODO-human (rubric mean per dimension, and the lowest score any fixture scored) |
| `eval:budget` | TODO-human (units per session, the configured `JUDGE_CREDITS_CAP`, and the headroom) |

## Stack

Next.js (App Router) and TypeScript in strict mode. Tailwind CSS wired to the design tokens in `src/styles/tokens.css`, which are the tokens in `docs/02-design-system.md`. Supabase for Postgres, magic link auth, and four private storage buckets, with row level security on every table. Vercel for hosting and route handlers. zod at every external boundary, including every provider response and every model output. Vitest for unit tests and the eval suites, Playwright for the end to end flows. Perfect Corp, SerpApi, and the Anthropic Claude API are called only from `src/lib/server`, where every module imports `server-only` and a lint rule fails the build if a client component imports one.

## Where the sponsors do real work

- **Perfect Corp YouCam API** is the only thing that reads the face: one upload fans out to skin analysis (per concern scores and the masks the report draws), Fitzpatrick type, facial color tones (skin, eye, and hair color, which is what the palette is derived from), face shape, and hair type, and the same photo is the canvas for the makeup, hairstyle, hair color, and cloth try on previews.
- **SerpApi** is the only thing that decides a product is real: a routine step, a makeup shade, or a gap in a look shows a card only when a Google Shopping listing came back for it, with the price and store printed as returned, and Google Maps or Google Local supplies a nearby store when the person has allowed location.

## Privacy

Consent comes first: nothing is captured or uploaded before the person confirms they are 18 or older and agrees to have their selfie processed, and the server refuses the capture and analyze routes without both. The original photo is deleted from storage as soon as every reading for it is done, unless the person asks us to keep it; what stays is the derived data, which is the product. The app is cosmetic and never medical: it describes concerns and suggests routines, it never diagnoses, and a banned lexicon is enforced by a test over every string of copy and every generated reading. Every product shown is a real listing with a source URL and a price as returned, never an invented one, and every try on is labeled as a preview. Judge sessions are capped in analyses and credits, cannot delete the demo profile, and cannot download data.

## What runs today

All six layers of `docs/09-build-order-and-demo.md` are built: layers 0 to 5 are merged, and layer 6 (the finish layer, which adds the projection row on the report, the accessory slot in the top look, the landing hero reveal, the accessibility passes, and this page) is on `feature/L6-finish`. There is no provider key, no Supabase project, and no deploy yet, so no call has ever been made to Perfect Corp, SerpApi, or the Claude API from this repository. The screens therefore run fixture first: the palette, the concern ranking, the routine, the hair rules, and the look composition are computed by the real pure functions over recorded analyses, and the parts that need a live call render their real empty states rather than a stand in. The Perfect Corp credit table in `docs/04-integrations.md` still has rows marked TBD, and `evals/fixtures/listings/` still holds hand written responses shaped like SerpApi's, both marked as such in place. `docs/SUBMISSION-RUNBOOK.md` is the ordered list of what turns each of those into the real thing.

## Documentation

`docs/` is the source of truth. If the code and a doc disagree, the doc wins until the human says otherwise. Read them in the order given in `CLAUDE.md`, starting with `docs/00-product.md`.

## License

MIT. See [LICENSE](LICENSE).
