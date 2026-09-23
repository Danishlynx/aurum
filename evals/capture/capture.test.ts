import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/** The jobs layer is server only; nothing here calls a provider or a database. */
vi.mock("server-only", () => ({}));

import { messageForTaskFailure } from "@/lib/server/jobs";
import {
  CAPTURE_OUTCOMES_EXPORT_COMMAND,
  CAPTURE_OUTCOMES_RELATIVE_PATH,
  OUTCOME_BUCKETS,
  OUTCOME_PICKERS,
  bucketRates,
  captureOutcomesFileSchema,
  engineOutcomeOf,
  precisionRecallOf,
  readCaptureOutcomes,
  refusalCodeCounts,
  refusalLines,
  type CaptureOutcomesFile,
  type OutcomeAnalysis,
  type OutcomeRow,
} from "../support/capture-outcomes";
import { toOutcomeRow } from "../../scripts/export-capture-outcomes";
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
 * The other half runs on exported outcome rows: what the client measured on
 * each first camera capture beside what the engine then did with it
 * (evals/support/capture-outcomes.ts, written by npm run calibration:export
 * into a gitignored private folder). It carries the precision and recall of
 * accept from docs/05-evals.md and it is what calibrates the constants in
 * quality.ts. On a machine without the export it skips and says so; the
 * arithmetic it runs is proved on synthetic rows either way.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = resolve(REPO_ROOT, "evals", "fixtures");

const FRAME = { width: 120, height: 120 } as const;
/**
 * A face that satisfies both framing rules at once, which since 2026-09-07 is
 * what "good" means.
 *
 * 72 of 120 is 60 percent of the frame height, exactly our own rule. 74 of 120
 * is 0.617 of the short axis, which clears the engine's own rule that the face
 * be wider than 60 percent of it (FACE_WIDTH_RATIO_MIN). The old box here was 60
 * wide, which is 0.5, and so described a frame this suite called good and the
 * engine would have refused with error_src_face_too_small.
 */
