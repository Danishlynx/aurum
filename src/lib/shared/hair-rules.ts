/**
 * The hair rules: a face shape and, when we have it, a hair type in, style
 * candidates out; a palette and a skin tone in, hair colors out.
 *
 * docs/01-user-flow.md section I is the screen this feeds:
 *   1. "Face shape line: 'Your face shape reads as oval. Most lengths and
 *      partings suit you; the styles below add structure at the jaw.' One
 *      sentence, specific."
 *   2. "Styles: a horizontal row of 3 to 4 rendered try ons ... Each has a plain
 *      name ('Textured crop', 'Soft layers past the collarbone') and one line of
 *      why it suits the face shape and hair type."
 *   3. "Colors: a row of 3 to 4 hair colors inside the palette ... One line each
 *      ('Warm chestnut brings out the warmth in your skin')."
 *
 * Everything here is pure and deterministic. No I/O, no provider types, no
 * React, no randomness, no clock. The same face shape always produces the same
 * four styles in the same order, which is what makes a style id a stable render
 * cache key (docs/03-architecture.md, "Caching").
 *
 * Where the strings live: src/lib/shared/copy.ts says catalog values ("palette
 * color names, garment type and pattern vocabularies, hairstyle names, season
 * names") are not copy and land beside their data. The style names, the why
 * lines, the hair color names, and the second half of the face shape line are
 * catalog values by that rule: there is one per shape and one per style,
 * docs/01 requires them but words only the oval example, which is quoted below
 * verbatim. They are held to the same standard as copy: the unit test runs every
 * one of them through checkLexicon and the punctuation checks, exactly as
 * evals/palette does for the palette lines.
 *
 * Degrading: hair type detection needs three photos of the same size (front,
 * right, left) and is skipped in the one selfie capture fan out
 * (docs/04-integrations.md), so the hair type is null on every profile this
 * build writes. Every rule here therefore reads face shape alone and treats the
 * hair type as an extra clause it adds when it exists. The face shape itself can
 * be null too, and the null column of the table is a real column with real
 * candidates, not an empty list.
 *
 * Budget: a hairstyle try on costs 2 units and a hair color try on costs 1
 * (docs/04-integrations.md), and a judge session is capped at 6 renders across
 * every kind (docs/07-payments-and-judge-mode.md). Four styles and two colors is
 * exactly those six renders and the ten units evals/budget prices as the
 * documented six, which is why the table holds four styles per shape and the
 * color rule returns three: a fourth color would be a fourth thing to tap that
 * the render cap can never reach once the four styles are rendered.
 */

import { copy, fill } from "./copy";
import { lightnessOf, SEASON_TEMPERATURE, type Palette } from "./palette";

/* ------------------------------------------------------------------ */
/* Face shape                                                          */
/* ------------------------------------------------------------------ */

/**
 * The shapes the rules table covers, in the words the face shape line uses.
 *
 * The six the flow doc implies (oval, round, square, heart, oblong, diamond)
 * plus triangle, which is one of the values the face analyzer returns
 * (FACE_SHAPE_VALUES in src/lib/server/providers/perfectcorp/schemas.ts). A
 * triangle face is wider at the jaw than at the forehead, which is the opposite
 * of every other row here, so folding it into one of the six would hand a person
 * advice written for a different face.
 */
export const HAIR_FACE_SHAPES = [
  "oval",
  "round",
  "square",
  "heart",
  "oblong",
  "diamond",
  "triangle",
] as const;

export type HairFaceShape = (typeof HAIR_FACE_SHAPES)[number];

/**
 * The provider's face shape values, mapped to our rows.
 *
 * "InvTriangle" is an inverted triangle: a wider forehead narrowing to a
 * pointed chin, which is the heart row without the widow's peak, so it reads the
 * heart rules. "Unknown", an absent value, and anything the provider adds later
 * map to null, which is the row written for a shape we do not have.
 */
const FACE_SHAPE_ALIASES: Readonly<Record<string, HairFaceShape>> = {
  oval: "oval",
  round: "round",
  square: "square",
  heart: "heart",
  oblong: "oblong",
  diamond: "diamond",
  triangle: "triangle",
  invtriangle: "heart",
};

