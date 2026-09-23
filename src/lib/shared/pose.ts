/**
 * Head pose, in the degrees Perfect Corp measures it in.
 *
 * Why this file exists at all. Every refusal this product has actually read off
 * the wire has been a pose refusal: error_face_angle_rightward and
 * error_face_not_forward_facing on 2026-09-02, error_face_angle_downward on
 * 2026-09-03. The capture gate measured none of it. It counted pixels and looked
 * at brightness and then sent a turned head to an engine that refuses turned
 * heads, and the person was asked to take the same photograph again with no idea
 * what was wrong with the first one.
 *
 * The provider publishes the exact tolerances, in the face_angle_strictness_level
 * table on ai_face_analyzer and in the Camera Kit quality configuration on the
 * skin analysis page (both read 2026-09-07). So the gate can be written in the
 * same units as the thing it is guarding, which is what makes "the engine will
 * take this" a claim we can check before spending a unit rather than a hope.
 *
 * Sign conventions, fixed here and depended on by src/lib/shared/quality.ts.
 * All three are degrees, all three are zero for a head square to the lens.
 *
 *     yaw     positive when the face turns toward the image's right edge
 *     pitch   positive when the chin lifts (looking up), negative looking down
 *     roll    positive when the head tips toward the image's right edge
 *
 * The pitch convention is the one that matters, because the provider's own
 * budget is asymmetric about it: the Camera Kit RELAXED profile allows pitch
 * from -20 to +10, so looking down is tolerated twice as far as looking up. A
 * phone held below the face pushes pitch positive, into the half of the range
 * with the least room in it, which is exactly the 2026-09-03 refusal.
 *
 * Pure: no DOM, no MediaPipe types, no I/O, so both estimators can be tested
 * against known geometry with no device and no model file.
 *
 * Calibration, one time
 *
 * MediaPipe documents that facialTransformationMatrixes is a 4 by 4 matrix
 * with column major data and documents nothing about its Euler convention, so
 * the signs above are a claim about geometry that has to be checked once on a
 * phone before any threshold trusts them. The check, on /capture?debug=1 with
 * a frame sent through "Upload instead" so the picture is un mirrored and the
 * signs are in image terms:
 *
 *     turn toward the person's own right    yaw reads negative
 *                                           (the person's right is the
 *                                           image's left)
 *     lift the chin                         pitch reads positive
 *     tip the head toward the image's right roll reads positive
 *
 * Facing the lens all three read within 3 degrees of zero. The free field
 * check is the same two turned frames sent with "Use it anyway": both come
 * back refused for 0 units with leftward and rightward in the engine's own
 * image terms, and those must agree with our sign.
 *
 * What the check catches. poseFromLandmarkerMatrix transposes the column major
 * data before decoding it. Reading a column major matrix as row major is
 * reading the transpose, which for a rotation is the inverse, so a wrong major
 * order negates all three angles at once, and a single turned frame shows it.
 * Until the check is written into this file as done, with the phones and the
 * date, the signs here are the convention the code is written to, not a
 * measurement.
 */

export type FacePose = {
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
};

export type PosePoint = {
  readonly x: number;
  readonly y: number;
};

/**
 * The six points the fallback estimator needs, in image pixels.
 *
 * "left" and "right" are the image's left and right, not the person's. A
 * detector reports boxes and points in the coordinates of the frame it was
 * handed, and every consumer of this module works in those same coordinates, so
 * introducing the sitter's own handedness here would only create a place to get
 * it backwards.
 */
export type PoseLandmarks = {
  readonly leftEye: PosePoint;
  readonly rightEye: PosePoint;
  readonly noseTip: PosePoint;
  /**
   * The corners of the mouth, or the same point twice when the detector reports
   * only a mouth centre. Only their midpoint is read, so a detector that gives
   * one point loses nothing here.
   */
  readonly mouthLeft: PosePoint;
  readonly mouthRight: PosePoint;
};

