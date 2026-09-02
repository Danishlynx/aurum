-- 0011: allow SVG on the garments bucket only.
--
-- The demo wardrobe (scripts/seed-demo.ts, fixtures mode) uploads six garment
-- silhouettes drawn in code as SVG files, because no photographs of garments
-- exist before the founder photographs real ones. Migration 0006 limited the
-- garments bucket to photographic MIME types, which refuses those uploads.
-- SVG is safe in this position: every object in the bucket is private, read
-- only through short lived signed URLs, and rendered exclusively inside img
-- elements, where browsers do not execute scripts embedded in SVG documents.
-- The captures, masks, and renders buckets stay photographic only.

update storage.buckets
set allowed_mime_types = allowed_mime_types || array['image/svg+xml']
where id = 'garments'
  and not ('image/svg+xml' = any (allowed_mime_types));
