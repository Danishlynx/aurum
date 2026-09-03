-- 0014 Session scoped originals
--
-- The founder's retention decision of 2026-09-03, in SQL.
--
-- Until now the original selfie was deleted twice over: in flow, the moment
-- every analysis for the capture went terminal (src/lib/server/jobs/index.ts),
-- and again by purge_stale_originals for anything the in flow deletion missed
-- after 24 hours (migration 0007, rule 2).
--
-- That made every try on impossible for a live person. Makeup try on, hairstyle
-- try on, hair colour try on, and cloth try on all send the original photo as
-- the source image, so a capture whose object was already gone could only ever
-- answer "Preview unavailable for this shade." A judge who ran a real analysis
-- reached /makeup and /hair with a reading and nothing to try it on.
--
-- The decision: the original is retained for the lifetime of the session that
-- made it, and removed when that session ends.
--
--   Judge session: the session ends at judge_sessions.expires_at (24 hours,
--   src/lib/server/env.ts). The object goes then. The rest of the session's data
--   still goes 7 days after expiry, in purge_expired_judge_data, which migration
--   0007 defines and this migration does not touch.
--
--   Signed in person: keep_originals false still means the app does not keep the
--   photo. The session window is the same 24 hours the app uses everywhere else,
--   so the rule below keeps the same interval it always had and now says out
--   loud what that interval is for.
--
-- The in flow deletion is gone from the code, so this function is no longer a
-- safety net behind it. It is the only thing that deletes an original, which is
-- why the judge branch is added here rather than left to the 7 day purge.
--
-- Everything else about rule 2 is unchanged: the function is transactional over
-- Postgres rows only, Postgres cannot reach into object storage, and the caller
-- (the daily cron route, running with the service role) must remove every
-- returned object path from the captures bucket in the same run. The return
-- value is required work, not a report.

create or replace function public.purge_stale_originals()
returns table (capture_id uuid, object_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with stale as (
    select c.id as stale_id, c.storage_path as stale_path
    from public.captures c
    left join public.profiles p on p.user_id = c.user_id
    left join public.judge_sessions js on js.id = c.user_id
    where c.storage_path is not null
      and c.deleted_at is null
      and (
        -- A judge session's photo goes when the session ends.
        (js.id is not null and js.expires_at < now())
        -- A signed in person's photo goes one session window after capture,
        -- unless they asked us to keep it.
        or (
          js.id is null
          and coalesce(p.keep_originals, false) = false
          and c.created_at < now() - interval '24 hours'
        )
      )
      -- A capture is in flight while one of its analyses is pending or running.
      -- An analysis whose own updated_at is more than 24 hours old counts as
      -- abandoned rather than in flight, so a stuck job can never pin an
      -- original in storage forever. Job lifetime is capped at 120 seconds.
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
  'Clears storage_path and stamps deleted_at on original captures whose session has ended: a judge capture once its judge session expired, a signed in person capture one session window (24 hours) after capture when keep_originals is false. Captures with analyses still in flight are left alone. Returns (capture_id, object_path) for every object the caller must delete from the captures bucket.';

-- Unchanged from 0007, restated because create or replace resets nothing else:
-- the function is not reachable from the browser.
revoke all on function public.purge_stale_originals() from public;
grant execute on function public.purge_stale_originals() to service_role;

-- The consent text changed with the rule ------------------------------------
--
-- copy.welcome.section1Body now says the photo is deleted when the session ends,
-- and the privacy sheet says the same. docs/06-safety-privacy.md requires a
-- version bump when the consent text changes, so src/lib/shared/schemas.ts moves
-- CONSENT_VERSION to 'v2' and this column default moves with it: the comment
-- there asks for both to be bumped together, so a row written by the consent
-- route and a row that fell back to the default read the same.
alter table public.profiles alter column consent_version set default 'v2';
