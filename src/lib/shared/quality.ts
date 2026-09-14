/**
 * The capture quality gate, as pure functions over grayscale image data.
 *
 * docs/01-user-flow.md section D: a frame is good enough to send when a face is
 * detected, roughly frontal, filling at least 60 percent of the frame height,
 * sharpness is above threshold (Laplacian variance), and exposure is in range
 * (no blown highlights on the forehead, no crushed shadows).
 *
 * Failing a check and being refused are different things. Only face detection
 * and the exposure extremes refuse a frame outright. Everything else is
 * borderline: the person is told what is wrong, Retake is the primary answer,
 * and "Use it anyway" is there under it. See assessCapture.
 *
 * docs/03-architecture.md keeps the deterministic logic pure and shared so the
 * same code runs client side before upload and server side before a credit is
 * spent. Nothing in this file touches the DOM, a canvas, or a provider.
 *
 * Face detection itself is not here. The caller runs a detector and passes the
 * face count, the face box, and the head position in; this module decides what
 * to do with them.
 */

import type { FacePose } from "./pose";

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
 * The one size sharpness is ever measured at.
 *
 * Laplacian variance is not a property of a photograph, it is a property of a
 * photograph at a resolution. Resampling smaller averages sensor noise away and
 * carries the same edge across fewer pixels, so one frame reads one number at a
 * 1024px long edge and quite another at a small preview sample. Two places in
 * this app ask "is this sharp": the live line under the oval and this gate.
 * Measured at their own sizes they cannot share a threshold, and on 2026-09-03
 * they did not. On a Samsung S26 Ultra indoors at night the live line read
 * "Good. Tap to capture." and the gate answered "A little blurry." on the very
 * frame that had just been tapped. Every shot, every angle.
 *
 * So there is one measurement, sharpnessOf below, which resamples whatever it is
 * handed down to this long edge before it measures anything.
 * src/lib/client/guidance.ts and assessCapture both call it, and that is what
 * makes "Good" and the verdict the same computation on the same face.
 *
 * 96, because both callers reach it by resampling down and neither ever has to
 * resample up. The gate measures the face box inside a 1024px capture, which is
 * 614px tall at the moment it clears FACE_COVERAGE_MIN. The guidance measures
 * the face box inside a preview sample sized in guidance.ts so that the same
 * face clears 96 there too. A face smaller than that on either side is a framing
 * problem, and too_far comes before blurry in CAPTURE_REASON_PRECEDENCE, so
 * sharpness is never the thing a person is told about a face too small to
 * measure it on.
 */
export const SHARPNESS_MEASURE_LONG_EDGE = 96;

/**
 * What the normalized ratio is multiplied by before anybody compares it to a
 * threshold. Nothing but readability: it puts a typical face somewhere in the
 * tens rather than at 0.0x, so a logged value can be read at a glance.
 */
export const SHARPNESS_SCALE = 100;

/**
 * Below this, at the measurement size above, a frame is borderline. There is no
 * reject threshold for sharpness. That is a decision, not an omission: see
 * assessCapture.
 *
 * RECALIBRATED 2026-09-07, when the measurement changed underneath it.
 *
 * What changed and why. Until this date sharpnessOf returned a bare Laplacian
 * variance, which is an absolute quantity of edge energy. Edge energy scales
 * with the contrast of whatever is being measured, so the number a face produced
 * was as much a reading of that face's contrast as of its focus. Two frames of
 * the same person at the same focus, one in flat window light and one in raking
 * light, read far apart. Worse, and this is the part that made it a product
 * failure rather than a rounding error: a deeply pigmented face in soft light
 * carries less local luminance contrast than a pale one under the same lamp, so
 * the measurement ran systematically low on exactly the skin tones this product
 * exists to serve, and told those people their perfectly sharp photograph was
 * blurry. docs/00-product.md calls tools that do this the problem the product is
 * answering, so shipping one inside the capture screen was not a defect we could
 * leave in place.
 *
 * sharpnessOf now divides that edge energy by the region's own intensity
 * variance. The ratio asks what share of the region's contrast sits at high
 * frequency, which is what focus actually is, and it is invariant to how much
 * contrast the face had to begin with. Blur still moves it, and moves it hard,
 * because defocus attenuates high frequencies far faster than it attenuates the
 * overall spread.
 *
 * What the change is worth, measured on the fixtures these suites already carry.
 * sharpMidtones (levels 60, 120, 180) and dimSharp (levels 30, 45, 60) are the
 * same pattern at the same focus, one of them dim and low contrast. Under the
 * old measurement they read far apart. Under this one they both read 3600.02,
 * which is the property the gate needed and did not have. A square wave of
 * period 8 reads 65.7 in focus, 41.8 under a 3 pixel box blur, 33.2 under 4, and
 * 19.8 under 6.
 *
 * The number below is set from those synthetic patterns rather than from
 * photographs, and it is therefore PROVISIONAL in the strongest sense: it is a
 * shape, not a measurement. It sits low on purpose. The cost of flagging a frame
 * that was fine is a person sent back to the camera for nothing, which is the
 * failure this whole change exists to remove, and the cost of missing a soft
 * frame is a couple of seconds against a provider gate that is free and reads
 * focus better than we do. Setting it from real faces is
 * docs/SUBMISSION-RUNBOOK.md C4, and nothing about it can refuse a frame in the
 * meantime.
 */
