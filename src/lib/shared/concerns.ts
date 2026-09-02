/**
 * Concern keys, the provider name mapping, and the tone first ranking rule.
 *
 * docs/04-integrations.md: "Map provider concern keys to our internal keys in
 * one place: src/lib/shared/concerns.ts. The tone first ranking lives there too
 * and is unit tested."
 *
 * Everything here is pure. No I/O, no provider types, no React.
 */

import { copy } from "./copy";

/**
 * Internal concern keys. Snake case, stable, stored in
 * aesthetic_profiles.concerns and used as the mask toggle identity.
 *
 * The set covers the concerns docs/04-integrations.md lists for Perfect Corp
 * skin analysis (redness, oiliness, age spots, radiance, moisture, dark
 * circles, eye bags, eyelid droop, firmness, texture, acne, pores by region,
 * wrinkles by region, tear trough) plus the three tone concerns the report
 * ranks first. Overall score, skin age, and skin type by zone are not concerns:
 * they are separate fields on the aesthetic profile.
 */
export const CONCERN_KEYS = [
  // Tone.
  "pigmentation",
  "uneven_tone",
  "dark_spots",
  // Surface.
  "texture",
  "pores",
  "oiliness",
  "moisture",
  "acne",
  "redness",
  "radiance",
  // Structure.
  "firmness",
  "wrinkles",
  // Eye area.
  "dark_circles",
  "eye_bags",
  "tear_trough",
  "eyelid_droop",
] as const;

export type ConcernKey = (typeof CONCERN_KEYS)[number];

const CONCERN_KEY_SET: ReadonlySet<string> = new Set<string>(CONCERN_KEYS);

/** True when a string is one of our concern keys. */
export function isConcernKey(value: string): value is ConcernKey {
  return CONCERN_KEY_SET.has(value);
}

/**
 * The display name shown on the mask toggle, the concern row, and the routine
 * tag. Indexing copy by ConcernKey means a missing entry in copy.ts is a
 * compile error, so the names here and the names on screen cannot drift.
 */
export function concernDisplayName(key: ConcernKey): string {
  return copy.report.concerns[key].name;
}

/** The one line plain description shown under the concern name. */
export function concernDescription(key: ConcernKey): string {
  return copy.report.concerns[key].description;
}

/**
 * The same names as a map, for callers that need to iterate. Built from the
 * copy above; the cast covers only the loose return type of Object.fromEntries.
 */
export const CONCERN_DISPLAY_NAMES = Object.fromEntries(
  CONCERN_KEYS.map((key) => [key, concernDisplayName(key)]),
) as Readonly<Record<ConcernKey, string>>;

/** Fitzpatrick skin type, I to VI, as the integers the provider returns. */
export type FitzpatrickType = 1 | 2 | 3 | 4 | 5 | 6;

export function isFitzpatrickType(value: number): value is FitzpatrickType {
  return Number.isInteger(value) && value >= 1 && value <= 6;
}

/**
 * Concerns whose display copy must be accompanied once on the report by
 * REQUIRED_SENSITIVE_CONCERN_LINE from src/lib/shared/lexicon.ts.
 * docs/06-safety-privacy.md, "Required framing".
 */
export const CONCERNS_REQUIRING_ESCALATION_LINE: readonly ConcernKey[] = [
  "redness",
  "acne",
];

// ---------------------------------------------------------------------------
// Perfect Corp name mapping
// ---------------------------------------------------------------------------

/**
 * PARTLY VERIFIED. One live skin analysis task on 2026-09-02 returned the 15
 * scored concern names in VERIFIED_SD_SKIN_CONCERN_TYPES below, and every one
 * of them now has a row in the table. The rest of the table is still the guess
 * it always was, derived from the prose in docs/04-integrations.md, and the
 * names it guesses at ("pigmentation", "spots", "hydration", "uneven_tone")
 * have never appeared in a response.
 *
 * So the status stays UNVERIFIED: it describes the table, and most of the table
 * is unconfirmed. It flips only when a run has confirmed every row it needs, or
 * when the unconfirmed rows are deleted. Until then the provider module must
 * treat an unmapped name as a warning it logs, not as a silent drop.
 */
