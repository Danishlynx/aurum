import { describe, expect, it } from "vitest";

import {
  NEUTRAL_NOSE_POSITION,
  normalizeDegrees,
  poseFromLandmarkerMatrix,
  poseFromLandmarks,
  poseFromTransformationMatrix,
  type PoseLandmarks,
} from "./pose";
import {
  POSE_PITCH_MAX_DEGREES,
  POSE_PITCH_MIN_DEGREES,
  POSE_ROLL_MAX_DEGREES,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
  poseExcessDegrees,
  poseVerdictFor,
} from "./quality";

/**
 * Head pose, which is the measurement the capture gate never had.
 *
 * Every refusal this product has read off the live API has been about pose:
 * error_face_angle_rightward and error_face_not_forward_facing on 2026-09-02,
 * error_face_angle_downward on 2026-09-03. Nothing in the gate could see any of
 * it, so a turned head was sent, charged nothing, refused, and handed back to the
 * person as "try again" with no idea what to change.
 */

/** A face looking straight into the lens, in the pixels of a 400 by 400 frame. */
const FRONTAL: PoseLandmarks = {
  leftEye: { x: 160, y: 170 },
  rightEye: { x: 240, y: 170 },
  noseTip: { x: 200, y: 170 + 100 * NEUTRAL_NOSE_POSITION },
  mouthLeft: { x: 180, y: 270 },
  mouthRight: { x: 220, y: 270 },
};

/** Rotates a point about the centre of the frame, to model a tilted phone. */
function rotate(
  point: { x: number; y: number },
  degrees: number,
  about = { x: 200, y: 220 },
) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - about.x;
  const dy = point.y - about.y;
  return {
    x: about.x + dx * cos - dy * sin,
    y: about.y + dx * sin + dy * cos,
  };
}

function rotateAll(landmarks: PoseLandmarks, degrees: number): PoseLandmarks {
  return {
    leftEye: rotate(landmarks.leftEye, degrees),
    rightEye: rotate(landmarks.rightEye, degrees),
    noseTip: rotate(landmarks.noseTip, degrees),
    mouthLeft: rotate(landmarks.mouthLeft, degrees),
    mouthRight: rotate(landmarks.mouthRight, degrees),
  };
}

describe("poseFromLandmarks", () => {
  it("reads a face square to the lens as square", () => {
    const pose = poseFromLandmarks(FRONTAL);
    expect(pose).not.toBeNull();
    expect(pose?.yawDegrees ?? 99).toBeCloseTo(0, 6);
    expect(pose?.rollDegrees ?? 99).toBeCloseTo(0, 6);
    expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 6);
  });

  it("reads roll exactly, which is the one angle it does not approximate", () => {
    for (const degrees of [-30, -15, -5, 5, 15, 30]) {
      const pose = poseFromLandmarks(rotateAll(FRONTAL, degrees));
      expect(pose?.rollDegrees ?? 99).toBeCloseTo(degrees, 6);
    }
  });

  /**
   * The property that makes the measurement usable on a handheld phone. A tilted
   * phone rotates every landmark together, and a naive estimate taken in image
   * axes reads that rotation as a turned head. It is not one: the head is square
   * to the lens and the lens is tipped.
   */
  it("does not turn a tilted phone into a turned head", () => {
    for (const degrees of [-25, -10, 10, 25]) {
      const pose = poseFromLandmarks(rotateAll(FRONTAL, degrees));
      expect(pose?.yawDegrees ?? 99).toBeCloseTo(0, 4);
      expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
    }
  });

  it("reads a nose carried toward one eye as yaw, with the sign of the turn", () => {
    const turnedRight = poseFromLandmarks({
      ...FRONTAL,
      noseTip: { x: 224, y: FRONTAL.noseTip.y },
    });
    const turnedLeft = poseFromLandmarks({
      ...FRONTAL,
      noseTip: { x: 176, y: FRONTAL.noseTip.y },
    });
    expect(turnedRight?.yawDegrees ?? 0).toBeGreaterThan(10);
    expect(turnedLeft?.yawDegrees ?? 0).toBeLessThan(-10);
  });

  it("reads a lifted chin as positive pitch and a dropped one as negative", () => {
    const eyeToMouth = 100;
    const lookingUp = poseFromLandmarks({
      ...FRONTAL,
      noseTip: { x: 200, y: 170 + eyeToMouth * (NEUTRAL_NOSE_POSITION - 0.2) },
    });
    const lookingDown = poseFromLandmarks({
      ...FRONTAL,
      noseTip: { x: 200, y: 170 + eyeToMouth * (NEUTRAL_NOSE_POSITION + 0.2) },
    });
    expect(lookingUp?.pitchDegrees ?? 0).toBeGreaterThan(0);
    expect(lookingDown?.pitchDegrees ?? 0).toBeLessThan(0);
  });

  it("refuses to answer when the two eyes are the same point", () => {
    expect(
      poseFromLandmarks({ ...FRONTAL, rightEye: { ...FRONTAL.leftEye } }),
    ).toBeNull();
  });
});

