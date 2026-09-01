-- 0007 Scheduled purges
--
-- Two retention rules, written down in SQL so they run even when an in flow
-- deletion failed.
--
--   1. Judge session data is purged 7 days after the session expires.
--      Sources: docs/03-architecture.md ("purged by a scheduled job 7 days after
--      expiry"), docs/04-integrations.md ("purge expired judge session data
--      after 7 days"), docs/06-safety-privacy.md ("Judge session data is purged
--      7 days after the session expires").
--
--   2. Original captures older than 24 hours are deleted when keep_originals is
--      false and processing is no longer in flight.
--      Sources: docs/04-integrations.md ("delete original captures older than 24
--      hours where keep_originals is false and processing is complete"),
--      docs/06-safety-privacy.md ("A daily scheduled job enforces all of the
--      above in case an in flow deletion failed").
--
-- Both functions are transactional over Postgres rows only. Postgres cannot
-- reach into object storage, so each function RETURNS the object paths it
-- orphaned. The caller (a server route or an edge function running with the
-- service role) must remove those objects with the storage API in the same run.
-- A caller that ignores the returned rows leaves files behind, which is a
-- retention bug. The return value is required work, not a report.

-- Rule 2: originals older than 24 hours ---------------------------------------
create or replace function public.purge_stale_originals()
returns table (capture_id uuid, object_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  -- A capture is in flight while one of its analyses is pending or running.
  -- An analysis whose own updated_at is more than 24 hours old counts as
  -- abandoned rather than in flight, so a stuck job can never pin an original
  -- in storage forever. Job lifetime is capped at 120 seconds, so a 24 hour
  -- window is generous.
  return query
  with stale as (
    select c.id as stale_id, c.storage_path as stale_path
    from public.captures c
    left join public.profiles p on p.user_id = c.user_id
    where c.storage_path is not null
      and c.deleted_at is null
      and c.created_at < now() - interval '24 hours'
      and coalesce(p.keep_originals, false) = false
      and not exists (
        select 1
        from public.analyses a
        where a.capture_id = c.id
          and a.status in ('pending', 'running')
          and a.updated_at >= now() - interval '24 hours'
      )
  ),
  cleared as (
    update public.captures c
    set storage_path = null,
        deleted_at = now()
    from stale s
    where c.id = s.stale_id
    returning s.stale_id, s.stale_path
  )
  select cleared.stale_id, cleared.stale_path from cleared;
end;
$$;

comment on function public.purge_stale_originals() is
  'Clears storage_path and stamps deleted_at on original captures older than 24 hours whose owner has keep_originals false and whose analyses are no longer in flight. Returns (capture_id, object_path) for every object the caller must delete from the captures bucket.';

-- Rule 1: judge session data 7 days after expiry ------------------------------
create or replace function public.purge_expired_judge_data()
returns table (bucket_id text, object_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  expired_ids uuid[];
begin
  select coalesce(array_agg(js.id), '{}'::uuid[])
    into expired_ids
  from public.judge_sessions js
  where js.expires_at < now() - interval '7 days';

  if array_length(expired_ids, 1) is null then
    return;
  end if;

  -- Collect object paths before deleting the rows that carry them.
  return query
    select 'captures'::text, c.storage_path
    from public.captures c
    where c.user_id = any (expired_ids)
      and c.storage_path is not null;

  return query
    select 'masks'::text, m.value
    from public.analyses a
    cross join lateral jsonb_array_elements_text(a.mask_paths) as m (value)
    where a.user_id = any (expired_ids)
      and jsonb_typeof(a.mask_paths) = 'array';

  return query
    select 'renders'::text, r.storage_path
    from public.renders r
    where r.user_id = any (expired_ids)
      and r.storage_path is not null;

  return query
    select 'renders'::text, l.render_path
    from public.looks l
    where l.user_id = any (expired_ids)
      and l.render_path is not null;

  return query
    select 'garments'::text, g.storage_path
    from public.garments g
    where g.user_id = any (expired_ids)
      and g.storage_path is not null;

  -- Then delete, children before parents so no cascade races a returning clause.
  delete from public.analyses a where a.user_id = any (expired_ids);
  delete from public.aesthetic_profiles ap where ap.user_id = any (expired_ids);
  delete from public.renders r where r.user_id = any (expired_ids);
  delete from public.looks l where l.user_id = any (expired_ids);
  delete from public.garments g where g.user_id = any (expired_ids);
  delete from public.jobs jb where jb.user_id = any (expired_ids);
  delete from public.captures c where c.user_id = any (expired_ids);
  delete from public.credit_ledger cl
    where cl.owner_type = 'judge_session'
      and cl.owner_id = any (expired_ids);
  delete from public.judge_sessions js where js.id = any (expired_ids);

  return;
end;
$$;

comment on function public.purge_expired_judge_data() is
  'Deletes every row owned by a judge session that expired more than 7 days ago, including the session itself. Returns (bucket_id, object_path) for every object the caller must delete from storage.';

-- Neither function is reachable from the browser.
revoke all on function public.purge_stale_originals() from public;
revoke all on function public.purge_expired_judge_data() from public;
grant execute on function public.purge_stale_originals() to service_role;
grant execute on function public.purge_expired_judge_data() to service_role;

-- Scheduling
--
-- Option A, Supabase cron. Enable the pg_cron extension in the dashboard
-- (Database, Extensions), then run the two statements below once. They are left
-- commented because pg_cron is not enabled on a fresh project and a migration
-- that assumes it would fail on first push.
--
--   select cron.schedule(
--     'aurum_purge_stale_originals',
--     '17 3 * * *',
--     $cron$ select * from public.purge_stale_originals(); $cron$
--   );
--
--   select cron.schedule(
--     'aurum_purge_expired_judge_data',
--     '37 3 * * *',
--     $cron$ select * from public.purge_expired_judge_data(); $cron$
--   );
--
-- Scheduling this way runs the row deletions only. Storage objects are left
-- orphaned, so Option A alone is not enough on its own.
--
-- Option B, and the one to ship: a Vercel cron route that calls both functions
-- with the service role client, then passes each returned (bucket, path) to
-- storage.from(bucket).remove([...]). This is the only path that deletes rows
-- and objects together. Run it daily.
