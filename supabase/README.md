# Supabase

The database layer for AURUM: schema, row level security, private storage buckets, and the two retention purges.

The spec is `docs/03-architecture.md` (data model, jobs, caching, credits, judge mode). Retention and access rules come from `docs/06-safety-privacy.md`. Judge session behaviour comes from `docs/07-payments-and-judge-mode.md`. If this folder and those docs disagree, the docs win.

## Migrations

Applied in filename order.

| File | What it creates |
| --- | --- |
| `0001_extensions_and_helpers.sql` | pgcrypto, and `public.set_updated_at()`, the trigger function every table uses |
| `0002_identity_and_capture.sql` | `profiles`, `captures`, `analyses`, `aesthetic_profiles` |
| `0003_wardrobe_and_renders.sql` | `garments`, `looks`, `renders` |
| `0004_operations.sql` | `product_cache`, `jobs`, `credit_ledger`, `judge_sessions` |
| `0005_row_level_security.sql` | RLS on all eleven tables, plus the policies |
| `0006_storage_buckets.sql` | the four private buckets and the `storage.objects` policies |
| `0007_scheduled_purges.sql` | `purge_stale_originals()` and `purge_expired_judge_data()` |

## Create the project

1. Create a project at https://supabase.com/dashboard. Pick the region closest to the Vercel region the app deploys to (`docs/03-architecture.md`, Deployment).
2. In Project Settings, API, copy the project URL, the anon key, and the service role key.
3. Install the CLI: https://supabase.com/docs/guides/local-development/cli/getting-started. `npm run db:migrate` and `npm run db:types` call it through `scripts/supabase-cli.mjs` and fail with a clear message if it is missing.
4. Link the repo to the project, from the repo root:

        npx supabase login
        npx supabase link --project-ref <your-project-ref>

   Linking writes `supabase/config.toml` and `supabase/.temp`. Keep the config, keep the temp folder out of git.

## Apply migrations

Against the linked hosted project:

        npm run db:migrate

That runs `supabase db push`, which applies every migration this project has not seen yet. Review the plan it prints before confirming.

Against a local stack, if you are running one:

        npx supabase start
        npx supabase migration up

To add a change, add a new numbered file. Never edit a migration that has already been pushed; the CLI tracks applied files by name and will not re run an edited one.

### If `0006_storage_buckets.sql` fails on permissions

`storage.objects` is owned by `supabase_storage_admin`. The push normally runs with enough privilege to add policies to it. If it does not, paste the `create policy` statements from that file into the SQL editor in the dashboard and run them there, then mark the migration as applied with `npx supabase migration repair --status applied 0006`.

## Regenerate types

`docs/04-integrations.md` puts the generated types at `src/lib/shared/db.types.ts`. The generator prints to stdout, so redirect it.

PowerShell:

        npx supabase gen types typescript --linked | Set-Content -Encoding utf8 src/lib/shared/db.types.ts

bash:

        npx supabase gen types typescript --linked > src/lib/shared/db.types.ts

`npm run db:types` is wired to `--local` and targets a running local stack. For the hosted project use `--linked` as above. Regenerate after every migration and commit the result, so a clean clone typechecks without a database.

## Environment variables

Set these in `.env.local` for development and in the Vercel project settings for production. `.env.example` at the repo root is the full list.

| Variable | Where it comes from | Where it is used |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings, API, Project URL | browser and server clients |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings, API, anon public | browser client, always subject to RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings, API, service_role | `src/lib/server` only: judge sessions, seeding, purges. Never in a client bundle, never in a log |
| `JUDGE_ACCESS_CODE_HASH` | `node scripts/hash-code.js "your-code"` | `POST /api/judge/session` compares the submitted code against it |
| `JUDGE_CREDITS_CAP` | your credit budget | written to `judge_sessions.credits_cap` when a session is created |
| `JUDGE_ANALYSES_ALLOWED` | default 3 | written to `judge_sessions.analyses_allowed` |

The anon key is safe in the browser only because RLS is on for every table. If a table is ever created without `enable row level security`, the anon key reads it.

## Ownership model

`profiles.user_id` references `auth.users`. No other table has a foreign key on `user_id`, on purpose: a judge session writes rows owned by its `judge_sessions.id`, which is not an `auth.users` id (`docs/07-payments-and-judge-mode.md`, "Data written during a judge session is owned by the session id"). So `user_id` holds one of two things:

- an `auth.users` id, reachable by that person through RLS
- a `judge_sessions` id, reachable only through the service role on the server

`auth.uid()` is null for a judge, so no policy matches judge owned rows. That is what makes judge data server only without a second set of tables.

