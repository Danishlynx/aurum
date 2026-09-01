/**
 * The banned lexicon from docs/06-safety-privacy.md, as data plus a checker.
 *
 * Two things use this module:
 *   1. eval:safety, which runs it over every string in copy.ts.
 *   2. The synthesis, stylist, and classifier layers, which run it over every
 *      generated output before storage. A failing output is regenerated once
 *      with the violations listed, then falls back to the deterministic text.
 *
 * Cosmetic, never medical. The app describes surface condition and suggests
 * routines. It never diagnoses.
 */

export type LexiconCategory = "disease" | "judgment" | "hype";

export type BannedTerm = {
  /** The term as written in docs/06-safety-privacy.md. */
  readonly term: string;
  readonly category: LexiconCategory;
  /** Why it is banned, or the caveat the doc attaches to it. */
  readonly note?: string;
};

/**
 * Disease and diagnosis words, judgment words, and hype words.
 * Source: docs/06-safety-privacy.md, "Banned lexicon", except "glow", which
 * docs/02-design-system.md "Writing inside the design" bans on its own.
 */
export const BANNED_TERMS: readonly BannedTerm[] = [
  // Disease and diagnosis.
  { term: "diagnose", category: "disease" },
  { term: "diagnosis", category: "disease" },
  { term: "disease", category: "disease" },
  { term: "disorder", category: "disease" },
  {
    term: "condition",
    category: "disease",
    note: "Banned as a noun about the person. See LEXICON_KNOWN_LIMITATIONS.",
  },
  { term: "infection", category: "disease" },
  { term: "cancer", category: "disease" },
  { term: "melanoma", category: "disease" },
  { term: "carcinoma", category: "disease" },
  { term: "eczema", category: "disease" },
  { term: "psoriasis", category: "disease" },
  { term: "rosacea", category: "disease" },
  { term: "dermatitis", category: "disease" },
  { term: "lesion", category: "disease" },
  { term: "tumor", category: "disease" },
  { term: "malignant", category: "disease" },
  { term: "benign", category: "disease" },
  { term: "symptom", category: "disease" },
  { term: "treat", category: "disease", note: "Use care or routine." },
  { term: "treatment", category: "disease", note: "Use care or routine." },
  { term: "cure", category: "disease" },
  { term: "heal", category: "disease" },
  { term: "clinical", category: "disease" },
  { term: "prescription", category: "disease" },
  {
    term: "dermatologist recommended",
    category: "disease",
    note: "The single word dermatologist is allowed in the escalation line.",
  },

  // Judgment.
  { term: "flawless", category: "judgment" },
  {
    term: "perfect",
    category: "judgment",
    note: "Perfect Corp is a company name and is allowed. See ALLOWED_PHRASES.",
  },
  { term: "ugly", category: "judgment" },
  { term: "bad skin", category: "judgment" },
  { term: "fix your face", category: "judgment" },
  { term: "problem area", category: "judgment", note: "Use concern." },

  // Hype.
  { term: "amazing", category: "hype" },
  { term: "glow up", category: "hype" },
  {
    term: "glow",
    category: "hype",
    note: "Banned on its own by docs/02-design-system.md.",
  },
  { term: "transform", category: "hype" },
  { term: "unlock", category: "hype" },
  { term: "elevate", category: "hype" },
  { term: "journey", category: "hype" },
  { term: "magic", category: "hype" },
];

/**
 * Proper nouns that contain a banned term and are still allowed. They are
 * masked out of the text before the term scan, so "Perfect Corp" never trips
 * the judgment word "perfect" while "a perfect result" still does.
 */
export const ALLOWED_PHRASES: readonly string[] = [
  "Perfect Corp",
  "PerfectCorp",
];

/**
 * En dash, U+2013. Built from its code point so the character itself never
 * appears in this repo, which is the rule this constant exists to enforce.
 */
export const EN_DASH = String.fromCharCode(0x2013);
/** Em dash, U+2014. Built from its code point for the same reason. */
export const EM_DASH = String.fromCharCode(0x2014);

/**
 * Required after every skin age figure. docs/06-safety-privacy.md,
 * "Required framing". Also stored in copy.report.skinAgeFraming; this is the
 * constant the eval asserts against so the requirement has one owner.
 */
export const REQUIRED_SKIN_AGE_FRAMING =
  "This is a cosmetic estimate of surface condition, not a health measure.";

/**
 * Required once on the report whenever a redness or blemish concern is shown.
 * docs/06-safety-privacy.md, "Required framing".
 */
export const REQUIRED_SENSITIVE_CONCERN_LINE =
  "If something on your skin is painful, spreading, or worrying you, a dermatologist is the right person to ask.";

export type LexiconViolationKind =
  | "banned_term"
  | "exclamation_mark"
  | "em_dash"
  | "en_dash";

export type LexiconViolation = {
  readonly kind: LexiconViolationKind;
  /** The exact text that matched. */
  readonly match: string;
  /** The term from BANNED_TERMS that produced the match, for a term hit. */
  readonly term?: string;
  readonly category?: LexiconCategory;
  /** Character offset into the original text. */
  readonly index: number;
};

/**
 * Known limitations of this checker. They are limitations of a word list, not
 * bugs to be silently patched. Anything the list cannot decide is handled by an
 * explicit entry in SAFETY_COPY_EXEMPTIONS with a written reason.
 */
