/**
 * The palette. Season, colors to wear, colors to keep away from the face.
 *
 * docs/00-product.md: "Color identity: a seasonal palette derived from tone,
 * undertone, eye and hair color, with colors to wear and colors to avoid. This
 * single layer drives makeup shades and clothing colors, which is what makes the
 * app feel like one product."
 *
 * docs/01-user-flow.md section G is the screen this feeds: the season line with
 * a one sentence explanation in plain words, 8 to 12 named swatches to wear with
 * one line of why each, and 4 to 6 to keep away from the face with one line each.
 *
 * Everything here is pure and deterministic. No I/O, no provider types, no React,
 * no randomness. The same input returns the same palette, which is what lets
 * evals/palette hold golden files for it.
 *
 * Where the strings live: src/lib/shared/copy.ts says catalog values (palette
 * color names, season names) are not copy and land here. The why lines and the
 * season lines are catalog values by the same rule: there is one per color and
 * one per season, docs/01 requires them but does not word them. They are held to
 * the same standard as copy, and evals/palette runs checkLexicon and the
 * punctuation checks over every one of them.
 *
 * Tone first duty (docs/00-product.md, the wedge): the deep seasons carry the
 * same number of colors as the light ones, and deep skin can never land in a
 * light season. Both are asserted in evals/palette.
 */

export type Undertone = "warm" | "cool" | "neutral";

/**
 * The twelve seasons, in the four traditional families. Spring and autumn are
 * the warm families, summer and winter the cool ones. Deep, light, soft, and
 * clear name where a person sits on depth and clarity inside a family.
 */
export const SEASONS = [
  "deep_winter",
  "deep_autumn",
  "warm_autumn",
  "warm_spring",
  "light_spring",
  "light_summer",
  "cool_summer",
  "cool_winter",
  "soft_autumn",
  "soft_summer",
  "clear_spring",
  "clear_winter",
] as const;

export type Season = (typeof SEASONS)[number];

const SEASON_SET: ReadonlySet<string> = new Set<string>(SEASONS);

export function isSeason(value: string): value is Season {
  return SEASON_SET.has(value);
}

export type PaletteColor = {
  /** Plain name, sentence case: "Olive", "Rust", "Cream". Never poetic. */
  readonly name: string;
  /** The swatch color, lowercase six digit hex. Data, not a design token. */
  readonly hex: string;
  /** One sentence saying why this color works on this coloring. */
  readonly why: string;
};

export type Palette = {
  readonly season: Season;
  /** "Deep Autumn", for the line "Your palette is Deep Autumn". */
  readonly seasonDisplayName: string;
  /** The plain words sentence under it, docs/01 section G item 3. */
  readonly seasonLine: string;
  readonly wear: PaletteColor[];
  readonly avoid: PaletteColor[];
};

export type PaletteInput = {
  readonly skinToneHex: string;
  readonly undertone: Undertone;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
  readonly fitzpatrick: number | null;
};

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

/*
 * Depth and contrast are read in CIELAB, not in RGB. L* is perceptual: the
 * distance from L* 30 to L* 40 means about as much to the eye as the distance
 * from L* 70 to L* 80, which is exactly the property a rule about "how deep is
 * this person's coloring" needs. Reading depth off raw RGB would put most deep
 * skin into one narrow band and spread light skin over a wide one, which is how
 * a color tool ends up serving light skin better than deep skin.
 *
 * Standard sRGB to XYZ (D65) to Lab. No approximations beyond the standard ones.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Lab {
  /** Lightness, 0 (black) to 100 (white). */
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

/** Parses "#rrggbb" or "rrggbb", any case. Null when it is not a hex color. */
export function hexToRgb(hex: string): Rgb | null {
  const trimmed = hex.trim().replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(trimmed)) {
    return null;
  }
  return {
    r: Number.parseInt(trimmed.slice(0, 2), 16),
    g: Number.parseInt(trimmed.slice(2, 4), 16),
    b: Number.parseInt(trimmed.slice(4, 6), 16),
  };
}

/** sRGB channel, 0 to 255, to linear light, 0 to 1. */
function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** D65 reference white, the one sRGB is defined against. */
const WHITE_X = 95.047;
const WHITE_Y = 100.0;
const WHITE_Z = 108.883;

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labF(ratio: number): number {
  return ratio > LAB_EPSILON
    ? Math.cbrt(ratio)
    : (LAB_KAPPA * ratio + 16) / 116;
}

