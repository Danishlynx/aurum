import { describe, expect, it } from "vitest";

import {
  ANALYSIS_FAILURE_REASONS,
  analysisFailureReasonFor,
  isReframeableFailure,
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
 * it is what the upload composer in src/lib/shared/frame-geometry.ts
 * (masterCropFor) now exists to stop happening. It is kept here because the
 * framing can only help a
 * photo that has a findable face in it, so the refusal still has to land well.
 */
const LIVE_CODES = {
  angleRightward: "error_face_angle_rightward",
  notForward: "error_face_not_forward_facing",
  noFace: "error_no_face",
  faceTooSmall: "error_src_face_too_small",
  /** Read on 2026-09-03, off a phone held below the face. */
  angleDownward: "error_face_angle_downward",
} as const;

/**
 * Every spelling of the same refusal: the lens is not square to the face. The
 * engine names a direction, and one line of copy answers all of them, because a
 * person cannot act on "rightward" without being told whose right it is.
 */
const FACE_ANGLE_CODES = [
  "error_face_angle_downward",
  "error_face_angle_upward",
  "error_face_angle_leftward",
  "error_face_angle_rightward",
  "error_face_not_forward_facing",
] as const;

describe("analysisFailureReasonFor, against the codes the API really sent", () => {
  it("reads a turned head as an angle problem", () => {
    expect(analysisFailureReasonFor(LIVE_CODES.angleRightward)).toBe("face_angle");
    expect(analysisFailureReasonFor(LIVE_CODES.notForward)).toBe("face_angle");
  });

  it("reads a tilted head the same way, whichever way it is tilted", () => {
    // error_face_angle_downward is the one the founder's phone produced on
    // 2026-09-03, held at chest height. The other directions are the same
    // refusal said another way.
    for (const code of FACE_ANGLE_CODES) {
      expect(analysisFailureReasonFor(code)).toBe("face_angle");
    }
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

  it("reads a face too small in the frame as its own thing, not a generic one", () => {
    /*
     * Both spellings, because the provider uses both: the skin analyzer answers
     * error_src_face_too_small and the other endpoints answer
     * error_face_position_too_small. Read off their reference pages 2026-09-07.
     */
    expect(analysisFailureReasonFor(LIVE_CODES.faceTooSmall)).toBe(
      "face_too_small",
    );
    expect(analysisFailureReasonFor("error_face_too_small")).toBe(
      "face_too_small",
    );
    expect(analysisFailureReasonFor("error_face_position_too_small")).toBe(
      "face_too_small",
    );
    expect(analysisFailureReasonFor("error_src_face_too_small")).not.toBe(
      "provider",
    );
  });

  it("separates the refusals a tighter crop cannot answer", () => {
    /*
     * These three used to land on "frame", which is the reframeable class, so
     * the client cropped a dark photo and sent it again, then cropped it tighter
     * and sent it again. Both attempts were spent on a certain refusal.
     */
    expect(analysisFailureReasonFor("error_lighting_dark")).toBe("lighting");
    expect(analysisFailureReasonFor("error_insufficient_lighting")).toBe(
      "lighting",
    );
    expect(analysisFailureReasonFor("error_below_min_image_size")).toBe(
      "image_size",
    );
    expect(analysisFailureReasonFor("error_exceed_max_image_size")).toBe(
      "image_size",
    );
    for (const code of [
      "error_lighting_dark",
      "error_insufficient_lighting",
      "error_below_min_image_size",
      "error_exceed_max_image_size",
    ]) {
      expect(isReframeableFailure(analysisFailureReasonFor(code))).toBe(false);
    }
  });

  it("names the two refusals that were reaching the generic provider line", () => {
    // A crop cannot choose which person to keep, and a face already running off
    // the edge needs a wider frame than the one it was refused in.
    expect(analysisFailureReasonFor("error_multiple_people")).toBe(
      "multiple_faces",
    );
    expect(analysisFailureReasonFor("error_face_position_out_of_boundary")).toBe(
      "face_out_of_bounds",
    );
    expect(analysisFailureReasonFor("error_src_face_out_of_bound")).toBe(
      "face_out_of_bounds",
    );
    expect(isReframeableFailure("multiple_faces")).toBe(false);
    expect(isReframeableFailure("face_out_of_bounds")).toBe(false);
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

  it("sends the same photo back only for what a tighter crop could fix", () => {
    // A face too small in the picture, or one the engine could not find at all,
    // or a photo problem we have no better name for.
    expect(isReframeableFailure("face_too_small")).toBe(true);
    expect(isReframeableFailure("no_face")).toBe(true);
    expect(isReframeableFailure("frame")).toBe(true);
    // No crop squares a face to the lens, adds light to a room, makes a picture
    // bigger, or decides which of two people is the one to read.
    expect(isReframeableFailure("face_angle")).toBe(false);
    expect(isReframeableFailure("lighting")).toBe(false);
    expect(isReframeableFailure("image_size")).toBe(false);
    expect(isReframeableFailure("multiple_faces")).toBe(false);
    expect(isReframeableFailure("face_out_of_bounds")).toBe(false);
    expect(isReframeableFailure("provider")).toBe(false);
  });

  it("puts the two framing codes the live run produced on the retry path", () => {
    for (const code of [
      LIVE_CODES.faceTooSmall,
      "error_src_face_position_too_small",
      LIVE_CODES.noFace,
    ]) {
      expect(isReframeableFailure(analysisFailureReasonFor(code))).toBe(true);
    }
    for (const code of [...FACE_ANGLE_CODES, "InternalError"]) {
      expect(isReframeableFailure(analysisFailureReasonFor(code))).toBe(false);
    }
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