/** The stored face_shape string as one of our rows, or null. */
export function normalizeFaceShape(value: string | null): HairFaceShape | null {
  if (value === null) {
    return null;
  }
  return FACE_SHAPE_ALIASES[value.trim().toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ */
/* Hair type                                                           */
/* ------------------------------------------------------------------ */

export const HAIR_TEXTURES = ["straight", "wavy", "curly", "coily"] as const;

export type HairTexture = (typeof HAIR_TEXTURES)[number];

/**
 * What we know about the hair itself.
 *
 * UNVERIFIED: hair type detection returns { mapping, term } and the vocabulary
 * of those two fields is not confirmed (endpoints.ts, hairType). readHairTexture
 * below reads the four words it can recognise out of either field and returns
 * null for everything else, which is why texture is nullable inside a reading
 * that exists.
 */
export type HairTypeReading = {
  readonly texture: HairTexture | null;
  /** The provider's own curl pattern label, for example "3b". Null when absent. */
  readonly curl: string | null;
};

/** Words that name each texture, longest first so "coily" beats "oily". */
const TEXTURE_WORDS: ReadonlyArray<readonly [HairTexture, readonly string[]]> = [
  ["coily", ["coily", "kinky", "afro", "4a", "4b", "4c"]],
  ["curly", ["curly", "curl", "3a", "3b", "3c"]],
  ["wavy", ["wavy", "wave", "2a", "2b", "2c"]],
  ["straight", ["straight", "1a", "1b", "1c"]],
];

/** The texture a provider term names, or null when it names none of them. */
export function readHairTexture(term: string | null): HairTexture | null {
  if (term === null) {
    return null;
  }
  const text = term.trim().toLowerCase();
  if (text.length === 0) {
    return null;
  }
  for (const [texture, words] of TEXTURE_WORDS) {
    if (words.some((word) => text.includes(word))) {
      return texture;
    }
  }
  return null;
}

/**
 * The clause added to a style's reason when the hair type is known.
 *
 * One per texture rather than one per texture and style: the hair type is null
 * on every profile this build writes, so four honest sentences that read well
 * after any style are worth more than a hundred that nobody has ever seen.
 */
const TEXTURE_NOTE: Readonly<Record<HairTexture, string>> = {
  straight: "Straight hair keeps the line of this cut, so the shape does the work.",
  wavy: "Your wave gives this cut its body without much styling.",
  curly: "Curl adds the volume this cut is built for.",
  coily: "Coily hair holds the shape of this cut on its own.",
};

/* ------------------------------------------------------------------ */
/* The face shape line                                                 */
/* ------------------------------------------------------------------ */

/**
 * The second sentence of the face shape line, one per shape.
 *
 * docs/01-user-flow.md section I item 1 writes the oval one word for word and
 * asks for "one sentence, specific" for the rest. Same arrangement as the season
 * lines in src/lib/shared/palette.ts: the doc gives one example, the catalog
 * holds all of them, and the eval runs the lexicon over every one.
 *
 * Each one names what the shape is, then what the styles below do about it.
 */
const FACE_SHAPE_CONSEQUENCE: Readonly<Record<HairFaceShape, string>> = {
  // Quoted verbatim from docs/01-user-flow.md section I item 1.
  oval: "Most lengths and partings suit you; the styles below add structure at the jaw.",
  round:
    "The face is about as wide as it is long; the styles below add length and keep width off the cheeks.",
  square:
    "The jaw is the strongest line you have; the styles below soften its corners and keep weight off it.",
  heart:
    "The forehead is wider than the chin; the styles below add width at the jaw and keep weight off the top.",
  oblong:
    "The face is longer than it is wide; the styles below add width at the cheeks and keep height off the crown.",
  diamond:
    "The cheekbones are the widest line; the styles below add width at the forehead and the chin.",
  triangle:
    "The jaw is wider than the forehead; the styles below add width at the top and keep weight off the jaw.",
};

/**
 * The line when the photo gave no shape we have rules for.
 *
 * It says what happened, which is the rule for every state in
 * docs/01-user-flow.md, and it does not name a shape nobody measured.
 */
export const FACE_SHAPE_UNKNOWN_LINE =
  "Your face shape was not read from this photo. The styles below suit most faces, and any of them can be tried on.";

/** The whole line, docs/01 section I item 1. */
export function faceShapeLine(shape: HairFaceShape | null): string {
  if (shape === null) {
    return FACE_SHAPE_UNKNOWN_LINE;
  }
  const first = fill(copy.hair.faceShapeLineTemplate, { shape });
  return `${first} ${FACE_SHAPE_CONSEQUENCE[shape]}`;
}

/* ------------------------------------------------------------------ */
/* The styles                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every style the table can offer. The id is the catalog key: it is what the
 * person saves, what the render is hashed under, and what
 * src/lib/server/renders/hair.ts maps to a provider template.
 */
export const HAIR_STYLE_IDS = [
  "textured-crop",
  "soft-layers-collarbone",
  "blunt-bob-jaw",
  "blunt-bob-below-jaw",
  "chin-length-bob",
  "angled-bob-below-chin",
  "curtain-fringe",
  "blunt-fringe",
  "long-layers-shoulders",
  "side-parted-lob",
  "side-swept-layers",
  "soft-waves-shoulder",
  "volume-through-top",
] as const;

export type HairStyleId = (typeof HAIR_STYLE_IDS)[number];

const STYLE_ID_SET: ReadonlySet<string> = new Set<string>(HAIR_STYLE_IDS);

export function isHairStyleId(value: string): value is HairStyleId {
  return STYLE_ID_SET.has(value);
}

/**
 * One name per id, so the same cut is called the same thing under every face
 * shape and a rename cannot fork into two names.
 */
export const HAIR_STYLE_NAME: Readonly<Record<HairStyleId, string>> = {
  // The two names docs/01-user-flow.md section I item 2 gives as examples.
  "textured-crop": "Textured crop",
  "soft-layers-collarbone": "Soft layers past the collarbone",
  "blunt-bob-jaw": "Blunt bob at the jaw",
  "blunt-bob-below-jaw": "Blunt bob below the jaw",
  "chin-length-bob": "Chin length bob",
  "angled-bob-below-chin": "Angled bob below the chin",
  "curtain-fringe": "Curtain fringe",
  "blunt-fringe": "Blunt fringe",
  "long-layers-shoulders": "Long layers past the shoulders",
  "side-parted-lob": "Side parted lob",
  "side-swept-layers": "Side swept layers",
  "soft-waves-shoulder": "Soft waves at the shoulder",
  "volume-through-top": "Volume through the top",
};

/**
 * Words that name a consequence of a face shape.
 *
 * Exported because the unit test asserts that every reason names the shape or
 * one of these, and a second copy of the list in the test would let the two
 * drift. A reason that mentions none of them is not a reason about a face.
 */
export const SHAPE_CONSEQUENCE_WORDS: readonly string[] = [
  "jaw",
  "chin",
  "cheek",
  "cheekbones",
  "forehead",
  "crown",
  "shape",
  "balance",
  "structure",
  "width",
  "wider",
  "widen",
  "widens",
  "widest",
  "narrow",
  "narrows",
  "narrower",
  "narrowest",
  "long",
  "longer",
  "length",
  "corner",
  "corners",
  "sides",
];

type ShapeRule = { readonly id: HairStyleId; readonly why: string };

/**
 * The table. Four candidates per shape, ordered as the row reads left to right,
 * each with one line tied to that shape.
 *
 * The same cut appears under more than one shape with a different reason, which
 * is the honest arrangement: a curtain fringe suits an oval and a square face
 * for different reasons, and pretending they are two different cuts would double
 * the render catalog for nothing.
 */
const STYLE_RULES: Readonly<Record<HairFaceShape, readonly ShapeRule[]>> = {
  oval: [
    {
      id: "textured-crop",
      why: "An oval carries a short shape without losing its balance, and the texture keeps the top from sitting flat.",
    },
    {
      id: "soft-layers-collarbone",
      why: "Layers that start below the jaw follow the balance an oval already has.",
    },
    {
      id: "blunt-bob-jaw",
      why: "A blunt line at the jaw is the one piece of structure an oval can take on.",
    },
    {
      id: "curtain-fringe",
      why: "A parted fringe frames an oval without shortening it.",
    },
  ],
  round: [
    {
      id: "long-layers-shoulders",
      why: "Length past the shoulders draws a round face longer rather than wider.",
    },
    {
      id: "side-parted-lob",
      why: "A side part breaks up the width across a round face.",
    },
    {
      id: "volume-through-top",
      why: "Height at the crown lengthens a round face.",
    },
    {
      id: "angled-bob-below-chin",
      why: "A bob that ends below the chin keeps weight off the widest part of a round face.",
    },
  ],
  square: [
    {
      id: "soft-waves-shoulder",
      why: "Waves round off the corners of a square jaw.",
    },
    {
      id: "side-swept-layers",
      why: "Layers falling across the face soften the straight sides of a square shape.",
    },
    {
      id: "curtain-fringe",
      why: "A parted fringe takes the hard edge off a square forehead.",
    },
    {
      id: "blunt-bob-below-jaw",
      why: "A bob that ends below the jaw keeps the cut off the corner of it.",
    },
  ],
  heart: [
    {
      id: "chin-length-bob",
      why: "A cut that ends at the chin adds width where a heart shape narrows.",
    },
    {
      id: "side-parted-lob",
      why: "A side part balances the wider forehead of a heart shape.",
    },
    {
      id: "soft-layers-collarbone",
      why: "Layers below the jaw put weight back where a heart shape is narrowest.",
    },
    {
      id: "curtain-fringe",
      why: "A parted fringe covers width at the forehead without flattening a heart shape.",
    },
  ],
  oblong: [
    {
      id: "blunt-bob-jaw",
      why: "A blunt line at the jaw adds width to a face that reads long.",
    },
    {
      id: "soft-waves-shoulder",
      why: "Waves at the cheeks widen a long face.",
    },
    {
      id: "blunt-fringe",
      why: "A fringe shortens the forehead, which is where an oblong face gains its length.",
    },
    {
      id: "side-swept-layers",
      why: "Layers swept across add width to the sides of a long face.",
    },
  ],
  diamond: [
    {
      id: "chin-length-bob",
      why: "Length ending at the chin adds width where a diamond shape narrows.",
    },
    {
      id: "curtain-fringe",
      why: "A parted fringe widens the narrow forehead of a diamond shape.",
    },
    {
      id: "soft-layers-collarbone",
      why: "Layers below the jaw put weight under the cheekbones of a diamond shape.",
    },
    {
      id: "side-parted-lob",
      why: "A side part softens the width across the cheekbones.",
    },
  ],
  triangle: [
    {
      id: "volume-through-top",
      why: "Height at the crown balances the wider jaw of a triangle shape.",
    },
    {
      id: "long-layers-shoulders",
      why: "Layers falling past the jaw keep weight off the widest part of a triangle shape.",
    },
    {
      id: "side-swept-layers",
      why: "Layers swept across the forehead widen the narrower top of a triangle shape.",
    },
    {
      id: "curtain-fringe",
      why: "A parted fringe adds width at the forehead of a triangle shape.",
    },
  ],
};

/**
 * The candidates when the face shape was not read. Four cuts whose reasons hold
 * without knowing the shape, so the screen is a real screen rather than an empty
 * one, and nothing claims to suit a face nobody measured.
 */
const STYLE_RULES_UNKNOWN_SHAPE: readonly ShapeRule[] = [
  {
    id: "soft-layers-collarbone",
    why: "Layers below the jaw add shape without depending on the face shape.",
  },
  {
    id: "blunt-bob-jaw",
    why: "A blunt line at the jaw adds structure to most face shapes.",
  },
  {
    id: "textured-crop",
    why: "A short shape with texture on top keeps its balance on most face shapes.",
  },
  {
    id: "curtain-fringe",
    why: "A parted fringe frames the face without committing to one face shape.",
  },
];

/** docs/01-user-flow.md section I item 2: "a horizontal row of 3 to 4". */
export const MIN_HAIR_STYLES = 3;
export const MAX_HAIR_STYLES = 4;

export type HairStyleCandidate = {
  readonly id: HairStyleId;
  readonly name: string;
  readonly why: string;
};

export interface HairStyleInput {
  readonly faceShape: HairFaceShape | null;
  /** Null on every profile this build writes. See the note at the top. */
  readonly hairType: HairTypeReading | null;
}

/**
 * The style candidates for a face shape, with the hair type clause added when
 * there is one. Always between MIN_HAIR_STYLES and MAX_HAIR_STYLES entries, for
 * every shape and for no shape at all.
 */
export function hairStylesFor(input: HairStyleInput): HairStyleCandidate[] {
  const rules =
    input.faceShape === null
      ? STYLE_RULES_UNKNOWN_SHAPE
      : STYLE_RULES[input.faceShape];
  const texture = input.hairType?.texture ?? null;
  const note = texture === null ? null : TEXTURE_NOTE[texture];

  return rules.slice(0, MAX_HAIR_STYLES).map((rule) => ({
    id: rule.id,
    name: HAIR_STYLE_NAME[rule.id],
    why: note === null ? rule.why : `${rule.why} ${note}`,
  }));
}

/* ------------------------------------------------------------------ */
/* The colors                                                          */
/* ------------------------------------------------------------------ */

/*
 * Hair colors are a catalog, not a slice of the palette's wear list.
 *
 * docs/01-user-flow.md section I item 3 asks for "3 to 4 hair colors inside the
 * palette". The wear list is a list of clothes colors: a Deep Autumn wears deep
 * teal and aubergine, and neither is a hair color anyone dyes. So "inside the
 * palette" is read the way the rest of the app reads it, as the palette's own
 * temperature: the warm seasons take the brown, chestnut, and auburn family, and
 * the cool seasons take the ash and cool browns. The season decides the family,
 * the person's own skin tone decides how light the family may go, and every hex
 * below is a hair color rather than a shirt.
 *
 * The skin tone rule, in one line: a hair color that is much lighter than the
 * skin it sits above takes the eye off the face. HAIR_COLOR_LIGHTER_THAN_SKIN_MARGIN
 * is how much lighter it may be, in L* points, and it is measured in CIELAB for
 * the same reason the palette measures depth there (src/lib/shared/palette.ts):
 * L* is perceptual, so one margin means the same thing on deep and on light skin
 * rather than being generous at one end and punishing at the other.
 */

export type HairColorCandidate = {
  readonly name: string;
  readonly hex: string;
  readonly why: string;
};

/**
 * How much lighter than the skin a hair color may be, in L* points.
 *
 * 22 is a little over one Fitzpatrick step of skin lightness. It keeps espresso
 * through copper available on the deep warm fixture (skin L* about 36, so the
 * cut sits at 58) and keeps honey and ash blonde off it, while a light skin tone
 * reaches the whole family. It is a boundary on a measured photograph, not a
 * statement about anyone, and it is the one number to move if the colors come
 * out too dark or too light on real faces.
 */
export const HAIR_COLOR_LIGHTER_THAN_SKIN_MARGIN = 22;

/** docs/01 allows 3 to 4. Three, for the render budget reason at the top. */
export const MIN_HAIR_COLORS = 3;
export const MAX_HAIR_COLORS = 3;

/**
 * The warm family. Brown, chestnut, auburn, and the two lighter shades a light
 * warm coloring can carry.
 */
const WARM_HAIR_COLORS: readonly HairColorCandidate[] = [
  {
    name: "Espresso",
    hex: "#2a1a12",
    why: "Espresso sits deeper than your skin, which keeps the warmth in your face.",
  },
  {
    name: "Warm chocolate",
    hex: "#402617",
    why: "Warm chocolate is a brown with red left in it, which is what warm skin takes.",
  },
  {
    // The line docs/01-user-flow.md section I item 3 gives as the register.
    name: "Warm chestnut",
    hex: "#6b3f24",
    why: "Warm chestnut brings out the warmth in your skin.",
  },
  {
    name: "Auburn",
    hex: "#8a3c1f",
    why: "Auburn adds red at the same warmth your skin already carries.",
  },
  {
    name: "Copper",
    hex: "#a85c28",
    why: "Copper picks up the gold that sits in your skin.",
  },
  {
    name: "Honey",
    hex: "#c1904f",
    why: "Honey is a light warm shade, close to the lift your skin can carry.",
  },
];

/** The cool family. Ash and cool browns, with a cool black at the deep end. */
const COOL_HAIR_COLORS: readonly HairColorCandidate[] = [
  {
    name: "Cool black",
    hex: "#191a1e",
    why: "Cool black holds depth without pulling warmth into your skin.",
  },
  {
    name: "Cool espresso",
    hex: "#2c2622",
    why: "Cool espresso is a deep brown with no red in it, which sits with cool skin.",
  },
  {
    name: "Plum brown",
    hex: "#4a2f38",
    why: "Plum brown adds color on the cool side, where your skin already sits.",
  },
  {
    name: "Ash brown",
    hex: "#574c44",
    why: "Ash brown is a brown with grey in it, so it stays as cool as your skin.",
  },
  {
    name: "Cool chestnut",
    hex: "#6b5548",
    why: "A chestnut kept cool sits beside your skin instead of warming it.",
  },
  {
    name: "Ash blonde",
    hex: "#a4907a",
    why: "Ash blonde stays grey rather than golden, which is what cool skin takes.",
  },
];

/**
 * Phrases a color reason has to contain, so it is about this person rather than
 * about the color. Exported for the unit test, same reason as the shape words.
 */
export const HAIR_COLOR_WHY_ANCHORS: readonly string[] = [
  "your skin",
  "your face",
  "warm skin",
  "cool skin",
];

const ALL_HAIR_COLORS: readonly HairColorCandidate[] = [
  ...WARM_HAIR_COLORS,
  ...COOL_HAIR_COLORS,
];

const HAIR_COLOR_NAME_SET: ReadonlySet<string> = new Set(
  ALL_HAIR_COLORS.map((color) => color.name),
);

/** Every catalog color name, for the save route's check. */
export const HAIR_COLOR_NAMES: readonly string[] = ALL_HAIR_COLORS.map(
  (color) => color.name,
);

export function isHairColorName(value: string): boolean {
  return HAIR_COLOR_NAME_SET.has(value);
}

/** Deepest first. Ties break on the name so the order never depends on writing order. */
function byDepth(a: HairColorCandidate, b: HairColorCandidate): number {
  const left = lightnessOf(a.hex) ?? 0;
  const right = lightnessOf(b.hex) ?? 0;
  if (left === right) {
    return a.name < b.name ? -1 : 1;
  }
  return left - right;
}

export interface HairColorInput {
  /**
   * Null when the photo gave no tone to derive one from, which is the same state
   * /color shows as "Confirm your undertone". With no palette there is no
   * temperature to choose a family by, so the row is empty and the screen shows
   * the styles alone.
   */
  readonly palette: Palette | null;
  readonly skinToneHex: string | null;
}

/**
 * The hair colors for a coloring: the family the season's temperature asks for,
 * cut off above the skin tone, deepest first.
 *
 * Returns an empty list when there is no palette. Otherwise it returns
 * MIN_HAIR_COLORS to MAX_HAIR_COLORS colors: the lightest ones the margin allows,
 * because those are the ones the cut actually decides between, ordered deepest
 * first for the row.
 */
export function hairColorsFor(input: HairColorInput): HairColorCandidate[] {
  if (input.palette === null) {
    return [];
  }

  const family =
    SEASON_TEMPERATURE[input.palette.season] === "warm"
      ? WARM_HAIR_COLORS
      : COOL_HAIR_COLORS;
  const ordered = [...family].sort(byDepth);

  const skinLightness =
    input.skinToneHex === null ? null : lightnessOf(input.skinToneHex);
  const allowed =
    skinLightness === null
      ? ordered
      : ordered.filter(
          (color) =>
            (lightnessOf(color.hex) ?? 0) <=
            skinLightness + HAIR_COLOR_LIGHTER_THAN_SKIN_MARGIN,
        );

  // The floor: on the deepest skin the cut can reach into the family, and a row
  // of one color is not the row docs/01 describes. The deepest colors are the
  // ones the cut can never be wrong about, so they are what it falls back to.
  const kept = allowed.length >= MIN_HAIR_COLORS
    ? allowed
    : ordered.slice(0, MIN_HAIR_COLORS);

  return kept.slice(-MAX_HAIR_COLORS).map((color) => ({ ...color }));
}
