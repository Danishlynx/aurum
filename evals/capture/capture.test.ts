import { describe, it } from "vitest";

/**
 * eval:capture, deterministic, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:capture.
 * Placeholder from Layer 0. The assertions land with the capture quality gate.
 */
describe("eval:capture", () => {
  it.todo(
    "rejects every image in evals/fixtures/captures-bad (blurry, dark, over exposed, off center, partial face, no face, photo of a printed photo)",
  );

  it.todo(
    "accepts every good window light fixture face in evals/fixtures/faces",
  );

  it.todo(
    "flags at most one warm indoor light fixture face as borderline rather than rejecting it",
  );

  it.todo("rejects a frame containing more than one face");
});
