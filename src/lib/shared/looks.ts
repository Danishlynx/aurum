/**
 * The looks rules engine: classified garments in, candidate combinations out.
 *
 * docs/04-integrations.md (Stylist) is the line this file exists for: "The rules
 * engine, not the model, generates candidates; the model ranks and explains."
 * So everything a look is allowed to be is decided here, deterministically, and
 * the model is only ever handed a shortlist it can rank. When the model is
 * unavailable (no key, an error, a failed parse) the same shortlist still stands
 * and src/lib/server builds the rationale from the ruleNotes below
 * (docs/03-architecture.md, "Claude API error").
 *
 * docs/09-build-order-and-demo.md Layer 4 names the three rules: "candidate
 * combinations by color harmony against the palette, formality against the
 * occasion, pattern clash rule". docs/05-evals.md, suite eval:stylist, is how
 * each one is proved:
 *
 *   1. "a garment in the avoid list is never the hero next to the face; an avoid
 *      color may appear below the waist with a rationale"
 *   2. "formality matches occasion"
 *   3. "pattern clash rule rejects two busy patterns adjacent"
 *
 * Everything here is pure and deterministic. No I/O, no provider types, no
 * React, no randomness, no clock. The same wardrobe, palette, and occasion
 * always produce the same candidates in the same order with the same ids, which
 * is what lets a look be cached, saved, and compared in an eval.
 *
 * Where the strings live: src/lib/shared/copy.ts says values that belong to a
 * catalog rather than to a screen are not copy and land beside their data. The
 * ruleNotes are that kind of value: one fragment per fact the rules established,
 * quoted by the stylist prompt and by the deterministic fallback rather than
 * rendered on their own. They are still held to the copy standard, and
 * src/lib/shared/looks.test.ts runs every one of them through checkLexicon, the
 * same arrangement evals/palette uses for the palette lines.
 *
 * The garment shape and the three vocabularies come from
 * src/lib/shared/wardrobe-view.ts, which owns them. The six occasions are
 * declared here because they are what the occasion table is keyed by; when
 * src/lib/shared/looks-view.ts lands it takes its Occasion from this file rather
 * than writing a second copy of the same six words.
 */

import { hexToLab, type Palette } from "./palette";
import {
  GARMENT_TYPES,
  type GarmentColor,
  type GarmentFormality,
  type GarmentPattern,
  type GarmentType,
  type GarmentView,
} from "./wardrobe-view";

/* ------------------------------------------------------------------ */
/* The vocabularies                                                     */
/* ------------------------------------------------------------------ */

/**
 * The six occasions, in the order the chips read on /looks
 * (docs/01-user-flow.md section K item 1).
 */
export const OCCASIONS = [
  "interview",
  "wedding_guest",
  "date",
  "festival",
  "everyday",
  "formal_evening",
] as const;

export type Occasion = (typeof OCCASIONS)[number];

/**
 * The garment fields the rules read.
 *
 * A GarmentView carries imageUrl, userEdited, and classificationStatus as well;
 * none of them changes what may be worn with what, so none of them is read here.
 * A garment whose classification never arrived has a null type and a null
 * formality, which is what keeps it out of every look (see usableGarments
 * below), so the status flag is never the thing being trusted.
 */
export type LooksGarment = Pick<
  GarmentView,
  "id" | "type" | "colors" | "pattern" | "formality"
>;

/* ------------------------------------------------------------------ */
/* Slots                                                                */
/* ------------------------------------------------------------------ */

/**
 * Where a garment sits on a person. The rules care about position, not about
 * the noun: a shirt and a sweater are both "the thing next to your face", and
 * that is the only thing the avoid color rule needs to know.
 */
export type GarmentSlot =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "accessory";

/**
 * Every garment type, and where it sits. Keyed by GarmentType, so a type added
 * to the wardrobe vocabulary without a slot here is a compile error rather than
 * a garment no look can ever use.
 *
 * A sweater is a top rather than outerwear: it is worn against the skin and
 * next to the face, so it takes the near face color rule. A blazer, a jacket,
 * and a coat go over everything, which is why they are the layer an interview
 * or a wedding asks for.
 */
