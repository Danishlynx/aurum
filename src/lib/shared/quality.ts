/**
 * The capture quality gate, as pure functions over grayscale image data.
 *
 * docs/01-user-flow.md section D: a frame is good enough to send when a face is
 * detected, roughly frontal, filling at least 60 percent of the frame height,
 * sharpness is above threshold (Laplacian variance), and exposure is in range
 * (no blown highlights on the forehead, no crushed shadows).
 *
 * docs/03-architecture.md keeps the deterministic logic pure and shared so the
 * same code runs client side before upload and server side before a credit is
 * spent. Nothing in this file touches the DOM, a canvas, or a provider.
 *
 * Face detection itself is not here. The caller runs a detector and passes the
 * face count and the face box in; this module decides what to do with them.
 */

/**
 * A single channel image. data holds luminance 0 to 255, row major, length
 * width * height. A Uint8ClampedArray from canvas getImageData converted to
 * luminance, or a plain number array in tests, both satisfy this.
 */
export type GrayscaleImage = {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
};

/** A rectangle in image pixels, origin top left. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The frame the face was detected in. */
export type Frame = {
  readonly width: number;
  readonly height: number;
};

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Sharpness is the variance of the Laplacian response, the standard blur
 * measure. On an 8 bit image downscaled to a 1024px long edge, a well focused
 * selfie sits in the hundreds; a motion blurred one collapses toward zero.
 *
 * CALIBRATED against the first real device, 2026-09-02: a Samsung S26 Ultra
 * front camera at night, held steady, was hard rejected in a loop at the old
 * floor of 60. Flagship night processing denoises skin into smooth regions,
 * which suppresses Laplacian variance even when the frame is genuinely usable,
 * and the person had no way forward. The floor now catches only real motion
 * smears (variance collapses toward zero); everything between it and the old
 * floor is borderline, which per docs/01 section D offers "Use it anyway".
 * The provider's own input gate is the true arbiter and refuses for free.
 */
export const SHARPNESS_REJECT_BELOW = 12;
/** Between this and SHARPNESS_REJECT_BELOW the frame is borderline. */
export const SHARPNESS_BORDERLINE_BELOW = 60;

/** A pixel at or above this luminance carries no detail. */
export const BLOWN_LUMINANCE_AT_OR_ABOVE = 250;
/** A pixel at or below this luminance carries no detail. */
export const CRUSHED_LUMINANCE_AT_OR_BELOW = 8;

/** More than this fraction of blown pixels in the measured region is a reject. */
export const BLOWN_FRACTION_REJECT_ABOVE = 0.1;
/** Above this fraction the frame is borderline. */
export const BLOWN_FRACTION_BORDERLINE_ABOVE = 0.04;

/** More than this fraction of crushed pixels is a reject. */
export const CRUSHED_FRACTION_REJECT_ABOVE = 0.35;
/** Above this fraction the frame is borderline. */
export const CRUSHED_FRACTION_BORDERLINE_ABOVE = 0.2;

/**
 * Mean luminance catches the frame that is uniformly too dark or too bright
 * without any single pixel being clipped, which is what a phone camera produces
 * indoors at night or against a window.
 * PROVISIONAL, same calibration note as the sharpness thresholds.
 */
export const MEAN_LUMINANCE_REJECT_BELOW = 40;
export const MEAN_LUMINANCE_BORDERLINE_BELOW = 60;
export const MEAN_LUMINANCE_REJECT_ABOVE = 225;
export const MEAN_LUMINANCE_BORDERLINE_ABOVE = 205;

/**
 * The face must fill at least 60 percent of the frame height.
 * docs/01-user-flow.md section D, quality gate after capture.
 */
export const FACE_COVERAGE_MIN = 0.6;
/**
 * Below the rule but close to it. The person is offered "Use it anyway".
 * Below FACE_COVERAGE_BORDERLINE_MIN the frame is rejected outright, because a
 * small face wastes a Perfect Corp credit.
 */
export const FACE_COVERAGE_BORDERLINE_MIN = 0.52;

// ---------------------------------------------------------------------------
// Pure measurements
// ---------------------------------------------------------------------------