/** CIELAB under D65, or null when the hex does not parse. */
export function hexToLab(hex: string): Lab | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) {
    return null;
  }

  const r = linearize(rgb.r);
  const g = linearize(rgb.g);
  const b = linearize(rgb.b);

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) * 100;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) * 100;

  const fx = labF(x / WHITE_X);
  const fy = labF(y / WHITE_Y);
  const fz = labF(z / WHITE_Z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** Perceptual lightness, 0 to 100, or null when the hex does not parse. */
export function lightnessOf(hex: string): number | null {
  return hexToLab(hex)?.l ?? null;
}

/**
 * Chroma, how much color there is as opposed to grey. Around 0 for a grey, past
 * 40 for a saturated color. Null when the hex does not parse.
 */
export function chromaOf(hex: string): number | null {
  const lab = hexToLab(hex);
  if (lab === null) {
    return null;
  }
  return Math.sqrt(lab.a * lab.a + lab.b * lab.b);
}

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

export type Depth = "deep" | "medium" | "light";

/**
 * The two lightness boundaries, in L*.
 *
 * 45 is about where Fitzpatrick V and VI skin sits: a mid brown like #8d5524
 * reads L* 42 and a deeper brown reads lower. 62 is about where Fitzpatrick I
 * and II skin sits: a fair tone like #f0d5c0 reads L* 87 and a light olive reads
 * in the seventies. The band between them holds tan, olive, and light brown
 * skin, which is the range the medium seasons are written for.
 *
 * These are boundaries on a measured photograph, not a statement about anyone.
 * The person can always overrule the undertone half of this on /color, and
 * eval:consistency is what will move these numbers if two captures of the same
 * face keep landing in different bands.
 */
export const DEEP_BELOW_LIGHTNESS = 45;
export const LIGHT_AT_OR_ABOVE_LIGHTNESS = 62;

/**
 * Fitzpatrick is a second opinion on depth from a separate provider call, so it
 * nudges the measured lightness rather than replacing it. A warm indoor capture
 * lifts measured lightness on deeper skin, which is the failure this correction
 * exists for.
 *
 * The largest nudge is 8 L* points, smaller than the 17 point wide medium band,
 * so Fitzpatrick can pull a borderline reading across one boundary and can never
 * carry a reading across the whole band on its own.
 */
export const FITZPATRICK_LIGHTNESS_BIAS: Readonly<Record<number, number>> = {
  1: 5,
  2: 3,
  3: 0,
  4: -2,
  5: -5,
  6: -8,
};

/** Depth from Fitzpatrick alone, used only when there is no tone to read. */
function depthFromFitzpatrick(fitzpatrick: number): Depth {
  if (fitzpatrick >= 5) {
    return "deep";
  }
  if (fitzpatrick <= 2) {
    return "light";
  }
  return "medium";
}

/**
 * Deep, medium, or light, from the detected skin tone corrected by Fitzpatrick.
 *
 * Falls back to Fitzpatrick alone when the tone hex does not parse, and to
 * medium when neither is readable. Medium is the honest default: it is the band
 * that borrows least from either end.
 */
export function classifyDepth(
  skinToneHex: string,
  fitzpatrick: number | null,
): Depth {
  const lightness = lightnessOf(skinToneHex);
  // A Fitzpatrick outside I to VI is not a reading, so it is treated as no
  // reading rather than pinned to the nearest type. Clamping would turn a bad
  // provider value into a confident answer, which is the one thing this layer
  // must not do.
  const fitz =
    fitzpatrick !== null &&
    Number.isInteger(fitzpatrick) &&
    fitzpatrick >= 1 &&
    fitzpatrick <= 6
      ? fitzpatrick
      : null;

  if (lightness === null) {
    return fitz === null ? "medium" : depthFromFitzpatrick(fitz);
  }

  const bias = fitz === null ? 0 : (FITZPATRICK_LIGHTNESS_BIAS[fitz] ?? 0);
  const corrected = lightness + bias;

  if (corrected < DEEP_BELOW_LIGHTNESS) {
    return "deep";
  }
  if (corrected >= LIGHT_AT_OR_ABOVE_LIGHTNESS) {
    return "light";
  }
  return "medium";
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

export type Contrast = "low" | "medium" | "high";

/**
 * How far apart the person's own colors sit. Near black hair on fair skin is the
 * high end. Hair, eyes, and skin within a few steps of each other is the low end.
 *
 * The score is the widest lightness gap between skin, hair, and eyes, plus a
 * smaller term for how vivid the eye color is, because a clear blue or green eye
 * reads as contrast even when the lightness gap is modest.
 */
export const EYE_CHROMA_WEIGHT = 0.4;

/**
 * 58 is roughly near black hair (L* around 15) against fair skin (L* around 85)
 * once the gap is taken alone, which is the coloring the clear and winter
 * families are written for. 30 is roughly hair within two shades of the skin,
 * the low contrast coloring the soft seasons are written for.
 */
export const HIGH_CONTRAST_AT_OR_ABOVE = 58;
export const LOW_CONTRAST_BELOW = 30;

export type ContrastInput = {
  readonly skinToneHex: string;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
};

/**
 * The contrast score, or null when there is nothing to compare the skin against.
 * Null is not zero: an unread hair color is unknown contrast, not low contrast,
 * and classifyContrast turns it into medium rather than into a soft season.
 */
export function contrastScore(input: ContrastInput): number | null {
  const skin = lightnessOf(input.skinToneHex);
  if (skin === null) {
    return null;
  }

  const eye = input.eyeColorHex === null ? null : lightnessOf(input.eyeColorHex);
  const hair =
    input.hairColorHex === null ? null : lightnessOf(input.hairColorHex);
  if (eye === null && hair === null) {
    return null;
  }

  const gaps: number[] = [];
  if (eye !== null) {
    gaps.push(Math.abs(skin - eye));
  }
  if (hair !== null) {
    gaps.push(Math.abs(skin - hair));
  }
  if (eye !== null && hair !== null) {
    gaps.push(Math.abs(eye - hair));
  }

  const widestGap = Math.max(...gaps);
  const eyeChroma =
    input.eyeColorHex === null ? null : chromaOf(input.eyeColorHex);

  return widestGap + EYE_CHROMA_WEIGHT * (eyeChroma ?? 0);
}

/** Low, medium, or high. Medium when the contrast cannot be read. */
export function classifyContrast(input: ContrastInput): Contrast {
  const score = contrastScore(input);
  if (score === null) {
    return "medium";
  }
  if (score >= HIGH_CONTRAST_AT_OR_ABOVE) {
    return "high";
  }
  if (score < LOW_CONTRAST_BELOW) {
    return "low";
  }
  return "medium";
}

// ---------------------------------------------------------------------------
// The rule table
// ---------------------------------------------------------------------------

/**
 * Undertone decides the family, depth decides how much weight the colors carry,
 * contrast decides how clear or how dusty they are.
 *
 *                 low contrast     medium contrast   high contrast
 *   warm  deep    deep autumn      deep autumn       deep autumn
 *   warm  medium  soft autumn      warm autumn       warm spring
 *   warm  light   light spring     warm spring       clear spring
 *   cool  deep    deep winter      deep winter       deep winter
 *   cool  medium  soft summer      cool summer       cool winter
 *   cool  light   light summer     light summer      clear winter
 *   neut  deep    deep autumn      deep autumn       deep winter
 *   neut  medium  soft summer      soft autumn       clear winter
 *   neut  light   soft summer      light summer      clear spring
 *
 * Why it reads this way:
 *
 * - Warm plus deep is the archetype of deep autumn: rich, warm, grounded. No
 *   amount of contrast moves it, because contrast inside deep warm coloring
 *   shows up as depth, not as coldness.
 * - Cool plus deep is deep winter for the mirror reason.
 * - Deep coloring never leaves the deep row. A light season on deep skin would
 *   hand a person a thin, pale list, which is the failure this product exists to
 *   correct (docs/00-product.md, the tone first wedge).
 * - Inside the warm and cool medium rows, contrast is what separates the muted
 *   seasons from the clear ones: low contrast coloring is drowned by clear
 *   colors, high contrast coloring is flattened by dusty ones.
 * - Neutral is the row that borrows. With little contrast it takes the soft
 *   seasons, which are the two written for coloring that has no strong
 *   temperature. With high contrast it takes the clear and winter families,
 *   where the colors are defined by their clarity rather than by their warmth.
 *
 * All twelve seasons are reachable from this table, which evals/palette asserts,
 * so no season is decoration.
 */
export const SEASON_RULE_TABLE: Readonly<
  Record<Undertone, Readonly<Record<Depth, Readonly<Record<Contrast, Season>>>>>
> = {
  warm: {
    deep: { low: "deep_autumn", medium: "deep_autumn", high: "deep_autumn" },
    medium: { low: "soft_autumn", medium: "warm_autumn", high: "warm_spring" },
    light: { low: "light_spring", medium: "warm_spring", high: "clear_spring" },
  },
  cool: {
    deep: { low: "deep_winter", medium: "deep_winter", high: "deep_winter" },
    medium: { low: "soft_summer", medium: "cool_summer", high: "cool_winter" },
    light: {
      low: "light_summer",
      medium: "light_summer",
      high: "clear_winter",
    },
  },
  neutral: {
    deep: { low: "deep_autumn", medium: "deep_autumn", high: "deep_winter" },
    medium: { low: "soft_summer", medium: "soft_autumn", high: "clear_winter" },
    light: { low: "soft_summer", medium: "light_summer", high: "clear_spring" },
  },
};

/** The warm families are spring and autumn, the cool ones summer and winter. */
export const SEASON_TEMPERATURE: Readonly<Record<Season, "warm" | "cool">> = {
  deep_autumn: "warm",
  warm_autumn: "warm",
  soft_autumn: "warm",
  warm_spring: "warm",
  light_spring: "warm",
  clear_spring: "warm",
  deep_winter: "cool",
  cool_winter: "cool",
  clear_winter: "cool",
  cool_summer: "cool",
  light_summer: "cool",
  soft_summer: "cool",
};

/** The two seasons deep coloring lands in. Nothing else is allowed to. */
export const DEEP_SEASONS: readonly Season[] = ["deep_autumn", "deep_winter"];

export type SeasonDerivation = {
  readonly season: Season;
  readonly depth: Depth;
  readonly contrast: Contrast;
  /** The contrast score, or null when hair and eyes were both unreadable. */
  readonly contrastScore: number | null;
};

/** The season and the two readings that produced it. */
export function deriveSeasonDetail(input: PaletteInput): SeasonDerivation {
  const depth = classifyDepth(input.skinToneHex, input.fitzpatrick);
  const contrastInput: ContrastInput = {
    skinToneHex: input.skinToneHex,
    eyeColorHex: input.eyeColorHex,
    hairColorHex: input.hairColorHex,
  };
  const contrast = classifyContrast(contrastInput);
  return {
    season: SEASON_RULE_TABLE[input.undertone][depth][contrast],
    depth,
    contrast,
    contrastScore: contrastScore(contrastInput),
  };
}

/** The season alone. */
export function deriveSeason(input: PaletteInput): Season {
  return deriveSeasonDetail(input).season;
}

// ---------------------------------------------------------------------------
// The colors
// ---------------------------------------------------------------------------

/*
 * One entry per season. Ten colors to wear and five to keep away from the face,
 * the same count for every season, so the deep seasons are never the thin ones.
 *
 * Each list is built the same way, which is why no season is a list of ten
 * browns: two neutrals (one light, one dark), one red, one warm earth color, one
 * yellow or gold, two greens, two blues or teals, one pink or purple. The count
 * sits inside the 8 to 12 the flow doc allows, with room to add without
 * rewriting the screen.
 *
 * Hexes are data. They are rendered from this file through an inline style, not
 * added to the design tokens, because they are the person's palette rather than
 * part of the interface (docs/02-design-system.md, "Tokens").
 *
 * The why lines name the coloring the season is built for, in plain words. No
 * poetry, no superlatives, one sentence each.
 */

type SeasonPalette = {
  readonly displayName: string;
  readonly line: string;
  readonly wear: readonly PaletteColor[];
  readonly avoid: readonly PaletteColor[];
};

const DEEP_AUTUMN: SeasonPalette = {
  displayName: "Deep Autumn",
  // docs/01-user-flow.md section G item 3 words this one: "rich, warm, and
  // grounded colors sit closest to your skin". Written here as a sentence,
  // because that is how it renders under the season line.
  line: "Rich, warm, and grounded colors sit closest to your skin.",
  wear: [
    {
      name: "Cream",
      hex: "#efe3cb",
      why: "Cream sits easier against deep warm skin than pure white.",
    },
    {
      name: "Chocolate",
      hex: "#4a2c1d",
      why: "Chocolate holds the depth of your hair without going flat.",
    },
    {
      name: "Brick red",
      hex: "#8e3b2e",
      why: "A red with brown in it is the red your warm skin takes.",
    },
    {
      name: "Rust",
      hex: "#9c4a1e",
      why: "Rust carries the same warmth that already sits in your skin.",
    },
    {
      name: "Camel",
      hex: "#b08a56",
      why: "Camel is a warm neutral, which stays kinder on you than grey.",
    },
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard picks up the gold in your skin.",
    },
    {
      name: "Olive",
      hex: "#6b6b3a",
      why: "Olive is warm and muted, so it reads as part of your coloring.",
    },
    {
      name: "Forest green",
      hex: "#2f4f35",
      why: "Forest green is deep enough to hold its own next to your skin.",
    },
    {
      name: "Deep teal",
      hex: "#14555a",
      why: "Deep teal is a cool color with warmth left in it, so it works on you.",
    },
    {
      name: "Aubergine",
      hex: "#4b2340",
      why: "Aubergine gives you a very dark color that is not black.",
    },
  ],
  avoid: [
    // The why line is the doc's own example, docs/01-user-flow.md section G
    // item 5: "4 to 6 swatches with one line each (Icy pastels wash you out)".
    {
      name: "Icy pink",
      hex: "#f6dde8",
      why: "Icy pastels wash you out.",
    },
    {
      name: "Baby blue",
      hex: "#bbd8f0",
      why: "Baby blue is too cool and too pale to stand next to your depth.",
    },
    {
      name: "Cool grey",
      hex: "#b8bcc4",
      why: "Cool grey pulls the warmth out of your skin.",
    },
    {
      name: "Fuchsia",
      hex: "#e2418e",
      why: "Fuchsia is a cold pink, and it works against your warmth.",
    },
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white is a harder light on your skin than cream.",
    },
  ],
};