const RADIANS_TO_DEGREES = 180 / Math.PI;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function midpoint(a: PosePoint, b: PosePoint): PosePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: PosePoint, b: PosePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Pose from a 4 by 4 transformation matrix, which is what a landmarker that
 * solves for head position hands back. This is the accurate path and the one
 * used whenever the detector offers it.
 *
 * The matrix is row major and the rotation lives in its upper left 3 by 3 block:
 *
 *     m0  m1  m2  m3
 *     m4  m5  m6  m7
 *     m8  m9  m10 m11
 *     m12 m13 m14 m15
 *
 * Decomposed as intrinsic rotations in the order yaw, pitch, roll about the
 * y, x and z axes. Returns null for a matrix that is not 16 finite numbers, so a
 * detector that changes its output shape degrades to the landmark estimator
 * instead of producing confident nonsense.
 *
 * The sign flips at the end are what put the result into the conventions at the
 * top of this file rather than into the graphics convention the matrix arrives
 * in, where y is up and this product's image coordinates have y going down.
 */
export function poseFromTransformationMatrix(
  matrix: ArrayLike<number> | null | undefined,
): FacePose | null {
  if (matrix === null || matrix === undefined || matrix.length !== 16) {
    return null;
  }
  for (let index = 0; index < 16; index += 1) {
    const value = matrix[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
  }

  const m0 = matrix[0] ?? 0;
  const m4 = matrix[4] ?? 0;
  const m8 = matrix[8] ?? 0;
  const m9 = matrix[9] ?? 0;
  const m10 = matrix[10] ?? 0;

  /*
   * Gimbal lock: when the head is pitched to very near straight up or straight
   * down the yaw and roll axes coincide and neither can be recovered. It is far
   * outside anything the engine would read anyway, so the honest answer is a
   * pitch at the pole and zero for the two that no longer mean anything.
   */
  const sinPitch = clampUnit(-m9);
  if (Math.abs(sinPitch) > 0.9999) {
    return {
      yawDegrees: 0,
      pitchDegrees: -Math.sign(sinPitch) * 90,
      rollDegrees: 0,
    };
  }

  const pitch = Math.asin(sinPitch) * RADIANS_TO_DEGREES;
  const yaw = Math.atan2(m8, m10) * RADIANS_TO_DEGREES;
  const roll = Math.atan2(m4, m0) * RADIANS_TO_DEGREES;

  return {
    yawDegrees: normalizeDegrees(yaw),
    /*
     * Negated into this file's convention: the matrix has y up, so a chin that
     * lifts produces a negative rotation about x, and every threshold in
     * quality.ts is written with a lifted chin as positive.
     */
    pitchDegrees: normalizeDegrees(-pitch),
    rollDegrees: normalizeDegrees(roll),
  };
}

/**
 * Pose from the matrix a MediaPipe FaceLandmarker hands back, which is the
 * same 4 by 4 as above with its 16 values laid out COLUMN major: data[c * 4 + r]
 * is the element in row r, column c. This transposes into the row major layout
 * poseFromTransformationMatrix reads and decodes it there.
 *
 * Kept as its own entry point rather than a flag, so the one place that knows
 * the landmarker's layout is the one place that reads it. The calibration
 * block at the top of this file is what proves the transpose is right: read
 * without it, every angle comes out negated.
 *
 * Null for anything that is not 16 numbers, like the decoder it wraps.
 */
export function poseFromLandmarkerMatrix(
  data: ArrayLike<number> | null | undefined,
): FacePose | null {
  if (data === null || data === undefined || data.length !== 16) {
    return null;
  }
  const rowMajor = new Array<number>(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      rowMajor[row * 4 + column] = data[column * 4 + row] ?? Number.NaN;
    }
  }
  return poseFromTransformationMatrix(rowMajor);
}

/** Wraps an angle into -180 to 180 so a threshold comparison is meaningful. */
export function normalizeDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) {
    return 0;
  }
  let value = degrees % 360;
  if (value > 180) {
    value -= 360;
  }
  if (value < -180) {
    value += 360;
  }
  /* Turns a -0 into 0 so an equality assertion reads the way it is written. */
  return value === 0 ? 0 : value;
}

/**
 * Pose from six landmarks, for a detector that reports points but does not
 * solve for head position.
 *
 * This is a heuristic and is documented as one. It reads:
 *
 * - roll exactly, from the angle of the line between the eyes. This one is not
 *   an approximation: the eye line is the head's own horizon.
 * - yaw from how far the nose tip sits from the midpoint between the eyes,
 *   measured along the eye line and scaled by the distance between the eyes. A
 *   head turned away carries the nose toward the near eye.
 * - pitch from how far the nose tip sits along the axis running from the eye
 *   midpoint to the mouth midpoint, compared with where it sits on a face
 *   looking straight ahead.
 *
 * The two scale factors below are what turn those ratios into degrees. They are
 * PROVISIONAL: they were chosen so that the ratios a frontal face produces read
 * near zero and the ratios produced at the edge of the provider's own tolerance
 * read near that tolerance, and they have not been checked against a measured
 * head at a known angle. They are used only when the accurate path above is
 * unavailable, and quality.ts widens its thresholds for an estimate that came
 * from here (see POSE_ESTIMATE_SLACK_DEGREES).
 */
