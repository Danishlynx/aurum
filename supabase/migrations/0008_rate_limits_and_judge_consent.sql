-- 0008 Rate limits and judge consent
--
-- Two additions the API layer needs.
--
--   1. rate_limits: the Postgres backed token bucket named in
--      docs/03-architecture.md ("Rate limiting per IP and per session on
--      capture, analyze, render, and product routes (a Postgres backed token
--      bucket is fine at this scale)") and sized in docs/06-safety-privacy.md
--      ("10 captures per hour, 30 renders per hour, 60 product queries per hour
--      per session").
--
--   2. Consent columns on judge_sessions. docs/06-safety-privacy.md requires
--      consent before any capture, and docs/07-payments-and-judge-mode.md says
--      judge sessions skip Supabase Auth. public.profiles.user_id references
--      auth.users, so a judge can never have a profiles row and their consent
--      has nowhere else to live. The columns below are the judge side of the
--      same gate the capture and analyze routes read.

-- rate_limits -----------------------------------------------------------------
-- Server owned. One row per (bucket, subject). A subject is "session:<owner id>"
-- or "ip:<address>": both are limited, so one person cannot spread a burst over
-- many sessions and one machine cannot be shared by a crowd of sessions.
--
-- tokens refills continuously at the rule's rate, computed in the app from
-- refilled_at, so a person is never blocked for a full hour by one burst. Writes
-- use compare and set on refilled_at, which is why that column is never null.
create table public.rate_limits (
  bucket text not null,
  subject text not null,
  tokens double precision not null,
  refilled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rate_limits_pkey primary key (bucket, subject),
  constraint rate_limits_bucket_length check (char_length(bucket) between 1 and 40),
  constraint rate_limits_subject_length check (char_length(subject) between 1 and 120),
  constraint rate_limits_tokens_non_negative check (tokens >= 0)
);

comment on table public.rate_limits is
  'Token buckets for the capture, analyze, render, and product routes. Server owned: no client role can read or write it.';
comment on column public.rate_limits.subject is
  'Either session:<owner id> or ip:<address>. An address is a rate limit key only and is never joined to a person.';
comment on column public.rate_limits.tokens is
  'Tokens left at refilled_at. The app adds the refill for the time since then before spending one.';
comment on column public.rate_limits.refilled_at is
  'When tokens was last written. Also the compare and set key, so two requests cannot both spend the last token.';

-- Lets a cleanup job find rows nothing has touched in a long time.
create index rate_limits_refilled_at_idx on public.rate_limits (refilled_at);

create trigger rate_limits_set_updated_at
  before update on public.rate_limits
  for each row execute function public.set_updated_at();

-- Same shape as product_cache and judge_sessions in migration 0005: RLS on, no
-- policy, grants revoked. Only the service role reaches it.
alter table public.rate_limits enable row level security;
revoke all on table public.rate_limits from anon, authenticated;

-- judge_sessions consent ------------------------------------------------------
alter table public.judge_sessions
  add column consent_at timestamptz,
  add column consent_version text,
  add column is_adult_confirmed boolean not null default false,
  add column keep_originals boolean not null default false;

comment on column public.judge_sessions.consent_at is
  'When the judge accepted biometric processing on /welcome. Required before the capture and analyze routes will run, exactly as profiles.consent_at is for a signed in person.';
comment on column public.judge_sessions.is_adult_confirmed is
  'The "I am 18 or older" checkbox. Both this and consent_at must be set before a capture is accepted.';
comment on column public.judge_sessions.keep_originals is
  'Opt in. False means the original selfie is deleted once every analysis for the capture is terminal.';

-- A judge session that has consented must have both halves recorded. The column
-- pair is checked rather than made not null so a session can exist before the
-- welcome screen is answered.
alter table public.judge_sessions
  add constraint judge_sessions_consent_pair_check check (
    consent_at is null or is_adult_confirmed
  );