export const SHARPNESS_BORDERLINE_BELOW = 20;

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
// The provider's own rule, in the provider's own terms
// ---------------------------------------------------------------------------

/**
 * The rule the engine actually applies, which is not the one above.
 *
 * Read verbatim off ai_skin_analysis, ai_face_analyzer and ai_skin_tone_analysis
 * on 2026-09-07, where it appears as a warning block on all three:
 *
 *     "The width of the face needs to be greater than 60% of the width of the
 *      image."
 *
 * and refined by the Camera Kit quality configuration on the same page, which
 * states how the ratio is taken: "Landscape mode: vertical ratio. Portrait mode:
 * horizontal ratio." So it is the face's width against the image's SHORT axis,
 * and for the portrait frames this app sends, the short axis is the width.
 *
 * Why this is not the same check as FACE_COVERAGE_MIN, and why both now exist.
 * Ours measured face height against frame height. A face is roughly three
 * quarters as wide as it is tall, so a face sitting exactly on our 60 percent
 * height rule inside a 768 by 1024 frame is about 460 pixels wide, which is
 * 0.599 of the width. Our gate passed at precisely the value the engine refuses
 * at. Every frame that cleared our rule by a hair failed theirs, and the face box
 * that decided it came from an estimator that runs down the neck and reports
 * boxes larger than the face, so the error only ever pointed one way.
 *
 * The band, not just the floor. The same page asks for "approximately 60 to 80
 * percent of image width", and error_face_position_out_of_boundary is waiting
 * above it for a face that runs off the edge, so this is a window and the gate
 * checks both sides of it.
 *
 * Why nothing here ever refuses a frame, only flags one. A face that is small in
 * the picture is the one framing failure this codebase can fix without asking
 * the person for anything: autoCropBoxFor composes the frame around the face,
 * and it already targets this same ratio (see the width cap in that function).
 * Refusing a photograph we could simply recompose would be choosing to send
 * somebody back to the camera in order to avoid a canvas operation. The height
 * rule above still refuses a face far too small to crop usefully, which is the
 * case where there is genuinely nothing to compose from.
 */
export const FACE_WIDTH_RATIO_MIN = 0.6;

/**
 * The top of the documented band. Above it the face starts leaving the frame,
 * and error_face_position_out_of_boundary is what the engine answers with.
 */
export const FACE_WIDTH_RATIO_MAX = 0.86;

// ---------------------------------------------------------------------------
// Head pose
// ---------------------------------------------------------------------------

/**
 * The pose window, in the degrees src/lib/shared/pose.ts defines.
 *
 * Every one of these is inside what the app now asks the engine for. Since
 * 2026-09-07 the two endpoints that gate on pose are called with
 * face_angle_strictness_level "flexible", which is 30 degrees on all three axes
 * (DEFAULT_FACE_ANGLE_STRICTNESS in
 * src/lib/server/providers/perfectcorp/schemas.ts). The numbers below are the
 * Camera Kit RELAXED profile, which is tighter, so a frame this gate accepts is
 * one the engine has room to take rather than one sitting on its boundary.
 *
 * Pitch is asymmetric because the provider's is. RELAXED allows -20 to +10, and
 * the sign convention in pose.ts makes a lifted chin positive, so the tight half
 * is the one a phone held below the face pushes into. That is the 2026-09-03
 * refusal (error_face_angle_downward) written as a number the gate can check
 * before a unit is spent instead of after.
 */