export const YAW_RATIO_TO_DEGREES = 90;
export const PITCH_RATIO_TO_DEGREES = 90;

/**
 * Where the nose tip sits between the eye line and the mouth line on a face
 * looking straight into the lens, as a share of that distance.
 *
 * 0.64, corrected from 0.56 on 2026-09-14. The first number was a guess, and it
 * was a guess in the expensive direction. On a real face the tip of the nose
 * sits roughly two thirds of the way from the line between the eyes to the
 * centre of the mouth: the nose is long, the philtrum is short. Measuring
 * against 0.56 read every level face as looking up by about eight degrees, and
 * the pitch window is tightest in exactly that direction (POSE_PITCH_MAX_DEGREES
 * is 10), so a phone held correctly at eye level sat on the edge of "Hold the
 * phone at eye level" and any breath of head movement pushed it over. That was
 * the line a person watched, level phone in hand, waiting for it to change.
 *
 * Still PROVISIONAL: it is anthropometry from a textbook, not a measurement
 * over faces this app has seen. The keypoints it is applied to are BlazeFace's,
 * whose mouth point is the mouth centre, which is what the two thirds is
 * relative to. The heuristic is used only when the detector cannot solve for a
 * head position, and the live line no longer holds on a borderline pitch from
 * it (src/lib/client/guidance.ts), so a residual error here costs a "Use it
 * anyway" rather than a wall.
 */
export const NEUTRAL_NOSE_POSITION = 0.64;

export function poseFromLandmarks(
  landmarks: PoseLandmarks,
): FacePose | null {
  const { leftEye, rightEye, noseTip, mouthLeft, mouthRight } = landmarks;

  const eyeSpan = distance(leftEye, rightEye);
  if (!Number.isFinite(eyeSpan) || eyeSpan <= 0) {
    return null;
  }

  const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const rollDegrees = normalizeDegrees(roll * RADIANS_TO_DEGREES);

  const eyeCenter = midpoint(leftEye, rightEye);
  const mouthCenter = midpoint(mouthLeft, mouthRight);

  /*
   * Measured in the head's own frame rather than the image's, by projecting onto
   * the eye line and onto the axis perpendicular to it. Doing it in image axes
   * would read a tilted head as a turned one, which is the mistake that makes
   * naive pose estimates useless on a handheld phone.
   */
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);

  const noseFromEyeCenterX = noseTip.x - eyeCenter.x;
  const noseFromEyeCenterY = noseTip.y - eyeCenter.y;

  const alongEyeLine = noseFromEyeCenterX * cosRoll + noseFromEyeCenterY * sinRoll;
  const acrossEyeLine =
    -noseFromEyeCenterX * sinRoll + noseFromEyeCenterY * cosRoll;

  const eyeToMouthX = mouthCenter.x - eyeCenter.x;
  const eyeToMouthY = mouthCenter.y - eyeCenter.y;
  const eyeToMouth =
    -eyeToMouthX * sinRoll + eyeToMouthY * cosRoll;

  const yawRatio = alongEyeLine / eyeSpan;
  const yawDegrees = normalizeDegrees(
    Math.asin(clampUnit(yawRatio)) * RADIANS_TO_DEGREES * (YAW_RATIO_TO_DEGREES / 90),
  );

  if (!Number.isFinite(eyeToMouth) || Math.abs(eyeToMouth) < 1e-6) {
    return { yawDegrees, pitchDegrees: 0, rollDegrees };
  }

  const nosePosition = acrossEyeLine / eyeToMouth;
  const pitchRatio = NEUTRAL_NOSE_POSITION - nosePosition;
  const pitchDegrees = normalizeDegrees(
    Math.asin(clampUnit(pitchRatio)) * RADIANS_TO_DEGREES * (PITCH_RATIO_TO_DEGREES / 90),
  );

  return { yawDegrees, pitchDegrees, rollDegrees };
}
