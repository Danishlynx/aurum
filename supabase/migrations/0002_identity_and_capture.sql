-- 0002 Identity and capture
--
-- profiles, captures, analyses, aesthetic_profiles.
-- Spec: docs/03-architecture.md, "Data model".
-- Consent and retention rules: docs/06-safety-privacy.md.

-- profiles ------------------------------------------------------------------
-- A profile row exists only after the person has consented on /welcome, so
-- consent_at is not null and is_adult_confirmed must be true.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  consent_at timestamptz not null,
  consent_version text not null default 'v1',
  is_adult_confirmed boolean not null,
  keep_originals boolean not null default false,
  location_consent boolean not null default false,
  approx_location jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_adult_confirmed_check check (is_adult_confirmed),
  constraint profiles_display_name_length check (
    display_name is null or char_length(display_name) between 1 and 80
  ),
  constraint profiles_approx_location_shape check (
    approx_location is null or jsonb_typeof(approx_location) = 'object'
  )
);

comment on table public.profiles is
  'One row per signed in person, created at consent time. Judge sessions never get a profiles row.';
comment on column public.profiles.consent_at is
  'When the person accepted biometric processing on /welcome. Required before any capture or analyze route runs.';
comment on column public.profiles.consent_version is
  'Version of the consent text that was accepted. Bump the app side constant when the text changes so people re consent.';
comment on column public.profiles.keep_originals is
  'Opt in. False means the original selfie object is deleted once processing is terminal, and by the daily purge at the latest.';
comment on column public.profiles.approx_location is
  'City level only: { city, lat, lng } with lat and lng rounded to 2 decimals. Never a precise coordinate.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- captures ------------------------------------------------------------------
create table public.captures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  sha256 text not null,
  storage_path text,
  width int,
  height int,
  quality jsonb,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint captures_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint captures_width_positive check (width is null or width > 0),
  constraint captures_height_positive check (height is null or height > 0),
  constraint captures_quality_shape check (
    quality is null or jsonb_typeof(quality) = 'object'
  ),
  constraint captures_user_sha256_unique unique (user_id, sha256)
);

comment on table public.captures is
  'One row per uploaded selfie. The image bytes live in the private captures bucket, never in Postgres.';
comment on column public.captures.sha256 is
  'Lowercase hex SHA 256 of the downscaled, EXIF stripped image. Unique per user so the same photo never costs a second credit.';
comment on column public.captures.storage_path is
  'Object path inside the captures bucket. Null once the original has been deleted. Convention: <user_id>/<capture_id>.<ext>';
comment on column public.captures.quality is
  'Client quality gate result: { sharpness, exposure, face_coverage }.';
comment on column public.captures.deleted_at is
  'Set when the original object was removed from storage. The row stays so analyses keep their parent.';

create index captures_user_created_at_idx
  on public.captures (user_id, created_at desc);
create index captures_pending_original_idx
  on public.captures (created_at)
  where storage_path is not null and deleted_at is null;

create trigger captures_set_updated_at
  before update on public.captures
  for each row execute function public.set_updated_at();

-- analyses ------------------------------------------------------------------
create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  capture_id uuid not null references public.captures (id) on delete cascade,
  user_id uuid not null,
  kind text not null,
  status text not null default 'pending',
  provider_task_id text,
  raw jsonb,
  summary jsonb,
  mask_paths jsonb,
  credits_used int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analyses_kind_check check (
    kind in ('skin', 'fitzpatrick', 'attributes', 'face_shape', 'hair_type')
  ),
  constraint analyses_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed')
  ),
  constraint analyses_credits_used_non_negative check (credits_used >= 0),
  constraint analyses_mask_paths_shape check (
    mask_paths is null or jsonb_typeof(mask_paths) = 'array'
  ),
  constraint analyses_capture_kind_unique unique (capture_id, kind)
);

comment on table public.analyses is
  'One row per provider analysis of one capture. Five kinds fan out in parallel from a single upload.';
comment on column public.analyses.raw is
  'Validated provider response with image bytes stripped. Kept for debugging a failed zod parse.';
comment on column public.analyses.summary is
  'Normalized scores and labels the app reads. The raw column is never read by feature code.';
comment on column public.analyses.mask_paths is
  'JSON array of object paths inside the masks bucket, for example ["<user_id>/<capture_id>/redness.png"].';

create index analyses_user_idx on public.analyses (user_id);
create index analyses_capture_idx on public.analyses (capture_id);
create index analyses_open_idx
  on public.analyses (status)
  where status in ('pending', 'running');

create trigger analyses_set_updated_at
  before update on public.analyses
  for each row execute function public.set_updated_at();

-- aesthetic_profiles --------------------------------------------------------
-- The single profile every feature reads from. One row per owner, so user_id is
-- the primary key. No foreign key: a judge session owns rows here too.
create table public.aesthetic_profiles (
  user_id uuid primary key,
  capture_id uuid references public.captures (id) on delete set null,
  skin_type_zones jsonb,
  concerns jsonb not null default '[]'::jsonb,
  skin_age int,
  fitzpatrick int,
  skin_tone_hex text,
  undertone text,
  undertone_source text,
  eye_color_hex text,
  hair_color_hex text,
  face_shape text,
  hair_type jsonb,
  season text,
  palette jsonb,
  reading text,
  reading_model text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aesthetic_profiles_concerns_shape check (jsonb_typeof(concerns) = 'array'),
  constraint aesthetic_profiles_skin_age_range check (
    skin_age is null or skin_age between 1 and 120
  ),
  constraint aesthetic_profiles_fitzpatrick_range check (
    fitzpatrick is null or fitzpatrick between 1 and 6
  ),
  constraint aesthetic_profiles_skin_tone_hex_format check (
    skin_tone_hex is null or skin_tone_hex ~ '^#[0-9a-fA-F]{6}$'
  ),
  constraint aesthetic_profiles_eye_color_hex_format check (
    eye_color_hex is null or eye_color_hex ~ '^#[0-9a-fA-F]{6}$'
  ),
  constraint aesthetic_profiles_hair_color_hex_format check (
    hair_color_hex is null or hair_color_hex ~ '^#[0-9a-fA-F]{6}$'
  ),
  constraint aesthetic_profiles_undertone_check check (
    undertone is null or undertone in ('warm', 'cool', 'neutral')
  ),
  constraint aesthetic_profiles_undertone_source_check check (
    undertone_source is null or undertone_source in ('detected', 'confirmed_by_user')
  ),
  constraint aesthetic_profiles_version_positive check (version >= 1)
);

comment on table public.aesthetic_profiles is
  'The aesthetic profile: one row per owner. Every feature is a lens on this row.';
comment on column public.aesthetic_profiles.concerns is
  'Ranked concerns as [{ key, score, rank, mask_path }]. Tone first ranking comes from src/lib/shared/concerns.ts.';
comment on column public.aesthetic_profiles.skin_age is
  'Cosmetic estimate of surface condition only. The report always renders the framing line beside it.';
comment on column public.aesthetic_profiles.palette is
  'Derived palette as { wear: [...], avoid: [...] }. Recomputed by a pure function, stored for the report.';
comment on column public.aesthetic_profiles.reading is
  'The synthesis paragraph. Passes the lexicon check in docs/06-safety-privacy.md before it is written here.';
comment on column public.aesthetic_profiles.reading_model is
  'Model id plus prompt version that produced reading, so a stale reading can be identified.';

create index aesthetic_profiles_capture_idx on public.aesthetic_profiles (capture_id);

create trigger aesthetic_profiles_set_updated_at
  before update on public.aesthetic_profiles
  for each row execute function public.set_updated_at();
