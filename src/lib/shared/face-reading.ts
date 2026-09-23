/**
 * A face reading: what the gate measures on one frame, read off a MediaPipe
 * FaceLandmarker result in the engine's own terms.
 *
 * Why this exists. The engine's face rule is about width ("the width of the
 * face needs to be greater than 60% of the width of the image") and "face
 * width" is never defined, while every detector reports a box whose extent is
 * undocumented, so no 60 percent rule could be built on a box. Cheek to cheek
 * across the landmarker's face oval is a defined measurement, it is narrower
 * than any detector's box (so a frame that clears our number clears the
 * engine's), and it is the same measurement on every device once the frame is
 * the master frame (src/lib/shared/frame-geometry.ts).
 *
 * Left and right follow MediaPipe's naming, which is the person's own side:
 * LEFT_EYE_LANDMARKS is the person's left eye, which sits on the image's right
 * in an un mirrored frame, and eyeBlinkLeft is the same eye. The two are kept
 * consistent with each other here and nothing downstream needs the image side.
 * The one exception is the pair of cheek constants below, which the plan names
 * by IMAGE side (CHEEK_LEFT is the image's left, the person's right); each
 * carries its own comment saying so, and only their distance is ever read.
 *
 * Pure: no DOM, no MediaPipe types, no I/O. The landmarker's result is passed
 * in as plain numbers, so this runs identically in a test with a synthetic
 * face (evals/support/synthetic-face.ts) and on a phone.
 */

import { MESH_FACE_WIDTH_SHARE, type Point, type Size } from "./frame-geometry";
import { poseFromLandmarkerMatrix, type FacePose } from "./pose";
import type { Box, GrayscaleImage } from "./quality";

// ---------------------------------------------------------------------------
// Landmark indices (MediaPipe Face Mesh, 478 points with the irises)
// ---------------------------------------------------------------------------

/** The person's right cheek, the image's left in an un mirrored frame. */
export const CHEEK_LEFT = 234;
/** The person's left cheek, the image's right in an un mirrored frame. */
export const CHEEK_RIGHT = 454;
/** The top of the forehead on the face oval. */
export const FOREHEAD = 10;
/** The bottom of the chin on the face oval. */
export const CHIN = 152;

/**
 * The face oval contour, 36 points, clockwise on screen from the forehead:
 * down the image's right side through CHEEK_RIGHT to the chin, and up the
 * image's left side through CHEEK_LEFT back to the top.
 */
export const FACE_OVAL_LANDMARKS: readonly number[] = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
];

/** The person's left eye contour, 16 points. */
export const LEFT_EYE_LANDMARKS: readonly number[] = [
  362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384,
  398,
];

/** The person's right eye contour, 16 points. */
export const RIGHT_EYE_LANDMARKS: readonly number[] = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];

/** The highest landmark index this module reads, so a short list is refused. */
const HIGHEST_INDEX_READ = Math.max(
  CHEEK_LEFT,
  CHEEK_RIGHT,
  FOREHEAD,
  CHIN,
  ...FACE_OVAL_LANDMARKS,
  ...LEFT_EYE_LANDMARKS,
  ...RIGHT_EYE_LANDMARKS,
);

/** The blendshape names read, as MediaPipe spells them. */
export const BLENDSHAPE_EYE_BLINK_LEFT = "eyeBlinkLeft";
export const BLENDSHAPE_EYE_BLINK_RIGHT = "eyeBlinkRight";
export const BLENDSHAPE_JAW_OPEN = "jawOpen";

// ---------------------------------------------------------------------------
// The reading
// ---------------------------------------------------------------------------

/** One landmark in normalized image coordinates, 0 to 1 on each axis. */
export type Landmark = {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
};

export type Blink = {
  /** The person's left eye, 0 open to 1 closed. */
  readonly left: number;
  /** The person's right eye, 0 open to 1 closed. */
  readonly right: number;
};

export type EyeBoxes = {
  /** The person's left eye. */
  readonly left: Box;
  /** The person's right eye. */
  readonly right: Box;
};

