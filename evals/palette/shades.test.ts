import { describe, expect, it, vi } from "vitest";

/**
 * The shade rules are a module under src/lib/server, which imports "server-only"
 * and throws outside a React server environment. The mock replaces that marker
 * package and nothing else, so the rules under test are the shipped ones. Same
 * reasoning as evals/synthesis/profile.test.ts.
 */
vi.mock("server-only", () => ({}));

import { DEMO_FIXTURE_MAKEUP_VIEW } from "@/lib/server/profile/demo-fixture";
import { copy } from "@/lib/shared/copy";
import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";
import type { Palette } from "@/lib/shared/palette";

import {
  buildMakeupCategoryViews,
  chromaOf,
  deepen,
  foundationDepthIndex,
  isNeutralDepth,
  isRedOrPink,
  lighten,
  lightnessOf,
  selectedShade,
  shadeRoot,
  FOUNDATION_DEPTHS,
} from "@/lib/server/profile/shades";

/**
 * eval:palette, second half: the shade rows the palette decides.
 *
 * Spec: docs/01-user-flow.md section H item 2 ("three swatches inside the
 * palette, the middle one selected") and docs/04-integrations.md (the
 * "<shade family> <category>" query grammar).
 *
 * It sits in this suite because a shade row is a consequence of the palette, and
 * docs/09-build-order-and-demo.md gates Layer 2 on eval:palette passing. The
 * palette mapping itself is checked in palette.test.ts.
 *
 * Everything here is deterministic and runs with no key, no database, and no
 * network. The palette below is written by hand rather than derived, so these
 * tests check the shade rules alone and do not move when the mapping changes.
 */

const PALETTE: Palette = {
  season: "deep_autumn",
  seasonDisplayName: "Deep Autumn",
  seasonLine: "Rich, warm, and grounded colors sit closest to your skin.",
  wear: [
    { name: "Cream", hex: "#efe0c4", why: "A soft light beside deeper colors." },
    { name: "Rose", hex: "#c98b86", why: "A muted pink that keeps its warmth." },
    { name: "Teal", hex: "#2f6b6b", why: "A cool colour that still reads deep." },
    { name: "Rust", hex: "#9c4a1e", why: "Warm and grounded against your skin." },
    { name: "Olive", hex: "#5b5a2a", why: "An earth colour that suits your depth." },
  ],
  avoid: [
    { name: "Icy pink", hex: "#f2c7d8", why: "Icy pastels wash you out." },
    { name: "Silver grey", hex: "#c8ccd0", why: "Cool greys flatten your warmth." },
  ],
};

/** The a09 fixture tone: deep and warm. */
const SKIN_TONE = "#6b4a2f";

describe("Layer 2 shades, colour maths", () => {
  it("lightens toward white and deepens toward black", () => {
    const lighter = lighten(SKIN_TONE, 0.2);
    const deeper = deepen(SKIN_TONE, 0.2);
    expect(lighter).not.toBeNull();
    expect(deeper).not.toBeNull();
    expect(lightnessOf(lighter ?? "")).toBeGreaterThan(
      lightnessOf(SKIN_TONE) ?? 0,
    );
    expect(lightnessOf(deeper ?? "")).toBeLessThan(lightnessOf(SKIN_TONE) ?? 1);
  });

  it("answers null for anything that is not a six digit hex", () => {
    expect(lighten("not a hex", 0.2)).toBeNull();
    expect(deepen("#fff", 0.2)).toBeNull();
    expect(lightnessOf("")).toBeNull();
    expect(chromaOf("#12345")).toBeNull();
  });

  it("puts reds, roses, and rusts in the lip family and nothing else", () => {
    expect(isRedOrPink("#9c4a1e")).toBe(true);
    expect(isRedOrPink("#c98b86")).toBe(true);
    expect(isRedOrPink("#5b5a2a")).toBe(false);
    expect(isRedOrPink("#2f6b6b")).toBe(false);
    // A grey is not a colour family, whatever its hue reads as.
    expect(isRedOrPink("#807f7f")).toBe(false);
  });

  it("puts earth tones and near greys in the eye family, never a red", () => {
    expect(isNeutralDepth("#5b5a2a")).toBe(true);
    expect(isNeutralDepth("#4a4a4d")).toBe(true);
    expect(isNeutralDepth("#9c4a1e")).toBe(false);
    // Too light to be an eye shade base.
    expect(isNeutralDepth("#efe0c4")).toBe(false);
  });

  it("keeps a lighter and a deeper rung either side of every foundation depth", () => {
    for (const hex of ["#f7ece1", "#f2d2a9", "#c68642", SKIN_TONE, "#2b1c12"]) {
      const index = foundationDepthIndex(hex);
      expect(index).not.toBeNull();
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(FOUNDATION_DEPTHS.length - 2);
    }
  });

  it("strips a depth word the palette name already carries", () => {
    expect(shadeRoot("Deep teal")).toBe("teal");
    expect(shadeRoot("Rust")).toBe("rust");
    expect(shadeRoot("Burnt orange")).toBe("burnt orange");
  });
});

