import { writeFileSync } from "node:fs";

import { derivePalette } from "@/lib/shared/palette";

import {
  goldenPathOf,
  loadProfileFixtures,
  paletteInputOf,
} from "../fixtures/profiles";

/**
 * Rewrites the golden palettes in evals/fixtures/profiles/goldens from the
 * current mapping in src/lib/shared/palette.ts.
 *
 *   npx tsx evals/palette/write-goldens.ts
 *
 * This is not part of any suite and nothing runs it automatically. Goldens exist
 * so that a change to the mapping is visible in a diff and has to be argued for:
 * docs/05-evals.md, eval:palette, "Any change to the mapping updates the goldens
 * deliberately in the same PR with a note on why". Run this only after deciding
 * the new mapping is right, then read the diff before committing it.
 */

for (const fixture of loadProfileFixtures()) {
  const palette = derivePalette(paletteInputOf(fixture));
  writeFileSync(
    goldenPathOf(fixture),
    `${JSON.stringify(palette, null, 2)}\n`,
    "utf8",
  );
  console.log(`${fixture.id}: ${palette.season}`);
}