export type FaceReading = {
  /**
   * The visible face width over the frame width, in the engine's terms: the
   * cheek to cheek span (meshWidthRatio) divided by MESH_FACE_WIDTH_SHARE,
   * because the mesh's outermost cheek points sit inside the visible edge of
   * the face (measured 2026-09-23). The number the width bands in
   * frame-geometry.ts and the oval on the stage are about.
   */
  readonly widthRatio: number;
  /**
   * The raw cheek to cheek span: |x of CHEEK_RIGHT minus x of CHEEK_LEFT| in
   * normalized coordinates, which are already divided by the frame width.
   * Stored beside widthRatio so the share can be moved from data.
   */
  readonly meshWidthRatio: number;
  /** The bounding box of the face oval contour, normalized 0 to 1. */
  readonly ovalBox: Box;
  /**
   * The visible face as a box: ovalBox grown about its centre by the same
   * share, so its width is widthRatio. The bounds test and the upload composer
   * read this one, because the engine's out of boundary rule and its width
   * rule are about the face it sees, not the mesh's oval.
   */
  readonly faceBox: Box;
  /** ovalBox.width: the mesh oval's extent over the frame width, for the report. */
  readonly bboxRatio: number;
  /** The centre of ovalBox, normalized. */
  readonly center: Point;
  /** Solved from the transformation matrix, or null when there was none. */
  readonly pose: FacePose | null;
  /** From the eyeBlink blendshapes, or null when there were none. */
  readonly blink: Blink | null;
  /** From the jawOpen blendshape, or null when there was none. */
  readonly jawOpen: number | null;
  /** Bounding boxes of the two eye contours, normalized. */
  readonly eyeBoxes: EyeBoxes;
  /** The 36 oval contour points, normalized, for the luma polygon. */
  readonly ovalPolygon: readonly Point[];
  /**
   * The same oval polygon and eye boxes in the pixels of the frame that was
   * given, ready for meanLumaInside and evenness. Null when no frame was given.
   */
  readonly pixels: {
    readonly frame: Size;
    /** The visible face box (faceBox) in that frame's pixels. */
    readonly faceBox: Box;
    readonly ovalPolygon: readonly Point[];
    readonly eyeBoxes: EyeBoxes;
  } | null;
};

export type FaceReadingInput = {
  /** The landmarker's 478 points for one face, normalized to the image. */
  readonly landmarks: readonly Landmark[];
  /** facialTransformationMatrixes[i].data, column major, or null. */
  readonly matrix: ArrayLike<number> | null;
  /** The 52 blendshape scores by name, or null when they were not asked for. */
  readonly blendshapes:
    | ReadonlyMap<string, number>
    | Readonly<Record<string, number>>
    | null;
};

function landmarkAt(
  landmarks: readonly Landmark[],
  index: number,
): Landmark | null {
  const point = landmarks[index];
  if (
    point === undefined ||
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    return null;
  }
  return point;
}

function pointsAt(
  landmarks: readonly Landmark[],
  indices: readonly number[],
): Point[] | null {
  const points: Point[] = [];
  for (const index of indices) {
    const point = landmarkAt(landmarks, index);
    if (point === null) {
      return null;
    }
    points.push({ x: point.x, y: point.y });
  }
  return points;
}