const DEEP_WINTER: SeasonPalette = {
  displayName: "Deep Winter",
  line: "Deep, cool, and clear colors sit closest to your skin.",
  wear: [
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white stays clean against cool, deep skin.",
    },
    {
      name: "Charcoal",
      hex: "#2b2b2e",
      why: "Charcoal is the grey that suits cool, deep coloring.",
    },
    {
      name: "True red",
      hex: "#c41f3e",
      why: "A red with blue in it stays sharp against your cool depth.",
    },
    {
      name: "Plum",
      hex: "#5a2350",
      why: "Plum is deep and cool, close to the depth of your hair.",
    },
    {
      name: "Ice blue",
      hex: "#cfe3f2",
      why: "Ice blue is the one pale color that stays crisp on you.",
    },
    {
      name: "Sapphire",
      hex: "#1b3a73",
      why: "Sapphire is dark and cool, so it sits quietly next to your skin.",
    },
    {
      name: "Cobalt",
      hex: "#2158a8",
      why: "Cobalt is a clear blue, and clear colors suit your contrast.",
    },
    {
      name: "Emerald",
      hex: "#126b52",
      why: "Emerald is deep and cool, which matches your own depth.",
    },
    {
      name: "Pine green",
      hex: "#14392c",
      why: "Pine green goes dark without turning warm, so it stays with your skin.",
    },
    {
      name: "Fuchsia",
      hex: "#b0347a",
      why: "Fuchsia is a cool pink, and your skin takes it easily.",
    },
  ],
  avoid: [
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard pulls yellow into cool skin.",
    },
    {
      name: "Beige",
      hex: "#d8c3a5",
      why: "Beige is warm and dusty, so it flattens your contrast.",
    },
    {
      name: "Rust",
      hex: "#9c4a1e",
      why: "Rust is a warm brown red, and it fights your cool tone.",
    },
    {
      name: "Olive",
      hex: "#6b6b3a",
      why: "Olive is warm and dusty next to your clarity.",
    },
    {
      name: "Peach",
      hex: "#ffcba4",
      why: "Peach is warm and pale, and your coloring asks for more depth.",
    },
  ],
};

