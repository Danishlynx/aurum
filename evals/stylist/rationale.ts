import { checkLexicon, describeViolation } from "@/lib/shared/lexicon";
import type { Occasion } from "@/lib/shared/looks";
import type { Palette } from "@/lib/shared/palette";

/**
 * The hard checks on a stylist rationale, as a function anything can call.
 *
 * docs/05-evals.md, suite eval:stylist: "Model rationale hard checks: 2
 * sentences, names the occasion, references the coloring, no numbers, no
 * superlatives." docs/04-integrations.md adds the same requirement from the
 * other side: "The rationale must reference the person's coloring and the
 * occasion by name. No scores, no superlatives."
 *
 * It lives here rather than beside the model call because it is a check, not a
 * behaviour: the eval runs it over samples, and the looks layer runs it over a
 * real model output before storing one, falling back to the deterministic rules
 * rationale when it fails (docs/03-architecture.md, "Claude API error"). No
 * judge model is involved, which is the point: these are the checks that never
 * depend on one.
 *
 * Nothing here is a rubric. A rationale that passes every check can still be a
 * bad sentence; that is what the human preference set at the bottom of
 * eval:stylist is for.
 */

/** How many sentences a rationale is, exactly. docs/04 and docs/05 both say 2. */
export const REQUIRED_SENTENCES = 2;

/**
 * The words that count as naming an occasion.
 *
 * Written as the words a person would use rather than as the stored keys, since
 * "wedding_guest" is a database value and "a wedding" is what a sentence says.
 */
export const OCCASION_WORDS: Readonly<Record<Occasion, readonly string[]>> = {
  interview: ["interview"],
  wedding_guest: ["wedding"],
  date: ["date"],
  festival: ["festival"],
  everyday: ["everyday", "every day"],
  formal_evening: ["formal evening", "formal night"],
};

/**
 * The words that count as referencing the person's coloring when the rationale
 * names no palette color and no season.
 *
 * "Warm" and "cool" are on the list because that is how the reading actually
 * reads on a page ("navy against your warm deep skin"), and "undertone" and
 * "season" because those are the two nouns the profile uses. A sentence that
 * contains none of these and no color name is a sentence about clothes, not
 * about this person, which is the failure this check exists to catch.
 */
export const COLORING_WORDS: readonly string[] = [
  "your skin",
  "your face",
  "your coloring",
  "your colouring",
  "your palette",
  "undertone",
  "season",
  "warm",
  "cool",
  "neutral",
];
// "deep" and "light" are deliberately not on that list even though both are
// season words. They are also ordinary words about clothes ("a light jacket"),
// and a check that passes on those is a check that does not check anything. Both
// reach this test through the season display name instead.

/**
 * Superlatives, banned by docs/04-integrations.md ("No scores, no
 * superlatives"). The lexicon in src/lib/shared/lexicon.ts already bans the hype
 * words the whole app bans ("amazing", "perfect", "flawless"); this list is the
 * grammar of overselling on top of it, which the lexicon has no opinion about.
 *
 * A word list cannot catch every superlative ever written. It catches the ones a
 * model reaches for, and a new one that appears in a real output is added here
 * with the output saved as a fixture (docs/05-evals.md, "When we find a real
 * failure").
 */
export const SUPERLATIVES: readonly string[] = [
  "best",
  "worst",
  "finest",
  "sharpest",
  "strongest",
  "boldest",
  "greatest",
  "ultimate",
  "unbeatable",
  "stunning",
  "gorgeous",
  "incredible",
  "outstanding",
  "superior",
  "most flattering",
  "the most",
];

export type RationaleContext = {
  readonly occasion: Occasion;
  /** Null when the person's undertone was never read, so no color is named. */
  readonly palette: Palette | null;
};

/** One line per failure, in the words a test report or a retry prompt can use. */
export type RationaleProblem = string;

function containsWord(haystack: string, needle: string): boolean {
  const pattern = new RegExp(
    `\\b${needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`,
    "iu",
  );
  return pattern.test(haystack);
}

/**
 * Sentences, counted by their full stops.
 *
 * Exclamation marks and question marks are not treated as sentence ends because
 * neither belongs in this app's copy at all: an exclamation mark is a lexicon
 * violation on its own, and a question is not a rationale.
 */
export function countSentences(text: string): number {
  return text
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

/** Every problem with a rationale, in order. An empty array means it passes. */
export function checkRationale(
  rationale: string,
  context: RationaleContext,
): RationaleProblem[] {
  const problems: RationaleProblem[] = [];
  const text = rationale.trim();

  if (text.length === 0) {
    return ["the rationale is empty"];
  }

  for (const violation of checkLexicon(text)) {
    problems.push(describeViolation(violation));
  }

  const sentences = countSentences(text);
  if (sentences !== REQUIRED_SENTENCES) {
    problems.push(
      `the rationale is ${sentences} sentences, it has to be ${REQUIRED_SENTENCES}`,
    );
  }
  if (!text.endsWith(".")) {
    problems.push("the rationale does not end with a full stop");
  }

  const occasionWords = OCCASION_WORDS[context.occasion];
  if (!occasionWords.some((word) => text.toLowerCase().includes(word))) {
    problems.push(
      `the rationale does not name the occasion (${occasionWords.join(" or ")})`,
    );
  }

  const paletteNames =
    context.palette === null
      ? []
      : [
          context.palette.seasonDisplayName,
          ...context.palette.wear.map((color) => color.name),
          ...context.palette.avoid.map((color) => color.name),
        ];
  const namesColoring =
    paletteNames.some((name) => text.toLowerCase().includes(name.toLowerCase())) ||
    COLORING_WORDS.some((word) =>
      word.includes(" ")
        ? text.toLowerCase().includes(word)
        : containsWord(text, word),
    );
  if (!namesColoring) {
    problems.push(
      "the rationale does not reference the person's coloring, by a palette color, a season, or a word about their skin",
    );
  }

  if (/\d/u.test(text)) {
    problems.push("the rationale contains a number");
  }
  if (text.includes("%")) {
    problems.push("the rationale contains a percentage");
  }

  for (const word of SUPERLATIVES) {
    if (
      word.includes(" ") ? text.toLowerCase().includes(word) : containsWord(text, word)
    ) {
      problems.push(`the rationale contains the superlative "${word}"`);
    }
  }

  return problems;
}

/** True when a rationale passes every hard check. */
export function isRationaleAcceptable(
  rationale: string,
  context: RationaleContext,
): boolean {
  return checkRationale(rationale, context).length === 0;
}
