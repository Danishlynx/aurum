-- 0009 Saved hair choice
--
-- Two columns on aesthetic_profiles for "Save this" on /hair.
--
-- docs/01-user-flow.md section I item 4 says "'Save this' saves the chosen style
-- and color to the profile", and section L item 2 lists the saved hair choice on
-- /profile. docs/03-architecture.md has no column for it: the data model carries
-- face_shape and hair_type, which are readings, not choices. This is that gap,
-- filled with the smallest thing that carries the choice.
--
-- Why here and not a new table: one person has one hair choice, the same way
-- they have one undertone and one season, and aesthetic_profiles is the row
-- every feature already reads. A table would add a join for a single pair of
-- values. When saved looks arrive in Layer 5 they get their own table, because
-- a person has many of those.
--
-- Both values are catalog keys owned by src/lib/shared/hair-rules.ts, not free
-- text: the style id is what a render is hashed under, and the color name is
-- what the row on /hair is labelled with. The app checks both against the
-- catalog before writing (src/lib/server/profile/hair.ts); the checks below are
-- only the shape.

alter table public.aesthetic_profiles
  add column saved_hair_style_id text,
  add column saved_hair_color_name text,
  add constraint aesthetic_profiles_saved_hair_style_id_format check (
    saved_hair_style_id is null or saved_hair_style_id ~ '^[a-z]+(-[a-z]+)*$'
  ),
  add constraint aesthetic_profiles_saved_hair_color_name_length check (
    saved_hair_color_name is null or char_length(saved_hair_color_name) between 1 and 48
  );

comment on column public.aesthetic_profiles.saved_hair_style_id is
  'The catalog style id the person saved on /hair, for example textured-crop. Ids live in src/lib/shared/hair-rules.ts and are what a hairstyle render is hashed under.';
comment on column public.aesthetic_profiles.saved_hair_color_name is
  'The catalog hair color name saved with the style, for example Warm chestnut. Null means a style was saved without a color, which is a real choice rather than a missing value.';

-- Row Level Security: nothing to add. RLS is enabled on this table in migration
-- 0005 and its four policies are per row ((select auth.uid()) = user_id), so
-- they cover every column, including these two. anon is already revoked there.
-- Judge sessions reach the row through the service role client, which is the
-- same path the rest of the profile takes.
