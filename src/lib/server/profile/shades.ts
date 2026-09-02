import "server-only";

import type {
  MakeupCategory,
  MakeupCategoryView,
  MakeupRenderCategoryInput,
  ShadeOption,
} from "@/lib/shared/color-view";
import { copy } from "@/lib/shared/copy";
import type { Palette, PaletteColor } from "@/lib/shared/palette";

import { buildProductQuery } from "../providers/serpapi";
import { hexToRgb, hueOf } from "./undertone";

/**
 * Shade rows for /makeup: a palette and a skin tone in, four rows of three
 * swatches out.
 *
 * docs/01-user-flow.md section H item 2: "Shade rows: 'Lip', 'Blush',
 * 'Foundation', 'Eye'. Each row shows three swatches inside the palette, the
 * middle one selected."
 *
 * The rule, in one line per row:
 *
 *   lip         the deepest red or pink in the palette, a step either side
 *   blush       the lightest red or pink in the palette, or the lip colour
 *               carried toward the skin tone when the palette has only one
 *   foundation  the detected skin tone, a step lighter and a step deeper
 *   eye         the deepest neutral colour in the palette, a step either side
 *
 * Why every row is [lighter, base, deeper] rather than three separate palette
 * colours: docs/01 says the middle swatch is the selected one, and a shade row
 * is a depth ladder in every shop in the world. The middle swatch is the palette
 * colour itself (or the person's own tone, for foundation), so the recommended
 * shade is always a real palette colour and the two neighbours are one step of
 * the same colour.
 *
 * This file is pure: no I/O, no clock, no randomness. The same palette always
 * produces the same swatches and therefore the same product queries, which is
 * what lets the product cache work (docs/03-architecture.md, "Caching").
 *
 * It lives in src/lib/server rather than src/lib/shared because it reads the
 * profile row's shape and calls the SerpApi query builder, both of which are
 * server side. It is a separate file from makeup.ts so the demo fixture can use
 * it without the fixture and the view builder importing each other.
 *
 * Shade names are a catalog, in the sense src/lib/shared/copy.ts uses the word
 * ("palette color names ... are not copy"). They are built from the palette's
 * own colour names plus the depth words below, and the unit test runs every one
 * of them, and every product query, through the banned lexicon.
 */

/* ------------------------------------------------------------------ */
/* Colour maths                                                        */
/* ------------------------------------------------------------------ */

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function rgbToHex(rgb: Rgb): string {
  const parts = [rgb.r, rgb.g, rgb.b].map((channel) =>
    clampChannel(channel).toString(16).padStart(2, "0"),
  );
  return `#${parts.join("")}`;
}

/** Blends two colours. amount 0 keeps `from`, amount 1 returns `to`. */
function blend(from: Rgb, to: Rgb, amount: number): Rgb {
  return {
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  };
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/** One step lighter. Null for anything that is not a six digit hex. */
export function lighten(hex: string, amount: number): string | null {
  const rgb = hexToRgb(hex);
  return rgb === null ? null : rgbToHex(blend(rgb, WHITE, amount));
}

/** One step deeper. Null for anything that is not a six digit hex. */
export function deepen(hex: string, amount: number): string | null {
  const rgb = hexToRgb(hex);
  return rgb === null ? null : rgbToHex(blend(rgb, BLACK, amount));
}

/** Carries one colour toward another, for a blush that sits over skin. */
export function carryToward(
  hex: string,
  towardHex: string,
  amount: number,
): string | null {
  const from = hexToRgb(hex);
  const to = hexToRgb(towardHex);
  if (from === null || to === null) {
    return null;
  }
  return rgbToHex(blend(from, to, amount));
}

/** 0 for black, 1 for white. The midpoint of the lightest and darkest channel. */
export function lightnessOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return null;
  }
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return (max + min) / 2 / 255;
}

/** How far the colour is from grey, 0 to 255. */
export function chromaOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return null;
  }
  return Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
}

/* ------------------------------------------------------------------ */
/* Families inside a palette                                           */
/* ------------------------------------------------------------------ */

/** Below this a colour reads as a grey or a taupe rather than as a hue. */
const MIN_FAMILY_CHROMA = 18;

/**
 * Reds, pinks, roses, and rusts: the family lips and cheeks come from. The
 * window is the red end of the hue circle, which holds berry and rose on one
 * side of 360 and coral, brick, and rust on the other, and excludes cream, gold,
 * and olive.
 */