const WARM_AUTUMN: SeasonPalette = {
  displayName: "Warm Autumn",
  line: "Warm, earthy colors with some weight sit closest to your skin.",
  wear: [
    {
      name: "Cream",
      hex: "#f0e6d2",
      why: "Cream is a softer light than pure white on warm skin.",
    },
    {
      name: "Chestnut",
      hex: "#6e3b23",
      why: "Chestnut sits close to the brown already in your hair.",
    },
    {
      name: "Tomato red",
      hex: "#b8442c",
      why: "A red with orange in it stays warm against your skin.",
    },
    {
      name: "Pumpkin",
      hex: "#c4622d",
      why: "Pumpkin is warm and earthy, like your own coloring.",
    },
    {
      name: "Caramel",
      hex: "#a9713b",
      why: "Caramel is the warm neutral your skin takes better than grey.",
    },
    {
      name: "Gold",
      hex: "#c79a3a",
      why: "Gold picks up the warmth sitting in your skin.",
    },
    {
      name: "Moss green",
      hex: "#6a7b3f",
      why: "A green with yellow in it is the green warm skin wears well.",
    },
    {
      name: "Teal",
      hex: "#1f6f6b",
      why: "Teal is cool but not cold, so it still works with warm skin.",
    },
    {
      name: "Aubergine",
      hex: "#5a2e45",
      why: "Aubergine gives you a dark color with warmth still in it.",
    },
    {
      name: "Salmon",
      hex: "#e08161",
      why: "Salmon is a pink with warmth in it, which suits your skin.",
    },
  ],
  avoid: [
    {
      name: "Icy blue",
      hex: "#cfe6f5",
      why: "Icy blue is too cold and too pale for warm coloring.",
    },
    {
      name: "Bubblegum pink",
      hex: "#f49ac2",
      why: "A cold pink works against the warmth in your skin.",
    },
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white is a harder light than cream on your skin.",
    },
    {
      name: "Cool grey",
      hex: "#b8bcc4",
      why: "Cool grey drains the warmth out of your skin.",
    },
    {
      name: "Magenta",
      hex: "#c2185b",
      why: "Magenta is a cold red, and it sits against your tone.",
    },
  ],
};