export const GARMENT_SLOT_OF_TYPE: Readonly<Record<GarmentType, GarmentSlot>> = {
  shirt: "top",
  t_shirt: "top",
  blouse: "top",
  top: "top",
  sweater: "top",
  jacket: "outerwear",
  blazer: "outerwear",
  coat: "outerwear",
  dress: "dress",
  skirt: "bottom",
  trousers: "bottom",
  jeans: "bottom",
  shorts: "bottom",
  shoes: "shoes",
  accessory: "accessory",
};

const SLOT_BY_TYPE_WORD: ReadonlyMap<string, GarmentSlot> = new Map(
  GARMENT_TYPES.map((type) => [type, GARMENT_SLOT_OF_TYPE[type]] as const),
);

/** The slot a garment type sits in, or null for a type we have no rules for. */
export function slotOfType(type: string | null): GarmentSlot | null {
  if (type === null) {
    return null;
  }
  return SLOT_BY_TYPE_WORD.get(type.trim().toLowerCase()) ?? null;
}

/**
 * The slots that sit next to the face. The avoid list is a list of colors to
 * keep away from the face (docs/01-user-flow.md section G item 5), so it is
 * exactly these three slots the rule bites on.
 */
export const NEAR_FACE_SLOTS: readonly GarmentSlot[] = [
  "top",
  "dress",
  "outerwear",
];

/** The slots below the waist, where an avoid color is allowed to sit. */
export const BELOW_WAIST_SLOTS: readonly GarmentSlot[] = ["bottom", "shoes"];

export function isNearFaceSlot(slot: GarmentSlot): boolean {
  return NEAR_FACE_SLOTS.includes(slot);
}

export function isBelowWaistSlot(slot: GarmentSlot): boolean {
  return BELOW_WAIST_SLOTS.includes(slot);
}

/**
 * Which slots touch each other on a body. The pattern clash rule reads this
 * table and nothing else.
 *
 * A top meets a bottom at the waist and a bottom meets shoes at the ankle, so
 * those two pairs are the obvious ones. Outerwear is adjacent to both the top it
 * sits over and the bottom its hem lands on, which is why an open checked jacket
 * over a striped shirt is a clash. A top and shoes are not adjacent: a stripe at
 * the collar and a print on a shoe are a metre apart and never read as one
 * surface. Accessories are not composed into looks at all (see composeCandidates),
 * so they appear in no pair here.
 */
export const ADJACENT_SLOT_PAIRS: readonly (readonly [
  GarmentSlot,
  GarmentSlot,
])[] = [
  ["top", "bottom"],
  ["top", "outerwear"],
  ["outerwear", "bottom"],
  ["bottom", "shoes"],
  ["dress", "outerwear"],
  ["dress", "shoes"],
];

/* ------------------------------------------------------------------ */
/* Patterns                                                             */
/* ------------------------------------------------------------------ */

/**
 * The busy half of the pattern vocabulary.
 *
 * docs/05-evals.md, suite eval:stylist: "pattern clash rule rejects two busy
 * patterns adjacent". Of the six patterns in the wardrobe vocabulary, solid has
 * nothing to clash with and texture is a surface rather than a figure (a cable
 * knit, a twill, a ribbed cotton), so it sits quietly next to anything. The
 * other four carry a repeating figure the eye reads at a distance, and two of
 * those next to each other is the clash.
 */
export const BUSY_PATTERNS: readonly GarmentPattern[] = [
  "stripe",
  "check",
  "floral",
  "print",
];

const BUSY_PATTERN_WORDS: ReadonlySet<string> = new Set<string>(BUSY_PATTERNS);

