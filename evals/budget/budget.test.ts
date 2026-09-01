import { describe, it } from "vitest";

/**
 * eval:budget, deterministic plus recorded timings, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:budget.
 * Placeholder from Layer 0. Depends on the credit table in docs/04-integrations.md.
 */
describe("eval:budget", () => {
  it.todo(
    "keeps a simulated session (the capture set plus 6 renders) under the per session credit budget",
  );

  it.todo(
    "leaves JUDGE_CREDITS_CAP enough headroom for 3 sessions plus 20 percent",
  );

  it.todo(
    "reports p50 and p95 time from capture accept to report render, warning above 45 and 90 seconds",
  );
});