const WARM_SPRING: SeasonPalette = {
  displayName: "Warm Spring",
  line: "Warm, clear colors with light in them sit closest to your skin.",
  wear: [
    {
      name: "Warm ivory",
      hex: "#f6edd8",
      why: "Warm ivory is a light neutral that keeps the warmth in your skin.",
    },
    {
      name: "Bronze",
      hex: "#a26a2b",
      why: "Bronze gives you a dark color that stays warm.",
    },
    {
      name: "Tomato red",
      hex: "#e24c33",
      why: "A red with orange in it matches the warmth in your skin.",
    },
    {
      name: "Apricot",
      hex: "#f0a162",
      why: "Apricot sits in the same warm range as your skin.",
    },
    {
      name: "Golden yellow",
      hex: "#efc03b",
      why: "Golden yellow picks up the gold in your coloring.",
    },
    {
      name: "Grass green",
      hex: "#6faa45",
      why: "Grass green has yellow in it, which is the green your skin takes.",
    },
    {
      name: "Jade",
      hex: "#3fb08a",
      why: "Jade is a green blue that stays warm enough for you.",
    },
    {
      name: "Warm turquoise",
      hex: "#24b4a8",
      why: "Warm turquoise is the clear blue green your coloring can carry.",
    },
    {
      name: "Sky blue",
      hex: "#79c2e8",
      why: "Sky blue is light and clear, which suits your brightness.",
    },
    {
      name: "Coral pink",
      hex: "#f4867b",
      why: "Coral pink is a pink with warmth in it, so it sits with your skin.",
    },
  ],
  avoid: [
    {
      name: "Black",
      hex: "#121212",
      why: "Black is heavier than your coloring and it flattens your face.",
    },
    {
      name: "Burgundy",
      hex: "#6b1f2e",
      why: "Burgundy is dark and cool, and it weighs down warm, light coloring.",
    },
    {
      name: "Dusty mauve",
      hex: "#a08696",
      why: "Dusty colors blur the clarity in your coloring.",
    },
    {
      name: "Cool grey",
      hex: "#a9afb8",
      why: "Cool grey pulls the warmth out of your skin.",
    },
    {
      name: "Icy lilac",
      hex: "#dcd3ee",
      why: "Icy lilac is cold and pale next to your warmth.",
    },
  ],
};

const LIGHT_SPRING: SeasonPalette = {
  displayName: "Light Spring",
  line: "Warm, light colors sit closest to your skin.",
  wear: [
    {
      name: "Warm ivory",
      hex: "#f7efe0",
      why: "Warm ivory is light without being colder than your skin.",
    },
    {
      name: "Camel",
      hex: "#c9a177",
      why: "Camel is as dark as your coloring needs a neutral to go.",
    },
    {
      name: "Coral red",
      hex: "#f0655a",
      why: "A red with orange in it stays inside your warmth.",
    },
    {
      name: "Peach",
      hex: "#f9c6a3",
      why: "Peach is close to the warmth in your own skin.",
    },
    {
      name: "Butter yellow",
      hex: "#f4e3a1",
      why: "Butter yellow is warm and light, which is where your coloring sits.",
    },
    {
      name: "Spring green",
      hex: "#8fc96b",
      why: "A light green with yellow in it keeps your coloring warm.",
    },
    {
      name: "Light jade",
      hex: "#86cdb0",
      why: "Light jade is a soft green blue that does not outweigh you.",
    },
    {
      name: "Light aqua",
      hex: "#9fd8d2",
      why: "Light aqua is the blue green your light, warm coloring can carry.",
    },
    {
      name: "Powder blue",
      hex: "#a9cde8",
      why: "Powder blue is light enough to sit beside your skin, not over it.",
    },
    {
      name: "Warm pink",
      hex: "#f6a9b4",
      why: "A pink with warmth in it stays with your skin instead of cutting it.",
    },
  ],
  avoid: [
    {
      name: "Black",
      hex: "#121212",
      why: "Black is far heavier than your coloring and it takes over.",
    },
    {
      name: "Deep navy",
      hex: "#1b2a4a",
      why: "Deep navy is a weight your light coloring has to fight.",
    },
    {
      name: "Burgundy",
      hex: "#6b1f2e",
      why: "Burgundy is dark and cool, and it drags your warmth down.",
    },
    {
      name: "Olive",
      hex: "#6b6b3a",
      why: "Olive is warm but dusty, and it dulls light coloring.",
    },
    {
      name: "Dark plum",
      hex: "#3e2340",
      why: "Dark plum is cool and heavy next to your lightness.",
    },
  ],
};

