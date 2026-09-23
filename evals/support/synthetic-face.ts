/**
 * A synthetic FaceLandmarker result: 478 landmarks, a transformation matrix and
 * the three blendshapes the gate reads, built from the numbers a reading
 * should come back with.
 *
 * Why this exists. The face reading in src/lib/shared/face-reading.ts is pure
 * and has to be proven without a model file, a device or a photograph, and the
 * e2e seam later hands the capture screen a face of known width, position and
 * pose. Both need the same thing: a landmark list whose reading is known
 * before it is read. So the anchors the reading measures are placed by
 * construction (the cheeks at exactly the width ratio asked for, the forehead
 * and chin at the oval height, the eyes as small ellipses) and every other
 * index is filled inside the oval so the list has the landmarker's shape.
 *
 * The matrix is COLUMN major, as MediaPipe's Matrix.data is, and is built so
 * that poseFromLandmarkerMatrix reads back the yaw, pitch and roll it was
 * built from under the convention src/lib/shared/pose.ts documents. Since the
 * phone check of 2026-09-23 that decoder negates every angle, because the
 * landmarker's matrix carries each turn with the opposite sign, so this builder
 * writes the negated angles the way the landmarker would.
 *
 * The cheek landmarks sit at MESH_FACE_WIDTH_SHARE of the width asked for, as
 * they do on a real face (the mesh's oval stops short of the visible edge), so
 * widthRatio here means what it means everywhere else: the visible face width
 * the oval is drawn for and the engine's rule is about.
 *
 * Landmarks are normalized to the frame, as the landmarker reports them: x
 * over the frame width, y over the frame height. The oval's height is given
 * in width units (FRAME_OVAL_HEIGHT_RATIO times the width) and converted with
 * the frame's aspect, so the face is the shape it would be on that frame.
 */

import {
  BLENDSHAPE_EYE_BLINK_LEFT,
  BLENDSHAPE_EYE_BLINK_RIGHT,
  BLENDSHAPE_JAW_OPEN,
  CHEEK_LEFT,
  CHEEK_RIGHT,
  CHIN,
  FACE_OVAL_LANDMARKS,
  FOREHEAD,
  LEFT_EYE_LANDMARKS,
  RIGHT_EYE_LANDMARKS,
  type Landmark,
} from "@/lib/shared/face-reading";
import {
  FRAME_FACE_CENTER_X,
  FRAME_FACE_CENTER_Y,
  FRAME_OVAL_HEIGHT_RATIO,
  FRAME_OVAL_WIDTH,
  MESH_FACE_WIDTH_SHARE,
  type Point,
  type Size,
} from "@/lib/shared/frame-geometry";

/** How many landmarks a FaceLandmarker result carries, irises included. */
export const LANDMARK_COUNT = 478;

export type SyntheticFaceOptions = {
  /**
   * The visible face width over the frame width, in the engine's terms, which
   * is what faceReadingFrom reads back as widthRatio. The mesh's cheek points
   * are placed at MESH_FACE_WIDTH_SHARE of it, as the landmarker places them
   * on a real face. Default FRAME_OVAL_WIDTH.
   */
  readonly widthRatio?: number;
  /** The oval's centre, normalized. Default the frame's target centre. */
  readonly center?: Point;
  /** Degrees, in the convention pose.ts documents. Default 0. */
  readonly yaw?: number;
  readonly pitch?: number;
  readonly roll?: number;
  /** 0 open to 1 closed, one value for both eyes or one per eye. Default 0. */
  readonly blink?: number | { readonly left: number; readonly right: number };
  /** 0 closed to 1 open. Default 0. */
  readonly jawOpen?: number;
  /** The frame the landmarks are normalized to. Default 1080 by 1440. */
  readonly frame?: Size;
};

export type SyntheticFace = {
  readonly landmarks: readonly Landmark[];
  /** 16 values, column major, as MediaPipe's Matrix.data. */
  readonly matrix: readonly number[];
  readonly blendshapes: ReadonlyMap<string, number>;
  /** The frame the landmarks were normalized to. */
  readonly frame: Size;
};

