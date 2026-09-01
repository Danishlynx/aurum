import { describe, expect, it } from "vitest";

import { copy } from "./copy";
import {
  faceShapeLine,
  FACE_SHAPE_UNKNOWN_LINE,
  HAIR_COLOR_LIGHTER_THAN_SKIN_MARGIN,
  HAIR_COLOR_NAMES,
  HAIR_COLOR_WHY_ANCHORS,
  HAIR_FACE_SHAPES,
  HAIR_STYLE_NAME,
  hairColorsFor,
  hairStylesFor,
  isHairColorName,
  isHairStyleId,
  MAX_HAIR_COLORS,
  MAX_HAIR_STYLES,
  MIN_HAIR_COLORS,
  MIN_HAIR_STYLES,
  normalizeFaceShape,
  readHairTexture,
  SHAPE_CONSEQUENCE_WORDS,
  type HairColorCandidate,
  type HairFaceShape,
  type HairStyleCandidate,
} from "./hair-rules";
import { checkLexicon, describeViolation } from "./lexicon";
import { lightnessOf, paletteForSeason, SEASONS } from "./palette";

/**
 * The hair rules, docs/01-user-flow.md section I and docs/09 Layer 3.
 *
 * Three things this suite is for:
 *   1. every face shape, and no face shape at all, produces a real row of styles
 *      with a reason that is about a face,
 *   2. the colors follow the palette's temperature and the person's own skin
 *      tone, and degrade to nothing rather than to a guess,
 *   3. every string a person reads passes the same lexicon and punctuation
 *      checks copy.ts does, because these are catalog values held to the copy
 *      standard (the arrangement evals/palette uses for the palette lines).
 */

/** Every shape the table covers, plus the null column. */
const SHAPES: readonly (HairFaceShape | null)[] = [...HAIR_FACE_SHAPES, null];

/** The fixture coloring: deep warm skin, the same tone a09 carries. */
const DEEP_WARM_SKIN = "#6b4a2f";
const LIGHT_SKIN = "#f0d5c0";

function expectClean(text: string): void {
  const violations = checkLexicon(text);
  expect(
    violations.map(describeViolation),
    `"${text}" is not lexicon clean`,
  ).toEqual([]);
}

/** Sentence case, one sentence or more, a full stop, nothing doubled. */
function expectSentence(text: string): void {
  expectClean(text);
  expect(text, `"${text}" has leading or trailing space`).toBe(text.trim());
  expect(text, `"${text}" has a doubled space`).not.toMatch(/ {2}/u);
  expect(text[0], `"${text}" does not start with a capital`).toBe(
    text[0]?.toUpperCase(),
  );
  expect(text.endsWith("."), `"${text}" does not end with a full stop`).toBe(true);
  expect(text.length).toBeGreaterThan(20);
}

/** A plain name: sentence case, no full stop, no title case. */
function expectName(name: string): void {
  expectClean(name);
  expect(name).toBe(name.trim());
  expect(name.endsWith("."), `"${name}" ends with a full stop`).toBe(false);
  expect(name[0]).toBe(name[0]?.toUpperCase());
  expect(name.slice(1)).toBe(name.slice(1).toLowerCase());
}

function mentionsShape(why: string, shape: HairFaceShape | null): boolean {
  const text = why.toLowerCase();
  if (shape !== null && text.includes(shape)) {
    return true;
  }
  return SHAPE_CONSEQUENCE_WORDS.some((word) => text.includes(word));
}

/* ------------------------------------------------------------------ */
/* Face shapes                                                          */
/* ------------------------------------------------------------------ */