export const LEXICON_KNOWN_LIMITATIONS: readonly string[] = [
  'docs/06-safety-privacy.md bans "condition" only as a noun about the person. This is a word list, so it cannot read grammar or reference. It flags every occurrence, including the allowed "surface condition" in the required skin age framing. Allowed uses go in SAFETY_COPY_EXEMPTIONS with a written reason.',
  'Inflections are matched with a fixed suffix set (s, es, ed, ing, d). Forms outside that set, for example "transformative" or "diagnostic", are not caught. Add the form to BANNED_TERMS when one appears.',
  'The scan is literal. It does not catch a medical claim written in ordinary words, for example "this will get rid of it". The synthesis prompt and the eval:synthesis rubric cover that; the word list does not.',
];

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * A term matches on a word boundary, allows one of a small set of inflections,
 * and treats a space inside a phrase as any run of whitespace.
 */
function buildTermPattern(term: string): RegExp {
  const body = term.split(/\s+/u).map(escapeForRegex).join("\\s+");
  return new RegExp(`\\b${body}(?:s|es|ed|ing|d)?\\b`, "giu");
}

const TERM_PATTERNS: readonly (readonly [BannedTerm, RegExp])[] =
  BANNED_TERMS.map((entry) => [entry, buildTermPattern(entry.term)] as const);

/** U+0000. Not a word character and not whitespace, which is why it is used. */
const MASK_CHAR = String.fromCharCode(0);

/**
 * Replaces every allowed phrase with mask characters of the same length, so the
 * term scan cannot see it while every other offset stays correct. The mask
 * character is neither a word character nor whitespace, so a masked phrase can
 * neither match a term nor join two words into a banned two word phrase.
 */
function maskAllowedPhrases(text: string): string {
  let masked = text;
  for (const phrase of ALLOWED_PHRASES) {
    const pattern = new RegExp(escapeForRegex(phrase), "giu");
    masked = masked.replace(pattern, (found) => MASK_CHAR.repeat(found.length));
  }
  return masked;
}

/** Exclamation mark, en dash, em dash. Built at runtime, never written out. */
const PUNCTUATION_PATTERN = new RegExp(`[!${EN_DASH}${EM_DASH}]`, "gu");

/**
 * Scans a string for banned terms, exclamation marks, em dashes, and en dashes.
 * Returns every violation, in order of appearance, with its offset. An empty
 * array means the string is clean.
 */
export function checkLexicon(text: string): LexiconViolation[] {
  const violations: LexiconViolation[] = [];
  const masked = maskAllowedPhrases(text);

  for (const [entry, pattern] of TERM_PATTERNS) {
    pattern.lastIndex = 0;
    let found = pattern.exec(masked);
    while (found !== null) {
      violations.push({
        kind: "banned_term",
        match: found[0],
        term: entry.term,
        category: entry.category,
        index: found.index,
      });
      found = pattern.exec(masked);
    }
  }

  PUNCTUATION_PATTERN.lastIndex = 0;
  let mark = PUNCTUATION_PATTERN.exec(text);
  while (mark !== null) {
    let kind: LexiconViolationKind = "exclamation_mark";
    if (mark[0] === EM_DASH) {
      kind = "em_dash";
    } else if (mark[0] === EN_DASH) {
      kind = "en_dash";
    }
    violations.push({ kind, match: mark[0], index: mark.index });
    mark = PUNCTUATION_PATTERN.exec(text);
  }

  return violations.sort((a, b) => a.index - b.index);
}

/** True when the string has no banned term and no banned punctuation. */
export function isLexiconClean(text: string): boolean {
  return checkLexicon(text).length === 0;
}

export type LexiconExemption = {
  /** The exact string, so the exemption cannot spread to other copy. */
  readonly text: string;
  /** The BANNED_TERMS entries this string is allowed to contain. */
  readonly allowedTerms: readonly string[];
  readonly reason: string;
};

/**
 * The only strings allowed to contain a banned term, each with the term it may
 * contain and why. Both entries are sentences the docs require or quote
 * verbatim, and both use the term as an explicit negation or as a description
 * of a surface, never as a claim about the person.
 *
 * Adding an entry here is a decision about safety copy. Do it only with the
 * human, and only for a string quoted from a doc.
 */
export const SAFETY_COPY_EXEMPTIONS: readonly LexiconExemption[] = [
  {
    text: "We never diagnose anything. We never share your photo. We never process anyone's face but yours.",
    allowedTerms: ["diagnose"],
    reason:
      'The consent screen promise, quoted from docs/01-user-flow.md section C. The word appears inside "We never diagnose anything", which is the safety statement itself.',
  },
  {
    text: REQUIRED_SKIN_AGE_FRAMING,
    allowedTerms: ["condition"],
    reason:
      'The framing sentence docs/06-safety-privacy.md requires after every skin age. "Surface condition" describes the skin surface, not the person, which is the use the doc allows.',
  },
];

/**
 * The lexicon check for a copy string. Same as checkLexicon, with the
 * violations covered by an exemption removed. Punctuation violations are never
 * exempt.
 */
export function checkCopyString(text: string): LexiconViolation[] {
  const exemption = SAFETY_COPY_EXEMPTIONS.find((entry) => entry.text === text);
  const violations = checkLexicon(text);
  if (exemption === undefined) {
    return violations;
  }
  return violations.filter(
    (violation) =>
      violation.kind !== "banned_term" ||
      violation.term === undefined ||
      !exemption.allowedTerms.includes(violation.term),
  );
}

/** A one line description of a violation, for a prompt or a test failure. */
export function describeViolation(violation: LexiconViolation): string {
  switch (violation.kind) {
    case "banned_term":
      return `banned ${violation.category ?? "unknown"} term "${
        violation.term ?? violation.match
      }" at index ${violation.index}`;
    case "exclamation_mark":
      return `exclamation mark at index ${violation.index}`;
    case "em_dash":
      return `em dash at index ${violation.index}`;
    case "en_dash":
      return `en dash at index ${violation.index}`;
  }
}