export const POSE_YAW_MAX_DEGREES = 15;
export const POSE_ROLL_MAX_DEGREES = 15;
export const POSE_PITCH_MAX_DEGREES = 10;
export const POSE_PITCH_MIN_DEGREES = -20;

/**
 * How far past the window a frame can sit and still be offered rather than
 * refused, and why there is any slack at all.
 *
 * Two reasons, both about the estimate rather than the pose. The landmark
 * estimator in pose.ts is a heuristic with provisional scales on it, and even
 * the accurate path is solving for a head position off a single photograph. And
 * the strictness level the engine is called with is looser than this window, so
 * a frame a little outside it is one the engine may well still read.
 *
 * So the window is where the line goes green, the window plus this slack is
 * where the frame is offered with "Use it anyway", and past that is where the
 * engine is certain enough to refuse that spending a person's time on it would
 * be worse than saying so.
 */
export const POSE_SLACK_DEGREES = 12;

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

/**
 * The same picture with its long edge at longEdge, by box average.
 *
 * Never scales up: an image already at or under the target is returned as it is,
 * because inventing pixels would invent the detail the caller is about to
 * measure. Each output pixel is the mean of the input pixels its cell covers,
 * which is the resampling a canvas does at high smoothing quality and the reason
 * the number this produces tracks what the browser would have produced.
 *
 * Pure, so the gate can run this identically on a phone before an upload and on
 * the server before a credit is spent.
 */