export function isBusyPattern(pattern: string | null): boolean {
  if (pattern === null) {
    return false;
  }
  return BUSY_PATTERN_WORDS.has(pattern.trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Color harmony                                                        */
/* ------------------------------------------------------------------ */

/*
 * A garment color is matched to the nearest color in the person's palette, and
 * the family of that nearest color (wear or avoid) is what the rules act on.
 *
 * The distance is measured in CIELAB for the reason src/lib/shared/palette.ts
 * gives: L* is perceptual, so one threshold means the same thing on a deep color
 * and on a pale one. Two departures from a plain CIE76 distance, both
 * deliberate:
 *
 * 1. Lightness is weighted at LIGHTNESS_WEIGHT. A garment is very often a
 *    lighter or deeper version of a palette color (a pale olive shirt, a deep
 *    rust knit) and it is still that color on that person. A shift in a* or b*
 *    is a change of hue or of temperature, which is precisely what a seasonal
 *    palette is about, so those two axes keep their full weight.
 *
 * 2. A match farther away than PALETTE_MATCH_MAX_DISTANCE is not a match at all.
 *    The family is then "neither", which means our catalog holds nothing close
 *    to this color. That is a statement about the catalog, not about the color:
 *    a "neither" garment is used freely, it is simply never described as
 *    flattering and never banned from the face. Claiming a color is in a
 *    person's palette because it was the least distant of fifteen entries would
 *    be inventing a reading, which is the one thing this layer must not do.
 */

export type ColorFamily = "wear" | "avoid" | "neither";

/** How much of the lightness difference counts. See the note above. */
export const LIGHTNESS_WEIGHT = 0.5;

/**
 * The farthest a garment color may sit from a palette color and still be called
 * that color, in weighted CIELAB units.
 *
 * Calibration: inside one season's own list, neighbouring colors sit roughly 12
 * to 25 units apart under this metric (deep autumn rust to brick red is 16,
 * olive to camel is 19, cream to pure white across the wear and avoid boundary
 * is 14). Twenty is inside that spacing, so a garment is only claimed by a
 * palette color when it is nearer to it than that color's own neighbours
 * typically are. It is a boundary on measured hexes, not a statement about
 * anyone, and it is the number to move if real wardrobes come back with too many
 * "neither" garments.
 */
export const PALETTE_MATCH_MAX_DISTANCE = 20;

/**
 * The weighted CIELAB distance between two hexes, or null when either hex does
 * not parse. Null is not zero: an unreadable color is an unknown color.
 */
export function paletteDistance(a: string, b: string): number | null {
  const left = hexToLab(a);
  const right = hexToLab(b);
  if (left === null || right === null) {
    return null;
  }
  const deltaL = (left.l - right.l) * LIGHTNESS_WEIGHT;
  const deltaA = left.a - right.a;
  const deltaB = left.b - right.b;
  return Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);
}

export type PaletteMatch = {
  readonly family: ColorFamily;
  /** The palette color it matched, or null when nothing was close enough. */
  readonly paletteColorName: string | null;
  /** The distance to that color, or null when there was no readable match. */
  readonly distance: number | null;
};

const NO_MATCH: PaletteMatch = {
  family: "neither",
  paletteColorName: null,
  distance: null,
};

/**
 * The family a single color falls in for this palette.
 *
 * Returns "neither" for an unreadable hex, for a color past the distance
 * ceiling, and for every color when there is no palette at all. A person whose
 * undertone was never read has no wear list and no avoid list, so no garment is
 * flattered and no garment is banned; the rules still compose looks by
 * formality and pattern, which is the honest amount to say.
 */
export function matchToPalette(
  hex: string,
  palette: Palette | null,
): PaletteMatch {
  if (palette === null) {
    return NO_MATCH;
  }

  let best: PaletteMatch = NO_MATCH;
  let bestDistance = Number.POSITIVE_INFINITY;

  const families: readonly (readonly [ColorFamily, readonly { name: string; hex: string }[]])[] =
    [
      ["wear", palette.wear],
      ["avoid", palette.avoid],
    ];

  for (const [family, colors] of families) {
    for (const color of colors) {
      const distance = paletteDistance(hex, color.hex);
      if (distance === null || distance >= bestDistance) {
        continue;
      }
      bestDistance = distance;
      best = { family, paletteColorName: color.name, distance };
    }
  }

  if (bestDistance > PALETTE_MATCH_MAX_DISTANCE) {
    return NO_MATCH;
  }
  return best;
}

/**
 * The garment's dominant color: the first one, because the classifier is told to
 * list colors "most of the garment first" (src/lib/prompts/classifier.ts). Null
 * when the garment has no color recorded.
 */
export function dominantColorOf(
  garment: LooksGarment,
): GarmentColor | null {
  return garment.colors[0] ?? null;
}

/** The family of the garment's dominant color. */
export function garmentColorMatch(
  garment: LooksGarment,
  palette: Palette | null,
): PaletteMatch {
  const dominant = dominantColorOf(garment);
  if (dominant === null) {
    return NO_MATCH;
  }
  return matchToPalette(dominant.hex, palette);
}

/* ------------------------------------------------------------------ */
/* The occasion table                                                   */
/* ------------------------------------------------------------------ */

export type OccasionRule = {
  /** The formality bands a garment may carry for this occasion. */
  readonly formality: readonly GarmentFormality[];
  /**
   * Whether a layer is put on top when the wardrobe has one. docs/09 Layer 4:
   * "outerwear optional and added for interview, wedding_guest, formal_evening
   * when available".
   */
  readonly addsOuterwear: boolean;
};

/**
 * What each occasion will accept, and why.
 *
 *   interview       smart, formal    A jacket is the safe read for an interview
 *                                    in almost every field, and nothing casual
 *                                    belongs in a first meeting. Both bands are
 *                                    allowed because a smart shirt with a formal
 *                                    trouser is a normal interview outfit.
 *   wedding_guest   smart, formal    A guest dresses up but never outdresses the
 *                                    couple, so the band runs from smart to
 *                                    formal and stops short of nothing.
 *   date            casual, smart    A date is the widest band we have: dinner
 *                                    is smart, a walk is casual, and neither is
 *                                    wrong. Formal is left out because turning
 *                                    up in eveningwear is a different evening.
 *   festival        casual           A field, standing, weather. Smart clothes
 *                                    are the wrong tool, so the band is one word
 *                                    wide and no layer is forced on top.
 *   everyday        casual, smart    What the person actually leaves the house
 *                                    in. Smart is included because plenty of
 *                                    people work in it.
 *   formal_evening  formal           The one occasion with a single band. A
 *                                    smart blazer at a black tie evening is
 *                                    underdressed, and the rules should say so
 *                                    by leaving it out rather than by ranking it
 *                                    last.
 *
 * Layer 5 tunes this table with all six occasions on real wardrobes
 * (docs/09-build-order-and-demo.md). Until then these are the bands the eval
 * asserts, and any change to them is a change to a test.
 */
export const OCCASION_RULES: Readonly<Record<Occasion, OccasionRule>> = {
  interview: { formality: ["smart", "formal"], addsOuterwear: true },
  wedding_guest: { formality: ["smart", "formal"], addsOuterwear: true },
  date: { formality: ["casual", "smart"], addsOuterwear: false },
  festival: { formality: ["casual"], addsOuterwear: false },
  everyday: { formality: ["casual", "smart"], addsOuterwear: false },
  formal_evening: { formality: ["formal"], addsOuterwear: true },
};

/** True when a garment's formality band is allowed for the occasion. */
export function formalityFitsOccasion(
  formality: GarmentFormality | null,
  occasion: Occasion,
): boolean {
  if (formality === null) {
    // Unknown formality is not a match. A garment nobody has classified cannot
    // be described as interview appropriate, and guessing would put a person in
    // front of an interviewer in the wrong clothes on our word.
    return false;
  }
  return OCCASION_RULES[occasion].formality.includes(formality);
}

/* ------------------------------------------------------------------ */
/* Completeness                                                         */
/* ------------------------------------------------------------------ */

/**
 * A complete look, docs/09-build-order-and-demo.md Layer 4: "top plus bottom
 * plus shoes, or dress plus shoes, outerwear optional".
 */
export const SEPARATES_SLOTS: readonly GarmentSlot[] = ["top", "bottom", "shoes"];
export const DRESS_SLOTS: readonly GarmentSlot[] = ["dress", "shoes"];

/**
 * The garment type word used to shop for a missing slot.
 *
 * A gap is a slot, but "Shop the gap" needs a word to search with and
 * docs/01-user-flow.md section K item 3 shows it in the line ("You do not own
 * shoes yet"). One neutral member of each slot, chosen because it is the type a
 * person is most likely to be missing and the one a search returns the widest
 * range for. Outerwear is not in this table on purpose: the layer is optional,
 * so a wardrobe without a jacket has no gap, it has a look without a layer.
 *
 * Open item for Layer 5: make the bottom word follow the occasion, so a festival
 * gap shops for shorts rather than trousers.
 */
export const GAP_TYPE_OF_SLOT: Readonly<Partial<Record<GarmentSlot, string>>> = {
  top: "shirt",
  bottom: "trousers",
  shoes: "shoes",
  dress: "dress",
};

/* ------------------------------------------------------------------ */
/* Rule notes                                                           */
/* ------------------------------------------------------------------ */

/*
 * A rule note is a plain factual fragment about something the rules established:
 * lowercase, no full stop, no claim the rules did not make. The stylist prompt
 * hands them to the model as facts it may use, and the deterministic fallback
 * builds its rationale out of them when there is no model.
 *
 * They are written as fragments rather than sentences so that neither consumer
 * has to unpick a sentence to reuse it, and every one of them is run through
 * checkLexicon in the unit test.
 */

/** At most this many wear notes, so the list stays quotable. */
export const MAX_WEAR_NOTES = 2;

function lower(value: string): string {
  return value.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Candidates                                                           */
/* ------------------------------------------------------------------ */

export type Candidate = {
  id: string;
  garmentIds: string[];
  heroGarmentId: string | null;
  gaps: string[];
  ruleNotes: string[];
};

/** docs/01-user-flow.md section K item 2: "two to three looks". */
export const MAX_CANDIDATES = 3;

/**
 * How many garments per slot enter the cross product.
 *
 * Six keeps the enumeration under about 1300 combinations for any wardrobe of
 * any size (6 tops by 6 bottoms by 6 shoes, twice for the dress path), which is
 * small enough to stay instant on a phone and large enough that a wardrobe of
 * thirty garments still offers real variety. The buckets are sorted before the
 * cut, so the six that enter are the six that sit best in the palette.
 */
export const MAX_PER_SLOT = 6;

export type ComposeInput = {
  /** A GarmentView is a LooksGarment, so GET /api/wardrobe feeds this directly. */
  readonly garments: readonly LooksGarment[];
  readonly palette: Palette | null;
  readonly occasion: Occasion;
};

type SlottedGarment = {
  readonly garment: LooksGarment;
  readonly slot: GarmentSlot;
  readonly match: PaletteMatch;
};

/**
 * How much a garment costs a look, in palette terms. Lower is better.
 *
 * A wear color costs its distance from the palette color it matched, so an exact
 * rust costs nothing and a near rust costs a little. A "neither" color costs the
 * ceiling: no worse than the worst wear match, no better than any of them, which
 * is the right place for a color we can say nothing about. An avoid color costs
 * twice the ceiling, so a look that puts one below the waist ranks under an
 * equally complete look that does not, without being thrown away.
 */
function paletteCost(match: PaletteMatch): number {
  if (match.family === "wear") {
    return match.distance ?? PALETTE_MATCH_MAX_DISTANCE;
  }
  if (match.family === "avoid") {
    return PALETTE_MATCH_MAX_DISTANCE * 2;
  }
  return PALETTE_MATCH_MAX_DISTANCE;
}

/**
 * The garments a look may be built from: a known slot, a formality the occasion
 * accepts, and, next to the face, a color that is not on the avoid list.
 *
 * The avoid rule is applied here rather than at ranking time because it is not a
 * preference. docs/05-evals.md: "a garment in the avoid list is never the hero
 * next to the face". A dropped near face garment is not silently discarded from
 * the wardrobe; it is still shown on /wardrobe, and it can still be worn below
 * the waist when it is a bottom or a pair of shoes.
 */
function usableGarments(input: ComposeInput): SlottedGarment[] {
  const usable: SlottedGarment[] = [];

  for (const garment of input.garments) {
    const slot = slotOfType(garment.type);
    if (slot === null || slot === "accessory") {
      // An accessory has no place in the top, bottom, shoes structure a look is
      // checked for completeness against. docs/09 Layer 6 adds one accessory try
      // on to the top look; that is a render, not a slot in the composition.
      continue;
    }
    if (!formalityFitsOccasion(garment.formality, input.occasion)) {
      continue;
    }
    const match = garmentColorMatch(garment, input.palette);
    if (isNearFaceSlot(slot) && match.family === "avoid") {
      continue;
    }
    usable.push({ garment, slot, match });
  }

  return usable;
}

/** Palette cost first, then the garment id, so the order never depends on input order. */
function bySlotPreference(a: SlottedGarment, b: SlottedGarment): number {
  const costA = paletteCost(a.match);
  const costB = paletteCost(b.match);
  if (costA !== costB) {
    return costA - costB;
  }
  return a.garment.id < b.garment.id ? -1 : 1;
}

function bucketOf(
  garments: readonly SlottedGarment[],
  slot: GarmentSlot,
): SlottedGarment[] {
  return garments
    .filter((entry) => entry.slot === slot)
    .sort(bySlotPreference)
    .slice(0, MAX_PER_SLOT);
}

type Combination = {
  /** In slot order: outerwear, top or dress, bottom, shoes. */
  readonly pieces: readonly SlottedGarment[];
  readonly bySlot: ReadonlyMap<GarmentSlot, SlottedGarment>;
  readonly gaps: string[];
  /**
   * True when the occasion asks for a layer, the wardrobe has one, and this
   * combination is the variant without it. It is not a gap (the layer is
   * optional, so nothing is missing), it is a ranking term: the layered look
   * leads and the same look without the layer is the second look, which is how a
   * six garment wardrobe still produces two looks for a wedding.
   */
  readonly missingLayer: boolean;
};

/** Two busy patterns in slots that touch each other. */
function hasPatternClash(bySlot: ReadonlyMap<GarmentSlot, SlottedGarment>): boolean {
  for (const [left, right] of ADJACENT_SLOT_PAIRS) {
    const first = bySlot.get(left);
    const second = bySlot.get(right);
    if (first === undefined || second === undefined) {
      continue;
    }
    if (
      isBusyPattern(first.garment.pattern) &&
      isBusyPattern(second.garment.pattern)
    ) {
      return true;
    }
  }
  return false;
}

function buildCombination(
  parts: readonly (SlottedGarment | null)[],
  requiredSlots: readonly GarmentSlot[],
  layerWasAvailable: boolean,
): Combination | null {
  const pieces = parts.filter((part): part is SlottedGarment => part !== null);
  const bySlot = new Map<GarmentSlot, SlottedGarment>();
  for (const piece of pieces) {
    bySlot.set(piece.slot, piece);
  }

  if (hasPatternClash(bySlot)) {
    return null;
  }

  const gaps: string[] = [];
  for (const slot of requiredSlots) {
    if (!bySlot.has(slot)) {
      const word = GAP_TYPE_OF_SLOT[slot];
      if (word !== undefined) {
        gaps.push(word);
      }
    }
  }

  return {
    pieces,
    bySlot,
    gaps,
    missingLayer: layerWasAvailable && !bySlot.has("outerwear"),
  };
}

/**
 * How well a look's colors sit, averaged over its pieces rather than summed.
 *
 * Summed would make every extra garment a cost, which would rank a dress and
 * shoes above a top, a bottom, shoes, and a jacket for no reason except that it
 * has fewer pieces. Averaged, the question is the one that matters: of the
 * clothes in this look, how many of them are colors this person wears.
 */
function meanPaletteCost(combination: Combination): number {
  if (combination.pieces.length === 0) {
    return PALETTE_MATCH_MAX_DISTANCE;
  }
  const total = combination.pieces.reduce(
    (sum, piece) => sum + paletteCost(piece.match),
    0,
  );
  return total / combination.pieces.length;
}

/**
 * Ranking, in order: complete looks first, then the layer the occasion asked
 * for, then the look whose colors sit best, then the fuller look, then the ids
 * so that two looks that are equal in every way still come out in one order.
 */
function rankCombinations(combinations: readonly Combination[]): Combination[] {
  return [...combinations].sort((a, b) => {
    if (a.gaps.length !== b.gaps.length) {
      return a.gaps.length - b.gaps.length;
    }
    if (a.missingLayer !== b.missingLayer) {
      return a.missingLayer ? 1 : -1;
    }
    const costA = meanPaletteCost(a);
    const costB = meanPaletteCost(b);
    if (costA !== costB) {
      return costA - costB;
    }
    if (a.pieces.length !== b.pieces.length) {
      return b.pieces.length - a.pieces.length;
    }
    const idsA = a.pieces.map((piece) => piece.garment.id).join(",");
    const idsB = b.pieces.map((piece) => piece.garment.id).join(",");
    return idsA < idsB ? -1 : 1;
  });
}

/**
 * How many garments two combinations do not share.
 *
 * Used to keep the three looks visibly different rather than the same shirt
 * three times with a different shoe. Two passes: first only combinations that
 * differ in at least two garments, then, if there were not enough of those,
 * anything that is not identical. A six garment wardrobe often cannot offer two
 * different tops for one occasion, and a screen with one look on it is worse
 * than a screen with two similar ones.
 */
export const MIN_DIFFERENT_GARMENTS = 2;

function differenceCount(a: Combination, b: Combination): number {
  const idsA = new Set(a.pieces.map((piece) => piece.garment.id));
  const idsB = new Set(b.pieces.map((piece) => piece.garment.id));
  let different = 0;
  for (const id of idsA) {
    if (!idsB.has(id)) {
      different += 1;
    }
  }
  for (const id of idsB) {
    if (!idsA.has(id)) {
      different += 1;
    }
  }
  return different;
}

function pickDiverse(ranked: readonly Combination[]): Combination[] {
  const picked: Combination[] = [];

  for (const candidate of ranked) {
    if (picked.length >= MAX_CANDIDATES) {
      break;
    }
    const differentEnough = picked.every(
      (chosen) => differenceCount(chosen, candidate) >= MIN_DIFFERENT_GARMENTS,
    );
    if (differentEnough) {
      picked.push(candidate);
    }
  }

  for (const candidate of ranked) {
    if (picked.length >= MAX_CANDIDATES) {
      break;
    }
    if (!picked.includes(candidate)) {
      picked.push(candidate);
    }
  }

  return picked;
}

/**
 * The near face slots in the order the hero is chosen from them.
 *
 * Outerwear first: when a layer is on top it is the piece a person sees from
 * across a room, and it is the piece the render has to show. Then the dress,
 * then the top.
 */
export const HERO_SLOT_PREFERENCE: readonly GarmentSlot[] = [
  "outerwear",
  "dress",
  "top",
];

/**
 * The garment that carries the look, and the one cloth try on renders on the
 * person (docs/01-user-flow.md section K item 2, one garment per call per
 * src/lib/server/providers/perfectcorp).
 *
 * Shoes and bottoms are never the hero, which falls out of the same rule that
 * keeps an avoid color off the face: the hero is by definition the piece next to
 * it. Null when the look has no near face garment at all, which happens when the
 * wardrobe has no usable top.
 */
function heroOf(bySlot: ReadonlyMap<GarmentSlot, SlottedGarment>): string | null {
  for (const slot of HERO_SLOT_PREFERENCE) {
    const piece = bySlot.get(slot);
    if (piece !== undefined) {
      return piece.garment.id;
    }
  }
  return null;
}

/** The notes for one combination, in the order a rationale would use them. */
function notesFor(combination: Combination, occasion: Occasion): string[] {
  const notes: string[] = [];

  // 1. Color, first, because it is the thing this app knows that a closet app
  //    does not. One note per wear garment, capped so the list stays quotable.
  let wearNotes = 0;
  for (const piece of combination.pieces) {
    if (wearNotes >= MAX_WEAR_NOTES) {
      break;
    }
    const dominant = dominantColorOf(piece.garment);
    if (piece.match.family === "wear" && dominant !== null) {
      notes.push(`${lower(dominant.name)} sits in your wear palette`);
      wearNotes += 1;
    }
  }

  // 2. The avoid color that was allowed below the waist, named so the rationale
  //    can say why it is there. docs/05-evals.md: "an avoid color may appear
  //    below the waist with a rationale".
  for (const piece of combination.pieces) {
    const dominant = dominantColorOf(piece.garment);
    if (
      isBelowWaistSlot(piece.slot) &&
      piece.match.family === "avoid" &&
      dominant !== null
    ) {
      notes.push(
        `${lower(dominant.name)} stays below the waist, away from your face`,
      );
    }
  }

  // 3. The one busy pattern, if there is one, and where it sits.
  const busy = combination.pieces.filter((piece) =>
    isBusyPattern(piece.garment.pattern),
  );
  if (busy.length === 1) {
    const piece = busy[0];
    if (piece !== undefined && piece.garment.pattern !== null) {
      const pattern = lower(piece.garment.pattern);
      notes.push(
        isBelowWaistSlot(piece.slot)
          ? `the ${pattern} stays below the waist`
          : `the ${pattern} is the only pattern in this look`,
      );
    }
  }

  // 4. Formality, which is the occasion half of the reasoning.
  const bands = [
    ...new Set(
      combination.pieces
        .map((piece) => piece.garment.formality)
        .filter((band): band is GarmentFormality => band !== null),
    ),
  ].sort();
  const onlyBand = bands.length === 1 ? bands[0] : undefined;
  if (onlyBand !== undefined) {
    notes.push(`every piece here reads ${onlyBand}`);
  } else if (bands.length > 1) {
    notes.push(`the pieces here read ${bands.join(" and ")}`);
  }

  // 5. The layer, when the occasion asked for one and the wardrobe had it.
  const outerwear = combination.bySlot.get("outerwear");
  if (outerwear !== undefined && OCCASION_RULES[occasion].addsOuterwear) {
    const type = outerwear.garment.type;
    if (type !== null) {
      notes.push(`the ${lower(type).replace("_", " ")} is the layer this occasion asks for`);
    }
  }

  // 6. What is missing, in the words "Shop the gap" uses.
  for (const gap of combination.gaps) {
    notes.push(`you do not own ${gap} yet`);
  }

  return notes;
}

/**
 * The candidate combinations for one wardrobe, one palette, and one occasion.
 *
 * At most MAX_CANDIDATES, best coverage first. Empty when the wardrobe holds
 * nothing this occasion can use, which is the state /looks renders from live
 * listings instead (docs/01-user-flow.md section K, "No wardrobe"). An empty
 * list is the honest answer there: a look with no garments in it is not a look.
 *
 * Total: every branch returns an array. Nothing here throws, nothing here reads
 * a clock, and nothing here invents a garment.
 */
export function composeCandidates(input: ComposeInput): Candidate[] {
  const usable = usableGarments(input);
  if (usable.length === 0) {
    return [];
  }

  const tops = bucketOf(usable, "top");
  const bottoms = bucketOf(usable, "bottom");
  const dresses = bucketOf(usable, "dress");
  const shoes = bucketOf(usable, "shoes");
  const outerwear = bucketOf(usable, "outerwear");

  // The layer is added when the occasion asks for one and the wardrobe has one.
  // The best one, not each one: a second candidate that differs only by which
  // jacket is on top is not a second look. Both variants are enumerated, with
  // and without it, and the ranking puts the layered one first.
  const layer =
    OCCASION_RULES[input.occasion].addsOuterwear && outerwear.length > 0
      ? (outerwear[0] ?? null)
      : null;
  const layerOptions: (SlottedGarment | null)[] =
    layer === null ? [null] : [layer, null];

  const orNone = (bucket: readonly SlottedGarment[]): (SlottedGarment | null)[] =>
    bucket.length > 0 ? [...bucket] : [null];

  const combinations: Combination[] = [];

  for (const worn of layerOptions) {
    for (const dress of dresses) {
      for (const shoe of orNone(shoes)) {
        const combination = buildCombination(
          [worn, dress, shoe],
          DRESS_SLOTS,
          layer !== null,
        );
        if (combination !== null) {
          combinations.push(combination);
        }
      }
    }

    for (const top of orNone(tops)) {
      for (const bottom of orNone(bottoms)) {
        for (const shoe of orNone(shoes)) {
          if (
            worn === null &&
            top === null &&
            bottom === null &&
            shoe === null
          ) {
            // Nothing at all is not a look. Every other shape, including a
            // single garment with three gaps, is a real answer for a wardrobe
            // that holds one garment.
            continue;
          }
          const combination = buildCombination(
            [worn, top, bottom, shoe],
            SEPARATES_SLOTS,
            layer !== null,
          );
          if (combination !== null) {
            combinations.push(combination);
          }
        }
      }
    }
  }

  const chosen = pickDiverse(rankCombinations(combinations));

  return chosen.map((combination, index) => ({
    // Deterministic and short: the same wardrobe and occasion produce the same
    // id for the same look, and the id is small enough to sit in the stylist
    // prompt as a combination_id without spending tokens on uuids.
    id: `${input.occasion}-${index + 1}`,
    garmentIds: combination.pieces.map((piece) => piece.garment.id),
    heroGarmentId: heroOf(combination.bySlot),
    gaps: [...combination.gaps],
    ruleNotes: notesFor(combination, input.occasion),
  }));
}
