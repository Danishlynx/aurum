-- 0006 Storage buckets
--
-- Spec: docs/03-architecture.md ("Storage buckets, all private, all accessed
-- through short lived signed URLs") and docs/06-safety-privacy.md ("All buckets
-- are private").
--
-- Path convention, relied on by the policies below and by the purge functions
-- in migration 0007. The first folder of every object name is the owner id,
-- which is an auth.users id for a signed in person or a judge_sessions id for a
-- judge session:
--
--   captures/<owner_id>/<capture_id>.<ext>
--   masks/<owner_id>/<capture_id>/<concern_key>.<ext>
--   renders/<owner_id>/<render_id>.<ext>
--   garments/<owner_id>/<garment_id>.<ext>
--
-- Never store an image as base64 in Postgres. Never log an object path that is
-- part of a signed URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('captures', 'captures', false, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('masks',    'masks',    false, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('renders',  'renders',  false, 10485760, array['image/jpeg', 'image/png', 'image/webp']),
  ('garments', 'garments', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Supabase ships storage.objects with row level security already enabled, so
-- this migration only adds policies. Everything not matched below is reachable
-- only through the service role, which is how the server mints signed URLs.

-- captures and garments: the person uploads and deletes their own objects.
create policy "aurum_owner_read_own_uploads" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('captures', 'garments')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "aurum_owner_insert_own_uploads" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('captures', 'garments')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "aurum_owner_update_own_uploads" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('captures', 'garments')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id in ('captures', 'garments')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy "aurum_owner_delete_own_uploads" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('captures', 'garments')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- masks and renders: provider outputs. The server writes them with the service
-- role, the person only reads their own.
create policy "aurum_owner_read_own_derived" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('masks', 'renders')
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