const COS_20 = Math.cos((20 * Math.PI) / 180);
const SIN_20 = Math.sin((20 * Math.PI) / 180);

/** The standard right handed rotation about y by 20 degrees, row major. */
const YAW_20_ROW_MAJOR = [
  COS_20, 0, SIN_20, 0,
  0, 1, 0, 0,
  -SIN_20, 0, COS_20, 0,
  0, 0, 0, 1,
];

/** The standard right handed rotation about x by 20 degrees, row major. */
const PITCH_20_ROW_MAJOR = [
  1, 0, 0, 0,
  0, COS_20, -SIN_20, 0,
  0, SIN_20, COS_20, 0,
  0, 0, 0, 1,
];

/** The standard right handed rotation about z by 20 degrees, row major. */
const ROLL_20_ROW_MAJOR = [
  COS_20, -SIN_20, 0, 0,
  SIN_20, COS_20, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

/** The same 16 values laid out column major, as MediaPipe hands them over. */
function transposed(rowMajor: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out[column * 4 + row] = rowMajor[row * 4 + column] ?? 0;
    }
  }
  return out;
}

describe("poseFromTransformationMatrix", () => {
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("reads the identity as a head square to the lens", () => {
    const pose = poseFromTransformationMatrix(IDENTITY);
    expect(pose).toEqual({ yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 });
  });

  it("refuses anything that is not sixteen finite numbers", () => {
    expect(poseFromTransformationMatrix(null)).toBeNull();
    expect(poseFromTransformationMatrix(undefined)).toBeNull();
    expect(poseFromTransformationMatrix([1, 2, 3])).toBeNull();
    const withNaN = [...IDENTITY];
    withNaN[5] = Number.NaN;
    expect(poseFromTransformationMatrix(withNaN)).toBeNull();
  });

  /**
   * Signed, since 2026-09-23. These used to assert Math.abs, which let a
   * decoder with every sign backwards pass, and a sign is the whole question
   * the pitch window asks (looking up is tolerated half as far as looking
   * down). The expectations below are what the decoder reads under the
   * convention at the top of pose.ts: the standard right handed rotation
   * matrices about y, x and z, row major, read as yaw minus 20, pitch plus 20
   * and roll plus 20. The one time calibration in that file is what ties
   * these signs to a head on a phone.
   */
  it("reads a rotation about the vertical axis as signed yaw", () => {
    const pose = poseFromTransformationMatrix(YAW_20_ROW_MAJOR);
    expect(pose?.yawDegrees ?? 0).toBeCloseTo(-20, 4);
    expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
    expect(pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);
  });

  it("reads a rotation about the horizontal axis as signed pitch", () => {
    const pose = poseFromTransformationMatrix(PITCH_20_ROW_MAJOR);
    expect(pose?.pitchDegrees ?? 0).toBeCloseTo(20, 4);
    expect(pose?.yawDegrees ?? 99).toBeCloseTo(0, 4);
    expect(pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);
  });

  it("reads a rotation about the lens axis as signed roll", () => {
    const pose = poseFromTransformationMatrix(ROLL_20_ROW_MAJOR);
    expect(pose?.rollDegrees ?? 0).toBeCloseTo(20, 4);
    expect(pose?.yawDegrees ?? 99).toBeCloseTo(0, 4);
    expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
  });
});

describe("poseFromLandmarkerMatrix", () => {
  /**
   * MediaPipe's Matrix.data is column major. The same rotation laid out that
   * way has to read the SAME signed value the row major test above reads,
   * which is what the transpose inside poseFromLandmarkerMatrix is for.
   */
  it("reads a column major yaw matrix as the same signed yaw", () => {
    const pose = poseFromLandmarkerMatrix(transposed(YAW_20_ROW_MAJOR));
    expect(pose?.yawDegrees ?? 0).toBeCloseTo(-20, 4);
    expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
    expect(pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);
  });

  it("reads column major pitch and roll as the same signed values too", () => {
    expect(
      poseFromLandmarkerMatrix(transposed(PITCH_20_ROW_MAJOR))?.pitchDegrees ?? 0,
    ).toBeCloseTo(20, 4);
    expect(
      poseFromLandmarkerMatrix(transposed(ROLL_20_ROW_MAJOR))?.rollDegrees ?? 0,
    ).toBeCloseTo(20, 4);
  });

  /**
   * The failure the on phone calibration is written to catch: feeding the
   * column major data straight to the row major decoder reads the transpose,
   * which for a rotation is its inverse, so every angle comes out negated.
   */
  it("would negate all three angles if the major order were read wrong", () => {
    const wrongYaw = poseFromTransformationMatrix(transposed(YAW_20_ROW_MAJOR));
    const wrongPitch = poseFromTransformationMatrix(transposed(PITCH_20_ROW_MAJOR));
    const wrongRoll = poseFromTransformationMatrix(transposed(ROLL_20_ROW_MAJOR));
    expect(wrongYaw?.yawDegrees ?? 0).toBeCloseTo(20, 4);
    expect(wrongPitch?.pitchDegrees ?? 0).toBeCloseTo(-20, 4);
    expect(wrongRoll?.rollDegrees ?? 0).toBeCloseTo(-20, 4);
  });

  it("reads the identity as square and refuses the wrong shape", () => {
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(poseFromLandmarkerMatrix(IDENTITY)).toEqual({
      yawDegrees: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
    });
    expect(poseFromLandmarkerMatrix(null)).toBeNull();
    expect(poseFromLandmarkerMatrix([1, 2, 3])).toBeNull();
    expect(poseFromLandmarkerMatrix(new Float32Array(16))).not.toBeNull();
  });
});