export function isRedOrPink(hex: string): boolean {
  const hue = hueOf(hex);
  const chroma = chromaOf(hex);
  if (hue === null || chroma === null || chroma < MIN_FAMILY_CHROMA) {
    return false;
  }
  return hue >= 330 || hue < 30;
}

/**
 * The colours an eye shade comes from: earth tones (brown, bronze, olive) and
 * anything close to grey (taupe, charcoal), and never a red or a pink, which
 * belongs to the lip row.
 */
export function isNeutralDepth(hex: string): boolean {
  const hue = hueOf(hex);
  const chroma = chromaOf(hex);
  const lightness = lightnessOf(hex);
  if (chroma === null || lightness === null || isRedOrPink(hex)) {
    return false;
  }
  if (lightness > 0.66) {
    return false;
  }
  if (chroma < MIN_FAMILY_CHROMA) {
    return true;
  }
  return hue !== null && hue >= 20 && hue <= 120;
}

/**
 * The matching wear colours, deepest first. Ties break on the name so the order
 * never depends on how the palette happened to be written.
 */
export function familyOf(
  palette: Palette,
  matches: (hex: string) => boolean,
): PaletteColor[] {
  return palette.wear
    .filter((color) => matches(color.hex))
    .sort((a, b) => {
      const left = lightnessOf(a.hex) ?? 1;
      const right = lightnessOf(b.hex) ?? 1;
      if (left === right) {
        return a.name < b.name ? -1 : 1;
      }
      return left - right;
    });
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/**
 * Depth words a palette colour name may already carry. They are stripped before
 * the row's own depth words are added, so "Deep teal" gives a row of
 * "Light teal", "Teal", "Deep teal" rather than "Light deep teal".
 */
const DEPTH_WORDS: readonly string[] = [
  "light",
  "deep",
  "dark",
  "soft",
  "pale",
  "rich",
  "bright",
  "muted",
  "dusty",
  "warm",
  "cool",
];

/** The colour name with any leading depth word removed, in lower case. */
export function shadeRoot(name: string): string {
  const words = name.trim().split(/\s+/u);
  if (words.length > 1) {
    const first = (words[0] ?? "").toLowerCase();
    if (DEPTH_WORDS.includes(first)) {
      return words.slice(1).join(" ").toLowerCase();
    }
  }
  return name.trim().toLowerCase();
}

function sentenceCase(value: string): string {
  return value.length === 0
    ? value
    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/** How far a lip, blush, or eye neighbour sits from the middle swatch. */
export const SHADE_STEP = 0.2;

/** Foundation neighbours are one shade up and down, so the step is smaller. */
export const FOUNDATION_STEP = 0.14;

/** How far a blush is carried toward the skin when the palette has one red. */
export const BLUSH_CARRY = 0.45;

/**
 * The foundation depth ladder, lightest first. These are the words a foundation
 * shade family is actually sold under, which is what makes them useful in the
 * "<shade family> <category>" query grammar (docs/04-integrations.md).
 */
export const FOUNDATION_DEPTHS: readonly string[] = [
  "Porcelain",
  "Fair",
  "Light",
  "Medium",
  "Tan",
  "Deep",
  "Rich",
  "Espresso",
];

/** Lightness at or above which each rung starts, in the same order. */
const FOUNDATION_THRESHOLDS: readonly number[] = [
  0.82, 0.7, 0.58, 0.46, 0.34, 0.26, 0.18,
];

/**
 * The rung a tone sits on, clamped so a lighter and a deeper rung always exist.
 * Without the clamp the lightest and deepest tones would produce a row with two
 * swatches carrying the same name.
 */
export function foundationDepthIndex(hex: string): number | null {
  const lightness = lightnessOf(hex);
  if (lightness === null) {
    return null;
  }
  let index = FOUNDATION_THRESHOLDS.length;
  for (let rung = 0; rung < FOUNDATION_THRESHOLDS.length; rung += 1) {
    if (lightness >= (FOUNDATION_THRESHOLDS[rung] ?? 0)) {
      index = rung;
      break;
    }
  }
  return Math.max(1, Math.min(FOUNDATION_DEPTHS.length - 2, index));
}

/** The word a query uses for each row, per the makeup grammar in docs/04. */
const QUERY_CATEGORY: Readonly<Record<MakeupCategory, string>> = {
  lip: "lipstick",
  blush: "blush",
  foundation: "foundation",
  eye: "eyeshadow",
};

/** The row label, quoted from docs/01-user-flow.md section H item 2. */
const ROW_LABEL: Readonly<Record<MakeupCategory, string>> = {
  lip: copy.makeup.rowLip,
  blush: copy.makeup.rowBlush,
  foundation: copy.makeup.rowFoundation,
  eye: copy.makeup.rowEye,
};

/**
 * A shade with its query, or null when the name cannot produce one. The query
 * builder refuses a part that cleans to nothing, and a swatch we cannot shop for
 * is dropped rather than shown with an empty query.
 */
function toShade(
  name: string,
  hex: string | null,
  category: MakeupCategory,
): ShadeOption | null {
  if (hex === null) {
    return null;
  }
  try {
    return {
      name,
      hex,
      productQuery: buildProductQuery({
        kind: "makeup",
        shadeFamily: name.toLowerCase(),
        category: QUERY_CATEGORY[category],
      }),
    };
  } catch {
    return null;
  }
}

/** The middle swatch, which is the one the row opens on. */
export const RECOMMENDED_INDEX = 1;

/**
 * A row of three around one base colour. Returns null when any of the three
 * could not be built, because a row of two is not the row docs/01 describes.
 */
function rowAround(args: {
  readonly category: MakeupCategory;
  readonly baseName: string;
  readonly baseHex: string;
  readonly step: number;
}): MakeupCategoryView | null {
  const root = shadeRoot(args.baseName);
  const shades = [
    toShade(`Light ${root}`, lighten(args.baseHex, args.step), args.category),
    toShade(sentenceCase(root), args.baseHex, args.category),
    toShade(`Deep ${root}`, deepen(args.baseHex, args.step), args.category),
  ];
  if (shades.some((shade) => shade === null)) {
    return null;
  }
  return {
    category: args.category,
    label: ROW_LABEL[args.category],
    shades: shades as ShadeOption[],
    recommendedIndex: RECOMMENDED_INDEX,
  };
}

/** The foundation row, named by depth rather than by a palette colour. */
function foundationRow(skinToneHex: string): MakeupCategoryView | null {
  const index = foundationDepthIndex(skinToneHex);
  if (index === null) {
    return null;
  }
  const shades = [
    toShade(
      FOUNDATION_DEPTHS[index - 1] ?? "",
      lighten(skinToneHex, FOUNDATION_STEP),
      "foundation",
    ),
    toShade(FOUNDATION_DEPTHS[index] ?? "", skinToneHex, "foundation"),
    toShade(
      FOUNDATION_DEPTHS[index + 1] ?? "",
      deepen(skinToneHex, FOUNDATION_STEP),
      "foundation",
    ),
  ];
  if (shades.some((shade) => shade === null)) {
    return null;
  }
  return {
    category: "foundation",
    label: ROW_LABEL.foundation,
    shades: shades as ShadeOption[],
    recommendedIndex: RECOMMENDED_INDEX,
  };
}

export interface ShadeInput {
  /** Null when no tone was read, which is when lip, blush, and eye are absent. */
  readonly palette: Palette | null;
  /** Null when the attributes analysis gave no tone, which drops foundation. */
  readonly skinToneHex: string | null;
}

/**
 * The four rows, in the order docs/01 section H lists them. A row that cannot be
 * built honestly is left out rather than filled with a guess, so a profile with
 * no palette and no tone produces an empty list and the screen shows nothing
 * rather than something invented.
 */
export function buildMakeupCategoryViews(
  input: ShadeInput,
): MakeupCategoryView[] {
  const rows: MakeupCategoryView[] = [];
  const palette = input.palette;

  if (palette !== null) {
    const reds = familyOf(palette, isRedOrPink);
    const lipBase = reds[0] ?? null;

    if (lipBase !== null) {
      const lip = rowAround({
        category: "lip",
        baseName: lipBase.name,
        baseHex: lipBase.hex,
        step: SHADE_STEP,
      });
      if (lip !== null) {
        rows.push(lip);
      }

      // The lightest other red when the palette has one. Otherwise the lip
      // colour carried toward the skin, which is what a blush is: the same
      // family, sitting over skin rather than on the lips. The two rows then
      // share their names and differ in their swatches, which is how a rust lip
      // and a rust blush differ in a shop as well.
      const blushBase = reds.length > 1 ? reds[reds.length - 1] : null;
      const blushName = blushBase?.name ?? lipBase.name;
      const blushHex =
        blushBase?.hex ??
        (input.skinToneHex === null
          ? lighten(lipBase.hex, BLUSH_CARRY)
          : carryToward(lipBase.hex, input.skinToneHex, BLUSH_CARRY));
      if (blushHex !== null) {
        const blush = rowAround({
          category: "blush",
          baseName: blushName,
          baseHex: blushHex,
          step: SHADE_STEP,
        });
        if (blush !== null) {
          rows.push(blush);
        }
      }
    }
  }

  if (input.skinToneHex !== null) {
    const foundation = foundationRow(input.skinToneHex);
    if (foundation !== null) {
      rows.push(foundation);
    }
  }

  if (palette !== null) {
    const eyeBase = familyOf(palette, isNeutralDepth)[0] ?? null;
    if (eyeBase !== null) {
      const eye = rowAround({
        category: "eye",
        baseName: eyeBase.name,
        baseHex: eyeBase.hex,
        step: SHADE_STEP,
      });
      if (eye !== null) {
        rows.push(eye);
      }
    }
  }

  return rows;
}

/** The shade a row opens on: the saved one when there is one, else the middle. */
export function openingIndex(row: MakeupCategoryView): number {
  const saved = row.savedIndex;
  if (
    saved !== undefined &&
    Number.isInteger(saved) &&
    saved >= 0 &&
    saved < row.shades.length
  ) {
    return saved;
  }
  return row.recommendedIndex;
}

/** The shade a row opens on, or the selected one when the screen sent an index. */
export function selectedShade(
  row: MakeupCategoryView,
  selectedIndex: number | null,
): ShadeOption | null {
  const index =
    selectedIndex !== null &&
    Number.isInteger(selectedIndex) &&
    selectedIndex >= 0 &&
    selectedIndex < row.shades.length
      ? selectedIndex
      : openingIndex(row);
  return row.shades[index] ?? null;
}

/* ------------------------------------------------------------------ */
/* The saved look                                                      */
/* ------------------------------------------------------------------ */

/** Two hexes are the same shade whatever case they were written in. */
function sameHex(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Where a shade belongs in a row that runs lightest first, so an added swatch
 * does not break the depth ladder the row reads as.
 */
function ladderPosition(shades: readonly ShadeOption[], hex: string): number {
  const lightness = lightnessOf(hex);
  if (lightness === null) {
    return shades.length;
  }
  for (let index = 0; index < shades.length; index += 1) {
    const other = lightnessOf(shades[index]?.hex ?? "");
    if (other !== null && other < lightness) {
      return index;
    }
  }
  return shades.length;
}

/**
 * The rows a saved look opens on, docs/01-user-flow.md section H item 4.
 *
 * A saved shade that is one of the three the palette derives simply becomes the
 * row's opening swatch. A saved shade that is not (which is the ordinary case
 * once a palette has been re derived, or once the person has saved a shade from
 * a row that has since moved) is added to the row in its place on the depth
 * ladder and opens the row from there. It is never dropped: the person chose it,
 * a try on may already exist for it, and a row that quietly opened on something
 * else would send the screen asking for a render nobody asked for.
 *
 * The swatch keeps the name it was saved under, because that is the name the
 * person saw when they saved it and the name the stored render carries.
 *
 * A saved shade whose name cannot produce a product query is left out and the row
 * is untouched: every swatch on this screen carries a query, and a swatch with an
 * empty one would put a product card under a shade nobody can shop for.
 *
 * Pure, like the rest of this file.
 */
export function applySavedShades(
  rows: readonly MakeupCategoryView[],
  saved: readonly MakeupRenderCategoryInput[],
): MakeupCategoryView[] {
  if (saved.length === 0) {
    return [...rows];
  }
  const savedByCategory = new Map<MakeupCategory, MakeupRenderCategoryInput>(
    saved.map((entry) => [entry.category, entry] as const),
  );

  return rows.map((row) => {
    const choice = savedByCategory.get(row.category);
    if (choice === undefined) {
      return row;
    }

    const existing = row.shades.findIndex((shade) =>
      sameHex(shade.hex, choice.shadeHex),
    );
    if (existing !== -1) {
      return { ...row, savedIndex: existing };
    }

    const added = toShade(choice.shadeName, choice.shadeHex, row.category);
    if (added === null) {
      return row;
    }

    const position = ladderPosition(row.shades, choice.shadeHex);
    const shades = [
      ...row.shades.slice(0, position),
      added,
      ...row.shades.slice(position),
    ];
    return {
      ...row,
      shades,
      // The recommendation is still the same swatch, one place further along
      // when the saved shade was inserted before it.
      recommendedIndex:
        row.recommendedIndex >= position
          ? row.recommendedIndex + 1
          : row.recommendedIndex,
      savedIndex: position,
    };
  });
}