describe("Layer 2 shades, the four rows", () => {
  const rows = buildMakeupCategoryViews({
    palette: PALETTE,
    skinToneHex: SKIN_TONE,
  });

  it("builds the four rows in the order docs/01 section H lists them", () => {
    expect(rows.map((row) => row.category)).toEqual([
      "lip",
      "blush",
      "foundation",
      "eye",
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      copy.makeup.rowLip,
      copy.makeup.rowBlush,
      copy.makeup.rowFoundation,
      copy.makeup.rowEye,
    ]);
  });

  it("gives every row three shades with the middle one recommended", () => {
    for (const row of rows) {
      expect(row.shades).toHaveLength(3);
      expect(row.recommendedIndex).toBe(1);
      expect(selectedShade(row, null)).toBe(row.shades[1]);
      expect(selectedShade(row, 2)).toBe(row.shades[2]);
      // An index the screen could never have sent falls back to the middle.
      expect(selectedShade(row, 9)).toBe(row.shades[1]);
    }
  });

  it("orders every row lightest first", () => {
    for (const row of rows) {
      const lightness = row.shades.map((shade) => lightnessOf(shade.hex) ?? 0);
      expect(lightness[0]).toBeGreaterThan(lightness[1] ?? 0);
      expect(lightness[1]).toBeGreaterThan(lightness[2] ?? 0);
    }
  });

  it("never repeats a shade name inside a row", () => {
    for (const row of rows) {
      const names = row.shades.map((shade) => shade.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("takes the lip from the deepest red in the palette and the blush from the lightest", () => {
    const lip = rows.find((row) => row.category === "lip");
    const blush = rows.find((row) => row.category === "blush");
    expect(lip?.shades[1]?.hex).toBe("#9c4a1e");
    expect(lip?.shades[1]?.name).toBe("Rust");
    expect(blush?.shades[1]?.hex).toBe("#c98b86");
    expect(blush?.shades[1]?.name).toBe("Rose");
  });

  it("takes the eye shade from the palette's deepest neutral, never from a red", () => {
    const eye = rows.find((row) => row.category === "eye");
    expect(eye?.shades[1]?.hex).toBe("#5b5a2a");
    expect(eye?.shades[1]?.name).toBe("Olive");
  });

  it("puts the person's own tone in the middle of the foundation row", () => {
    const foundation = rows.find((row) => row.category === "foundation");
    expect(foundation?.shades[1]?.hex).toBe(SKIN_TONE);
    expect(foundation?.shades.map((shade) => shade.name)).toEqual([
      "Tan",
      "Deep",
      "Rich",
    ]);
  });

  it("writes every product query as <shade family> <category>", () => {
    const byCategory = new Map(rows.map((row) => [row.category, row]));
    expect(byCategory.get("lip")?.shades.map((shade) => shade.productQuery)).toEqual([
      "light rust lipstick",
      "rust lipstick",
      "deep rust lipstick",
    ]);
    expect(
      byCategory.get("foundation")?.shades.map((shade) => shade.productQuery),
    ).toEqual(["tan foundation", "deep foundation", "rich foundation"]);
    expect(byCategory.get("eye")?.shades.map((shade) => shade.productQuery)).toEqual([
      "light olive eyeshadow",
      "olive eyeshadow",
      "deep olive eyeshadow",
    ]);
  });

  it("produces the same rows every time it is asked", () => {
    const again = buildMakeupCategoryViews({
      palette: PALETTE,
      skinToneHex: SKIN_TONE,
    });
    expect(again).toEqual(rows);
  });

  it("keeps every shade name and every query clear of the banned lexicon", () => {
    for (const row of rows) {
      for (const shade of row.shades) {
        for (const value of [shade.name, shade.productQuery]) {
          for (const violation of checkLexicon(value)) {
            throw new Error(`${value}: ${describeViolation(violation)}`);
          }
        }
      }
    }
  });
});

describe("Layer 2 shades, what is missing stays missing", () => {
  it("shows only the foundation row when there is no palette", () => {
    const rows = buildMakeupCategoryViews({
      palette: null,
      skinToneHex: SKIN_TONE,
    });
    expect(rows.map((row) => row.category)).toEqual(["foundation"]);
  });

  it("drops the foundation row when no tone was read", () => {
    const rows = buildMakeupCategoryViews({
      palette: PALETTE,
      skinToneHex: null,
    });
    expect(rows.map((row) => row.category)).toEqual(["lip", "blush", "eye"]);
  });

  it("recommends nothing at all when there is neither", () => {
    expect(
      buildMakeupCategoryViews({ palette: null, skinToneHex: null }),
    ).toEqual([]);
  });

  it("still builds four rows from the real derived fixture palette", () => {
    // The fixture is the screen a judge sees. Its palette comes from the real
    // derivePalette, so this is where a mapping with no red or no neutral in it
    // would show up as a missing shade row.
    expect(
      DEMO_FIXTURE_MAKEUP_VIEW.categories.map((row) => row.category),
    ).toEqual(["lip", "blush", "foundation", "eye"]);
    for (const row of DEMO_FIXTURE_MAKEUP_VIEW.categories) {
      expect(row.shades).toHaveLength(3);
      for (const shade of row.shades) {
        for (const value of [shade.name, shade.productQuery]) {
          for (const violation of checkLexicon(value)) {
            throw new Error(`${value}: ${describeViolation(violation)}`);
          }
        }
      }
    }
  });

  it("shows no product and no photo on the fixture, because neither exists", () => {
    // docs/06-safety-privacy.md, "Grounding and honesty", and the try on rule:
    // nothing has been fetched and nothing has been rendered, so the screen
    // carries its empty states rather than a stand in.
    expect(DEMO_FIXTURE_MAKEUP_VIEW.product).toBeNull();
    expect(DEMO_FIXTURE_MAKEUP_VIEW.captureImageUrl).toBeNull();
  });

  it("carries the lip colour toward the skin for a palette with one red", () => {
    const single: Palette = {
      ...PALETTE,
      wear: [
        { name: "Rust", hex: "#9c4a1e", why: "Warm and grounded." },
        { name: "Olive", hex: "#5b5a2a", why: "An earth colour." },
      ],
    };
    const rows = buildMakeupCategoryViews({
      palette: single,
      skinToneHex: SKIN_TONE,
    });
    const lip = rows.find((row) => row.category === "lip");
    const blush = rows.find((row) => row.category === "blush");
    expect(lip?.shades[1]?.hex).toBe("#9c4a1e");
    // The blush is the same family sitting over skin, so it is a real colour of
    // its own rather than a copy of the lip.
    expect(blush?.shades[1]?.hex).not.toBe(lip?.shades[1]?.hex);
    expect(blush?.shades).toHaveLength(3);
  });
});
