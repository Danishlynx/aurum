# AURUM

One selfie. Every decision.

AURUM is a mobile first web app that turns a single selfie into a personal aesthetic profile: skin concerns, skin tone and undertone, eye and hair color, face shape, and hair type. Every feature is a lens on that one profile, from a tone first skin report with a grounded routine to makeup shades rendered on the person's own face and a wardrobe composed into occasion ready looks. Every product it recommends is a real listing with a live price and a source URL, never an invented one.

Built for the DevNetwork API + Cloud + AI Hackathon 2026.

## Where the sponsors do real work

- **Perfect Corp YouCam API** reads the selfie. Skin analysis produces the concern scores and masks the report is built from; facial color tones produces the skin, eye, and hair colors the color identity and makeup shades are matched against; face attributes produces the face shape. Later layers add makeup, hairstyle, and cloth try on, rendered on the person's own face.
- **SerpApi** grounds every recommendation. A product appears only when a Google Shopping listing was fetched for it, and its price and store are shown exactly as returned. Google Local supplies availability near the person.

## Stack

Next.js (App Router) and TypeScript in strict mode, Tailwind CSS wired to the design tokens in `docs/02-design-system.md`, Supabase for Postgres, magic link auth, and private storage buckets with row level security on every table, Vercel for hosting and route handlers, zod at every external boundary, Vitest for unit and eval suites, Playwright for the end to end flows. Perfect Corp, SerpApi, and the Anthropic Claude API are called only from server modules under `src/lib/server`, which cannot be imported by client code.

## Setup from a clean clone

Requires Node 20 or newer.

    git clone <repository-url>
    cd aurum
    npm install
    cp .env.example .env.local

Fill `.env.local`. Nothing in it is committed, and the app runs without it in a reduced form: the screens render and `/api/health` reports what is configured, but capture and analysis need Supabase and a Perfect Corp key.

1. Create a Supabase project. Copy the project URL, the anon key, and the service role key into `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
2. Apply the schema: `npm run db:migrate`. This creates the tables, the row level security policies, the four private storage buckets, and the retention functions in `supabase/migrations`.
3. Add the provider keys: `PERFECTCORP_API_KEY` and `PERFECTCORP_BASE_URL` from the YouCam API console, `SERPAPI_API_KEY`, and `ANTHROPIC_API_KEY`.
4. Set a judge access code: `node scripts/hash-code.js "your-code"` prints a bcrypt hash for `JUDGE_ACCESS_CODE_HASH`. The code itself is never stored.
5. `npm run dev`, then open http://localhost:3000 on a phone sized viewport.

Checks, all of which must pass before a pull request:

    npm run build
    npm run lint
    npm run typecheck
    npm run test
    npm run eval:smoke
    npm run e2e

## Judge access

Live URL: TO BE ADDED once the first deploy is promoted.

Judge access code: TO BE ADDED. Enter it at `/judge`, or follow "Judging this build? Enter your access code" from the landing screen. A judge session lasts 24 hours and carries its own credit cap and a fixed number of analyses. When the cap is reached the app keeps working from saved demo data rather than showing a dead screen.

Screenshot of the reveal: TO BE ADDED with Layer 1, which is where the report screen and its masks land.

## Documentation

`docs/` is the source of truth. If the code and a doc disagree, the doc wins until the human says otherwise. Read them in the order given in `CLAUDE.md`, starting with `docs/00-product.md`.

## License

TO BE CHOSEN before submission.
