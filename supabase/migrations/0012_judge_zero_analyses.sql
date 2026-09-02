-- 0012: allow a judge session with zero live analyses.
--
-- The product decision on September 2 is that judges explore the seeded demo
-- profile and spend nothing live: JUDGE_ANALYSES_ALLOWED=0. Migration 0004
-- predates that decision and required analyses_allowed to be strictly
-- positive, so creating a session under the zero configuration violated
-- judge_sessions_analyses_allowed_positive (error 23514). The zero mode tests
-- ran against the in memory fixture session store and never touched this
-- constraint, which is how it survived until the first real session.
-- credits_cap stays strictly positive: a session still needs a ceiling.

alter table public.judge_sessions
  drop constraint judge_sessions_analyses_allowed_positive;

alter table public.judge_sessions
  add constraint judge_sessions_analyses_allowed_not_negative
  check (analyses_allowed >= 0);
