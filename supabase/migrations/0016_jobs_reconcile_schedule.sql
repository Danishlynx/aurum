-- 0016 Jobs reconcile schedule
--
-- The scheduled driver for readings nobody is polling.
--
-- Until now the client poll was the only thing that advanced a reading
-- (docs/03-architecture.md, "Jobs"). A tab backgrounded on /analyzing has its
-- timers paused, a phone that loses its network stops asking, and in both cases
-- the task at Perfect Corp runs to completion and is charged whether or not
-- anything reads it: docs/04-integrations.md, polling is mandatory and an
-- unpolled task consumes its units. Vercel's own cron on the Hobby plan runs
-- once a day, which is not a driver for a job with a 120 second lifetime, so the
-- schedule lives here, in the database, next to the rows it is about.
--
-- The shape. Every minute pg_cron runs public.reconcile_open_jobs(). The
-- function returns at once when no analysis job is pending or running, which is
-- most minutes and costs no HTTP call. Otherwise it reads the deployment URL and
-- the bearer out of Vault and asks pg_net to POST /api/jobs/reconcile, which
-- polls every open analysis job no tab is watching (src/lib/server/jobs/
-- reconcile.ts). The route checks the bearer in constant time against
-- JOBS_RECONCILE_SECRET and nothing else: there is no person behind the call.
--
-- Nothing secret is in this file. The URL and the bearer are Vault secrets the
-- human creates once (below), read at call time through vault.decrypted_secrets,
-- and never a literal in a migration or in git.
--
-- Human steps, in order, after this migration is pushed. Also written in
-- supabase/README.md, "Reconcile schedule", and docs/04-integrations.md.
--
--   1. Enable pg_cron and pg_net in the dashboard (Database, Extensions). The
--      two create extension statements below are what the toggle runs; they are
--      kept here so a fresh project pushed from the CLI gets them, and they are
--      "if not exists" so a project that already has them is untouched. If the
--      push fails on either statement, turn the extension on in the dashboard
--      and push again.
--
--   2. Create the two Vault secrets in the SQL editor. The first is the
--      deployment's URL for the route; the second is the same value as
--      JOBS_RECONCILE_SECRET in the Vercel project settings (a long random
--      string, for example: openssl rand -base64 48).
--
--        select vault.create_secret(
--          'https://<your deployment>/api/jobs/reconcile',
--          'aurum_reconcile_url'
--        );
--        select vault.create_secret(
--          '<the value of JOBS_RECONCILE_SECRET>',
--          'aurum_reconcile_secret'
--        );
--
--      Rotating the secret means vault.update_secret on the second and a new
--      value in Vercel; the function reads Vault on every call, so nothing else
--      changes.
--
--   3. Schedule it. Left as a documented statement rather than run here for the
--      same reason 0007 leaves its schedules: it depends on the extension and
--      the secrets both existing, and a migration that assumed either would fail
--      on a fresh push.
--
--        select cron.schedule(
--          'aurum_reconcile',
--          '* * * * *',
--          $$select public.reconcile_open_jobs()$$
--        );
--
--      To watch it: select * from cron.job_run_details order by start_time desc
--      limit 20; and for the HTTP side, select * from net._http_response order
--      by created desc limit 20; (pg_net keeps responses for a few hours). The
--      route logs one aurum.reconcile_pass line per call with its counts. To
--      stop it: select cron.unschedule('aurum_reconcile');

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.reconcile_open_jobs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_url text;
  bearer text;
begin
  -- Most minutes there is nothing open. Return before touching Vault or the
  -- network, so an idle deployment costs nothing here.
  if not exists (
    select 1
    from public.jobs j
    where j.subject_type = 'analysis'
      and j.status in ('pending', 'running')
  ) then
    return;
  end if;

  select s.decrypted_secret into target_url
  from vault.decrypted_secrets s
  where s.name = 'aurum_reconcile_url';

  select s.decrypted_secret into bearer
  from vault.decrypted_secrets s
  where s.name = 'aurum_reconcile_secret';

  if target_url is null or bearer is null then
    -- A warning, not an exception: an exception would mark every run failed in
    -- cron.job_run_details, and the fix is the same either way (step 2 above).
    raise warning 'aurum_reconcile: Vault secrets aurum_reconcile_url and aurum_reconcile_secret must both exist';
    return;
  end if;

  -- pg_net queues the request and a worker sends it; this call does not wait
  -- for the answer. The 30 second timeout bounds how long the worker waits on
  -- the route, not how long the route works: the route bounds itself at a 45
  -- second budget and a 60 second function limit, and settles what it reached
  -- whether or not the worker is still listening.
  perform net.http_post(
    url := target_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || bearer,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

comment on function public.reconcile_open_jobs() is
  'Scheduled every minute by pg_cron. When any analysis job is pending or running, reads the deployment URL and bearer from Vault (aurum_reconcile_url, aurum_reconcile_secret) and asks pg_net to POST /api/jobs/reconcile, which polls every open analysis job nobody is polling. Returns at once when nothing is open.';

-- Reachable by nothing but the role the schedule runs as. pg_cron runs a job as
-- the role that scheduled it, which is postgres from the SQL editor, so postgres
-- is the only grant. The Supabase default privileges hand execute on new public
-- functions to the API roles, so each of those is revoked by name.
revoke all on function public.reconcile_open_jobs() from public;
revoke all on function public.reconcile_open_jobs() from anon;
revoke all on function public.reconcile_open_jobs() from authenticated;
revoke all on function public.reconcile_open_jobs() from service_role;
grant execute on function public.reconcile_open_jobs() to postgres;