describe("normalizeFaceShape", () => {
  it("reads the provider's own face shape values", () => {
    expect(normalizeFaceShape("Oval")).toBe("oval");
    expect(normalizeFaceShape("Round")).toBe("round");
    expect(normalizeFaceShape("Square")).toBe("square");
    expect(normalizeFaceShape("Heart")).toBe("heart");
    expect(normalizeFaceShape("Oblong")).toBe("oblong");
    expect(normalizeFaceShape("Diamond")).toBe("diamond");
    expect(normalizeFaceShape("Triangle")).toBe("triangle");
  });

  it("reads an inverted triangle as the heart row, which is the same face", () => {
    expect(normalizeFaceShape("InvTriangle")).toBe("heart");
  });

  it("returns null for a shape we have no rules for, rather than the nearest one", () => {
    expect(normalizeFaceShape("Unknown")).toBeNull();
    expect(normalizeFaceShape("")).toBeNull();
    expect(normalizeFaceShape("hexagon")).toBeNull();
    expect(normalizeFaceShape(null)).toBeNull();
  });

  it("ignores case and surrounding space, because the column is provider text", () => {
    expect(normalizeFaceShape("  oVaL ")).toBe("oval");
  });
});

describe("the face shape line", () => {
  it("is the doc's sentence, word for word, for an oval", () => {
    expect(faceShapeLine("oval")).toBe(
      "Your face shape reads as oval. Most lengths and partings suit you; the styles below add structure at the jaw.",
    );
  });

  it("names the shape and then says what the styles do about it", () => {
    for (const shape of HAIR_FACE_SHAPES) {
      const line = faceShapeLine(shape);
      expect(line.startsWith(`Your face shape reads as ${shape}.`)).toBe(true);
      // One sentence of shape, one of consequence.
      expect(line.split(". ").length).toBeGreaterThanOrEqual(2);
      expectSentence(line);
    }
  });

  it("says the shape was not read rather than naming one, when there is none", () => {
    expect(faceShapeLine(null)).toBe(FACE_SHAPE_UNKNOWN_LINE);
    expect(faceShapeLine(null)).not.toContain("reads as");
    expectSentence(faceShapeLine(null));
  });

  it("uses the template from copy.ts, so the first sentence has one owner", () => {
    expect(copy.hair.faceShapeLineTemplate).toBe(
      "Your face shape reads as {shape}.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Styles                                                               */
/* ------------------------------------------------------------------ */

function stylesFor(shape: HairFaceShape | null): HairStyleCandidate[] {
  return hairStylesFor({ faceShape: shape, hairType: null });
}

describe("hairStylesFor", () => {
  it("gives 3 to 4 candidates for every shape and for no shape", () => {
    for (const shape of SHAPES) {
      const styles = stylesFor(shape);
      expect(styles.length, `${String(shape)} row`).toBeGreaterThanOrEqual(
        MIN_HAIR_STYLES,
      );
      expect(styles.length, `${String(shape)} row`).toBeLessThanOrEqual(
        MAX_HAIR_STYLES,
      );
    }
  });

  it("gives four candidates today, which is the six render judge cap with two colors", () => {
    for (const shape of SHAPES) {
      expect(stylesFor(shape)).toHaveLength(4);
    }
  });

  it("never repeats a style inside one row", () => {
    for (const shape of SHAPES) {
      const ids = stylesFor(shape).map((style) => style.id);
      expect(new Set(ids).size, `${String(shape)} row`).toBe(ids.length);
    }
  });

  it("uses catalog ids and the one name each id has", () => {
    for (const shape of SHAPES) {
      for (const style of stylesFor(shape)) {
        expect(isHairStyleId(style.id)).toBe(true);
        expect(style.name).toBe(HAIR_STYLE_NAME[style.id]);
      }
    }
  });

  it("carries the two names the flow doc gives as examples", () => {
    const names = Object.values(HAIR_STYLE_NAME);
    expect(names).toContain("Textured crop");
    expect(names).toContain("Soft layers past the collarbone");
  });

  it("ties every reason to the shape or to a consequence of one", () => {
    for (const shape of SHAPES) {
      for (const style of stylesFor(shape)) {
        expect(
          mentionsShape(style.why, shape),
          `${String(shape)}: "${style.why}" says nothing about a face`,
        ).toBe(true);
      }
    }
  });

  it("writes every name and every reason to the copy standard", () => {
    for (const shape of SHAPES) {
      for (const style of stylesFor(shape)) {
        expectName(style.name);
        expectSentence(style.why);
      }
    }
  });

  it("returns the same row for the same input, so a style id is a stable cache key", () => {
    expect(stylesFor("round")).toEqual(stylesFor("round"));
    expect(stylesFor(null)).toEqual(stylesFor(null));
  });
});

describe("hairStylesFor with a hair type", () => {
  it("adds one clause about the hair and keeps the shape reason intact", () => {
    const plain = stylesFor("oval");
    const curly = hairStylesFor({
      faceShape: "oval",
      hairType: { texture: "curly", curl: "3b" },
    });

    expect(curly).toHaveLength(plain.length);
    for (let index = 0; index < curly.length; index += 1) {
      const base = plain[index];
      const withHair = curly[index];
      expect(withHair.id).toBe(base.id);
      expect(withHair.why.startsWith(base.why)).toBe(true);
      expect(withHair.why.length).toBeGreaterThan(base.why.length);
      expect(withHair.why.toLowerCase()).toContain("curl");
      expectSentence(withHair.why);
    }
  });

  it("adds nothing when the reading exists but names no texture", () => {
    const reading = hairStylesFor({
      faceShape: "square",
      hairType: { texture: null, curl: null },
    });
    expect(reading).toEqual(stylesFor("square"));
  });

  it("writes a clean clause for every texture", () => {
    for (const texture of ["straight", "wavy", "curly", "coily"] as const) {
      for (const style of hairStylesFor({
        faceShape: null,
        hairType: { texture, curl: null },
      })) {
        expectSentence(style.why);
      }
    }
  });
});

describe("readHairTexture", () => {
  it("reads the four textures out of a provider term", () => {
    expect(readHairTexture("Straight")).toBe("straight");
    expect(readHairTexture("wavy 2b")).toBe("wavy");
    expect(readHairTexture("3C curly")).toBe("curly");
    expect(readHairTexture("coily 4a")).toBe("coily");
  });

  it("reads a coily term as coily, not as oily", () => {
    expect(readHairTexture("coily")).toBe("coily");
  });

  it("returns null for a term it does not recognise, which is the usual case", () => {
    expect(readHairTexture(null)).toBeNull();
    expect(readHairTexture("")).toBeNull();
    expect(readHairTexture("medium density")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Colors                                                               */
/* ------------------------------------------------------------------ */

const DEEP_AUTUMN = paletteForSeason("deep_autumn");
const COOL_SUMMER = paletteForSeason("cool_summer");

function colorsFor(
  season: Parameters<typeof paletteForSeason>[0],
  skinToneHex: string | null,
): HairColorCandidate[] {
  return hairColorsFor({ palette: paletteForSeason(season), skinToneHex });
}

describe("hairColorsFor", () => {
  it("returns nothing when there is no palette, so the screen shows styles alone", () => {
    expect(hairColorsFor({ palette: null, skinToneHex: DEEP_WARM_SKIN })).toEqual(
      [],
    );
    expect(hairColorsFor({ palette: null, skinToneHex: null })).toEqual([]);
  });

  it("returns 3 to 4 colors for every season", () => {
    for (const season of SEASONS) {
      const colors = colorsFor(season, DEEP_WARM_SKIN);
      expect(colors.length, season).toBeGreaterThanOrEqual(MIN_HAIR_COLORS);
      expect(colors.length, season).toBeLessThanOrEqual(4);
      expect(colors.length, season).toBe(MAX_HAIR_COLORS);
    }
  });

  it("takes the warm family for a warm season and the cool family for a cool one", () => {
    const warm = hairColorsFor({
      palette: DEEP_AUTUMN,
      skinToneHex: DEEP_WARM_SKIN,
    }).map((color) => color.name);
    const cool = hairColorsFor({
      palette: COOL_SUMMER,
      skinToneHex: DEEP_WARM_SKIN,
    }).map((color) => color.name);

    expect(warm).toContain("Warm chestnut");
    expect(warm.some((name) => name.startsWith("Cool"))).toBe(false);
    expect(cool.every((name) => !warm.includes(name))).toBe(true);
  });

  it("gives the demo coloring the chestnut the demo beat shows", () => {
    // docs/09-build-order-and-demo.md, Layer 3 demo beat: "a warm chestnut
    // applied". The fixture profile has to be able to produce it.
    expect(
      hairColorsFor({
        palette: DEEP_AUTUMN,
        skinToneHex: DEEP_WARM_SKIN,
      })[0]?.name,
    ).toBe("Warm chestnut");
  });

  it("skips a color lighter than the skin by more than the margin", () => {
    const skin = lightnessOf(DEEP_WARM_SKIN);
    expect(skin).not.toBeNull();
    const cut = (skin ?? 0) + HAIR_COLOR_LIGHTER_THAN_SKIN_MARGIN;
    for (const color of hairColorsFor({
      palette: DEEP_AUTUMN,
      skinToneHex: DEEP_WARM_SKIN,
    })) {
      expect(lightnessOf(color.hex) ?? 0, color.name).toBeLessThanOrEqual(cut);
    }
    // Honey is the lightest warm shade and sits above the cut on this skin.
    expect(
      hairColorsFor({ palette: DEEP_AUTUMN, skinToneHex: DEEP_WARM_SKIN }).map(
        (color) => color.name,
      ),
    ).not.toContain("Honey");
  });

  it("lets a lighter skin tone reach the lighter end of the family", () => {
    const light = hairColorsFor({
      palette: DEEP_AUTUMN,
      skinToneHex: LIGHT_SKIN,
    }).map((color) => color.name);
    expect(light).toContain("Honey");
    expect(light).not.toEqual(
      hairColorsFor({ palette: DEEP_AUTUMN, skinToneHex: DEEP_WARM_SKIN }).map(
        (color) => color.name,
      ),
    );
  });

  it("still returns a full row when there is no tone to cut against", () => {
    const colors = hairColorsFor({ palette: DEEP_AUTUMN, skinToneHex: null });
    expect(colors).toHaveLength(MAX_HAIR_COLORS);
  });

  it("orders the row deepest first", () => {
    for (const season of SEASONS) {
      const colors = colorsFor(season, DEEP_WARM_SKIN);
      const lightness = colors.map((color) => lightnessOf(color.hex) ?? 0);
      expect([...lightness].sort((a, b) => a - b)).toEqual(lightness);
    }
  });

  it("uses catalog names and lowercase six digit hexes", () => {
    for (const season of SEASONS) {
      for (const color of colorsFor(season, DEEP_WARM_SKIN)) {
        expect(isHairColorName(color.name)).toBe(true);
        expect(HAIR_COLOR_NAMES).toContain(color.name);
        expect(color.hex).toMatch(/^#[0-9a-f]{6}$/u);
      }
    }
  });

  it("writes every reason about the person's own coloring, to the copy standard", () => {
    for (const season of SEASONS) {
      for (const color of colorsFor(season, LIGHT_SKIN)) {
        expectName(color.name);
        expectSentence(color.why);
        expect(
          HAIR_COLOR_WHY_ANCHORS.some((anchor) =>
            color.why.toLowerCase().includes(anchor),
          ),
          `"${color.why}" does not mention the person's coloring`,
        ).toBe(true);
      }
    }
  });

  it("returns fresh objects, so a caller cannot edit the catalog", () => {
    const first = hairColorsFor({
      palette: DEEP_AUTUMN,
      skinToneHex: DEEP_WARM_SKIN,
    });
    const second = hairColorsFor({
      palette: DEEP_AUTUMN,
      skinToneHex: DEEP_WARM_SKIN,
    });
    expect(first).toEqual(second);
    expect(first[0]).not.toBe(second[0]);
  });
});
