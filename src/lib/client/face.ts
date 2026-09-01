/**
 * Where the face is, approximately, in the browser.
 *
 * The quality gate in src/lib/shared/quality.ts is given a face count and a face
 * box and decides what to do with them. Producing those two values is this
 * module's whole job.
 *
 * Two sources, in order:
 *
 * 1. The browser's Shape Detection API, when it exists. Its result is validated
 *    with zod like any other external response.
 * 2. PROVISIONAL: a skin region heuristic, for every browser that has no
 *    detector. It thresholds the frame in YCbCr, takes the largest connected
 *    region, and reports its bounding box. It over reports height when the neck
 *    and shoulders are lit like the face, so the coverage it produces reads a
 *    little generous.
 *
 * The server recomputes the gate on the uploaded object before a credit is
 * spent (docs/03-architecture.md), so this estimate decides what the person is
 * told, never what is charged.
 *
 * OPEN ITEM: replace the heuristic with a real detector, then recalibrate
 * FACE_COVERAGE_MIN against evals/fixtures/faces.
 */

import { z } from "zod";

import type { Box } from "@/lib/shared/quality";

export type FaceEstimateSource = "detector" | "skin_region";

export type FaceEstimate = {
  readonly faceCount: number;
  /** In the pixel coordinates of the frame that was measured. */
  readonly faceBox: Box | null;
  readonly source: FaceEstimateSource;
};

// ---------------------------------------------------------------------------
// The browser detector
// ---------------------------------------------------------------------------

const detectedFaceSchema = z.object({
  boundingBox: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
});

const detectedFacesSchema = z.array(detectedFaceSchema);

type FaceDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<unknown>;
};

type FaceDetectorConstructor = new (options: {
  maxDetectedFaces: number;
  fastMode: boolean;
}) => FaceDetectorLike;

function faceDetectorConstructor(): FaceDetectorConstructor | null {
  const candidate = (window as unknown as Record<string, unknown>)[
    "FaceDetector"
  ];
  return typeof candidate === "function"
    ? (candidate as FaceDetectorConstructor)
    : null;
}

async function detectWithBrowser(
  canvas: HTMLCanvasElement,
): Promise<FaceEstimate | null> {
  const Detector = faceDetectorConstructor();
  if (Detector === null) {
    return null;
  }
  let raw: unknown;
  try {
    const detector = new Detector({ maxDetectedFaces: 5, fastMode: true });
    raw = await detector.detect(canvas);
  } catch {
    return null;
  }
  const parsed = detectedFacesSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const faces = parsed.data;
  if (faces.length === 0) {
    return { faceCount: 0, faceBox: null, source: "detector" };
  }
  const largest = faces.reduce((best, face) =>
    face.boundingBox.height > best.boundingBox.height ? face : best,
  );
  return {
    faceCount: faces.length,
    faceBox: {
      x: largest.boundingBox.x,
      y: largest.boundingBox.y,
      width: largest.boundingBox.width,
      height: largest.boundingBox.height,
    },
    source: "detector",
  };
}

// ---------------------------------------------------------------------------
// The skin region heuristic
// ---------------------------------------------------------------------------

/** The heuristic runs on a small copy of the frame. 96px is enough and cheap. */
export const SKIN_SAMPLE_LONG_EDGE = 96;

/**
 * The commonly used YCbCr skin range, widened at the dark end so deep skin is
 * not thrown away with the shadows. Chroma is close to tone independent, which
 * is the reason this rule is used at all rather than a brightness rule.
 */
const CB_MIN = 77;
const CB_MAX = 135;
const CR_MIN = 131;
const CR_MAX = 180;
const LUMA_MIN = 25;

/** Below this share of the frame, there is nothing face sized in the picture. */
const NO_FACE_AREA_FRACTION = 0.008;
/** A second region this large, relative to the frame, counts as a second face. */
const SECOND_FACE_AREA_FRACTION = 0.05;
/** and this large relative to the largest region. */
const SECOND_FACE_RELATIVE_FRACTION = 0.45;