const LIGHT_SUMMER: SeasonPalette = {
  displayName: "Light Summer",
  line: "Cool, soft, light colors sit closest to your skin.",
  wear: [
    {
      name: "Soft white",
      hex: "#f2f1ee",
      why: "A white with grey in it is gentler on cool skin than a bright white.",
    },
    {
      name: "Soft navy",
      hex: "#3f4e6b",
      why: "Soft navy is as dark as your coloring wants to go.",
    },
    {
      name: "Grey blue",
      hex: "#7c8ca3",
      why: "Grey blue is a cool neutral that stays quiet beside your skin.",
    },
    {
      name: "Rose",
      hex: "#d98ba0",
      why: "Rose is a cool pink at the softness your coloring holds.",
    },
    {
      name: "Dusty pink",
      hex: "#e0aeb6",
      why: "Dusty pink sits close to the coolness in your skin.",
    },
    {
      name: "Powder blue",
      hex: "#b6cfe3",
      why: "Powder blue is light and cool, the same as your coloring.",
    },
    {
      name: "Periwinkle",
      hex: "#8e9fd4",
      why: "Periwinkle is a blue with a little pink in it, which suits cool skin.",
    },
    {
      name: "Lavender",
      hex: "#c3b4da",
      why: "Lavender is soft and cool, so it does not outweigh your face.",
    },
    {
      name: "Sage",
      hex: "#a9bfa4",
      why: "A green with grey in it stays as soft as the rest of your coloring.",
    },
    {
      name: "Sea green",
      hex: "#6fa9a0",
      why: "Sea green is the cool green your light coloring can carry.",
    },
  ],
  avoid: [
    {
      name: "Orange",
      hex: "#e4641b",
      why: "Orange is warmer and louder than your coloring.",
    },
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard pulls yellow into cool skin.",
    },
    {
      name: "Black",
      hex: "#121212",
      why: "Black is heavier than your light coloring and it hardens your face.",
    },
    {
      name: "Tomato red",
      hex: "#e24c33",
      why: "A red with orange in it fights the coolness in your skin.",
    },
    {
      name: "Warm brown",
      hex: "#8b5e34",
      why: "Warm brown is a heavy warmth your skin does not share.",
    },
  ],
};

const COOL_SUMMER: SeasonPalette = {
  displayName: "Cool Summer",
  line: "Cool, muted colors sit closest to your skin.",
  wear: [
    {
      name: "Soft white",
      hex: "#f1f0ec",
      why: "A white with grey in it is easier on cool skin than a bright white.",
    },
    {
      name: "Soft navy",
      hex: "#37456b",
      why: "Soft navy gives you a dark neutral without the hardness of black.",
    },
    {
      name: "Grey blue",
      hex: "#6e829c",
      why: "Grey blue is a cool neutral that matches how muted your coloring is.",
    },
    {
      name: "Raspberry",
      hex: "#b03a63",
      why: "A red with blue in it stays with the coolness in your skin.",
    },
    {
      name: "Rose",
      hex: "#c4778c",
      why: "Rose is a cool pink at the depth your coloring carries.",
    },
    {
      name: "Soft plum",
      hex: "#7a5478",
      why: "Soft plum is cool and muted, which is where your coloring sits.",
    },
    {
      name: "Lavender",
      hex: "#b6a8d0",
      why: "Lavender is cool and quiet, so it sits beside your skin.",
    },
    {
      name: "Sage",
      hex: "#97ae94",
      why: "A green with grey in it stays as soft as your own coloring.",
    },
    {
      name: "Sea green",
      hex: "#3f7f72",
      why: "Sea green is the cool green with enough depth for your skin.",
    },
    {
      name: "Cool grey",
      hex: "#9aa0a8",
      why: "Cool grey is the neutral your skin reads as its own.",
    },
  ],
  avoid: [
    {
      name: "Orange",
      hex: "#e4641b",
      why: "Orange is warmer and brighter than your coloring.",
    },
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard pulls yellow into cool skin.",
    },
    {
      name: "Camel",
      hex: "#c09b6a",
      why: "Camel is a warm neutral, and it works against the coolness in your skin.",
    },
    {
      name: "Black",
      hex: "#121212",
      why: "Black is harder than your muted coloring and it takes over.",
    },
    {
      name: "Bright coral",
      hex: "#ff6f51",
      why: "Bright coral is warm and loud beside your softness.",
    },
  ],
};

const SOFT_SUMMER: SeasonPalette = {
  displayName: "Soft Summer",
  line: "Cool, dusty colors with little contrast sit closest to your skin.",
  wear: [
    {
      name: "Soft white",
      hex: "#f0eee8",
      why: "A white with warmth taken out of it stays gentle on your skin.",
    },
    {
      name: "Slate",
      hex: "#4c555f",
      why: "Slate is a dark neutral that keeps your low contrast intact.",
    },
    {
      name: "Mushroom",
      hex: "#c3b8ac",
      why: "Mushroom is a grey brown, which is the neutral your coloring likes.",
    },
    {
      name: "Cranberry",
      hex: "#9c3f55",
      why: "A red with blue and grey in it stays inside your softness.",
    },
    {
      name: "Dusty rose",
      hex: "#c68f94",
      why: "Dusty rose is a muted pink at the level your coloring sits.",
    },
    {
      name: "Soft plum",
      hex: "#6e5570",
      why: "Soft plum is cool and dusty, the same as your own coloring.",
    },
    {
      name: "Lavender grey",
      hex: "#ada6b9",
      why: "Lavender grey is quiet enough not to outrun your face.",
    },
    {
      name: "Sage",
      hex: "#9dad9b",
      why: "A green with grey in it matches how muted your coloring is.",
    },
    {
      name: "Soft teal",
      hex: "#4e7c7b",
      why: "Soft teal is a cool blue green that keeps your contrast gentle.",
    },
    {
      name: "Denim blue",
      hex: "#5c7292",
      why: "Denim blue is a dusty blue, which is the blue your skin takes.",
    },
  ],
  avoid: [
    {
      name: "Bright orange",
      hex: "#f26a1b",
      why: "Bright orange is warm and loud beside your soft coloring.",
    },
    {
      name: "Hot pink",
      hex: "#ff3d9e",
      why: "Hot pink is far brighter than anything in your own coloring.",
    },
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white is a harder edge than your low contrast face wants.",
    },
    {
      name: "Black",
      hex: "#121212",
      why: "Black makes a contrast your coloring does not have.",
    },
    {
      name: "Golden yellow",
      hex: "#efc03b",
      why: "Golden yellow is warm and bright, and it drains your softness.",
    },
  ],
};