export const PERFECT_CORP_CONCERN_MAP_STATUS: "UNVERIFIED" | "verified" =
  "UNVERIFIED";

/**
 * The scored concern types one live SD skin analysis returned, in the order the
 * provider sent them. Confirmed on 2026-09-02 against the recorded response in
 * evals/fixtures/perfectcorp/skin-analysis-status.json. Every one of these must
 * map to a concern key, which is asserted in src/lib/shared/concerns.test.ts.
 *
 * Not in this list, because they are not concerns: "all" (one overall score),
 * "skin_age", "skin_type" (repeated per zone), and "resize_image".
 */
export const VERIFIED_SD_SKIN_CONCERN_TYPES: readonly string[] = [
  "eye_bag",
  "tear_trough",
  "redness",
  "oiliness",
  "pore",
  "droopy_lower_eyelid",
  "droopy_upper_eyelid",
  "dark_circle_v2",
  "texture",
  "firmness",
  "radiance",
  "age_spot",
  "wrinkle",
  "acne",
  "moisture",
];

/**
 * Skin analysis output types that carry something other than a concern score.
 * They are not unmapped names, and a caller that logs unmapped names must not
 * report them: the reading for each one has its own home on the profile.
 */
export const PROVIDER_NON_CONCERN_OUTPUT_TYPES: ReadonlySet<string> = new Set([
  "all",
  "skin_age",
  "skin_type",
  "resize_image",
]);

/** True when a provider output type is deliberately not a concern. */
export function isNonConcernOutputType(raw: string): boolean {
  return PROVIDER_NON_CONCERN_OUTPUT_TYPES.has(normalizeProviderConcernName(raw));
}

/**
 * Provider name to internal key. Keys are already normalized by
 * normalizeProviderConcernName, so both "Dark Circles" and "dark_circle" reach
 * the same entry.
 *
 * Rows marked LIVE were returned by the live API on 2026-09-02. The rest are
 * still guesses and are kept because they cost nothing and because an
 * unrecognised name is dropped from the report, which is worse than a spare row.
 */
export const UNVERIFIED_PERFECT_CORP_CONCERN_MAP: Readonly<
  Record<string, ConcernKey>
> = {
  pigmentation: "pigmentation",
  spot: "pigmentation",
  spots: "pigmentation",
  uneven_tone: "uneven_tone",
  skin_tone: "uneven_tone",
  tone_evenness: "uneven_tone",
  /* LIVE. The provider says age_spot; the report calls it dark spots. */
  age_spot: "dark_spots",
  age_spots: "dark_spots",
  dark_spot: "dark_spots",
  dark_spots: "dark_spots",
  texture: "texture" /* LIVE */,
  pore: "pores" /* LIVE */,
  pores: "pores",
  oiliness: "oiliness" /* LIVE */,
  oily: "oiliness",
  moisture: "moisture" /* LIVE */,
  hydration: "moisture",
  acne: "acne" /* LIVE */,
  blemish: "acne",
  blemishes: "acne",
  redness: "redness" /* LIVE */,
  radiance: "radiance" /* LIVE */,
  firmness: "firmness" /* LIVE */,
  wrinkle: "wrinkles" /* LIVE */,
  wrinkles: "wrinkles",
  dark_circle: "dark_circles",
  dark_circles: "dark_circles",
  /*
   * LIVE. The v2 suffix is the provider's model version, not a different
   * concern, and it survives normalizeProviderConcernName as "dark_circle_v2",
   * so it needs its own row: without one the whole dark circles reading was
   * dropped from the report and its mask never stored.
   */
  dark_circle_v2: "dark_circles",
  eye_bag: "eye_bags" /* LIVE */,
  eye_bags: "eye_bags",
  tear_trough: "tear_trough" /* LIVE */,
  eyelid_droop: "eyelid_droop",
  droopy_eyelid: "eyelid_droop",
  /*
   * LIVE, both of them. The provider scores the upper and the lower lid
   * separately; the report has one eyelid droop concern, so they share a key
   * and the higher score wins in dedupeByKey below.
   */
  droopy_upper_eyelid: "eyelid_droop",
  droopy_lower_eyelid: "eyelid_droop",
};