function assertImage(image: GrayscaleImage): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height)) {
    throw new Error("GrayscaleImage width and height must be integers.");
  }
  if (image.width <= 0 || image.height <= 0) {
    throw new Error("GrayscaleImage width and height must be positive.");
  }
  if (image.data.length !== image.width * image.height) {
    throw new Error(
      `GrayscaleImage data length ${image.data.length} does not match ${image.width} by ${image.height}.`,
    );
  }
}

/** The same box in the pixels of an image scaled by this factor. */
export function scaleBox(box: Box, scale: number): Box {
  return {
    x: box.x * scale,
    y: box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

/** Clamps a box to the image bounds. Returns null when nothing is left. */
export function clampBox(box: Box, frame: Frame): Box | null {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(frame.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(frame.height, Math.ceil(box.y + box.height));
  if (right <= left || bottom <= top) {
    return null;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Copies the pixels inside a box into a new image. */
export function cropToBox(image: GrayscaleImage, box: Box): GrayscaleImage {
  assertImage(image);
  const clamped = clampBox(box, image);
  if (clamped === null) {
    throw new Error("Crop box does not overlap the image.");
  }
  const data = new Array<number>(clamped.width * clamped.height);
  for (let row = 0; row < clamped.height; row += 1) {
    const source = (clamped.y + row) * image.width + clamped.x;
    const target = row * clamped.width;
    for (let column = 0; column < clamped.width; column += 1) {
      data[target + column] = image.data[source + column] ?? 0;
    }
  }
  return { data, width: clamped.width, height: clamped.height };
}

/**
 * The variance of the 4 neighbour Laplacian response over the interior pixels.
 * Kernel: 0 1 0 / 1 -4 1 / 0 1 0.
 *
 * A flat image gives 0. A hard edged pattern gives a large number. An image
 * smaller than 3 by 3 has no interior pixel and gives 0, which reads as "not
 * sharp" and is the safe answer.
 */
export function laplacianVariance(image: GrayscaleImage): number {
  assertImage(image);
  const { data, width, height } = image;
  if (width < 3 || height < 3) {
    return 0;
  }

  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const response =
        (data[index - width] ?? 0) +
        (data[index - 1] ?? 0) +
        (data[index + 1] ?? 0) +
        (data[index + width] ?? 0) -
        4 * (data[index] ?? 0);
      sum += response;
      sumOfSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }
  const mean = sum / count;
  return sumOfSquares / count - mean * mean;
}

export type ExposureStats = {
  /** Fraction of pixels at or above BLOWN_LUMINANCE_AT_OR_ABOVE, 0 to 1. */
  readonly blownFraction: number;
  /** Fraction of pixels at or below CRUSHED_LUMINANCE_AT_OR_BELOW, 0 to 1. */
  readonly crushedFraction: number;
  /** Mean luminance over the measured pixels, 0 to 255. */
  readonly meanLuminance: number;
  readonly pixelsMeasured: number;
};

/**
 * Blown highlight and crushed shadow fractions plus the mean.
 *
 * docs/01-user-flow.md names the forehead for highlights. Until face landmarks
 * are wired, assessCapture measures over the face box, which is the closest
 * region we have. Pass a forehead box here once landmarks land.
 */
export function exposureStats(image: GrayscaleImage): ExposureStats {
  assertImage(image);
  const { data } = image;
  const total = data.length;

  let blown = 0;
  let crushed = 0;
  let sum = 0;

  for (let index = 0; index < total; index += 1) {
    const value = data[index] ?? 0;
    sum += value;
    if (value >= BLOWN_LUMINANCE_AT_OR_ABOVE) {
      blown += 1;
    }
    if (value <= CRUSHED_LUMINANCE_AT_OR_BELOW) {
      crushed += 1;
    }
  }

  return {
    blownFraction: blown / total,
    crushedFraction: crushed / total,
    meanLuminance: sum / total,
    pixelsMeasured: total,
  };
}

export type FaceCoverage = {
  /** Face box height divided by frame height, 0 to 1. */
  readonly coverage: number;
  /** True when coverage meets the 60 percent rule. */
  readonly meetsMinimum: boolean;
  /** True when coverage is under the rule but close enough to offer anyway. */
  readonly isBorderline: boolean;
};

/**
 * The 60 percent height rule from docs/01-user-flow.md section D.
 * Height only: a frontal face is taller than it is wide, and width varies with
 * hair and head turn, so height is the stable measure.
 */
export function faceCoverageCheck(faceBox: Box, frame: Frame): FaceCoverage {
  if (frame.height <= 0) {
    throw new Error("Frame height must be positive.");
  }
  const coverage = faceBox.height / frame.height;
  return {
    coverage,
    meetsMinimum: coverage >= FACE_COVERAGE_MIN,
    isBorderline:
      coverage < FACE_COVERAGE_MIN && coverage >= FACE_COVERAGE_BORDERLINE_MIN,
  };
}

// ---------------------------------------------------------------------------
// Auto framing
// ---------------------------------------------------------------------------

/**
 * The share of the crop height the face is framed to fill.
 *
 * 62 percent, which is the oval on the camera screen: it is drawn at h-[62%] of
 * the stage in src/components/capture/CaptureScreen.tsx, and a person who fills
 * it lands a frame the analyzers read. The upload path has no oval to aim at, so
 * this is the number it composes to instead. It sits above FACE_COVERAGE_MIN
 * with room to spare, so a crop that comes out a little loose still clears the
 * rule rather than landing on the line.
 */
export const AUTO_CROP_FACE_COVERAGE = 0.62;

/**
 * The crop never comes closer to the detected box than this share of it.
 *
 * The face box is approximate. The browser detector returns the face without the
 * hair, and the skin region heuristic in src/lib/client/face.ts returns whatever
 * lit skin happened to connect, which can miss the crown and can spill down the
 * neck. Both are wrong in ways a generous margin covers and a tight crop does
 * not, and a crop that cuts the top off the head buys a worse refusal than the
 * one it was trying to avoid.
 */
export const AUTO_CROP_MIN_FACE_MARGIN = 0.4;

/**
 * Width over height the crop aims for: 3 by 4, the portrait shape a phone
 * already takes and the shape the capture stage shows a frame in. It is where
 * the width starts, not where it always ends: the two margins below can pull it
 * either way, and a crop is never allowed to come out landscape.
 */
export const AUTO_CROP_ASPECT = 0.75;

export type AutoCropInput = {
  /** The face box in frame pixels, or null when no face was found. */
  readonly faceBox: Box | null;
  readonly frame: Frame;
};

/**
 * The crop that recomposes a photo around the face it contains, or null when
 * there is nothing to do.
 *
 * Why it exists. The camera path guides framing with the oval; the upload path
 * has no way to ask a photo already in the gallery to have been taken closer. A
 * phone gallery selfie carries the face at 30 to 50 percent of the frame height,
 * the analyzers want more than 60, and on 2026-09-02 one such upload was sent
 * anyway and came back error_src_face_too_small. So the upload path composes the
 * frame itself rather than refusing a photo that has a perfectly good face in it.
 *
 * The rule, in order:
 *
 * 1. No face box, or a face that already meets FACE_COVERAGE_MIN: null. Nothing
 *    is recomposed on a photo that was framed well enough, and a photo with no
 *    face is not a framing problem, it is a refusal the person has to hear.
 * 2. Height is the face height divided by AUTO_CROP_FACE_COVERAGE, which is what
 *    puts the face at 62 percent of the result. That is 1.61 times the face box,
 *    so the margin floor is already cleared with room above the crown.
 * 3. Width starts at that height taken at AUTO_CROP_ASPECT, and is then held
 *    between three limits:
 *
 *    - never closer to the sides of the box than the margin floor, because the
 *      box is approximate and the hair is usually outside it;
 *    - never so wide that the face stops filling the width, which is the
 *      framing the engine itself asks for: the facialColorTones constraints in
 *      endpoints.ts say "face width greater than 60 percent of image width", so
 *      the width is capped at the face width over the same 62 percent the
 *      height uses, and the crop satisfies both readings of the rule;
 *    - never wider than the crop is tall. The square is the limit because a
 *      skin region that ran into bare shoulders is wide, and letting it widen
 *      the crop without bound would push the face back under the rule the crop
 *      exists to satisfy. What gets trimmed at that limit is shoulder, not face.
 *
 * 4. Centered on the face box, slid back inside the picture rather than shrunk,
 *    and clamped to the frame.
 *
 * Pure geometry: no canvas, no pixels. The caller draws it.
 */
export function autoCropBoxFor(input: AutoCropInput): Box | null {
  const { faceBox, frame } = input;
  if (faceBox === null) {
    return null;
  }
  if (frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  if (faceBox.width <= 0 || faceBox.height <= 0) {
    return null;
  }
  if (faceCoverageCheck(faceBox, frame).meetsMinimum) {
    return null;
  }

  const height = Math.min(
    faceBox.height / AUTO_CROP_FACE_COVERAGE,
    frame.height,
  );
  const width = Math.min(
    Math.max(
      height * AUTO_CROP_ASPECT,
      faceBox.width * (1 + AUTO_CROP_MIN_FACE_MARGIN),
    ),
    faceBox.width / AUTO_CROP_FACE_COVERAGE,
    height,
    frame.width,
  );

  const centerX = faceBox.x + faceBox.width / 2;
  const centerY = faceBox.y + faceBox.height / 2;
  const x = Math.min(Math.max(centerX - width / 2, 0), frame.width - width);
  const y = Math.min(Math.max(centerY - height / 2, 0), frame.height - height);

  const crop = clampBox({ x, y, width, height }, frame);
  if (crop === null) {
    return null;
  }
  /*
   * A box that covers the whole picture is not a crop. Returning null says so,
   * which keeps the caller on the untouched frame and off a redraw that would
   * only cost a canvas pass.
   */
  if (crop.width >= frame.width && crop.height >= frame.height) {
    return null;
  }
  return crop;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Every reason a frame can be rejected or flagged, in the order they are shown
 * when a frame fails more than one check. The array is both the value set and
 * the precedence, so the two can never disagree.
 *
 * Face first: without one face and its box, no other measurement means
 * anything. Light next: a badly lit frame also measures as unsharp and often as
 * badly framed, so leading with sharpness would send the person to fix the
 * wrong thing. Framing next, because it is one clear instruction. Sharpness
 * last, because it is the measurement most degraded by the other two.
 */
export const CAPTURE_REASON_PRECEDENCE = [
  "no_face",
  "multiple_faces",
  "too_dark",
  "over_exposed",
  "too_far",
  "blurry",
] as const;

/**
 * The reason a frame was rejected or flagged. Every value has a line of copy in
 * copy.capture.rejection, checked at compile time by captureRejectionCopy.
 */
export type CaptureRejectionReason = (typeof CAPTURE_REASON_PRECEDENCE)[number];

export const CAPTURE_VERDICTS = ["accept", "borderline", "reject"] as const;

export type CaptureVerdict = (typeof CAPTURE_VERDICTS)[number];

export type CaptureFailure = {
  readonly reason: CaptureRejectionReason;
  readonly severity: "reject" | "borderline";
};

export type CaptureMetrics = {
  readonly sharpness: number;
  readonly blownFraction: number;
  readonly crushedFraction: number;
  readonly meanLuminance: number;
  /** Null when there is no face box to measure. */
  readonly faceCoverage: number | null;
};

export type CaptureAssessment = {
  readonly verdict: CaptureVerdict;
  /** The reason to show, chosen by CAPTURE_REASON_PRECEDENCE. Null on accept. */
  readonly reason: CaptureRejectionReason | null;
  /**
   * Whether to offer "Use it anyway". True only for borderline frames, never
   * for a face detection failure. docs/01-user-flow.md section D.
   */
  readonly canUseAnyway: boolean;
  /** Everything that failed, for guidance and for the quality column. */
  readonly failures: readonly CaptureFailure[];
  readonly metrics: CaptureMetrics;
};

export type CaptureAssessmentInput = {
  readonly image: GrayscaleImage;
  /** How many faces the detector found. */
  readonly faceCount: number;
  /** The face box in image pixels, or null when there is no usable face. */
  readonly faceBox: Box | null;
};

/**
 * Runs the whole gate and returns accept, borderline, or reject with the reason
 * key that names a line in copy.capture.rejection.
 *
 * Sharpness and exposure are measured over the face box when there is one, so a
 * bright window behind the person cannot mark the frame as blown and a busy
 * background cannot mask a soft face. With no face box, the whole frame is
 * measured and the verdict is a reject anyway.
 */
export function assessCapture(input: CaptureAssessmentInput): CaptureAssessment {
  const { image, faceCount, faceBox } = input;
  assertImage(image);

  const failures: CaptureFailure[] = [];

  const hasSingleFace = faceCount === 1 && faceBox !== null;
  if (faceCount > 1) {
    failures.push({ reason: "multiple_faces", severity: "reject" });
  } else if (!hasSingleFace) {
    failures.push({ reason: "no_face", severity: "reject" });
  }

  const measured =
    faceBox !== null && clampBox(faceBox, image) !== null
      ? cropToBox(image, faceBox)
      : image;

  const exposure = exposureStats(measured);
  const sharpness = laplacianVariance(measured);
  const coverage =
    faceBox !== null ? faceCoverageCheck(faceBox, image) : null;

  if (
    exposure.crushedFraction > CRUSHED_FRACTION_REJECT_ABOVE ||
    exposure.meanLuminance < MEAN_LUMINANCE_REJECT_BELOW
  ) {
    failures.push({ reason: "too_dark", severity: "reject" });
  } else if (
    exposure.crushedFraction > CRUSHED_FRACTION_BORDERLINE_ABOVE ||
    exposure.meanLuminance < MEAN_LUMINANCE_BORDERLINE_BELOW
  ) {
    failures.push({ reason: "too_dark", severity: "borderline" });
  }

  if (
    exposure.blownFraction > BLOWN_FRACTION_REJECT_ABOVE ||
    exposure.meanLuminance > MEAN_LUMINANCE_REJECT_ABOVE
  ) {
    failures.push({ reason: "over_exposed", severity: "reject" });
  } else if (
    exposure.blownFraction > BLOWN_FRACTION_BORDERLINE_ABOVE ||
    exposure.meanLuminance > MEAN_LUMINANCE_BORDERLINE_ABOVE
  ) {
    failures.push({ reason: "over_exposed", severity: "borderline" });
  }

  if (coverage !== null && !coverage.meetsMinimum) {
    failures.push({
      reason: "too_far",
      severity: coverage.isBorderline ? "borderline" : "reject",
    });
  }

  if (sharpness < SHARPNESS_REJECT_BELOW) {
    failures.push({ reason: "blurry", severity: "reject" });
  } else if (sharpness < SHARPNESS_BORDERLINE_BELOW) {
    failures.push({ reason: "blurry", severity: "borderline" });
  }

  const metrics: CaptureMetrics = {
    sharpness,
    blownFraction: exposure.blownFraction,
    crushedFraction: exposure.crushedFraction,
    meanLuminance: exposure.meanLuminance,
    faceCoverage: coverage === null ? null : coverage.coverage,
  };

  const rejection = firstByPrecedence(failures, "reject");
  if (rejection !== null) {
    return {
      verdict: "reject",
      reason: rejection,
      canUseAnyway: false,
      failures,
      metrics,
    };
  }

  const borderline = firstByPrecedence(failures, "borderline");
  if (borderline !== null) {
    return {
      verdict: "borderline",
      reason: borderline,
      canUseAnyway: true,
      failures,
      metrics,
    };
  }

  return {
    verdict: "accept",
    reason: null,
    canUseAnyway: false,
    failures,
    metrics,
  };
}

function firstByPrecedence(
  failures: readonly CaptureFailure[],
  severity: CaptureFailure["severity"],
): CaptureRejectionReason | null {
  for (const reason of CAPTURE_REASON_PRECEDENCE) {
    const hit = failures.find(
      (failure) => failure.reason === reason && failure.severity === severity,
    );
    if (hit !== undefined) {
      return hit.reason;
    }
  }
  return null;
}