/** The master frame on a phone, the frame every reading is meant to see. */
export const DEFAULT_SYNTHETIC_FRAME: Size = { width: 1080, height: 1440 };

const DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Angles at which the oval contour's 36 points sit, in order. The list runs
 * clockwise on screen from the forehead (index 0), so the four anchors are
 * pinned to their compass points and the points between them are spaced
 * evenly, which puts the cheeks at exactly the widest point of the ellipse.
 */
function ovalAngleFor(position: number): number {
  const anchors: ReadonlyArray<readonly [number, number]> = [
    [FACE_OVAL_LANDMARKS.indexOf(FOREHEAD), -90],
    [FACE_OVAL_LANDMARKS.indexOf(CHEEK_RIGHT), 0],
    [FACE_OVAL_LANDMARKS.indexOf(CHIN), 90],
    [FACE_OVAL_LANDMARKS.indexOf(CHEEK_LEFT), 180],
    [FACE_OVAL_LANDMARKS.length, 270],
  ];
  for (let index = 0; index + 1 < anchors.length; index += 1) {
    const [fromPosition, fromDegrees] = anchors[index] ?? [0, 0];
    const [toPosition, toDegrees] = anchors[index + 1] ?? [0, 0];
    if (position >= fromPosition && position < toPosition) {
      const share = (position - fromPosition) / (toPosition - fromPosition);
      return (fromDegrees + share * (toDegrees - fromDegrees)) * DEGREES_TO_RADIANS;
    }
  }
  return 270 * DEGREES_TO_RADIANS;
}

function ellipsePoint(
  center: Point,
  semiWidth: number,
  semiHeight: number,
  radians: number,
): Landmark {
  return {
    x: center.x + semiWidth * Math.cos(radians),
    y: center.y + semiHeight * Math.sin(radians),
    z: 0,
  };
}

/**
 * A row major rotation matrix that poseFromTransformationMatrix decodes back
 * to the given angles: Rz(roll) times Rx(pitch) times Ry(minus yaw), in the
 * graphics axes the decoder assumes (y up), so its pitch negation and its
 * atan2 on the third row land on the numbers this was built from.
 */
export function rotationRowMajorFor(
  yawDegrees: number,
  pitchDegrees: number,
  rollDegrees: number,
): number[] {
  const alpha = -yawDegrees * DEGREES_TO_RADIANS;
  const beta = pitchDegrees * DEGREES_TO_RADIANS;
  const gamma = rollDegrees * DEGREES_TO_RADIANS;
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);

  // Rx(beta) times Ry(alpha).
  const xy = [
    [ca, 0, sa],
    [sb * sa, cb, -sb * ca],
    [-cb * sa, sb, cb * ca],
  ] as const;
  // Rz(gamma) times the above.
  const r00 = cg * xy[0][0] - sg * xy[1][0];
  const r01 = cg * xy[0][1] - sg * xy[1][1];
  const r02 = cg * xy[0][2] - sg * xy[1][2];
  const r10 = sg * xy[0][0] + cg * xy[1][0];
  const r11 = sg * xy[0][1] + cg * xy[1][1];
  const r12 = sg * xy[0][2] + cg * xy[1][2];
  const [r20, r21, r22] = xy[2];

  return [
    r00, r01, r02, 0,
    r10, r11, r12, 0,
    r20, r21, r22, 0,
    0, 0, 0, 1,
  ];
}

/** The same 16 values laid out column major, which is how MediaPipe hands them over. */
export function toColumnMajor(rowMajor: readonly number[]): number[] {
  const columnMajor = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      columnMajor[column * 4 + row] = rowMajor[row * 4 + column] ?? 0;
    }
  }
  return columnMajor;
}

/**
 * Where the eyes sit on the oval, as shares of the oval's semi axes: a little
 * under halfway out from the centre, a little above the centre line, and
 * small enough that the two boxes never touch the contour.
 */
const EYE_OFFSET_X = 0.42;
const EYE_OFFSET_Y = -0.15;
const EYE_SEMI_WIDTH = 0.2;
const EYE_SEMI_HEIGHT = 0.09;