Consequence to remember: deleting an `auth.users` row does not cascade to captures, analyses, garments, looks, renders, jobs, or ledger entries. "Delete everything" on `/profile` removes rows and storage objects itself, in one transaction, as `docs/06-safety-privacy.md` requires. Judge owned rows are removed by `purge_expired_judge_data()`.

## Row level security

Every table has RLS enabled.

- Person owned tables (`profiles`, `captures`, `analyses`, `aesthetic_profiles`, `garments`, `looks`, `renders`, `jobs`) get four policies each, for select, insert, update and delete, all matching `user_id = auth.uid()` and all scoped to the `authenticated` role.
- `credit_ledger` gets select only. Daily caps are computed from this table, so a client that could insert a negative row or delete a reservation could spend past its own cap. Every write goes through the server with the service role.
- `product_cache` and `judge_sessions` get no policies at all. RLS is on, so every client role sees nothing, and the service role bypasses RLS. Default grants to `anon` and `authenticated` are revoked on both as well, so a future policy cannot open them by accident.

The service role bypasses RLS entirely. Use it only inside `src/lib/server`.

## Storage

Four private buckets, created by `0006_storage_buckets.sql`: `captures`, `masks`, `renders`, `garments`. All have `public = false`, a 10 MB per object limit, and an allow list of `image/jpeg`, `image/png`, `image/webp`.

Every object name starts with its owner id:

        captures/<owner_id>/<capture_id>.<ext>
        masks/<owner_id>/<capture_id>/<concern_key>.<ext>
        renders/<owner_id>/<render_id>.<ext>
        garments/<owner_id>/<garment_id>.<ext>

The `storage.objects` policies read that first folder, so the convention is load bearing. A file written outside it is unreachable by its owner.

Reads and writes go through short lived signed URLs minted on the server: 60 seconds for upload, 10 minutes for read (`docs/03-architecture.md`). The policies are the second line of defence for anything that talks to storage with the anon key and a person's JWT.

## Scheduled purges

Two functions, both `security definer`, both callable only by the service role.

- `public.purge_stale_originals()` clears `storage_path` and stamps `deleted_at` on original captures older than 24 hours whose owner has `keep_originals` false and whose analyses are no longer in flight.
- `public.purge_expired_judge_data()` deletes every row owned by a judge session that expired more than 7 days ago, including the session row.

Both return the storage object paths they orphaned, as `(capture_id, object_path)` and `(bucket_id, object_path)`. Postgres cannot reach object storage, so the caller must pass each returned path to `storage.from(bucket).remove([...])` in the same run. Ignoring the return value leaves files behind, which is a retention bug.

Ship this as a daily Vercel cron route that calls both functions with the service role client and then deletes the objects. `0007_scheduled_purges.sql` also carries the `cron.schedule` statements for pg_cron, commented out, for the rows only case.

## Seed the demo profile

        npx tsx scripts/seed-demo.ts

Today this prints the seeding plan and exits non zero, because the fixture set does not exist yet. Recording it needs the Perfect Corp provider module (`docs/09-build-order-and-demo.md`, Layer 0). The demo rows are owned by a fixed id, the same way judge rows are, so the same read paths serve them.

## Judge access code

        node scripts/hash-code.js "your-code"

Prints a bcrypt hash. Put the hash in `JUDGE_ACCESS_CODE_HASH`, keep the plain code out of git, and publish the plain code on the Devpost page. Rotating means running this again and replacing the env value; sessions already created keep working until `expires_at`.

## Conventions in the schema

- Every table has `created_at` and `updated_at`, and a `before update` trigger that keeps `updated_at` honest.
- Every enumerated column is a `text` column with a check constraint, so a new value is a one line migration rather than a type change.
- Hashes computed by the app (`captures.sha256`, `renders.params_hash`, `product_cache.query_hash`) are lowercase hex SHA 256. Only `captures.sha256` enforces the exact format; the other two enforce length only, so the canonical form can stay in one tested place in `src/lib/shared`.
- Freshness of `product_cache` is a read time rule, not a constraint: 24 hours for shopping, 6 hours for local.
- `jobs` has a partial unique index on `(subject_type, subject_id)` for rows that are pending or running, which is the idempotency rule from `docs/03-architecture.md` written down.

## Open items

- No Supabase project exists yet, so no migration in this folder has been run. Apply them against a fresh project and check the output before trusting them.
- `npm run db:types` targets a local stack. Decide whether to run a local stack or change the script to `--linked`, then keep one form.
- pg_cron is not enabled by default. Decide between the Vercel cron route (deletes rows and objects) and pg_cron (rows only), and enable whichever you pick.
- `credit_ledger.provider` is checked against `perfectcorp`, `serpapi`, `anthropic`. Adding a fourth provider needs a migration.
