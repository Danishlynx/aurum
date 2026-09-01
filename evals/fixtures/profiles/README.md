# Profile fixtures and golden palettes

Spec: docs/05-evals.md, "Fixtures": three complete profiles (deep warm, medium
neutral, light cool) with known expected palettes as golden files, and suite
eval:palette, which compares `derivePalette` against them on every PR.

## What is here

    deep-warm.json        Fitzpatrick V, warm, near black hair, dark brown eyes
    medium-neutral.json   Fitzpatrick IV, neutral, dark brown hair, brown eyes
    light-cool.json       Fitzpatrick I, cool, light brown hair, blue eyes
    goldens/*.palette.json  the palette each profile currently produces
    index.ts              loader, with a zod shape for both files

All three are SYNTHETIC. No person's coloring is recorded here, and no photo
lives in this folder, so the consent rule in evals/fixtures/README.md has nothing
to bite on. Two of the three copy their hexes from an analysis fixture so the
same coloring produces the same palette everywhere in the repository:

- `deep-warm` copies `evals/fixtures/analyses/a09.json`, which is the set
  `src/lib/server/profile/demo-fixture.ts` is built from. Its golden is
  therefore the palette the demo profile shows on /color.
- `light-cool` copies `evals/fixtures/analyses/a01.json`.
- `medium-neutral` has no matching analysis fixture. The only neutral set in
  that folder is a12, which is Fitzpatrick VI and therefore deep. Open item:
  add a neutral Fitzpatrick IV analysis set and copy its hexes here.

## Why these three

They are the three corners the mapping has to get right. Deep warm proves the
tone first duty (deep coloring lands a deep season with a full list, never a
thin pale one). Light cool proves the opposite end. Medium neutral proves the
row that has no strong temperature and therefore leans on contrast.

## What a golden is

The complete `Palette` returned by `derivePalette` for that profile: season,
display name, season line, ten colors to wear, five to keep away from the face,
each with its hex and its one line of why.

The point of recording all of it, rather than only the season, is that the words
are part of the product. A change to a why line is a change a reviewer should
see in a diff.

## Changing a golden

docs/05-evals.md: "Any change to the mapping updates the goldens deliberately in
the same PR with a note on why."

1. Change the mapping or the color data in `src/lib/shared/palette.ts`.
2. Run `npx tsx evals/palette/write-goldens.ts`.
3. Read the diff. If a season changed, say why in the PR description. If a why
   line changed, check it still reads as one plain sentence about the person's
   coloring.
4. Run `npm run eval:palette`.

Never edit a golden by hand to make a test pass. Either the mapping is right and
the golden follows it, or the mapping is wrong and the mapping changes.