/**
 * Tokens that name a place on the face rather than a concern. Perfect Corp
 * reports pores and wrinkles by region, so "wrinkle_forehead" and "pore_nose"
 * have to reduce to "wrinkle" and "pore" while keeping the region for the
 * reading, which must say where the concern sits.
 *
 * UNVERIFIED for the same reason as the map above.
 */
const REGION_TOKENS: ReadonlySet<string> = new Set([
  "forehead",
  "glabella",
  "nose",
  "chin",
  "jaw",
  "jawline",
  "cheek",
  "cheeks",
  "temple",
  "temples",
  "nasolabial",
  "perioral",
  "mouth",
  "t",
  "zone",
]);

export type ParsedProviderConcern = {
  /** The name after case and separator normalization, regions included. */
  readonly normalized: string;
  /** The internal key, or null when the name is not in the table. */
  readonly key: ConcernKey | null;
  /** The region tokens joined with underscores, or null when there are none. */
  readonly region: string | null;
};

/**
 * Lowercases a provider concern name and collapses every run of characters that
 * is not a letter or a digit into a single underscore.
 */
export function normalizeProviderConcernName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

/**
 * Splits a provider concern name into its concern and its region, then looks
 * the concern up. Returns key null when the name is unknown; the caller decides
 * whether that is a warning or a failure.
 */
export function parseProviderConcernName(raw: string): ParsedProviderConcern {
  const normalized = normalizeProviderConcernName(raw);
  if (normalized === "") {
    return { normalized, key: null, region: null };
  }

  const direct = UNVERIFIED_PERFECT_CORP_CONCERN_MAP[normalized];
  if (direct !== undefined) {
    return { normalized, key: direct, region: null };
  }

  const tokens = normalized.split("_");
  const regionTokens = tokens.filter((token) => REGION_TOKENS.has(token));
  const concernTokens = tokens.filter((token) => !REGION_TOKENS.has(token));
  const stripped = concernTokens.join("_");
  const key = UNVERIFIED_PERFECT_CORP_CONCERN_MAP[stripped];

  return {
    normalized,
    key: key ?? null,
    region: regionTokens.length > 0 ? regionTokens.join("_") : null,
  };
}

/** The internal key for a provider concern name, or null when unknown. */
export function mapProviderConcern(raw: string): ConcernKey | null {
  return parseProviderConcernName(raw).key;
}

// ---------------------------------------------------------------------------
// Tone first ranking
// ---------------------------------------------------------------------------

/**
 * The concerns the report ranks first for deeper skin.
 * docs/01-user-flow.md section F item 3: "Ordered tone first (pigmentation and
 * uneven tone rank above wrinkles for deeper skin)".
 */
export const TONE_FIRST_CONCERNS: readonly ConcernKey[] = [
  "pigmentation",
  "uneven_tone",
  "dark_spots",
];

/** The concerns a tone concern outranks when the rule applies. */
export const TONE_FIRST_DEPRIORITIZED: readonly ConcernKey[] = [
  "wrinkles",
  "redness",
];

/** The Fitzpatrick types the rule applies to: IV, V, and VI. */
export const TONE_FIRST_FITZPATRICK_TYPES: readonly FitzpatrickType[] = [
  4, 5, 6,
];

/**
 * Two scores are comparable when they are within this many points of each
 * other, on the provider's 1 to 100 scale.
 *
 * 12 is not a taste call. docs/05-evals.md sets the eval:consistency threshold
 * at a median top concern difference under 12 points between two captures of
 * the same face in different light. A gap smaller than that is inside our own
 * measurement noise, so it is not a real ordering, and the tone first rule is
 * allowed to decide it. A gap larger than that is a real difference and the
 * higher score wins regardless of category.
 *
 * If eval:consistency later reports a different median, change this constant in
 * the same PR and note it, because the two numbers mean the same thing.
 */
export const TONE_FIRST_COMPARABLE_BAND = 12;

/** The rule in one paragraph, for PR descriptions and prompt context. */
export const TONE_FIRST_RULE_DESCRIPTION =
  "For Fitzpatrick IV to VI, a tone concern (pigmentation, uneven tone, dark spots) is ranked above wrinkles and redness whenever their scores are comparable, meaning the tone concern's score is no more than 12 points below. Outside that band, and for Fitzpatrick I to III or an unknown type, concerns are ranked by score alone. Ties are broken by concern key in alphabetical order, so the same input always produces the same order.";

