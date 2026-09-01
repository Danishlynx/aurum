import "server-only";

import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";

import { namesALocation } from "./locations";

/**
 * Every check a generated reading has to pass before it is stored.
 *
 * docs/05-evals.md, eval:synthesis, hard checks: "output parses against the
 * schema; reading is 3 to 5 sentences and under 90 words; contains the top
 * concern key's display name and a location word; contains no term from the
 * banned lexicon; contains no exclamation mark, em dash, or en dash; contains no
 * brand name."
 *
 * docs/06-safety-privacy.md, "Regeneration and fallback": a reading that fails
 * is regenerated once with the violations listed, and a second failure uses the
 * deterministic fallback.
 *
 * The same functions run in three places, which is the point: the model call
 * validates with them, the eval asserts with them, and the deterministic
 * fallback is written to pass them by construction.
 */

/** docs/04-integrations.md: the reading is 3 to 5 sentences. */
export const MIN_SENTENCES = 3;
export const MAX_SENTENCES = 5;

/** docs/04-integrations.md: under 90 words. */
export const MAX_WORDS = 89;

/** docs/04-integrations.md: 4 to 6 routine steps across morning and night. */
export const MIN_ROUTINE_STEPS = 4;
export const MAX_ROUTINE_STEPS = 6;

/**
 * Capitalized words that are not brands. Without this list the brand check
 * would flag "Vitamin C" and "SPF", which are the two things a routine is most
 * likely to name.
 */
const ALLOWED_CAPITALIZED: ReadonlySet<string> = new Set([
  "A",
  "AHA",
  "B",
  "BHA",
  "C",
  "Corp",
  "E",
  "Fitzpatrick",
  "I",
  "II",
  "III",
  "IV",
  "K",
  "PHA",
  "Perfect",
  "SPF",
  "T",
  "UV",
  "V",
  "VI",
  "Vitamin",
]);

/**
 * Brands common enough in skincare that a model could reach for one in lower
 * case, where the capitalization rule below would not see it.
 *
 * Not exhaustive and not meant to be. The general rule is the capitalization
 * check; this list catches the ones that slip under it.
 */
export const BRAND_DENYLIST: readonly string[] = [
  "cerave",
  "cetaphil",
  "the ordinary",
  "neutrogena",
  "olay",
  "nivea",
  "aveeno",
  "eucerin",
  "vichy",
  "bioderma",
  "la roche posay",
  "loreal",
  "l'oreal",
  "garnier",
  "clinique",
  "estee lauder",
  "paula's choice",
  "drunk elephant",
  "mamaearth",
  "minimalist",
  "deconstruct",
  "dot and key",
  "foxtale",
  "plum goodness",
  "sephora",
  "nykaa",
  "amazon",
];

/** Sentences, split on terminal punctuation. Trailing text counts as one. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

/**
 * Words that look like a brand: a capitalized word that is not starting a
 * sentence and is not in the allowed list, or a name from the denylist.
 */
export function findBrandLikeWords(text: string): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();

  for (const brand of BRAND_DENYLIST) {
    if (lower.includes(brand)) {
      found.push(brand);
    }
  }

  for (const sentence of splitSentences(text)) {
    const words = sentence.split(/\s+/u);
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index] ?? "";
      const bare = word.replace(/[^\p{L}\p{N}']/gu, "");
      if (bare.length === 0) {
        continue;
      }
      const first = bare[0] ?? "";
      if (first !== first.toUpperCase() || first === first.toLowerCase()) {
        continue;
      }
      if (ALLOWED_CAPITALIZED.has(bare)) {
        continue;
      }
      found.push(bare);
    }
  }

  return [...new Set(found)];
}

export interface ReadingCheckContext {
  /** The display name of the concern ranked 1, for example "Pigmentation". */
  readonly topConcernName: string;
}

/**
 * Every problem with a reading, as sentences a prompt can be given verbatim.
 * An empty array means the reading may be stored.
 */
export function findReadingProblems(
  reading: string,
  context: ReadingCheckContext,
): string[] {
  const problems: string[] = [];

  for (const violation of checkLexicon(reading)) {
    problems.push(`the reading contains a ${describeViolation(violation)}`);
  }

  const sentences = countSentences(reading);
  if (sentences < MIN_SENTENCES || sentences > MAX_SENTENCES) {
    problems.push(
      `the reading has ${String(sentences)} sentences and it has to have ${String(
        MIN_SENTENCES,
      )} to ${String(MAX_SENTENCES)}`,
    );
  }

  const words = countWords(reading);
  if (words > MAX_WORDS) {
    problems.push(
      `the reading is ${String(words)} words and it has to stay under 90`,
    );
  }

  if (!reading.toLowerCase().includes(context.topConcernName.toLowerCase())) {
    problems.push(
      `the reading does not name the top concern, which is "${context.topConcernName}"`,
    );
  }

  if (!namesALocation(reading)) {
    problems.push("the reading does not say where on the face the concern sits");
  }

  const brands = findBrandLikeWords(reading);
  if (brands.length > 0) {
    problems.push(
      `the reading names something that reads as a brand: ${brands.join(", ")}`,
    );
  }

  return problems;
}

/**
 * A short sentence has fewer checks: it is the going well line, which only has
 * to be one lexicon clean sentence with no brand in it.
 */
export function findSentenceProblems(text: string, label: string): string[] {
  const problems: string[] = [];
  for (const violation of checkLexicon(text)) {
    problems.push(`${label} contains a ${describeViolation(violation)}`);
  }
  if (text.trim().length === 0) {
    problems.push(`${label} is empty`);
  }
  const brands = findBrandLikeWords(text);
  if (brands.length > 0) {
    problems.push(`${label} names something that reads as a brand: ${brands.join(", ")}`);
  }
  return problems;
}

/**
 * A product query is sent to a search engine, so it is cleaned before it is
 * used. Letters, digits, and single spaces survive; everything else is dropped.
 * docs/06-safety-privacy.md: text that came back from a model is data, never an
 * instruction, and never anything that can reshape a request.
 */
export const MAX_QUERY_LENGTH = 80;

export function sanitizeProductQuery(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}