const SOFT_AUTUMN: SeasonPalette = {
  displayName: "Soft Autumn",
  line: "Warm, dusty colors with little contrast sit closest to your skin.",
  wear: [
    {
      name: "Oat",
      hex: "#e3d8c3",
      why: "Oat is a warm light neutral, softer on you than a bright white.",
    },
    {
      name: "Mahogany",
      hex: "#6e3b33",
      why: "Mahogany is as dark as your coloring goes without breaking it.",
    },
    {
      name: "Taupe",
      hex: "#9c8b79",
      why: "A grey brown is the neutral that matches your muted warmth.",
    },
    {
      name: "Clay",
      hex: "#b4715a",
      why: "Clay is a warm red brown at the softness your skin carries.",
    },
    {
      name: "Soft gold",
      hex: "#c6a96b",
      why: "Soft gold picks up the warmth in your skin without shouting.",
    },
    {
      name: "Olive",
      hex: "#7a7a4e",
      why: "Olive is warm and muted, which is where your coloring sits.",
    },
    {
      name: "Sage",
      hex: "#9aa383",
      why: "A green with grey in it keeps your contrast low, the way it is.",
    },
    {
      name: "Teal",
      hex: "#40706e",
      why: "Teal is the cool color that still holds warmth, so it works on you.",
    },
    {
      name: "Denim blue",
      hex: "#61738c",
      why: "Denim blue is dusty rather than clear, which suits your coloring.",
    },
    {
      name: "Dusty rose",
      hex: "#c39089",
      why: "Dusty rose is a warm pink with grey in it, close to your skin.",
    },
  ],
  avoid: [
    {
      name: "Icy blue",
      hex: "#cfe6f5",
      why: "Icy blue is cold and clear next to your muted warmth.",
    },
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white is a harder edge than your soft coloring wants.",
    },
    {
      name: "Hot pink",
      hex: "#ff3d9e",
      why: "Hot pink is brighter and colder than anything in your coloring.",
    },
    {
      name: "Black",
      hex: "#121212",
      why: "Black makes a contrast your face does not have on its own.",
    },
    {
      name: "Bright turquoise",
      hex: "#17c3d6",
      why: "Bright turquoise is clear and cold beside your dusty warmth.",
    },
  ],
};

const CLEAR_SPRING: SeasonPalette = {
  displayName: "Clear Spring",
  line: "Warm, bright colors sit closest to your skin.",
  wear: [
    {
      name: "Warm ivory",
      hex: "#f8f1e2",
      why: "Warm ivory is a clean light that keeps the warmth in your skin.",
    },
    {
      name: "Navy",
      hex: "#23335e",
      why: "Navy is the dark neutral your contrast can carry.",
    },
    {
      name: "True red",
      hex: "#e22b26",
      why: "A clear red matches how sharply your coloring reads.",
    },
    {
      name: "Bright coral",
      hex: "#ff6f51",
      why: "Bright coral is warm and clear, the same as your coloring.",
    },
    {
      name: "Golden yellow",
      hex: "#f5c518",
      why: "Golden yellow picks up the warmth in your skin at full strength.",
    },
    {
      name: "Bright green",
      hex: "#35b14a",
      why: "A clear green with yellow in it stays inside your warmth.",
    },
    {
      name: "Bright turquoise",
      hex: "#16bfc4",
      why: "Bright turquoise is the cool color your clarity can hold.",
    },
    {
      name: "Cobalt blue",
      hex: "#2a62d4",
      why: "Cobalt is a clear blue, and clear colors suit your contrast.",
    },
    {
      name: "Bright pink",
      hex: "#f1367f",
      why: "Bright pink is strong enough to keep up with your coloring.",
    },
    {
      name: "Camel",
      hex: "#c08f55",
      why: "Camel is the warm neutral that sits between your brights.",
    },
  ],
  avoid: [
    {
      name: "Dusty mauve",
      hex: "#a08696",
      why: "Dusty colors blur the clarity your coloring has.",
    },
    {
      name: "Beige",
      hex: "#d8c3a5",
      why: "Beige is flat next to a face that reads this clearly.",
    },
    {
      name: "Muted olive",
      hex: "#7a7a4e",
      why: "Muted olive dulls the brightness in your coloring.",
    },
    {
      name: "Rust",
      hex: "#9c4a1e",
      why: "Rust is warm but heavy, and it dims your contrast.",
    },
    {
      name: "Pale grey",
      hex: "#d6d6d6",
      why: "Pale grey has neither the warmth nor the clarity your skin asks for.",
    },
  ],
};

