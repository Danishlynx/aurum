import { describe, it } from "vitest";

/**
 * eval:palette, deterministic, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:palette.
 * Placeholder from Layer 0. The assertions land with src/lib/shared/palette.ts.
 */
describe("eval:palette", () => {
  it.todo(
    "maps season from skin tone, undertone, eye color, and hair color for the three fixture profiles",
  );

  it.todo(
    "matches the golden wear and avoid lists in evals/fixtures/profiles",
  );

  it.todo("gives every palette 8 to 12 wear colors and 4 to 6 avoid colors");

  it.todo("never places the same color in both the wear list and the avoid list");

  it.todo(
    "moves the palette to the corresponding season family when the undertone flips",
  );
});
