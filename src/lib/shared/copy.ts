/**
 * Every string the person reads lives here, quoted from docs/01-user-flow.md.
 * Components never hold inline strings. Voice rules: sentence case, plain verbs,
 * no exclamation marks, no em dashes or en dashes, cosmetic never medical.
 *
 * Layer 0 seeds only the strings the scaffold renders. Later layers add their
 * screens here, quoting the flow doc verbatim rather than paraphrasing it.
 */

export const copy = {
  product: {
    name: "AURUM",
    tagline: "One selfie. Every decision.",
  },
  landing: {
    headline: "One selfie. Every decision.",
    subhead:
      "Skin, color, makeup, hair, and what to wear, from a profile that knows you. Every product is a real listing you can buy.",
    primaryAction: "Start with a selfie",
    secondaryLink: "Watch the 2 minute demo",
    judgeFooter: "Judging this build? Enter your access code",
  },
} as const;

export type Copy = typeof copy;
