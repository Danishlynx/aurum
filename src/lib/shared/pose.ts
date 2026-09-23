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
 * Since 2026-09-23 the only source of a pose is the FaceLandmarker's
 * transformation matrix (src/lib/client/landmarks.ts). The six keypoint
 * heuristic that estimated one from BlazeFace's points is gone with the
 * detector it read: a frame is measured by the landmarker or it is unmeasured,
 * and an unmeasured frame is not judged on pose at all.
 *
 * Pure: no DOM, no MediaPipe types, no I/O, so the decoder can be tested
 * against known rotations with no device and no model file.
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
 * reading the transpose, which for a rotation is the inverse, so for a turn
 * about ONE axis (which is what each calibration move is) a wrong major order
 * negates that angle, and a single turned frame shows it. For a combined
 * rotation the transpose is a different decomposition, not a negation, so if
 * the phone check finds the signs reversed the fix is to negate the three
 * decoded angles inside poseFromLandmarkerMatrix (and the synthetic face's
 * matrix builder and the signed tests with it), never to drop the transpose.
 * The geometric reading of MediaPipe's metric space (x right, y up, z toward
 * the viewer, the face looking along +z) predicts exactly that reversal on all
 * three axes, so expect the check to ask for it. Until the check is written
 * into this file as done, with the phones and the date, the signs here are the
 * convention the code is written to, not a measurement.
 */

export type FacePose = {
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
  readonly rollDegrees: number;
};

const RADIANS_TO_DEGREES = 180 / Math.PI;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/**
 * Pose from a 4 by 4 transformation matrix, which is what a landmarker that
 * solves for head position hands back.
 *
 * The matrix is row major and the rotation lives in its upper left 3 by 3 block:
 *
 *     m0  m1  m2  m3
 *     m4  m5  m6  m7
 *     m8  m9  m10 m11
 *     m12 m13 m14 m15
 *
 * Decomposed as R = Rz(roll) Rx(pitch) Ry(yaw), in the graphics axes the
 * matrix arrives in (y up). Under that product the third row is
 * (-cos(pitch) sin(yaw'), sin(pitch), cos(pitch) cos(yaw')) and the second
 * column is (-sin(roll) cos(pitch), cos(roll) cos(pitch), sin(pitch)), which is
 * why pitch reads off m9, yaw off m8 and m10, and roll off m1 and m5. All three
 * reads are exact for that decomposition, for a combined turn as much as for a
 * single axis. Until 2026-09-23 roll was read off m4 and m0, which is exact
 * only about one axis and picked up a spurious roll that grew with yaw times
 * pitch on a combined turn (yaw 15, pitch -20 read roll 5.24).
 *
 * Returns null for a matrix that is not 16 finite numbers, so a detector that
 * changes its output shape leaves the frame without a pose instead of
 * producing confident nonsense.
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

  const m1 = matrix[1] ?? 0;
  const m5 = matrix[5] ?? 0;
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
  const roll = Math.atan2(-m1, m5) * RADIANS_TO_DEGREES;

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
