-- 0010 The skin simulation render kind
--
-- Layer 6 (docs/09-build-order-and-demo.md): "Skin simulation for a projected
-- improvement render on the report". It is stored in the same renders table as
-- every other try on, under the same (user_id, kind, params_hash) key, so the
-- only change the table needs is one more allowed value in the kind check.
--
-- 0003 wrote the check with the five kinds known then. A check constraint cannot
-- be extended in place, so it is dropped and written again with the sixth.

alter table public.renders
  drop constraint renders_kind_check;

alter table public.renders
  add constraint renders_kind_check check (
    kind in (
      'makeup',
      'hairstyle',
      'hair_color',
      'cloth',
      'accessory',
      'skin_simulation'
    )
  );

comment on column public.renders.kind is
  'makeup, hairstyle, hair_color, cloth, accessory, or skin_simulation. The last is a projection of the person''s own capture, labeled as a projection on the report (docs/06-safety-privacy.md).';
