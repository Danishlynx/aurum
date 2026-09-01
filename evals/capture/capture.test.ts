import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { captureRejectionCopy } from "@/lib/shared/copy";
import {
  CAPTURE_REASON_PRECEDENCE,
  FACE_COVERAGE_BORDERLINE_MIN,
  FACE_COVERAGE_MIN,
  assessCapture,
  type Box,
  type CaptureRejectionReason,
  type GrayscaleImage,
} from "@/lib/shared/quality";

/**
 * eval:capture, deterministic, runs on every PR.
 * Spec: docs/05-evals.md, suite eval:capture.
 *
 * The suite has two halves.
 *
 * The half that runs now exercises the pure gate in src/lib/shared/quality.ts
 * against synthetic images, one per failure category in
 * evals/fixtures/captures-bad. Synthetic data is enough to prove the decision
 * logic, the reason precedence, and the accept and borderline boundaries. It is
 * not enough to prove the thresholds, which are numbers about real photographs.
 *
 * The half left as it.todo is the fixture half: the consented selfies and bad
 * captures the human has to add, listed in evals/fixtures/README.md. Those
 * tests carry the precision and recall thresholds from docs/05-evals.md and
 * they are what calibrates the constants in quality.ts.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = resolve(REPO_ROOT, "evals", "fixtures");

const FRAME = { width: 120, height: 120 } as const;
/** 72 of 120 is 60 percent of the frame height, exactly the rule. */
const GOOD_FACE_BOX: Box = { x: 30, y: 24, width: 60, height: 72 };

function image(
  pixel: (x: number, y: number) => number,
  width = FRAME.width,
  height = FRAME.height,
): GrayscaleImage {
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = Math.max(0, Math.min(255, Math.round(pixel(x, y))));
    }
  }
  return { data, width, height };
}

/** Sharp and evenly lit. The stand in for a good window light capture. */
const goodFrame = image((x, y) => [64, 128, 192][(x + y) % 3] ?? 128);

/** Same structure, every value pulled down to the bottom of the range. */
const darkFrame = image((x, y) => ([3, 6, 9][(x + y) % 3] ?? 6));

/** Same structure, every value pushed to the top of the range. */
const blownFrame = image((x, y) => ([250, 252, 255][(x + y) % 3] ?? 252));

/** No local contrast at all, which is what motion blur converges to. */
const blurryFrame = image(() => 128);

const bad: readonly {
  readonly name: string;
  readonly input: Parameters<typeof assessCapture>[0];
  readonly reason: CaptureRejectionReason;
}[] = [
  {
    name: "no face",
    input: { image: goodFrame, faceCount: 0, faceBox: null },
    reason: "no_face",
  },
  {
    name: "two faces in the frame",
    input: { image: goodFrame, faceCount: 2, faceBox: GOOD_FACE_BOX },
    reason: "multiple_faces",
  },
  {
    name: "too dark",
    input: { image: darkFrame, faceCount: 1, faceBox: GOOD_FACE_BOX },
    reason: "too_dark",
  },
  {
    name: "over exposed",
    input: { image: blownFrame, faceCount: 1, faceBox: GOOD_FACE_BOX },
    reason: "over_exposed",
  },
  {
    name: "blurry",
    input: { image: blurryFrame, faceCount: 1, faceBox: GOOD_FACE_BOX },
    reason: "blurry",
  },
  {
    name: "face far too small in the frame",
    input: {
      image: goodFrame,
      faceCount: 1,
      faceBox: { x: 45, y: 45, width: 24, height: 30 },
    },
    reason: "too_far",
  },
];

describe("eval:capture, gate logic on synthetic frames", () => {
  it("accepts a sharp, evenly lit frame with the face at the 60 percent rule", () => {
    const result = assessCapture({
      image: goodFrame,
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("accept");
    expect(result.reason).toBeNull();
  });

  it.each(bad)("rejects $name with the reason $reason", ({ input, reason }) => {
    const result = assessCapture(input);
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe(reason);
  });

  it("never offers use it anyway on a rejected frame", () => {
    for (const entry of bad) {
      expect(assessCapture(entry.input).canUseAnyway).toBe(false);
    }
  });

  it("never offers use it anyway when face detection failed", () => {
    for (const faceCount of [0, 2, 3]) {
      const result = assessCapture({
        image: goodFrame,
        faceCount,
        faceBox: faceCount === 0 ? null : GOOD_FACE_BOX,
      });
      expect(result.canUseAnyway).toBe(false);
    }
  });

  it("offers use it anyway on a frame that is only slightly under the framing rule", () => {
    const height = Math.round(
      FRAME.height * ((FACE_COVERAGE_MIN + FACE_COVERAGE_BORDERLINE_MIN) / 2),
    );
    const result = assessCapture({
      image: goodFrame,
      faceCount: 1,
      faceBox: { x: 30, y: 20, width: 60, height },
    });
    expect(result.verdict).toBe("borderline");
    expect(result.reason).toBe("too_far");
    expect(result.canUseAnyway).toBe(true);
  });

  it("gives every reason it can return a line of copy from docs/01-user-flow.md", () => {
    for (const reason of CAPTURE_REASON_PRECEDENCE) {
      expect(captureRejectionCopy(reason).length).toBeGreaterThan(0);
    }
  });

  it("is stable: the same frame always gets the same verdict", () => {
    const once = assessCapture({
      image: goodFrame,
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    const twice = assessCapture({
      image: goodFrame,
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(twice).toEqual(once);
  });
});

describe("eval:capture, fixture contract", () => {
  it("documents which consented photos the human has to add", () => {
    expect(existsSync(resolve(FIXTURES, "README.md"))).toBe(true);
  });

  /*
   * These land when evals/fixtures/faces and evals/fixtures/captures-bad have
   * real photos in them. See docs/05-evals.md, "Fixtures" and suite
   * eval:capture, and evals/fixtures/README.md for what to add and where.
   * They also replace the PROVISIONAL threshold constants in
   * src/lib/shared/quality.ts with calibrated ones.
   */
  it.todo(
    "rejects every image in evals/fixtures/captures-bad (blurry, dark, over exposed, off center, partial face, no face, and a photo of a printed photo)",
  );

  it.todo(
    "accepts every good window light fixture face in evals/fixtures/faces",
  );

  it.todo(
    "flags at most one warm indoor light fixture face as borderline rather than rejecting it",
  );

  it.todo(
    "rejects a frame containing more than one face, using the real detector rather than a passed in face count",
  );

  it.todo(
    "writes precision and recall of accept to evals/results/capture-<git sha>.json",
  );
});