export type ConcernScore = {
  readonly key: ConcernKey;
  /** The provider score, 1 to 100. Higher means more present. */
  readonly score: number;
};

export type RankedConcern = {
  readonly key: ConcernKey;
  readonly score: number;
  /** 1 based position after ranking. */
  readonly rank: number;
  /** True when the tone first rule moved this concern up. */
  readonly promotedByToneFirst: boolean;
};

function isToneFirst(key: ConcernKey): boolean {
  return TONE_FIRST_CONCERNS.includes(key);
}

function isDeprioritized(key: ConcernKey): boolean {
  return TONE_FIRST_DEPRIORITIZED.includes(key);
}

/** True when the tone first rule applies to this Fitzpatrick type. */
export function toneFirstApplies(fitzpatrick: FitzpatrickType | null): boolean {
  return (
    fitzpatrick !== null && TONE_FIRST_FITZPATRICK_TYPES.includes(fitzpatrick)
  );
}

/**
 * Removes duplicate keys, keeping the highest score for a key. Equal scores
 * keep the first occurrence, so the result does not depend on input order.
 */
function dedupeByKey(concerns: readonly ConcernScore[]): ConcernScore[] {
  const best = new Map<ConcernKey, ConcernScore>();
  for (const concern of concerns) {
    const existing = best.get(concern.key);
    if (existing === undefined || concern.score > existing.score) {
      best.set(concern.key, { key: concern.key, score: concern.score });
    }
  }
  return [...best.values()];
}

/** Score descending, then concern key alphabetically. */
function compareByScoreThenKey(a: ConcernScore, b: ConcernScore): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Ranks concerns tone first.
 *
 * The algorithm is two deterministic phases rather than one comparator, because
 * a comparator that promotes inside a band is not transitive and Array.prototype.sort
 * gives engine dependent results for a non transitive comparator.
 *
 * Phase 1: sort by score descending, ties broken by key alphabetically.
 * Phase 2: when the rule applies, walk the deprioritized concerns in that order,
 * highest first. For each one, take every tone concern that currently sits
 * below it and whose score is within TONE_FIRST_COMPARABLE_BAND, and move that
 * group, in its existing order, to just above it.
 *
 * Properties this gives, all covered by tests:
 * - Same input, same output, every time.
 * - The relative order of two tone concerns never changes.
 * - A tone concern never moves below where phase 1 put it.
 * - For Fitzpatrick I to III or a null type, the output is exactly phase 1.
 */
export function rankConcernsToneFirst(
  concerns: readonly ConcernScore[],
  fitzpatrick: FitzpatrickType | null,
): RankedConcern[] {
  const base = dedupeByKey(concerns).sort(compareByScoreThenKey);

  if (!toneFirstApplies(fitzpatrick)) {
    return base.map((concern, index) => ({
      key: concern.key,
      score: concern.score,
      rank: index + 1,
      promotedByToneFirst: false,
    }));
  }

  let ordered = [...base];
  const promoted = new Set<ConcernKey>();

  for (const anchor of base) {
    if (!isDeprioritized(anchor.key)) {
      continue;
    }
    const anchorIndex = ordered.indexOf(anchor);
    const below = ordered.slice(anchorIndex + 1);
    const moving = below.filter(
      (concern) =>
        isToneFirst(concern.key) &&
        concern.score >= anchor.score - TONE_FIRST_COMPARABLE_BAND,
    );
    if (moving.length === 0) {
      continue;
    }

    const remaining = ordered.filter((concern) => !moving.includes(concern));
    const insertAt = remaining.indexOf(anchor);
    ordered = [
      ...remaining.slice(0, insertAt),
      ...moving,
      ...remaining.slice(insertAt),
    ];
    for (const concern of moving) {
      promoted.add(concern.key);
    }
  }

  return ordered.map((concern, index) => ({
    key: concern.key,
    score: concern.score,
    rank: index + 1,
    promotedByToneFirst: promoted.has(concern.key),
  }));
}

/** The top ranked concern, or null when there are none. */
export function topConcern(ranked: readonly RankedConcern[]): RankedConcern | null {
  return ranked[0] ?? null;
}
