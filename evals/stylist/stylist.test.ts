import { describe, it } from "vitest";

/**
 * eval:stylist, rules deterministic plus a recorded human preference signal.
 * Spec: docs/05-evals.md, suite eval:stylist.
 * Placeholder from Layer 0. The assertions land with src/lib/shared/looks.ts.
 */
describe("eval:stylist", () => {
  it.todo(
    "never puts a garment from the avoid list next to the face as the hero piece",
  );

  it.todo(
    "allows an avoid color below the waist only when the rationale explains it",
  );

  it.todo("matches formality to the occasion for all six occasions");

  it.todo("rejects two busy patterns placed next to each other");

  it.todo(
    "keeps every rationale to 2 sentences that name the occasion and the coloring, with no numbers and no superlatives",
  );

  it.todo(
    "records the human preference picks in evals/results as a signal, not as a gate",
  );
});
