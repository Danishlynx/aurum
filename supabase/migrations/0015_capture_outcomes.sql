-- 0015 Capture outcomes
--
-- The numbers behind the one go reading rate, and what captures.quality holds.
--
-- The promise this product makes is one selfie, one reading. The number that
-- says whether it keeps that promise is the one go rate: of the first camera
-- captures the client accepted and a face model measured, how many were read
-- in full by the engine and became a profile without the person doing anything
-- else. Until now nothing in the database could answer that. captures.quality
-- carried eight numbers and dropped the pose the client measured, analyses.raw
-- lost the engine's own face_quality words to a schema that stripped them, and
-- the two tables were never joined.
--
-- Two things change here.
--
-- 1. The comment on captures.quality is brought up to what the column holds
--    since 2026-09-23 (src/lib/shared/capture-quality-stored.ts writes it, and
--    src/lib/shared/schemas.ts is the source of each field's meaning). Every key
--    is a number, a word from a fixed set, or a small object of numbers. No
--    pixel and no landmark is ever stored in it, which docs/06-safety-privacy.md
--    now says out loud.
--
-- 2. A view, capture_outcomes, with one row per capture and nothing in it but
--    the verdict the client gave, whether the engine read the frame in full,
--    whether a profile came of it, and the units it cost. It is what
--    /api/judge/stats reads for the one go rate over the last seven days, and
--    what the calibration report is checked against. It carries no path, no
--    hash, no face word and no raw body: numbers and category words only.
--
-- The 120 second clock. The rate counts a capture as one go when every runnable
-- reading succeeded and the profile row points at the capture. The readings
-- carry their own updated_at, so "within 120 seconds" is measured on the last
-- runnable reading to succeed, against the capture's created_at. It is not
-- measured on the profile row, because that row is one per owner and is
-- rewritten by every later save (a hair choice, a makeup look), so its
-- timestamp says when the person last touched their profile rather than when
-- the reading landed. 120 seconds is the job lifetime (JOB_LIFETIME_MS): a
-- reading that took longer than the app itself is willing to wait was not one
-- go by the app's own definition.

comment on column public.captures.quality is
  'Client quality gate result, numbers only (src/lib/shared/capture-quality-stored.ts). Keys: verdict, reason, sharpness, exposure, mean_luminance, blown_fraction, crushed_fraction, face_coverage, face_width_ratio, pose {yaw_degrees, pitch_degrees, roll_degrees}, face_source, measured, platform (ios, android, desktop), path (camera, gallery, reframe), attempt (1 to 3), frame {source_width, source_height, master_width, master_height}, face_bbox_ratio, face_center {x, y}, face_luma, face_luma_uneven, blink {left, right}, burst_losers [{yaw, pitch, roll, face_width_ratio, face_luma, blink_max, sharpness, score}], landmarker_ms, frame_geometry_version. Older rows carry fewer keys. Never a pixel, never a landmark.';

-- The view -----------------------------------------------------------------

create or replace view public.capture_outcomes
with (security_invoker = false)
as
with runnable as (
  -- The four readings one selfie can run. hair_type needs three photos and is
  -- closed as failed on every capture, so it never decides anything here.
  select a.capture_id,
         count(*) filter (where a.status = 'succeeded') as succeeded_kinds,
         max(a.updated_at) filter (where a.status = 'succeeded') as last_success_at,
         bool_or(a.status = 'failed' and (a.raw -> 'refusal' ->> 'reason') = 'provider') as provider_failed,
         coalesce(sum(a.credits_used), 0) as units_charged
  from public.analyses a
  where a.kind in ('skin', 'fitzpatrick', 'attributes', 'face_shape')
  group by a.capture_id
)
select c.id as capture_id,
       c.created_at,
       c.quality ->> 'platform' as platform,
       c.quality ->> 'path' as path,
       (c.quality ->> 'attempt')::int as attempt,
       c.quality ->> 'verdict' as verdict,
       (c.quality ->> 'measured')::boolean as measured,
       coalesce(r.succeeded_kinds, 0) = 4 as all_runnable_succeeded,
       coalesce(r.provider_failed, false) as provider_failed,
       exists (
         select 1
         from public.aesthetic_profiles ap
         where ap.capture_id = c.id
       ) as profile_points_at_capture,
       r.last_success_at is not null
         and r.last_success_at <= c.created_at + interval '120 seconds' as readings_within_120s,
       coalesce(r.succeeded_kinds, 0) = 4
         and exists (
           select 1
           from public.aesthetic_profiles ap
           where ap.capture_id = c.id
         )
         and r.last_success_at is not null
         and r.last_success_at <= c.created_at + interval '120 seconds' as one_go,
       coalesce(r.units_charged, 0)::int as units_charged
from public.captures c
left join runnable r on r.capture_id = c.id;

comment on view public.capture_outcomes is
  'One row per capture, numbers and category words only: when it was taken, platform, path, attempt, the client verdict, whether a face model measured it, all_runnable_succeeded, provider_failed, profile_points_at_capture, readings_within_120s, one_go, and the units charged. one_go is all_runnable_succeeded and profile_points_at_capture and readings_within_120s; it does not look at provider_failed, which the reader excludes on its own (a provider outage says nothing about the frame). Read by /api/judge/stats and the calibration report.';

-- Not reachable from the browser. The view is owned by the migration role and
-- reads the underlying tables without their row level security, which is
-- exactly why nothing but the service role may select from it.
revoke all on public.capture_outcomes from public;
revoke all on public.capture_outcomes from anon;
revoke all on public.capture_outcomes from authenticated;
grant select on public.capture_outcomes to service_role;
