-- 0013 Saved makeup look
--
-- One column on aesthetic_profiles for "Save this look" on /makeup.
--
-- docs/01-user-flow.md section H item 4 says "'Save this look' saves the selected
-- shades to the profile", and section L item 2 lists the saved makeup look on
-- /profile. Neither docs/03-architecture.md nor any migration before this one
-- gave it a home: the screen posted to a route that did not exist, the person was
-- told the look was not saved, and src/lib/server/profile/view.ts records the gap
-- in its own header ("there is no column for a saved makeup selection and no
-- route that writes one"). This is that gap, filled the same way migration 0009
-- filled it for the hair choice.
--
-- Why here and not a new table: one person has one saved makeup look, the same
-- way they have one hair choice and one undertone, and aesthetic_profiles is the
-- row every feature already reads. Saved outfits have their own table because a
-- person has many of those; this is one.
--
-- Why jsonb and not four columns: the look is a list of categories, each with a
-- shade, and it is the same list a makeup render is created and hashed under
-- (makeupRenderParamsSchema in src/lib/shared/color-view.ts, canonicalMakeupParams
-- in src/lib/server/renders/params.ts). Storing it in that shape is what lets the
-- saved look find the render it was made with instead of asking for a new one:
-- the screen opens on these shades, the hash matches the renders row, and the try
-- on the founder already paid for is what a judge sees.
--
-- The check below is the shape only, not the vocabulary. The app validates every
-- category and every hex against makeupRenderParamsSchema before writing
-- (src/lib/server/profile/makeup.ts), and reads it back through the same schema,
-- so a row written by an older build can never reach a screen as a colour it
-- cannot draw.

alter table public.aesthetic_profiles
  add column saved_makeup jsonb,
  add constraint aesthetic_profiles_saved_makeup_shape check (
    saved_makeup is null or (
      jsonb_typeof(saved_makeup) = 'object'
      and jsonb_typeof(saved_makeup -> 'categories') = 'array'
      and jsonb_array_length(saved_makeup -> 'categories') between 1 and 4
    )
  );

comment on column public.aesthetic_profiles.saved_makeup is
  'The shades saved by "Save this look" on /makeup, as {"categories":[{"category":"lip","shadeHex":"#9c5a44","shadeName":"Terracotta"}]}. The same shape a makeup render is created and hashed under, so the saved look finds its stored render instead of spending a credit. Null means nothing has been saved, which is what every profile starts as.';

-- Row Level Security: nothing to add, for the reason migration 0009 gives. RLS is
-- enabled on this table in migration 0005 and its four policies are per row
-- ((select auth.uid()) = user_id), so they cover every column, this one included.
-- A judge session reaches the row through the service role client, which is the
-- path the rest of the profile already takes.