export function resampleToLongEdge(
  image: GrayscaleImage,
  longEdge: number,
): GrayscaleImage {
  assertImage(image);
  if (longEdge <= 0) {
    throw new Error("Resample long edge must be positive.");
  }
  const largest = Math.max(image.width, image.height);
  if (largest <= longEdge) {
    return image;
  }

  const scale = longEdge / largest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Array<number>(width * height);

  for (let y = 0; y < height; y += 1) {
    const top = Math.floor((y * image.height) / height);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const left = Math.floor((x * image.width) / width);
      const right = Math.max(left + 1, Math.floor(((x + 1) * image.width) / width));
      let sum = 0;
      let count = 0;
      for (let row = top; row < bottom; row += 1) {
        for (let column = left; column < right; column += 1) {
          sum += image.data[row * image.width + column] ?? 0;
          count += 1;
        }
      }
      data[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }

  return { data, width, height };
}

/**
 * The sharpness of a frame, or of one region of it. The only sharpness
 * measurement in the app.
 *
 * Crop to the region when there is one, so a busy background cannot stand in for
 * a soft face and a plain wall cannot make a sharp one look soft. Then resample
 * to SHARPNESS_MEASURE_LONG_EDGE, so the number does not depend on whether the
 * caller happened to be holding a 1024px capture or a preview sample. Then
 * measure. Both callers, the live guidance line and the gate, do exactly this.
 */
export function sharpnessOf(
  image: GrayscaleImage,
  region: Box | null = null,
): number {
  assertImage(image);
  const measured =
    region !== null && clampBox(region, image) !== null
      ? cropToBox(image, region)
      : image;
  const resampled = resampleToLongEdge(measured, SHARPNESS_MEASURE_LONG_EDGE);
  const contrast = intensityVariance(resampled);
  if (contrast <= 0) {
    return 0;
  }
  return (laplacianVariance(resampled) / contrast) * SHARPNESS_SCALE;
}

/** Variance of the pixel values themselves. The contrast of the region. */
export function intensityVariance(image: GrayscaleImage): number {
  assertImage(image);
  const { data } = image;
  const count = data.length;
  if (count === 0) {
    return 0;
  }
  let sum = 0;
  let sumOfSquares = 0;
  for (let index = 0; index < count; index += 1) {
    const value = data[index] ?? 0;
    sum += value;
    sumOfSquares += value * value;
  }
  const mean = sum / count;
  return Math.max(0, sumOfSquares / count - mean * mean);
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
 * Where the composed crop puts the face, as a share of the crop's width.
 *
 * This is the number the engine actually measures (FACE_WIDTH_RATIO_MIN, "the
 * width of the face needs to be greater than 60 percent of the width of the
 * image"), so it is the number the crop is built from rather than one it
 * happens to satisfy.
 *
 * 0.66 sits inside the provider's documented band of roughly 60 to 80 percent,
 * near the bottom of it. Low on purpose: every point higher is a tighter crop,
 * and a tighter crop is what cuts a forehead off. The floor is 0.60 and the
 * margin above it absorbs the rounding that clampBox does when the box is
 * turned into whole pixels.
 */
export const AUTO_CROP_FACE_WIDTH_TARGET = 0.66;

/**
 * How much room is kept above the face box, as a share of its height, for the
 * forehead and the hair.
 *
 * A face box is not a head, and the difference is what broke the framing on
 * 2026-09-10. MediaPipe reports eyebrows to chin; a head with hair on it extends
 * roughly half a face height further up. Keeping 0.45 of a face height above the
 * box covers the forehead and most of the hair, and the crop is placed to honour
 * it rather than centring and hoping.
 *
 * PROVISIONAL, in the same sense as every other number in this file: it is
 * derived from where a detector puts its box and from the provider's "forehead
 * fully revealed", not from measurements over a set of real faces. It errs
 * loose, because the two failures are not symmetric. A crop that is too loose is
 * refused with error_src_face_too_small, which costs nothing and which the
 * reframe path answers by cropping tighter. A crop that is too tight cuts a
 * person's forehead off, and no retry recovers it.
 */
export const AUTO_CROP_HEAD_ROOM_ABOVE = 0.45;

/**
 * How much room is kept below the face box, as a share of its height.
 *
 * Small, and not zero. The jaw needs somewhere to sit: a crop that ends exactly
 * at the bottom of the face box is a face touching the edge of its own picture,
 * which is what error_face_position_out_of_boundary names and which the gate
 * flags as face_out_of_bounds before it is ever sent.
 *
 * It is a quarter of the room kept above because the two sides are not worth the
 * same. Above the face is forehead and hair and the provider asks for both;
 * below it is chin, neck and shoulders, and a reading needs none of them.
 */
export const AUTO_CROP_CHIN_ROOM_BELOW = 0.12;

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
 *    and then floored at the width of the face box itself, which outranks all
 *    three: a crop narrower than the face is a face cut down the side, and no
 *    framing rule is worth that.
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
  /*
   * A face box wider than the picture it came from cannot be composed around.
   * Every crop below is at least as wide as the box, so there is nothing left to
   * cut that would not be face, and null keeps the caller on the untouched
   * frame. It is a detection that has gone wrong rather than a framing problem:
   * the gate answers for the frame, and the engine answers for the photograph.
   */
  if (faceBox.width > frame.width) {
    return null;
  }
  /*
   * Both rules have to be satisfied before there is nothing to do, and until
   * 2026-09-07 only the first of them was checked here.
   *
   * The height rule is ours and the width rule is the engine's, and they are not
   * the same statement about a photograph. Take the front camera's usual 3 by 4
   * frame at 768 by 1024, and a person filling the oval exactly: the face is 635
   * pixels tall, which clears the 62 percent the oval is drawn to, and about 432
   * wide, which is 0.56 of the short axis. The engine wants more than 0.60 and
   * refuses at that number. So the frame passed this function untouched, was sent
   * whole, and came back error_src_face_too_small, and the only thing offered to
   * the person was a suggestion that they take it again.
   *
   * Checking the width ratio here means the composition step now fires on exactly
   * the frames the engine would have refused for framing, camera and gallery
   * alike, and the crop it produces targets AUTO_CROP_FACE_COVERAGE, which clears
   * FACE_WIDTH_RATIO_MIN with margin rather than landing on it.
   */
  const coverage = faceCoverageCheck(faceBox, frame);
  const widthRatio = faceWidthRatio(faceBox, frame);
  if (coverage.meetsMinimum && widthRatio >= FACE_WIDTH_RATIO_MIN) {
    return null;
  }

  /*
   * The width is what the engine measures, so the width is what the crop is
   * built from. Everything else follows.
   *
   * AUTO_CROP_FACE_WIDTH_TARGET sits just inside the provider's own band rather
   * than in the middle of it, deliberately. Aiming higher would make the crop
   * tighter, and a tighter crop is the thing that cuts a forehead off.
   */
  const height = Math.min(
    faceBox.width / AUTO_CROP_FACE_WIDTH_TARGET / AUTO_CROP_ASPECT,
    frame.height,
  );
  /*
   * The floor is the face itself, and it outranks every cap above it.
   *
   * Each of those caps is there to stop a crop being too loose, and two of them
   * can take the width below the width of the face box: the picture's own width
   * on a frame narrower than the crop wants, and the height cap on a landscape
   * frame with a wide box. A width under faceBox.width is a crop that cuts a
   * face in half down the side, which is the one framing mistake no retry
   * recovers and is strictly worse than the thing the caps exist to prevent.
   * A face left a little too large in the frame is answered by the gate as
   * too_close and by the engine as a refusal, both of which are free.
   */
  const width = Math.max(
    faceBox.width,
    Math.min(
      /*
       * Never landscape, whatever the box says. The provider states that "the
       * use of a portrait aspect ratio is strongly recommended over landscape",
       * and a box wider than it is tall is a detection this app should not be
       * reshaping the picture around: it is the colour threshold fallback
       * reporting a neck and two shoulders. Capping the width at the height
       * keeps the frame the shape a face belongs in and trims shoulder rather
       * than face.
       */
      Math.min(faceBox.width / AUTO_CROP_FACE_WIDTH_TARGET, height),
      frame.width,
    ),
  );

  const centerX = faceBox.x + faceBox.width / 2;

  /*
   * Vertically the crop is NOT centred on the face box, and this is the fix for
   * the refusals of 2026-09-10.
   *
   * A face box is not a head. The detector this app used until 2026-09-07 was a
   * skin colour threshold whose box already ran up over the forehead and down
   * the neck, so centring on it happened to leave room for hair. MediaPipe's box
   * is a real face box: eyebrows to chin, cheek to cheek, and nothing else. The
   * geometry was never re derived when the detector changed, so the same
   * centring left only 0.3 face heights above the box, the crown and part of the
   * forehead were cut off, and the engine, which asks for the forehead to be
   * fully revealed, answered that it could not read the face.
   *
   * So the room above and below the box is now asked for by name.
   * AUTO_CROP_HEAD_ROOM_ABOVE is the share of a face height kept above the box
   * for forehead and hair, and the crop is placed to honour it wherever the
   * height allows. What is left goes below, where it is neck and shoulders and
   * where losing some costs nothing.
   *
   * The asymmetry is the whole point. Above the face is where a crop can fail;
   * below it is where a crop can be generous for free.
   */
  const spare = Math.max(0, height - faceBox.height);
  const wantAbove = faceBox.height * AUTO_CROP_HEAD_ROOM_ABOVE;
  const wantBelow = faceBox.height * AUTO_CROP_CHIN_ROOM_BELOW;
  /*
   * Shared out rather than taken. Spending the whole spare height on the
   * forehead puts the chin exactly on the bottom edge, which is a face touching
   * the boundary of its own picture and is what
   * error_face_position_out_of_boundary names. The split keeps the asymmetry
   * (most of it goes above, where a crop can fail) while always leaving the jaw
   * somewhere to sit.
   */
  const wanted = wantAbove + wantBelow;
  const roomAbove =
    wanted <= 0 ? 0 : Math.min(wantAbove, (spare * wantAbove) / wanted);
  const desiredTop = faceBox.y - roomAbove;

  const x = Math.min(Math.max(centerX - width / 2, 0), Math.max(0, frame.width - width));
  const y = Math.min(Math.max(desiredTop, 0), Math.max(0, frame.height - height));

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
  "face_out_of_bounds",
  "too_far",
  "too_close",
  "facing_away",
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
  /**
   * Face width over the frame's short axis, which is the ratio the engine
   * measures (FACE_WIDTH_RATIO_MIN). Null when there is no face box.
   */
  readonly faceWidthRatio: number | null;
  /** Null when the detector could not solve for a head position. */
  readonly pose: FacePose | null;
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
  /**
   * The head position, when the detector could solve for one.
   *
   * Optional, and absent is not the same as square to the lens: a frame with no
   * pose is simply not judged on pose, which is what every frame did before
   * 2026-09-07. A detector that reports one gets the pose checks; one that does
   * not is no worse off than it was.
   */
  readonly pose?: FacePose | null;
  /**
   * Whether the face count and box came from something that can actually see a
   * face. Defaults to true, so a caller that does not say keeps the old
   * behaviour.
   *
   * False means the numbers came from the YCbCr colour threshold in
   * src/lib/client/face.ts, which is what answers when the detector has not
   * loaded. That estimator does not find faces; it finds skin coloured blobs. It
   * misses deep skin under warm light entirely, it merges a face with a wooden
   * wall behind it, and it reads a bare arm as a second person.
   *
   * A guess that wrong is not grounds for refusing to send somebody's
   * photograph. When it is the only source available, the frame is offered
   * instead of refused, and the decision is left to the engine's own input gate,
   * which is free, authoritative, and refuses for nothing when it says no. This
   * is the same reasoning that already keeps sharpness from refusing a frame.
   */
  readonly faceEstimateTrusted?: boolean;
};

/**
 * Face width over the frame's short axis, which is the ratio the engine gates
 * on. See FACE_WIDTH_RATIO_MIN for why this is not faceCoverageCheck.
 */
export function faceWidthRatio(faceBox: Box, frame: Frame): number {
  const shortAxis = Math.min(frame.width, frame.height);
  if (shortAxis <= 0) {
    throw new Error("Frame width and height must be positive.");
  }
  return faceBox.width / shortAxis;
}

/**
 * True when any edge of the face box has reached the edge of the frame, which is
 * what error_face_position_out_of_boundary names.
 *
 * A tolerance of one pixel rather than an exact touch: a box that came back from
 * a detector at the very edge of its own coordinate space is at the edge of the
 * picture, and rounding should not decide it.
 */
export function faceIsClipped(faceBox: Box, frame: Frame): boolean {
  return (
    faceBox.x <= 1 ||
    faceBox.y <= 1 ||
    faceBox.x + faceBox.width >= frame.width - 1 ||
    faceBox.y + faceBox.height >= frame.height - 1
  );
}

export type PoseVerdict = "ok" | "borderline" | "reject";

/** How far outside the pose window a head sits, in degrees. Zero when inside. */
export function poseExcessDegrees(pose: FacePose): number {
  const yaw = Math.max(0, Math.abs(pose.yawDegrees) - POSE_YAW_MAX_DEGREES);
  const roll = Math.max(0, Math.abs(pose.rollDegrees) - POSE_ROLL_MAX_DEGREES);
  const pitch = Math.max(
    0,
    Math.max(
      pose.pitchDegrees - POSE_PITCH_MAX_DEGREES,
      POSE_PITCH_MIN_DEGREES - pose.pitchDegrees,
    ),
  );
  return Math.max(yaw, roll, pitch);
}

export function poseVerdictFor(pose: FacePose | null | undefined): PoseVerdict {
  if (pose === null || pose === undefined) {
    return "ok";
  }
  const excess = poseExcessDegrees(pose);
  if (excess <= 0) {
    return "ok";
  }
  return excess <= POSE_SLACK_DEGREES ? "borderline" : "reject";
}

/**
 * Runs the whole gate and returns accept, borderline, or reject with the reason
 * key that names a line in copy.capture.rejection.
 *
 * Sharpness and exposure are measured over the face box when there is one, so a
 * bright window behind the person cannot mark the frame as blown and a busy
 * background cannot mask a soft face. With no face box, the whole frame is
 * measured and the verdict is a reject anyway.
 *
 * What can reach "reject", and nothing else can:
 *
 * - no_face and multiple_faces, per docs/01 section D. Without exactly one face
 *   there is no reading to be had, and picking a face out of a group is not a
 *   decision this screen makes.
 * - too_dark and over_exposed at the extremes: crushed or blown past the reject
 *   fractions, or a mean luminance outside the reject bounds. Nothing can be
 *   read off a black or a white frame, so sending one spends a credit on a
 *   refusal.
 * - too_far below FACE_COVERAGE_BORDERLINE_MIN, where the engine's own
 *   error_src_face_too_small is waiting.
 *
 * Sharpness is deliberately not on that list at any value.
 */
export function assessCapture(input: CaptureAssessmentInput): CaptureAssessment {
  const { image, faceCount, faceBox } = input;
  const pose = input.pose ?? null;
  assertImage(image);

  const failures: CaptureFailure[] = [];

  /*
   * A face claim is only strong enough to refuse a photograph when it came from
   * something that can see faces. See faceEstimateTrusted above: when the
   * detector has not loaded, these two numbers are a colour threshold's opinion,
   * and the engine's own gate is both better at the question and free to ask.
   *
   * multiple_faces is downgraded along with no_face, deliberately, even though
   * docs/06-safety-privacy.md asks for a frame with two faces to be refused. The
   * rule is kept, it is just enforced by the party that can actually count: every
   * face endpoint this app calls is single face only and answers
   * error_multiple_people, which src/lib/shared/analysis-failure.ts classifies and
   * turns back into the same sentence this screen would have shown. What is given
   * up is refusing a bare arm; what is bought is not refusing a person.
   */
  const trusted = input.faceEstimateTrusted ?? true;
  const faceSeverity: CaptureFailure["severity"] = trusted
    ? "reject"
    : "borderline";
  const hasSingleFace = faceCount === 1 && faceBox !== null;
  if (faceCount > 1) {
    failures.push({ reason: "multiple_faces", severity: faceSeverity });
  } else if (!hasSingleFace) {
    failures.push({ reason: "no_face", severity: faceSeverity });
  }

  const measured =
    faceBox !== null && clampBox(faceBox, image) !== null
      ? cropToBox(image, faceBox)
      : image;

  const exposure = exposureStats(measured);
  /*
   * The face box rather than the cropped copy, because sharpnessOf does its own
   * cropping and then its own resampling, and the resampling is the whole point:
   * it is what makes this number the same number the live guidance line got off
   * a preview sample of the same face.
   */
  const sharpness = sharpnessOf(image, faceBox);
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

  /*
   * The engine's own framing rule, checked in the engine's own terms. It sits
   * beside the height rule above rather than replacing it, because they are two
   * different statements about the same photograph and the person is served by
   * both: the height rule is what the oval on the camera screen is drawn to, and
   * this one is what the reading will actually be refused for.
   */
  const widthRatio = faceBox !== null ? faceWidthRatio(faceBox, image) : null;
  if (widthRatio !== null) {
    if (widthRatio < FACE_WIDTH_RATIO_MIN) {
      failures.push({ reason: "too_far", severity: "borderline" });
    } else if (widthRatio > FACE_WIDTH_RATIO_MAX) {
      failures.push({ reason: "too_close", severity: "borderline" });
    }
  }

  /*
   * A face already touching the edge of the picture is the one framing failure
   * the reframe path cannot answer, because that path only ever crops tighter.
   * Saying so here, before the upload, is the difference between one instruction
   * and two wasted attempts (isReframeableFailure in
   * src/lib/shared/analysis-failure.ts).
   */
  if (faceBox !== null && faceIsClipped(faceBox, image)) {
    failures.push({ reason: "face_out_of_bounds", severity: "borderline" });
  }

  const poseVerdict = poseVerdictFor(pose);
  if (poseVerdict !== "ok") {
    failures.push({
      reason: "facing_away",
      severity: poseVerdict === "reject" ? "reject" : "borderline",
    });
  }

  /*
   * Borderline at every value, never a reject. Softness is the one thing on this
   * screen we are worse at judging than the engine that is about to read the
   * photo: its input gate is free, it is authoritative, and it answers in a
   * couple of seconds. A frame we call soft and it would have read is a person
   * sent back to the camera for nothing, which is exactly the loop the S26 Ultra
   * was stuck in on 2026-09-03. So a soft frame is always offered: the words say
   * it is soft, Retake is still the primary answer, and "Use it anyway" is there
   * underneath it. Only face detection (docs/01 section D) and the exposure
   * extremes, which cost a credit for a reading nothing can come of, refuse.
   */
  if (sharpness < SHARPNESS_BORDERLINE_BELOW) {
    failures.push({ reason: "blurry", severity: "borderline" });
  }

  const metrics: CaptureMetrics = {
    sharpness,
    blownFraction: exposure.blownFraction,
    crushedFraction: exposure.crushedFraction,
    meanLuminance: exposure.meanLuminance,
    faceCoverage: coverage === null ? null : coverage.coverage,
    faceWidthRatio: widthRatio,
    pose,
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
