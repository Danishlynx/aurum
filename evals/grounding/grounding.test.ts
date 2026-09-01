import { describe, it } from "vitest";

/**
 * eval:grounding, deterministic over recorded SerpApi responses, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:grounding.
 * Placeholder from Layer 0.
 */
describe("eval:grounding", () => {
  it.todo("gives every displayed product a source URL and a price");

  it.todo("keeps every listing host out of the blocked aggregator list");

  it.todo(
    "shares at least one key token between the top listing title and the product query",
  );

  it.todo("shows no product at all when the recorded response is empty");
});
