-- 0004 Operations
--
-- product_cache, jobs, credit_ledger, judge_sessions.
-- Spec: docs/03-architecture.md ("Jobs", "Caching", "Credits and caps",
-- "Judge mode") and docs/07-payments-and-judge-mode.md.

-- product_cache -------------------------------------------------------------
-- Server owned. No user_id, no user facing policy: see migration 0005.
create table public.product_cache (
  query_hash text primary key,
  engine text not null,
  query jsonb not null,
  results jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_cache_engine_check check (
    engine in ('google_shopping', 'google_maps', 'google_local', 'google_lens')
  ),
  constraint product_cache_query_shape check (jsonb_typeof(query) = 'object'),
  constraint product_cache_results_shape check (jsonb_typeof(results) = 'array'),
  constraint product_cache_query_hash_length check (
    char_length(query_hash) between 8 and 128
  )
);

comment on table public.product_cache is
  'Recorded SerpApi responses keyed by query hash. Freshness is a read time rule, not a constraint: shopping results are used for 24 hours, local results for 6 hours (docs/03-architecture.md, Caching).';
comment on column public.product_cache.query_hash is
  'App computed hash covering engine, query text, location, gl and hl. Lowercase hex SHA 256 is the expected form.';
comment on column public.product_cache.results is
  'Normalized listings: [{ title, priceText, priceValue, currency, url, imageUrl, store }]. Every listing has a real source URL.';
comment on column public.product_cache.fetched_at is
  'When the provider was actually called. Read this for freshness, not created_at.';

create index product_cache_engine_fetched_at_idx
  on public.product_cache (engine, fetched_at desc);

create trigger product_cache_set_updated_at
  before update on public.product_cache
  for each row execute function public.set_updated_at();

-- jobs ----------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  subject_type text not null,
  subject_id uuid,
  status text not null default 'pending',
  provider_task_id text,
  attempts int not null default 0,
  last_polled_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_subject_type_check check (
    subject_type in ('analysis', 'render', 'classification')
  ),
  constraint jobs_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed')
  ),
  constraint jobs_attempts_non_negative check (attempts >= 0)
);

comment on table public.jobs is
  'One row per provider task. The client polls GET /api/jobs; no request ever waits on a provider.';
comment on column public.jobs.attempts is
  'Retry counter. The cap of 2 lives in the job runner so a stuck row can still be inspected rather than rejected by the database.';
comment on column public.jobs.error is
  'Human readable failure text shown in the UI. Never a raw provider payload and never a signed URL.';

create index jobs_user_created_at_idx on public.jobs (user_id, created_at desc);
create index jobs_open_poll_idx
  on public.jobs (last_polled_at nulls first)
  where status in ('pending', 'running');

-- Idempotency from docs/03-architecture.md: creating a job for the same subject
-- while one is running returns the running job instead of starting a second.
create unique index jobs_open_subject_unique
  on public.jobs (subject_type, subject_id)
  where status in ('pending', 'running');

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- credit_ledger -------------------------------------------------------------
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null,
  owner_id uuid not null,
  provider text not null,
  units int not null,
  subject_id uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_ledger_owner_type_check check (
    owner_type in ('user', 'judge_session')
  ),
  constraint credit_ledger_provider_check check (
    provider in ('perfectcorp', 'serpapi', 'anthropic')
  ),
  constraint credit_ledger_units_non_zero check (units <> 0)
);

comment on table public.credit_ledger is
  'Append only record of every provider spend and refund. Daily caps per person and hard caps per judge session are computed from this table.';
comment on column public.credit_ledger.units is
  'Positive for a reservation or spend, negative for a refund. Never zero.';
comment on column public.credit_ledger.subject_id is
  'The analysis, render, or job the spend belongs to, so a refund can find its reservation.';

create index credit_ledger_owner_created_at_idx
  on public.credit_ledger (owner_type, owner_id, created_at desc);
create index credit_ledger_subject_idx
  on public.credit_ledger (subject_id);

create trigger credit_ledger_set_updated_at
  before update on public.credit_ledger
  for each row execute function public.set_updated_at();

-- judge_sessions ------------------------------------------------------------
-- Server owned. A judge never holds a Supabase session, so there is no user
-- facing policy: see migration 0005.
create table public.judge_sessions (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  expires_at timestamptz not null,
  analyses_allowed int not null default 3,
  analyses_used int not null default 0,
  credits_cap int not null,
  credits_used int not null default 0,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint judge_sessions_analyses_allowed_positive check (analyses_allowed > 0),
  constraint judge_sessions_analyses_used_range check (
    analyses_used >= 0 and analyses_used <= analyses_allowed
  ),
  constraint judge_sessions_credits_cap_positive check (credits_cap > 0),
  constraint judge_sessions_credits_used_non_negative check (credits_used >= 0)
);

comment on table public.judge_sessions is
  'A gated session created by POST /api/judge/session. The session id is the owner id on every row written during the session.';
comment on column public.judge_sessions.code_hash is
  'Hash of the access code that opened the session, recorded so a rotated code can be traced. The canonical hash lives in JUDGE_ACCESS_CODE_HASH.';
comment on column public.judge_sessions.credits_cap is
  'Hard cap from JUDGE_CREDITS_CAP. Once credits_used reaches it, provider routes return 429 and reads serve the demo profile.';
comment on column public.judge_sessions.analyses_used is
  'Incremented when a capture reaches the analyze step. The render cap of 6 (docs/07) is enforced by counting public.renders where user_id equals this session id.';

create index judge_sessions_expires_at_idx on public.judge_sessions (expires_at);

create trigger judge_sessions_set_updated_at
  before update on public.judge_sessions
  for each row execute function public.set_updated_at();