type Region = {
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function skinMask(image: ImageData): Uint8Array {
  const { data, width, height } = image;
  const mask = new Uint8Array(width * height);
  for (let index = 0, pixel = 0; pixel < mask.length; index += 4, pixel += 1) {
    const red = data[index] ?? 0;
    const green = data[index + 1] ?? 0;
    const blue = data[index + 2] ?? 0;
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
    const cb = 128 - 0.168736 * red - 0.331264 * green + 0.5 * blue;
    const cr = 128 + 0.5 * red - 0.418688 * green - 0.081312 * blue;
    const isSkin =
      luma >= LUMA_MIN &&
      cb >= CB_MIN &&
      cb <= CB_MAX &&
      cr >= CR_MIN &&
      cr <= CR_MAX;
    mask[pixel] = isSkin ? 1 : 0;
  }
  return mask;
}

/** Four neighbour connected regions of the mask, largest first. */
function regions(mask: Uint8Array, width: number, height: number): Region[] {
  const seen = new Uint8Array(mask.length);
  const found: Region[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || seen[start] === 1) {
      continue;
    }
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);
    const region: Region = {
      area: 0,
      minX: width,
      minY: height,
      maxX: -1,
      maxY: -1,
    };

    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) {
        break;
      }
      const x = index % width;
      const y = (index - x) / width;
      region.area += 1;
      region.minX = Math.min(region.minX, x);
      region.minY = Math.min(region.minY, y);
      region.maxX = Math.max(region.maxX, x);
      region.maxY = Math.max(region.maxY, y);

      if (x > 0 && mask[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x + 1 < width && mask[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && mask[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (
        y + 1 < height &&
        mask[index + width] === 1 &&
        seen[index + width] === 0
      ) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }

    found.push(region);
  }

  return found.sort((a, b) => b.area - a.area);
}

/** The estimate for a small sampled frame, in that frame's own pixels. */
export function estimateFaceFromSkin(sample: ImageData): FaceEstimate {
  const { width, height } = sample;
  const frameArea = width * height;
  const found = regions(skinMask(sample), width, height);
  const largest = found[0];

  if (largest === undefined || largest.area < frameArea * NO_FACE_AREA_FRACTION) {
    return { faceCount: 0, faceBox: null, source: "skin_region" };
  }

  const faceCount = found.filter(
    (region) =>
      region.area >= frameArea * SECOND_FACE_AREA_FRACTION &&
      region.area >= largest.area * SECOND_FACE_RELATIVE_FRACTION,
  ).length;

  return {
    faceCount: Math.max(1, faceCount),
    faceBox: {
      x: largest.minX,
      y: largest.minY,
      width: largest.maxX - largest.minX + 1,
      height: largest.maxY - largest.minY + 1,
    },
    source: "skin_region",
  };
}

function scaleEstimate(estimate: FaceEstimate, scale: number): FaceEstimate {
  if (estimate.faceBox === null) {
    return estimate;
  }
  return {
    ...estimate,
    faceBox: {
      x: estimate.faceBox.x * scale,
      y: estimate.faceBox.y * scale,
      width: estimate.faceBox.width * scale,
      height: estimate.faceBox.height * scale,
    },
  };
}

/**
 * The estimate for a full size frame. Runs the heuristic on a small copy and
 * scales the box back up, so cost does not grow with the frame.
 */
export function estimateFaceFromFrame(
  full: ImageData,
  sample: ImageData,
): FaceEstimate {
  const estimate = estimateFaceFromSkin(sample);
  return scaleEstimate(estimate, full.height / sample.height);
}

/**
 * The estimate used for the frame that is about to be uploaded. Prefers the
 * browser detector and falls back to the heuristic.
 */
export async function estimateFaceForCapture(
  canvas: HTMLCanvasElement,
  full: ImageData,
  sample: ImageData,
): Promise<FaceEstimate> {
  const detected = await detectWithBrowser(canvas);
  if (detected !== null) {
    return detected;
  }
  return estimateFaceFromFrame(full, sample);
}