/** The bounding box of a polygon. Undefined on an empty one, so never called on one. */
function boundsOf(points: readonly Point[]): Box {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function blendshapeValue(
  blendshapes: FaceReadingInput["blendshapes"],
  name: string,
): number | null {
  if (blendshapes === null) {
    return null;
  }
  /*
   * A Map by its get method rather than instanceof, so a Map handed across a
   * realm boundary (the e2e seam, a worker) still reads as one.
   */
  const value =
    typeof (blendshapes as ReadonlyMap<string, number>).get === "function"
      ? (blendshapes as ReadonlyMap<string, number>).get(name)
      : (blendshapes as Readonly<Record<string, number>>)[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function scalePolygon(points: readonly Point[], frame: Size): Point[] {
  return points.map((point) => ({
    x: point.x * frame.width,
    y: point.y * frame.height,
  }));
}

function scaleBoxTo(box: Box, frame: Size): Box {
  return {
    x: box.x * frame.width,
    y: box.y * frame.height,
    width: box.width * frame.width,
    height: box.height * frame.height,
  };
}

export type FacePixels = {
  readonly ovalBox: Box;
  /** The visible face box (FaceReading.faceBox) in the frame's pixels. */
  readonly faceBox: Box;
  readonly ovalPolygon: readonly Point[];
  readonly eyeBoxes: EyeBoxes;
};

/**
 * The mesh oval's box grown about its centre into the visible face box: the
 * width and the height both divided by MESH_FACE_WIDTH_SHARE, the centre kept.
 * Pure geometry on a normalized or a pixel box alike.
 */
export function visualFaceBoxOf(ovalBox: Box): Box {
  const width = ovalBox.width / MESH_FACE_WIDTH_SHARE;
  const height = ovalBox.height / MESH_FACE_WIDTH_SHARE;
  return {
    x: ovalBox.x + ovalBox.width / 2 - width / 2,
    y: ovalBox.y + ovalBox.height / 2 - height / 2,
    width,
    height,
  };
}

/**
 * The reading's oval box, oval polygon and eye boxes in the pixels of a given
 * image, whatever frame the reading was taken with.
 *
 * The gate and the live line measure luma over a grayscale copy whose size is
 * the canvas the landmarker saw, and this is how they put the normalized
 * reading onto those pixels without trusting that the two sizes agree.
 */
export function facePixelsIn(reading: FaceReading, frame: Size): FacePixels {
  return {
    ovalBox: scaleBoxTo(reading.ovalBox, frame),
    faceBox: scaleBoxTo(reading.faceBox, frame),
    ovalPolygon: scalePolygon(reading.ovalPolygon, frame),
    eyeBoxes: {
      left: scaleBoxTo(reading.eyeBoxes.left, frame),
      right: scaleBoxTo(reading.eyeBoxes.right, frame),
    },
  };
}

/**
 * The reading for one face, or null when the landmark list is too short to
 * carry the points this module reads (the landmarker always gives 478; a
 * shorter list is a result this code was not written for).
 *
 * With a frame, the reading also carries the oval polygon and the eye boxes in
 * that frame's pixels, which is what the luma measurements below take.
 */
export function faceReadingFrom(
  input: FaceReadingInput,
  frame?: Size,
): FaceReading | null {
  const { landmarks } = input;
  if (landmarks.length <= HIGHEST_INDEX_READ) {
    return null;
  }

  const cheekLeft = landmarkAt(landmarks, CHEEK_LEFT);
  const cheekRight = landmarkAt(landmarks, CHEEK_RIGHT);
  const ovalPolygon = pointsAt(landmarks, FACE_OVAL_LANDMARKS);
  const leftEye = pointsAt(landmarks, LEFT_EYE_LANDMARKS);
  const rightEye = pointsAt(landmarks, RIGHT_EYE_LANDMARKS);
  if (
    cheekLeft === null ||
    cheekRight === null ||
    ovalPolygon === null ||
    leftEye === null ||
    rightEye === null
  ) {
    return null;
  }

  const ovalBox = boundsOf(ovalPolygon);
  const eyeBoxes: EyeBoxes = {
    left: boundsOf(leftEye),
    right: boundsOf(rightEye),
  };

  const blinkLeft = blendshapeValue(input.blendshapes, BLENDSHAPE_EYE_BLINK_LEFT);
  const blinkRight = blendshapeValue(
    input.blendshapes,
    BLENDSHAPE_EYE_BLINK_RIGHT,
  );
  const blink: Blink | null =
    blinkLeft === null || blinkRight === null
      ? null
      : { left: blinkLeft, right: blinkRight };

  const pixels =
    frame !== undefined &&
    Number.isFinite(frame.width) &&
    Number.isFinite(frame.height) &&
    frame.width > 0 &&
    frame.height > 0
      ? {
          frame,
          faceBox: scaleBoxTo(visualFaceBoxOf(ovalBox), frame),
          ovalPolygon: scalePolygon(ovalPolygon, frame),
          eyeBoxes: {
            left: scaleBoxTo(eyeBoxes.left, frame),
            right: scaleBoxTo(eyeBoxes.right, frame),
          },
        }
      : null;

  const meshWidthRatio = Math.abs(cheekRight.x - cheekLeft.x);

  return {
    widthRatio: meshWidthRatio / MESH_FACE_WIDTH_SHARE,
    meshWidthRatio,
    ovalBox,
    faceBox: visualFaceBoxOf(ovalBox),
    bboxRatio: ovalBox.width,
    center: {
      x: ovalBox.x + ovalBox.width / 2,
      y: ovalBox.y + ovalBox.height / 2,
    },
    pose: input.matrix === null ? null : poseFromLandmarkerMatrix(input.matrix),
    blink,
    jawOpen: blendshapeValue(input.blendshapes, BLENDSHAPE_JAW_OPEN),
    eyeBoxes,
    ovalPolygon,
    pixels,
  };
}

// ---------------------------------------------------------------------------
// Light over the face
// ---------------------------------------------------------------------------

/**
 * The mean luma, 0 to 1, of the pixels inside a polygon given in the image's
 * pixels. 0 for a polygon with fewer than three points or no area, and 0 for
 * a polygon that covers no pixel centre.
 *
 * Scanline filled with the even odd rule: a pixel is inside when its centre
 * (x + 0.5, y + 0.5) is crossed by an odd number of edges to its left. This is
 * the region the engine's own capture SDK measures face brightness over (the
 * face, not the frame), on the same 0 to 1 scale its lighting bands are
 * published in, so a window behind the person cannot mark the face as lit.
 */
export function meanLumaInside(
  image: GrayscaleImage,
  polygon: readonly Point[],
): number {
  if (polygon.length < 3) {
    return 0;
  }
  const { data, width, height } = image;

  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return 0;
    }
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const firstRow = Math.max(0, Math.floor(minY));
  const lastRow = Math.min(height - 1, Math.ceil(maxY));

  let sum = 0;
  let count = 0;
  const crossings: number[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    const sampleY = row + 0.5;
    crossings.length = 0;
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index] ?? { x: 0, y: 0 };
      const b = polygon[(index + 1) % polygon.length] ?? { x: 0, y: 0 };
      /*
       * Half open on y, so a scanline through a vertex counts the edge that
       * starts there and not the one that ends there, and a vertex is never
       * counted twice.
       */
      const aBelow = a.y <= sampleY;
      const bBelow = b.y <= sampleY;
      if (aBelow === bBelow) {
        continue;
      }
      const t = (sampleY - a.y) / (b.y - a.y);
      crossings.push(a.x + t * (b.x - a.x));
    }
    if (crossings.length < 2) {
      continue;
    }
    crossings.sort((left, right) => left - right);
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const enter = crossings[pair] ?? 0;
      const leave = crossings[pair + 1] ?? 0;
      const from = Math.max(0, Math.ceil(enter - 0.5));
      const to = Math.min(width - 1, Math.floor(leave - 0.5));
      for (let column = from; column <= to; column += 1) {
        sum += data[row * width + column] ?? 0;
        count += 1;
      }
    }
  }

  if (count === 0) {
    return 0;
  }
  return sum / count / 255;
}

function rectangleOf(box: Box): Point[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}

/**
 * How unevenly the face is lit: the difference between the mean luma over the
 * two eye boxes, 0 to 1. Camera Kit's lighting_uneven is the maximum luma
 * difference between the eyes, and this is that number on the same scale. Eye
 * boxes in the image's pixels, as the reading's pixels field carries them.
 */
export function evenness(
  image: GrayscaleImage,
  leftEyeBox: Box,
  rightEyeBox: Box,
): number {
  return Math.abs(
    meanLumaInside(image, rectangleOf(leftEyeBox)) -
      meanLumaInside(image, rectangleOf(rightEyeBox)),
  );
}