const GOOD_FACE_BOX: Box = { x: 23, y: 24, width: 74, height: 72 };

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
    /*
     * Under FACE_COVERAGE_REJECT_BELOW, which since 2026-09-14 is the only
     * height the gate refuses on: a face this small at sensor size is one no
     * crop can rescue without upscaling into a frame the engine refuses anyway.
     * 24 of 120 is a fifth of the frame. Everything between this and the
     * engine's width rule is the composition step's job, not a refusal.
     */
    name: "face far too small in the frame",
    input: {
      image: goodFrame,
      faceCount: 1,
      faceBox: { x: 48, y: 48, width: 20, height: 24 },
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
  /**
   * Softness decides nothing at the gate, since 2026-09-14. It was a borderline
   * before that, which is a review screen with Retake as the primary answer and
   * in practice a wall, held against a threshold set from synthetic patterns
   * that a smooth face could read under at any focus. The engine publishes no
   * blur code, the burst sends the sharpest of five frames, and the number is
   * still recorded in the metrics for calibration. So a soft frame is accepted
   * and the engine, whose input gate is free, judges it.
   */
  it("accepts a soft frame at any sharpness, and records the number", () => {
    for (const contrast of [0, 1, 2, 4]) {
      const soft = image((x, y) =>
        (x + y) % 2 === 0 ? 128 - contrast / 2 : 128 + contrast / 2,
      );
      const result = assessCapture({
        image: soft,
        faceCount: 1,
        faceBox: GOOD_FACE_BOX,
      });
      expect(result.verdict).toBe("accept");
      expect(
        result.failures.some((failure) => failure.reason === "blurry"),
      ).toBe(false);
      expect(Number.isFinite(result.metrics.sharpness)).toBe(true);
    }
  });

  it("accepts the flattest frame there is", () => {
    const result = assessCapture({
      image: blurryFrame,
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.metrics.sharpness).toBe(0);
    expect(result.verdict).toBe("accept");
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
    /*
     * "Well enough" now means both rules, so it starts higher than
     * FACE_COVERAGE_MIN. In this 3 by 4 frame a face of the 0.72 aspect this
     * helper draws reaches 0.60 of the short axis at about 0.63 of the frame
     * height, so a face at exactly our height rule is one the engine would still
     * have refused and is now composed rather than sent as it came.
     */
    for (const coverage of [0.65, 0.7, 0.9]) {
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
    // Since 2026-09-07 that line names the problem instead of blaming the
    // provider for a photograph whose face was simply small in it.
    { code: "error_src_face_too_small", line: copy.capture.faceSmallInPhoto },
    // The other spelling of the same refusal, which every endpoint but the skin
    // analyzer uses.
    {
      code: "error_face_position_too_small",
      line: copy.capture.faceSmallInPhoto,
    },
    // Both were reaching the generic provider line until 2026-09-07, and both
    // are things the person can act on.
    {
      code: "error_multiple_people",
      line: copy.capture.rejection.multiple_faces,
    },
    {
      code: "error_face_position_out_of_boundary",
      line: copy.capture.rejection.face_out_of_bounds,
    },
    { code: "error_lighting_dark", line: copy.capture.rejection.too_dark },
    {
      code: "error_insufficient_lighting",
      line: copy.capture.rejection.too_dark,
    },
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
    expect(retakeable).toEqual([
      "face_angle",
      "no_face",
      "multiple_faces",
      "face_too_small",
      "face_out_of_bounds",
      "lighting",
      "image_size",
      "frame",
    ]);
    // Exactly one reason is not about the photograph.
    expect(
      ANALYSIS_FAILURE_REASONS.filter((reason) => !isRetakeFailure(reason)),
    ).toEqual(["provider"]);
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
});

/* ------------------------------------------------------------------ */
/* The arithmetic of the fixture half, on synthetic rows               */
/* ------------------------------------------------------------------ */

/**
 * The rows below are shaped exactly as the export writes them, with numbers
 * chosen to make each rule visible. Nothing here is a real capture.
 */
function analysis(
  kind: OutcomeAnalysis["kind"],
  status: OutcomeAnalysis["status"],
  refusal: OutcomeAnalysis["refusal"] = null,
): OutcomeAnalysis {
  return {
    kind,
    status,
    ran: status !== "pending",
    refusal,
    faceQuality:
      status === "succeeded"
        ? { hasFace: true, area: "good", frontal: "good", lighting: "good", faceangle: "good" }
        : null,
    creditsUsed: status === "succeeded" ? 10 : 0,
  };
}

const ALL_SUCCEEDED: OutcomeAnalysis[] = [
  analysis("skin", "succeeded"),
  analysis("fitzpatrick", "succeeded"),
  analysis("attributes", "succeeded"),
  analysis("face_shape", "succeeded"),
  analysis("hair_type", "failed"),
];

const LEADER_REFUSED: OutcomeAnalysis[] = [
  analysis("skin", "failed", { reason: "face_angle", code: "error_face_angle_rightward", elapsedMs: 900 }),
  analysis("fitzpatrick", "failed", { reason: "face_angle", code: "error_face_angle_rightward", elapsedMs: 900 }),
  analysis("attributes", "failed", { reason: "face_angle", code: "error_face_angle_rightward", elapsedMs: 4200 }),
  analysis("face_shape", "failed", { reason: "face_angle", code: "error_face_angle_rightward", elapsedMs: 900 }),
  analysis("hair_type", "failed"),
];

const STILL_RUNNING: OutcomeAnalysis[] = [
  analysis("skin", "pending"),
  analysis("fitzpatrick", "pending"),
  analysis("attributes", "running"),
  analysis("face_shape", "pending"),
  analysis("hair_type", "failed"),
];

function row(
  verdict: OutcomeRow["quality"]["verdict"],
  analyses: OutcomeAnalysis[],
  pose: { yaw: number; pitch: number; roll: number } | null = { yaw: 2, pitch: -3, roll: 1 },
  extra: Partial<OutcomeRow["quality"]> = {},
): OutcomeRow {
  return {
    captureId: `synthetic-${verdict}-${String(analyses[0]?.status)}`,
    createdAt: "2026-09-23T10:00:00.000Z",
    quality: {
      verdict,
      reason: verdict === "accept" ? null : "facing_away",
      sharpness: 40,
      exposure: 120,
      face_coverage: 0.66,
      blown_fraction: 0,
      crushed_fraction: 0,
      mean_luminance: 120,
      face_width_ratio: 0.7,
      pose:
        pose === null
          ? null
          : { yaw_degrees: pose.yaw, pitch_degrees: pose.pitch, roll_degrees: pose.roll },
      face_source: "model",
      measured: true,
      platform: "ios",
      path: "camera",
      attempt: 1,
      face_luma: 0.58,
      blink: { left: 0.1, right: 0.2 },
      ...extra,
    },
    analyses,
  };
}

describe("eval:capture, the fixture half's arithmetic", () => {
  it("reads the engine's verdict on a frame from the four runnable kinds", () => {
    expect(engineOutcomeOf(row("accept", ALL_SUCCEEDED))).toBe("accepted");
    expect(engineOutcomeOf(row("accept", LEADER_REFUSED))).toBe("refused");
    expect(engineOutcomeOf(row("accept", STILL_RUNNING))).toBe("undetermined");
    // hair_type cannot run from one selfie, so its failure decides nothing.
    expect(
      engineOutcomeOf(
        row("accept", ALL_SUCCEEDED.map((entry) => (entry.kind === "hair_type" ? analysis("hair_type", "failed") : entry))),
      ),
    ).toBe("accepted");
  });

  it("treats a provider failure as no verdict on the frame", () => {
    const outage = [
      analysis("skin", "succeeded"),
      analysis("fitzpatrick", "failed", { reason: "provider", code: "InternalError", elapsedMs: 1 }),
      analysis("attributes", "succeeded"),
      analysis("face_shape", "succeeded"),
    ];
    expect(engineOutcomeOf(row("accept", outage))).toBe("undetermined");
  });

  it("computes precision and recall of accept against the engine", () => {
    const rows = [
      row("accept", ALL_SUCCEEDED),
      row("accept", ALL_SUCCEEDED),
      row("accept", ALL_SUCCEEDED),
      row("accept", LEADER_REFUSED, { yaw: 24, pitch: 0, roll: 0 }),
      row("borderline", ALL_SUCCEEDED, { yaw: 12, pitch: 0, roll: 0 }),
      row("borderline", LEADER_REFUSED, { yaw: 19, pitch: 0, roll: 0 }),
      row("accept", STILL_RUNNING),
    ];
    const result = precisionRecallOf(rows);
    // The open reading is not a verdict and is not counted either way.
    expect(result.n).toBe(6);
    expect(result.accepts).toBe(4);
    expect(result.accepted).toBe(4);
    expect(result.truePositives).toBe(3);
    expect(result.precision).toBeCloseTo(0.75, 6);
    expect(result.recall).toBeCloseTo(0.75, 6);
  });

  it("answers null rather than a division by zero when a side is empty", () => {
    expect(precisionRecallOf([])).toEqual({
      n: 0,
      accepts: 0,
      accepted: 0,
      truePositives: 0,
      precision: null,
      recall: null,
    });
    const onlyRefused = precisionRecallOf([row("borderline", LEADER_REFUSED)]);
    expect(onlyRefused.precision).toBeNull();
    expect(onlyRefused.recall).toBeNull();
  });

  it("buckets acceptance by |yaw| and leaves unmeasured rows out", () => {
    const rows = [
      row("accept", ALL_SUCCEEDED, { yaw: 2, pitch: 0, roll: 0 }),
      row("accept", ALL_SUCCEEDED, { yaw: -4, pitch: 0, roll: 0 }),
      row("accept", LEADER_REFUSED, { yaw: 12, pitch: 0, roll: 0 }),
      row("accept", ALL_SUCCEEDED, { yaw: 11, pitch: 0, roll: 0 }),
      row("accept", ALL_SUCCEEDED, null),
      row("accept", STILL_RUNNING, { yaw: 1, pitch: 0, roll: 0 }),
    ];
    const rates = bucketRates(rows, OUTCOME_PICKERS.absYaw, OUTCOME_BUCKETS.absYaw);
    expect(rates[0]).toEqual({ label: "0 to 5", n: 2, ok: 2, rate: 1 });
    const tens = rates.find((rate) => rate.label === "10 to 15");
    expect(tens).toEqual({ label: "10 to 15", n: 2, ok: 1, rate: 0.5 });
    const counted = rates.reduce((total, rate) => total + rate.n, 0);
    expect(counted).toBe(4);
  });

  it("keeps the pitch buckets signed, because the engine's own presets are", () => {
    const rates = bucketRates(
      [
        row("accept", ALL_SUCCEEDED, { yaw: 0, pitch: -12, roll: 0 }),
        row("accept", LEADER_REFUSED, { yaw: 0, pitch: 12, roll: 0 }),
      ],
      OUTCOME_PICKERS.pitch,
      OUTCOME_BUCKETS.pitch,
    );
    expect(rates.find((rate) => rate.label === "-20 to -10")?.ok).toBe(1);
    expect(rates.find((rate) => rate.label === "10 to 20")?.ok).toBe(0);
  });

  it("puts a value on the top edge into the last bucket", () => {
    const rates = bucketRates(
      [row("accept", ALL_SUCCEEDED, null, { face_width_ratio: 1 })],
      OUTCOME_PICKERS.faceWidthRatio,
      OUTCOME_BUCKETS.faceWidthRatio,
    );
    expect(rates[rates.length - 1]?.n).toBe(1);
  });

  it("lists every refusal with our numbers beside it", () => {
    const lines = refusalLines([
      row("accept", ALL_SUCCEEDED),
      row("borderline", LEADER_REFUSED, { yaw: 19, pitch: 2, roll: -1 }),
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      code: "error_face_angle_rightward",
      reason: "face_angle",
      verdict: "borderline",
      measured: true,
      yaw: 19,
      pitch: 2,
      roll: -1,
      faceWidthRatio: 0.7,
      faceLuma: 0.58,
      blinkMax: 0.2,
    });
    expect(refusalCodeCounts([row("borderline", LEADER_REFUSED)])).toEqual([
      { code: "error_face_angle_rightward", count: 4 },
    ]);
  });

  it("reduces a database row the way the export writes it", () => {
    const first = toOutcomeRow({
      id: "cap-1",
      created_at: "2026-09-23T09:00:00.000Z",
      quality: { verdict: "accept", path: "camera", attempt: 1, face_width_ratio: 0.7 },
      analyses: [
        {
          kind: "attributes",
          status: "succeeded",
          provider_task_id: "pc-1",
          raw: { color: { skin_color: "#997357" }, face_quality: { has_face: true, faceangle: "good" } },
          credits_used: 20,
        },
        {
          kind: "skin",
          status: "failed",
          provider_task_id: null,
          raw: { refusal: { reason: "face_angle", code: "error_face_angle_rightward", elapsed_ms: 1200 } },
          credits_used: 0,
        },
      ],
    });
    expect("row" in first).toBe(true);
    if ("row" in first) {
      expect(first.row.analyses[0]).toEqual({
        kind: "attributes",
        status: "succeeded",
        ran: true,
        refusal: null,
        faceQuality: { hasFace: true, area: null, frontal: null, lighting: null, faceangle: "good" },
        creditsUsed: 20,
      });
      expect(first.row.analyses[1]).toMatchObject({
        ran: false,
        refusal: { reason: "face_angle", code: "error_face_angle_rightward", elapsedMs: 1200 },
        faceQuality: null,
      });
    }

    // A gallery upload, a reframe, an unreadable row and an outage are left out.
    expect(
      toOutcomeRow({
        id: "cap-2",
        created_at: "x",
        quality: { verdict: "accept", path: "gallery", attempt: 1 },
        analyses: [],
      }),
    ).toEqual({ skipped: "not_first_camera" });
    expect(
      toOutcomeRow({
        id: "cap-3",
        created_at: "x",
        quality: { verdict: "accept", path: "reframe", attempt: 2 },
        analyses: [],
      }),
    ).toEqual({ skipped: "not_first_camera" });
    expect(
      toOutcomeRow({ id: "cap-4", created_at: "x", quality: null, analyses: [] }),
    ).toEqual({ skipped: "unreadable_quality" });
    expect(
      toOutcomeRow({
        id: "cap-5",
        created_at: "x",
        quality: { verdict: "accept", path: "camera", attempt: 1 },
        analyses: [
          {
            kind: "skin",
            status: "failed",
            provider_task_id: "pc-2",
            raw: { refusal: { reason: "provider", code: "InternalError" } },
            credits_used: 0,
          },
        ],
      }),
    ).toEqual({ skipped: "provider" });
  });

  it("refuses a malformed export loudly", () => {
    const good: CaptureOutcomesFile = {
      format: "aurum.capture-outcomes.v1",
      exportedAt: "2026-09-23T10:00:00.000Z",
      filter: { path: "camera", attempt: 1, excludedProviderFailures: 0 },
      rows: [row("accept", ALL_SUCCEEDED)],
    };
    expect(captureOutcomesFileSchema.safeParse(good).success).toBe(true);
    expect(
      captureOutcomesFileSchema.safeParse({ ...good, format: "something-else" }).success,
    ).toBe(false);
    expect(
      captureOutcomesFileSchema.safeParse({
        ...good,
        rows: [{ ...good.rows[0], quality: { verdict: "maybe" } }],
      }).success,
    ).toBe(false);
    expect(
      captureOutcomesFileSchema.safeParse({
        ...good,
        filter: { path: "gallery", attempt: 1, excludedProviderFailures: 0 },
      }).success,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The fixture half, on the exported rows                              */
/* ------------------------------------------------------------------ */

/**
 * docs/05-evals.md, eval:capture: precision and recall of "accept", measured on
 * the rows the export wrote. The threshold on precision is asserted only once
 * there are at least a hundred decided rows, because a rate over fewer than
 * that is a rumour: zero failures in 30 says nothing that would move a
 * threshold. Below that it is reported and written to evals/results, which is
 * what a PR attaches.
 */
const PRECISION_THRESHOLD = 0.97;
const ROWS_BEFORE_ASSERTING = 100;

/** Loaded once; a malformed file throws here, which fails the suite loudly. */
const exported: CaptureOutcomesFile | null = readCaptureOutcomes();

function shortGitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

if (exported === null) {
  console.log(
    `eval:capture: the fixture half skipped. No ${CAPTURE_OUTCOMES_RELATIVE_PATH}; run ${CAPTURE_OUTCOMES_EXPORT_COMMAND} with the service role key to export the outcome rows.`,
  );
}

describe.skipIf(exported === null)("eval:capture, the exported outcome rows", () => {
  // The describe body still runs when skipped, so an absent file is an empty one here.
  const file: CaptureOutcomesFile = exported ?? {
    format: "aurum.capture-outcomes.v1",
    exportedAt: "",
    filter: { path: "camera", attempt: 1, excludedProviderFailures: 0 },
    rows: [],
  };
  const result = precisionRecallOf(file.rows);

  it("holds only first camera captures, each parsed against the private schema", () => {
    expect(file.filter).toMatchObject({ path: "camera", attempt: 1 });
    for (const entry of file.rows) {
      expect(entry.quality.path).toBe("camera");
      expect(entry.quality.attempt).toBe(1);
    }
  });

  it("keeps our numbers beside every refusal the engine answered", () => {
    for (const line of refusalLines(file.rows)) {
      expect(line.reason).not.toBe("provider");
      expect(line.verdict).not.toBe("reject");
    }
  });

  it("reports precision and recall of accept against the engine", () => {
    console.log(
      `eval:capture: ${String(file.rows.length)} rows, ${String(result.n)} decided. precision ${
        result.precision === null ? "-" : (result.precision * 100).toFixed(1)
      }%, recall ${result.recall === null ? "-" : (result.recall * 100).toFixed(1)}%.`,
    );
    expect(result.n).toBeLessThanOrEqual(file.rows.length);
  });

  it(`asserts precision at or above ${String(PRECISION_THRESHOLD)} once ${String(ROWS_BEFORE_ASSERTING)} rows are decided`, () => {
    if (result.n < ROWS_BEFORE_ASSERTING) {
      console.log(
        `eval:capture: ${String(result.n)} decided rows is under ${String(ROWS_BEFORE_ASSERTING)}; precision is reported and not asserted.`,
      );
      return;
    }
    expect(result.precision).not.toBeNull();
    expect(result.precision ?? 0).toBeGreaterThanOrEqual(PRECISION_THRESHOLD);
  });

  it("writes precision and recall of accept to evals/results/capture-<git sha>.json", () => {
    const sha = shortGitSha();
    const outPath = resolve(REPO_ROOT, "evals", "results", `capture-${sha}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          sha,
          exportedAt: file.exportedAt,
          rows: file.rows.length,
          ...result,
          thresholdAsserted: result.n >= ROWS_BEFORE_ASSERTING,
          precisionThreshold: PRECISION_THRESHOLD,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(existsSync(outPath)).toBe(true);
  });
});