const CLEAR_WINTER: SeasonPalette = {
  displayName: "Clear Winter",
  line: "Cool, bright colors with strong contrast sit closest to your skin.",
  wear: [
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white is as clean as the contrast your own coloring makes.",
    },
    {
      name: "Black",
      hex: "#121212",
      why: "Black matches the contrast between your hair and your skin.",
    },
    {
      name: "Charcoal",
      hex: "#2c2c31",
      why: "Charcoal is your softer dark neutral when black is too much.",
    },
    {
      name: "True red",
      hex: "#d50032",
      why: "A red with blue in it stays clean against cool skin.",
    },
    {
      name: "Bright pink",
      hex: "#e8207a",
      why: "A cool, bright pink keeps up with how strongly your face reads.",
    },
    {
      name: "Emerald",
      hex: "#0e9f6e",
      why: "Emerald is a clear cool green, which suits your clarity.",
    },
    {
      name: "Royal blue",
      hex: "#2a4fc7",
      why: "Royal blue is bright and cool, the same as your coloring.",
    },
    {
      name: "Violet",
      hex: "#7231c4",
      why: "Violet is cool and strong, so it holds its own next to your hair.",
    },
    {
      name: "Ice blue",
      hex: "#cfe3f2",
      why: "Ice blue is the pale color that stays crisp on cool skin.",
    },
    {
      name: "Bright turquoise",
      hex: "#12c0c9",
      why: "Bright turquoise is clear and cold, which is where you sit.",
    },
  ],
  avoid: [
    {
      name: "Beige",
      hex: "#d8c3a5",
      why: "Beige is warm and dusty, so it flattens your contrast.",
    },
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard pulls yellow into cool skin.",
    },
    {
      name: "Rust",
      hex: "#9c4a1e",
      why: "Rust is a warm brown red, and it works against your cool tone.",
    },
    {
      name: "Olive",
      hex: "#7a7a4e",
      why: "Olive is muted and warm next to a face that reads clearly.",
    },
    {
      name: "Dusty rose",
      hex: "#c39089",
      why: "Dusty rose is too soft to sit beside your contrast.",
    },
  ],
};

const COOL_WINTER: SeasonPalette = {
  displayName: "Cool Winter",
  line: "Cool, clear colors sit closest to your skin.",
  wear: [
    {
      name: "Pure white",
      hex: "#ffffff",
      why: "Pure white stays clean against cool skin.",
    },
    {
      name: "Charcoal",
      hex: "#2c2c31",
      why: "Charcoal is the cool dark neutral your skin reads as its own.",
    },
    {
      name: "Navy",
      hex: "#1b2a55",
      why: "Navy is dark and cool, so it sits quietly beside your face.",
    },
    {
      name: "True red",
      hex: "#c41f3e",
      why: "A red with blue in it holds the coolness in your skin.",
    },
    {
      name: "Fuchsia",
      hex: "#c42a8f",
      why: "Fuchsia is a cool pink, and your skin takes it easily.",
    },
    {
      name: "Plum",
      hex: "#57265a",
      why: "Plum is cool and deep, close to the darkness in your hair.",
    },
    {
      name: "Emerald",
      hex: "#0f7a5a",
      why: "Emerald is a cool green with enough depth for your coloring.",
    },
    {
      name: "Sapphire",
      hex: "#17418c",
      why: "Sapphire is a clear cool blue, which suits how your face reads.",
    },
    {
      name: "Ice pink",
      hex: "#f2d7e4",
      why: "A pale pink with blue in it stays cool the way your skin is.",
    },
    {
      name: "Cool grey",
      hex: "#9ea4ae",
      why: "Cool grey is the neutral that matches your own tone.",
    },
  ],
  avoid: [
    {
      name: "Orange",
      hex: "#e4641b",
      why: "Orange is warm and loud against cool skin.",
    },
    {
      name: "Mustard",
      hex: "#b8860b",
      why: "Mustard pulls yellow into cool skin.",
    },
    {
      name: "Camel",
      hex: "#c09b6a",
      why: "Camel is a warm neutral, and it works against the coolness in your skin.",
    },
    {
      name: "Warm beige",
      hex: "#dfc9a8",
      why: "Warm beige has no coolness in it, so your face loses its edge.",
    },
    {
      name: "Rust",
      hex: "#9c4a1e",
      why: "Rust is a warm brown red, and it fights your cool tone.",
    },
  ],
};

export const SEASON_PALETTES: Readonly<Record<Season, SeasonPalette>> = {
  deep_autumn: DEEP_AUTUMN,
  deep_winter: DEEP_WINTER,
  warm_autumn: WARM_AUTUMN,
  warm_spring: WARM_SPRING,
  light_spring: LIGHT_SPRING,
  light_summer: LIGHT_SUMMER,
  cool_summer: COOL_SUMMER,
  soft_summer: SOFT_SUMMER,
  soft_autumn: SOFT_AUTUMN,
  clear_spring: CLEAR_SPRING,
  clear_winter: CLEAR_WINTER,
  cool_winter: COOL_WINTER,
};

/** "Deep Autumn" for deep_autumn, for the season line and the profile row. */
export function seasonDisplayName(season: Season): string {
  return SEASON_PALETTES[season].displayName;
}

/** The plain words sentence under the season line. */
export function seasonLine(season: Season): string {
  return SEASON_PALETTES[season].line;
}

/** The palette for a season, without deriving one. */
export function paletteForSeason(season: Season): Palette {
  const entry = SEASON_PALETTES[season];
  return {
    season,
    seasonDisplayName: entry.displayName,
    seasonLine: entry.line,
    wear: [...entry.wear],
    avoid: [...entry.avoid],
  };
}

/**
 * The palette for a person's coloring.
 *
 * Total: every branch returns a palette. An unreadable skin tone hex falls back
 * to Fitzpatrick, then to the medium band; an unreadable eye or hair color falls
 * back to medium contrast. Nothing here throws and nothing here is invented: a
 * missing input widens the reading, it does not make one up.
 *
 * The arrays are fresh on every call, so a caller can hold onto a palette
 * without reaching the shared catalog.
 */
export function derivePalette(input: PaletteInput): Palette {
  return paletteForSeason(deriveSeason(input));
}
