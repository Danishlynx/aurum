-- 0005 Row Level Security
--
-- Spec: docs/03-architecture.md ("All tables with user_id have RLS: a row is
-- visible only to auth.uid() = user_id") and docs/06-safety-privacy.md
-- ("Row Level Security on every table. A person can only read and change their
-- own rows").
--
-- Two shapes are used.
--
-- 1. Person owned tables. Policies target the authenticated role only and match
--    on user_id = auth.uid(), for select, insert, update and delete.
-- 2. Server owned tables (product_cache, judge_sessions). RLS is enabled and no
--    policy is created, so every client role sees nothing. The service role
--    bypasses RLS, which is how the server reads and writes them.
--
-- Judge owned rows sit in the person owned tables with a judge_sessions id in
-- user_id. auth.uid() is null for a judge, so no policy ever matches those rows
-- and they are reachable only through the service role on the server. That is
-- the intended behaviour: a judge session never holds a Supabase session.
--
-- auth.uid() is wrapped in a scalar subquery so the planner evaluates it once
-- per statement instead of once per row.

alter table public.profiles enable row level security;
alter table public.captures enable row level security;
alter table public.analyses enable row level security;
alter table public.aesthetic_profiles enable row level security;
alter table public.garments enable row level security;
alter table public.looks enable row level security;
alter table public.renders enable row level security;
alter table public.jobs enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.product_cache enable row level security;
alter table public.judge_sessions enable row level security;

-- profiles ------------------------------------------------------------------
create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy profiles_delete_own on public.profiles
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- captures ------------------------------------------------------------------
create policy captures_select_own on public.captures
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy captures_insert_own on public.captures
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy captures_update_own on public.captures
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy captures_delete_own on public.captures
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- analyses ------------------------------------------------------------------
create policy analyses_select_own on public.analyses
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy analyses_insert_own on public.analyses
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy analyses_update_own on public.analyses
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy analyses_delete_own on public.analyses
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- aesthetic_profiles --------------------------------------------------------
create policy aesthetic_profiles_select_own on public.aesthetic_profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy aesthetic_profiles_insert_own on public.aesthetic_profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy aesthetic_profiles_update_own on public.aesthetic_profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy aesthetic_profiles_delete_own on public.aesthetic_profiles
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- garments ------------------------------------------------------------------
create policy garments_select_own on public.garments
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy garments_insert_own on public.garments
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy garments_update_own on public.garments
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy garments_delete_own on public.garments
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- looks ---------------------------------------------------------------------
create policy looks_select_own on public.looks
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy looks_insert_own on public.looks
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy looks_update_own on public.looks
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy looks_delete_own on public.looks
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- renders -------------------------------------------------------------------
create policy renders_select_own on public.renders
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy renders_insert_own on public.renders
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy renders_update_own on public.renders
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy renders_delete_own on public.renders
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- jobs ----------------------------------------------------------------------
create policy jobs_select_own on public.jobs
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy jobs_insert_own on public.jobs
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy jobs_update_own on public.jobs
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy jobs_delete_own on public.jobs
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- credit_ledger -------------------------------------------------------------
-- Read own rows only. Writes are server side with the service role.
-- Deviation from the plain "select, insert, update, delete" shape, on purpose:
-- daily caps are computed from this table (docs/03-architecture.md, Credits and
-- caps), so a client that could insert a negative row or delete a reservation
-- could spend past its own cap. The person can still see every unit spent on
-- their behalf, which is what /profile needs.
create policy credit_ledger_select_own on public.credit_ledger
  for select to authenticated
  using ((select auth.uid()) = owner_id and owner_type = 'user');

-- product_cache and judge_sessions ------------------------------------------
-- No policies on purpose. RLS is on and every client role is denied. Revoking
-- the default grants as well means a mistake in a future policy cannot open
-- these tables to anon or authenticated by accident.
revoke all on table public.product_cache from anon, authenticated;
revoke all on table public.judge_sessions from anon, authenticated;

-- The ledger is never written from the browser.
revoke insert, update, delete on table public.credit_ledger from anon, authenticated;

-- anon holds no session, so no policy above can ever match. Removing the
-- default grants makes that explicit at the privilege layer too.
revoke all on table public.profiles from anon;
revoke all on table public.captures from anon;
revoke all on table public.analyses from anon;
revoke all on table public.aesthetic_profiles from anon;
revoke all on table public.garments from anon;
revoke all on table public.looks from anon;
revoke all on table public.renders from anon;
revoke all on table public.jobs from anon;
revoke all on table public.credit_ledger from anon;
