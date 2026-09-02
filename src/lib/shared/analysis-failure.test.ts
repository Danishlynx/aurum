import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FAILURE_REASONS,
  analysisFailureReasonFor,
  isRetakeFailure,
  type AnalysisFailureReason,
} from "./analysis-failure";
import { analysisFailureCopy, COPY_NOT_IN_FLOW_DOC, copy } from "./copy";

/**
 * The codes at the top are the ones the live API sent, and they are the reason
 * this module exists: every one of them used to become the same generic refusal,
 * which told a person nothing they could act on.
 *
 * The first three were read on 2026-09-02. faceTooSmall came later, off a photo
 * picked out of the phone's gallery rather than taken on the capture screen, and
 * it is what the auto framing in src/lib/shared/quality.ts (autoCropBoxFor) now
 * exists to stop happening. It is kept here because the framing can only help a
 * photo that has a findable face in it, so the refusal still has to land well.
 */
const LIVE_CODES = {
  angleRightward: "error_face_angle_rightward",
  notForward: "error_face_not_forward_facing",
  noFace: "error_no_face",
  faceTooSmall: "error_src_face_too_small",
} as const;

describe("analysisFailureReasonFor, against the codes the API really sent", () => {
  it("reads a turned head as an angle problem", () => {
    expect(analysisFailureReasonFor(LIVE_CODES.angleRightward)).toBe("face_angle");
    expect(analysisFailureReasonFor(LIVE_CODES.notForward)).toBe("face_angle");
  });

  it("reads an empty frame as a missing face", () => {
    expect(analysisFailureReasonFor(LIVE_CODES.noFace)).toBe("no_face");
  });

  it("keeps the angle reading for a code that names both", () => {
    // error_face_not_forward_facing carries "face" as well. The angle line is
    // the one worth saying, so it wins.
    expect(analysisFailureReasonFor(LIVE_CODES.notForward)).not.toBe("no_face");
  });

  it("is not case or whitespace sensitive", () => {
    expect(analysisFailureReasonFor("  ERROR_NO_FACE  ")).toBe("no_face");
  });

  it("reads a face too small in the frame as a frame problem", () => {
    // The live code, and the two spellings around it, all land on the line that
    // asks for another photo rather than on the one that blames the provider.
    expect(analysisFailureReasonFor(LIVE_CODES.faceTooSmall)).toBe("frame");
    expect(analysisFailureReasonFor("error_face_too_small")).toBe("frame");
    expect(analysisFailureReasonFor("error_src_face_too_small")).not.toBe(
      "provider",
    );
  });

  it("reads an unrecorded code about the photo as a frame problem", () => {
    expect(analysisFailureReasonFor("error_image_resolution_too_low")).toBe("frame");
  });

  it("does not blame the photo for a code that never mentions it", () => {
    for (const code of ["InternalError", "error_internal", "500", "error"]) {
      expect(analysisFailureReasonFor(code)).toBe("provider");
    }
  });

  it("treats a missing code as a provider failure, not a bad photo", () => {
    expect(analysisFailureReasonFor(null)).toBe("provider");
    expect(analysisFailureReasonFor(undefined)).toBe("provider");
    expect(analysisFailureReasonFor("   ")).toBe("provider");
  });

  it("asks for a retake for every reason about the photo, and only those", () => {
    expect(isRetakeFailure("face_angle")).toBe(true);
    expect(isRetakeFailure("no_face")).toBe(true);
    expect(isRetakeFailure("frame")).toBe(true);
    expect(isRetakeFailure("provider")).toBe(false);
  });
});

describe("analysisFailureCopy", () => {
  it("has a line for every reason, and every line says what to do", () => {
    for (const reason of ANALYSIS_FAILURE_REASONS) {
      const line = analysisFailureCopy(reason);
      expect(line.length).toBeGreaterThan(0);
      expect(line.endsWith(".")).toBe(true);
      expect(line.toLowerCase()).toContain("again");
    }
  });

  it("says the same thing about a turned head that the capture screen says", () => {
    expect(analysisFailureCopy("face_angle")).toBe(copy.capture.facingAway);
    expect(analysisFailureCopy("no_face")).toBe(copy.capture.rejection.no_face);
  });

  it("falls back to the refusal line for anything unclassified", () => {
    expect(analysisFailureCopy("frame")).toBe(copy.errors.readingRefused);
    expect(analysisFailureCopy("provider")).toBe(copy.errors.readingRefused);
  });

  it("carries no dash of either kind", () => {
    // Written as escapes on purpose: this file lives under src, where the em
    // dash and en dash rule is enforced on the source itself.
    const dashes = /[\u2013\u2014]/u;
    for (const reason of ANALYSIS_FAILURE_REASONS) {
      expect(analysisFailureCopy(reason)).not.toMatch(dashes);
    }
  });

  it("registers the two new lines as written in house", () => {
    const paths: readonly string[] = COPY_NOT_IN_FLOW_DOC;
    expect(paths).toContain("capture.facingAway");
    expect(paths).toContain("errors.readingRefused");
  });

  it("names every reason exactly once", () => {
    const reasons: readonly AnalysisFailureReason[] = ANALYSIS_FAILURE_REASONS;
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
