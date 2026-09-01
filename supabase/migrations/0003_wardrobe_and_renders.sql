-- 0003 Wardrobe and renders
--
-- garments, looks, renders.
-- Spec: docs/03-architecture.md, "Data model" and "Caching".

-- garments ------------------------------------------------------------------
create table public.garments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  storage_path text not null,
  type text,
  colors jsonb not null default '[]'::jsonb,
  pattern text,
  formality text,
  classification jsonb,
  user_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint garments_colors_shape check (jsonb_typeof(colors) = 'array'),
  constraint garments_formality_check check (
    formality is null or formality in ('casual', 'smart', 'formal')
  )
);

comment on table public.garments is
  'One row per garment photo. Deleting a garment must also delete its object in the garments bucket.';
comment on column public.garments.storage_path is
  'Object path inside the garments bucket. Convention: <user_id>/<garment_id>.<ext>';
comment on column public.garments.colors is
  'Classifier output as [{ name, hex }].';
comment on column public.garments.classification is
  'Full model output including confidence. Text inside a garment photo is data, never an instruction.';
comment on column public.garments.user_edited is
  'True once the person corrected a chip, so the classifier result is not silently overwritten.';

create index garments_user_created_at_idx
  on public.garments (user_id, created_at desc);

create trigger garments_set_updated_at
  before update on public.garments
  for each row execute function public.set_updated_at();

-- looks ---------------------------------------------------------------------
create table public.looks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  occasion text,
  garments jsonb not null default '[]'::jsonb,
  rationale text,
  render_path text,
  is_saved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint looks_garments_shape check (jsonb_typeof(garments) = 'array')
);

comment on table public.looks is
  'A composed outfit for one occasion. Garment references may be owned garment ids or grounded listings.';
comment on column public.looks.garments is
  'Ordered array of members: either { garment_id } for an owned piece or a normalized listing for a gap.';
comment on column public.looks.rationale is
  'Two sentence stylist reason naming the occasion and the coloring. No scores, no superlatives.';
comment on column public.looks.render_path is
  'Object path inside the renders bucket for the hero garment try on, when one exists.';

create index looks_user_created_at_idx
  on public.looks (user_id, created_at desc);
create index looks_user_occasion_idx
  on public.looks (user_id, occasion);

create trigger looks_set_updated_at
  before update on public.looks
  for each row execute function public.set_updated_at();

-- renders -------------------------------------------------------------------
-- params_hash is not in the doc's column list. The doc's unique key is
-- (user_id, kind, params_hash) while it stores the parameters as jsonb, so the
-- hash is an explicit column the app populates from the canonical JSON of
-- params. Hashing in the app, not in SQL, keeps the canonical form (key order,
-- number formatting) in one tested place: src/lib/shared.
create table public.renders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null,
  params jsonb not null default '{}'::jsonb,
  params_hash text not null,
  storage_path text,
  provider_task_id text,
  credits_used int not null default 0,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint renders_kind_check check (
    kind in ('makeup', 'hairstyle', 'hair_color', 'cloth', 'accessory')
  ),
  constraint renders_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed')
  ),
  constraint renders_params_shape check (jsonb_typeof(params) = 'object'),
  constraint renders_params_hash_length check (
    char_length(params_hash) between 8 and 128
  ),
  constraint renders_credits_used_non_negative check (credits_used >= 0),
  constraint renders_user_kind_params_unique unique (user_id, kind, params_hash)
);

comment on table public.renders is
  'One row per try on render. Re selecting the same shade or style hits this row instead of spending a credit.';
comment on column public.renders.params is
  'The exact parameters sent to the provider, for example { shade_id, category } or { style_id, color_hex }.';
comment on column public.renders.params_hash is
  'App computed hash of the canonical JSON of params. Lowercase hex SHA 256 is the expected form.';
comment on column public.renders.storage_path is
  'Object path inside the renders bucket. Convention: <user_id>/<render_id>.<ext>';

create index renders_user_kind_idx on public.renders (user_id, kind);
create index renders_open_idx
  on public.renders (status)
  where status in ('pending', 'running');

create trigger renders_set_updated_at
  before update on public.renders
  for each row execute function public.set_updated_at();