describe("normalizeDegrees", () => {
  it("wraps into the range a threshold can be compared against", () => {
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(190)).toBeCloseTo(-170, 10);
    expect(normalizeDegrees(-190)).toBeCloseTo(170, 10);
    expect(normalizeDegrees(360)).toBe(0);
  });

  it("answers zero for a value that is not a number", () => {
    expect(normalizeDegrees(Number.NaN)).toBe(0);
    expect(normalizeDegrees(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("the pose gate", () => {
  const SQUARE = { yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 };

  it("says nothing at all about a frame with no pose to read", () => {
    // A detector that cannot solve for a head position leaves every frame
    // exactly where it was before any of this existed.
    expect(poseVerdictFor(null)).toBe("ok");
    expect(poseVerdictFor(undefined)).toBe("ok");
  });

  it("passes a head inside the window", () => {
    expect(poseVerdictFor(SQUARE)).toBe("ok");
    expect(
      poseVerdictFor({ ...SQUARE, yawDegrees: POSE_YAW_MAX_DEGREES }),
    ).toBe("ok");
    expect(
      poseVerdictFor({ ...SQUARE, rollDegrees: -POSE_ROLL_MAX_DEGREES }),
    ).toBe("ok");
  });

  /**
   * The provider's own budget is asymmetric and ours copies it: looking down is
   * tolerated twice as far as looking up, because a phone held below the face is
   * the ordinary grip and it pushes pitch the other way.
   */
  it("keeps the pitch window lopsided, the way the provider's is", () => {
    expect(poseVerdictFor({ ...SQUARE, pitchDegrees: POSE_PITCH_MAX_DEGREES })).toBe(
      "ok",
    );
    expect(poseVerdictFor({ ...SQUARE, pitchDegrees: POSE_PITCH_MIN_DEGREES })).toBe(
      "ok",
    );
    expect(POSE_PITCH_MIN_DEGREES).toBeLessThan(-POSE_PITCH_MAX_DEGREES);
  });

  it("offers a head just outside the window rather than refusing it", () => {
    const justOutside = {
      ...SQUARE,
      yawDegrees: POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES - 1,
    };
    expect(poseVerdictFor(justOutside)).toBe("borderline");
  });

  it("refuses a head far enough out that the engine certainly will", () => {
    const wellOutside = {
      ...SQUARE,
      yawDegrees: POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES + 1,
    };
    expect(poseVerdictFor(wellOutside)).toBe("reject");
  });

  it("measures the worst axis, not the sum of them", () => {
    const excess = poseExcessDegrees({
      yawDegrees: POSE_YAW_MAX_DEGREES + 5,
      rollDegrees: POSE_ROLL_MAX_DEGREES + 9,
      pitchDegrees: 0,
    });
    expect(excess).toBe(9);
  });

  it("stays inside what the app actually asks the engine for", () => {
    /*
     * The two endpoints that gate on pose are called with
     * face_angle_strictness_level "flexible", which is 30 degrees on all three
     * axes. Every threshold here has to sit inside that, or the gate would be
     * refusing frames the engine would have read.
     */
    const FLEXIBLE_DEGREES = 30;
    expect(POSE_YAW_MAX_DEGREES).toBeLessThan(FLEXIBLE_DEGREES);
    expect(POSE_ROLL_MAX_DEGREES).toBeLessThan(FLEXIBLE_DEGREES);
    expect(POSE_PITCH_MAX_DEGREES).toBeLessThan(FLEXIBLE_DEGREES);
    expect(Math.abs(POSE_PITCH_MIN_DEGREES)).toBeLessThan(FLEXIBLE_DEGREES);
  });
});
