import { describe, expect, it } from "vitest";

import {
  NEUTRAL_NOSE_POSITION,
  normalizeDegrees,
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

  it("reads a rotation about the vertical axis as yaw", () => {
    const radians = (20 * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    // A yaw only rotation matrix, row major.
    const matrix = [
      cos, 0, sin, 0,
      0, 1, 0, 0,
      -sin, 0, cos, 0,
      0, 0, 0, 1,
    ];
    const pose = poseFromTransformationMatrix(matrix);
    expect(Math.abs(pose?.yawDegrees ?? 0)).toBeCloseTo(20, 4);
    expect(pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
    expect(pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);
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
