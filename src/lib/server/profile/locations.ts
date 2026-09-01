import "server-only";

import type { ConcernKey } from "@/lib/shared/concerns";

/**
 * Where a concern sits, in the words a person would use.
 *
 * The report has to say where the top concern is (docs/01-user-flow.md section F
 * item 2, docs/04-integrations.md output field top_concern_location). Two
 * sources feed it:
 *
 *   1. the region the provider itself named, parsed out of names like
 *      "pore_nose" by parseProviderConcernName in src/lib/shared/concerns.ts,
 *   2. and, when the provider named none, the place that concern is normally
 *      read on a face.
 *
 * This is a vocabulary, not screen copy. src/lib/shared/copy.ts draws the line
 * the same way for palette colour names, season names, and garment types: a
 * catalog of values belongs with the logic that produces it, and the sentence
 * that frames it belongs in copy.ts. Every value below is checked against the
 * banned lexicon by the eval suite, exactly like copy is.
 */

/** Provider region token (or joined tokens) to the words a person would use. */
const REGION_PHRASES: Readonly<Record<string, string>> = {
  forehead: "forehead",
  glabella: "skin between the brows",
  nose: "nose",
  chin: "chin",
  jaw: "jawline",
  jawline: "jawline",
  cheek: "cheeks",
  cheeks: "cheeks",
  temple: "temples",
  temples: "temples",
  nasolabial: "lines from the nose to the mouth",
  perioral: "area around the mouth",
  mouth: "area around the mouth",
  t: "T zone",
  zone: "T zone",
  t_zone: "T zone",
};

/**
 * Where each concern is read when the provider named no region. Indexed by
 * ConcernKey, so a new concern key is a compile error here rather than a
 * concern that quietly loses its place on the face.
 */
const DEFAULT_LOCATIONS: Readonly<Record<ConcernKey, string>> = {
  pigmentation: "cheekbones",
  uneven_tone: "cheeks and around the mouth",
  dark_spots: "cheekbones",
  texture: "cheeks",
  pores: "T zone",
  oiliness: "T zone",
  moisture: "cheeks",
  acne: "jawline and chin",
  redness: "cheeks and nose",
  radiance: "cheeks",
  firmness: "jawline",
  wrinkles: "forehead",
  dark_circles: "skin under the eyes",
  eye_bags: "skin under the eyes",
  tear_trough: "skin under the eyes",
  eyelid_droop: "upper eyelids",
};

/**
 * Every phrase above reads correctly after "on the", which is the frame
 * copy.report.fallbackReadingTemplate puts it in ("... on the cheekbones.").
 * That is why the eye phrases say "skin under the eyes" rather than "under the
 * eyes": the shorter version does not survive the frame.
 */

/**
 * The location phrase for a concern. The provider's region wins when it gave
 * one; otherwise the concern's usual place is used.
 */
export function locationFor(key: ConcernKey, region: string | null): string {
  if (region !== null) {
    const whole = REGION_PHRASES[region];
    if (whole !== undefined) {
      return whole;
    }
    const first = region.split("_")[0];
    if (first !== undefined) {
      const partial = REGION_PHRASES[first];
      if (partial !== undefined) {
        return partial;
      }
    }
  }
  return DEFAULT_LOCATIONS[key];
}

/**
 * Words that name a place on a face. eval:synthesis requires every reading to
 * contain one (docs/05-evals.md, eval:synthesis hard checks), so the list is
 * the checker's vocabulary as well as the writer's.
 *
 * Matched case insensitively as substrings, so "cheek" also covers "cheeks" and
 * "cheekbones".
 */
export const LOCATION_WORDS: readonly string[] = [
  "cheek",
  "forehead",
  "nose",
  "chin",
  "jaw",
  "temple",
  "brow",
  "eye",
  "eyelid",
  "mouth",
  "lip",
  "t zone",
  "hairline",
  "neck",
  "face",
];

/** True when the text names somewhere on the face. */
export function namesALocation(text: string): boolean {
  const lower = text.toLowerCase();
  return LOCATION_WORDS.some((word) => lower.includes(word));
}
