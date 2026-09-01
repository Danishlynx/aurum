import { describe, it } from "vitest";

/**
 * eval:synthesis, hard checks plus a model judged rubric on a sample.
 * Spec: docs/05-evals.md, suite eval:synthesis.
 * Placeholder from Layer 0. Runs over recorded analyses, so it spends no
 * Perfect Corp credits, only the judge model call.
 */
describe("eval:synthesis", () => {
  it.todo("parses every reading against the structured output schema");

  it.todo("keeps every reading at 3 to 5 sentences and under 90 words");

  it.todo(
    "names the top concern display name and a location on the face in every reading",
  );

  it.todo(
    "contains no banned lexicon term, no exclamation mark, no em dash, no en dash, and no brand name",
  );

  it.todo(
    "scores at least 4.0 mean on the rubric with no fixture under 3 on any dimension",
  );

  it.todo(
    "mentions pigmentation or uneven tone before wrinkles for Fitzpatrick IV to VI fixtures when both are present",
  );
});