/** The golden angle, so the filler points spread evenly without a grid. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function syntheticFace(options: SyntheticFaceOptions = {}): SyntheticFace {
  const frame = options.frame ?? DEFAULT_SYNTHETIC_FRAME;
  const widthRatio = options.widthRatio ?? FRAME_OVAL_WIDTH;
  const center = options.center ?? {
    x: FRAME_FACE_CENTER_X,
    y: FRAME_FACE_CENTER_Y,
  };
  const yaw = options.yaw ?? 0;
  const pitch = options.pitch ?? 0;
  const roll = options.roll ?? 0;
  const blink =
    typeof options.blink === "number"
      ? { left: options.blink, right: options.blink }
      : (options.blink ?? { left: 0, right: 0 });
  const jawOpen = options.jawOpen ?? 0;

  const aspect = frame.width / frame.height;
  /* The mesh oval: its cheeks sit inside the visible face edge by the share. */
  const meshWidth = widthRatio * MESH_FACE_WIDTH_SHARE;
  const semiWidth = meshWidth / 2;
  const semiHeight = ((meshWidth * FRAME_OVAL_HEIGHT_RATIO) / 2) * aspect;

  const landmarks: Landmark[] = new Array<Landmark>(LANDMARK_COUNT);

  /* Everything not pinned below: spread inside the oval on a golden spiral. */
  for (let index = 0; index < LANDMARK_COUNT; index += 1) {
    const radius = 0.85 * Math.sqrt((index + 0.5) / LANDMARK_COUNT);
    const angle = index * GOLDEN_ANGLE;
    landmarks[index] = ellipsePoint(
      center,
      semiWidth * radius,
      semiHeight * radius,
      angle,
    );
  }

  /* The oval contour, cheeks at the widest point, forehead and chin at the poles. */
  FACE_OVAL_LANDMARKS.forEach((index, position) => {
    landmarks[index] = ellipsePoint(
      center,
      semiWidth,
      semiHeight,
      ovalAngleFor(position),
    );
  });

  /* The eyes: the person's left eye on the image's right, and the reverse. */
  const eyes: ReadonlyArray<readonly [readonly number[], number, number]> = [
    [LEFT_EYE_LANDMARKS, 1, blink.left],
    [RIGHT_EYE_LANDMARKS, -1, blink.right],
  ];
  for (const [indices, side, closed] of eyes) {
    const eyeCenter: Point = {
      x: center.x + side * EYE_OFFSET_X * semiWidth,
      y: center.y + EYE_OFFSET_Y * semiHeight,
    };
    const eyeSemiWidth = EYE_SEMI_WIDTH * semiWidth;
    const eyeSemiHeight =
      EYE_SEMI_HEIGHT * semiHeight * Math.max(0.05, 1 - Math.min(1, closed));
    indices.forEach((index, position) => {
      const radians = (position / indices.length) * 2 * Math.PI;
      landmarks[index] = ellipsePoint(eyeCenter, eyeSemiWidth, eyeSemiHeight, radians);
    });
  }

  /*
   * Built for the negated angles, because poseFromLandmarkerMatrix negates
   * every angle it decodes since the phone check of 2026-09-23 (pose.ts,
   * "Calibration, one time"): the landmarker's own matrix carries each turn
   * with the opposite sign to the convention, and this builder imitates the
   * landmarker, so the round trip reads back the angles asked for.
   */
  const rowMajor = rotationRowMajorFor(-yaw, -pitch, -roll);
  /* A translation in centimetres, as the landmarker reports one. Decoders ignore it. */
  rowMajor[11] = -45;
  const matrix = toColumnMajor(rowMajor);

  const blendshapes = new Map<string, number>([
    [BLENDSHAPE_EYE_BLINK_LEFT, blink.left],
    [BLENDSHAPE_EYE_BLINK_RIGHT, blink.right],
    [BLENDSHAPE_JAW_OPEN, jawOpen],
  ]);

  return { landmarks, matrix, blendshapes, frame };
}
