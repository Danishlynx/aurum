import { describe, it } from "vitest";

/**
 * eval:consistency, spends provider credits, runs on demand and before submission.
 * Spec: docs/05-evals.md, suite eval:consistency.
 * Placeholder from Layer 0. Never wire this into eval:smoke.
 */
describe("eval:consistency", () => {
  it.todo(
    "median absolute score difference for the top three concerns across the two lighting conditions stays under 12 points",
  );

  it.todo("undertone agrees across lighting on at least 10 of 12 fixture faces");

  it.todo("Fitzpatrick agrees within one step on every fixture face");

  it.todo("reports per face results into evals/results for the PR summary");
});
