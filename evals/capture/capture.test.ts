import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/** The jobs layer is server only; nothing here calls a provider or a database. */
vi.mock("server-only", () => ({}));

import { messageForTaskFailure } from "@/lib/server/jobs";
import {
  ANALYSIS_FAILURE_REASONS,
  analysisFailureReasonFor,
  isRetakeFailure,
} from "@/lib/shared/analysis-failure";
import { analysisFailureCopy, captureRejectionCopy, copy } from "@/lib/shared/copy";
import {
  CAPTURE_REASON_PRECEDENCE,
  FACE_COVERAGE_BORDERLINE_MIN,
  FACE_COVERAGE_MIN,
  SHARPNESS_BORDERLINE_BELOW,
  assessCapture,
  autoCropBoxFor,
  cropToBox,
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
  width: number = FRAME.width,
  height: number = FRAME.height,
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

  /**
   * Softness is flagged and never refused, which is a policy and not a
   * threshold. The engine's own input gate reads the frame for free and is the
   * authority on whether it is sharp enough; ours guesses from a canvas. When
   * they disagreed on a real phone the person had no way through at all
   * (Samsung S26 Ultra, indoors at night, 2026-09-03), so the disagreement is
   * now settled in the person's favour and the engine gets to answer.
   */
  it("offers a soft frame rather than refusing it, at any sharpness", () => {
    for (const contrast of [0, 1, 2, 4]) {
      const soft = image((x, y) =>
        (x + y) % 2 === 0 ? 128 - contrast / 2 : 128 + contrast / 2,
      );
      const result = assessCapture({
        image: soft,
        faceCount: 1,
        faceBox: GOOD_FACE_BOX,
      });
      expect(result.verdict).not.toBe("reject");
      if (result.metrics.sharpness < SHARPNESS_BORDERLINE_BELOW) {
        expect(result.verdict).toBe("borderline");
        expect(result.reason).toBe("blurry");
        expect(result.canUseAnyway).toBe(true);
      }
    }
  });

  it("puts the flattest frame there is on borderline, not on reject", () => {
    const result = assessCapture({
      image: blurryFrame,
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.metrics.sharpness).toBe(0);
    expect(result.verdict).toBe("borderline");
    expect(result.reason).toBe("blurry");
    expect(result.canUseAnyway).toBe(true);
  });

  it("keeps reject for the frames a credit cannot survive, and no others", () => {
    for (const entry of bad) {
      const result = assessCapture(entry.input);
      expect(result.verdict).toBe("reject");
      for (const failure of result.failures) {
        expect(failure.reason === "blurry" ? failure.severity : "borderline").toBe(
          "borderline",
        );
      }
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

/* ------------------------------------------------------------------ */
/* The framing the upload path composes for itself                     */
/* ------------------------------------------------------------------ */

/**
 * The camera path has an oval to aim at. The upload path has a photo that was
 * already taken, and a phone gallery selfie carries the face at 30 to 50 percent
 * of the frame height when the analyzers want more than 60. On 2026-09-02 one
 * was sent as it came and the engine answered error_src_face_too_small.
 *
 * autoCropBoxFor is what the upload path does about it. This block runs the same
 * photo through the gate twice, before and after the crop, on the same synthetic
 * frames the rest of the suite uses.
 */
describe("eval:capture, auto framing an uploaded photo", () => {
  const GALLERY = { width: 300, height: 400 } as const;

  /** Sharp and evenly lit, at the shape and size a phone photo comes in. */
  const galleryFrame = image(
    (x, y) => [64, 128, 192][(x + y) % 3] ?? 128,
    GALLERY.width,
    GALLERY.height,
  );

  /** A face filling this share of the frame height, centered. */
  function galleryFace(coverage: number): Box {
    const height = Math.round(GALLERY.height * coverage);
    const width = Math.round(height * 0.72);
    return {
      x: Math.round((GALLERY.width - width) / 2),
      y: Math.round((GALLERY.height - height) / 2),
      width,
      height,
    };
  }

  /** The crop, and the face box in the cropped frame's own pixels. */
  function compose(faceBox: Box): {
    readonly image: GrayscaleImage;
    readonly faceBox: Box;
  } {
    const crop = autoCropBoxFor({ faceBox, frame: GALLERY });
    if (crop === null) {
      throw new Error("Expected a crop for a face under the framing rule.");
    }
    return {
      image: cropToBox(galleryFrame, crop),
      faceBox: {
        x: faceBox.x - crop.x,
        y: faceBox.y - crop.y,
        width: faceBox.width,
        height: faceBox.height,
      },
    };
  }

  const GALLERY_COVERAGES = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55] as const;

  it.each(GALLERY_COVERAGES)(
    "refuses a face at %s of the frame height as it came",
    (coverage) => {
      const result = assessCapture({
        image: galleryFrame,
        faceCount: 1,
        faceBox: galleryFace(coverage),
      });
      expect(result.verdict).not.toBe("accept");
      expect(result.reason).toBe("too_far");
    },
  );

  it.each(GALLERY_COVERAGES)(
    "accepts the same photo at %s once it is composed around the face",
    (coverage) => {
      const composed = compose(galleryFace(coverage));
      const result = assessCapture({
        image: composed.image,
        faceCount: 1,
        faceBox: composed.faceBox,
      });
      expect(result.verdict).toBe("accept");
      expect(result.reason).toBeNull();
      expect(result.metrics.faceCoverage).toBeGreaterThanOrEqual(
        FACE_COVERAGE_MIN,
      );
    },
  );

  it("leaves a photo that was already framed well enough alone", () => {
    for (const coverage of [FACE_COVERAGE_MIN, 0.7, 0.9]) {
      expect(
        autoCropBoxFor({ faceBox: galleryFace(coverage), frame: GALLERY }),
      ).toBeNull();
    }
  });

  it("has nothing to offer a photo with no face, which stays a refusal", () => {
    expect(autoCropBoxFor({ faceBox: null, frame: GALLERY })).toBeNull();
    const result = assessCapture({
      image: galleryFrame,
      faceCount: 0,
      faceBox: null,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("no_face");
    expect(result.canUseAnyway).toBe(false);
  });

  it("keeps the crop inside the picture and portrait", () => {
    for (const coverage of GALLERY_COVERAGES) {
      const faceBox = galleryFace(coverage);
      const crop = autoCropBoxFor({ faceBox, frame: GALLERY });
      expect(crop).not.toBeNull();
      const box = crop as Box;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(GALLERY.width);
      expect(box.y + box.height).toBeLessThanOrEqual(GALLERY.height);
      expect(box.width).toBeLessThanOrEqual(box.height);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The gate the provider runs after ours                               */
/* ------------------------------------------------------------------ */

/**
 * Our gate is not the only one. The engine runs its own checks on the frame we
 * send and refuses the reading with a code, and on 2026-09-02 it refused three
 * ways: error_face_angle_rightward and error_face_not_forward_facing from the
 * skin tone analysis, which checks the face angle strictly, and error_no_face.
 *
 * A refused task costs nothing, so the only thing at stake is what the person
 * is told. This block holds the jobs layer to the same words the capture screen
 * uses for the same two problems.
 */
describe("eval:capture, what the engine's own refusal says", () => {
  const LIVE_REFUSALS = [
    { code: "error_face_angle_rightward", line: copy.capture.facingAway },
    { code: "error_face_not_forward_facing", line: copy.capture.facingAway },
    { code: "error_no_face", line: copy.capture.rejection.no_face },
    // Read off a gallery upload. The auto framing above is what stops it being
    // reached; this holds the line it lands on when the framing cannot help.
    { code: "error_src_face_too_small", line: copy.errors.readingRefused },
  ] as const;

  it("answers each live code with the capture screen's own line", () => {
    for (const refusal of LIVE_REFUSALS) {
      expect(messageForTaskFailure(refusal.code)).toBe(refusal.line);
    }
  });

  it("routes the jobs layer through the shared mapping and nothing else", () => {
    for (const code of [
      ...LIVE_REFUSALS.map((refusal) => refusal.code),
      "error_image_resolution_too_low",
      "InternalError",
      "",
    ]) {
      expect(messageForTaskFailure(code)).toBe(
        analysisFailureCopy(analysisFailureReasonFor(code)),
      );
    }
  });

  it("says something the person can act on, never a provider code", () => {
    for (const refusal of LIVE_REFUSALS) {
      const line = messageForTaskFailure(refusal.code);
      expect(line).not.toContain("error_");
      expect(line).not.toContain("_");
      expect(line.toLowerCase()).toContain("again");
    }
  });

  it("falls back to the refusal line rather than blaming a good photo", () => {
    expect(messageForTaskFailure(null)).toBe(copy.errors.readingRefused);
    expect(messageForTaskFailure("InternalError")).toBe(copy.errors.readingRefused);
  });

  it("marks the photo reasons as worth a retake and the provider one as not", () => {
    const retakeable = ANALYSIS_FAILURE_REASONS.filter(isRetakeFailure);
    expect(retakeable).toEqual(["face_angle", "no_face", "frame"]);
  });

  it("keeps every line free of a dash of either kind", () => {
    for (const reason of ANALYSIS_FAILURE_REASONS) {
      expect(analysisFailureCopy(reason)).not.toMatch(/[\u2013\u2014]/u);
    }
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
