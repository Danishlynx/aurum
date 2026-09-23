/**
 * The capture quality gate, as pure functions over grayscale image data and a
 * face reading.
 *
 * docs/01-user-flow.md section D: a frame is good enough to send when the
 * landmarker measured exactly one face, the face is wide enough in the frame
 * and inside its edges, the head is roughly square to the lens, and the light
 * over the face is in range (no blown highlights, no crushed shadows).
 *
 * Failing a check and being refused are different things. Only face detection
 * (measured, and no face or more than one), the exposure extremes and a face
 * far too small refuse a frame outright. Everything else is borderline: the
 * person is told what is wrong, Retake is the primary answer, and "Use it
 * anyway" is there under it. A frame the landmarker never measured is
 * borderline too, with the reason unmeasured, because a gate that measured
 * nothing has no grounds to refuse anything. See assessCapture.
 *
 * docs/03-architecture.md keeps the deterministic logic pure and shared so the
 * same code can run client side before upload and server side before a credit
 * is spent. Nothing in this file touches the DOM, a canvas, or a provider.
 *
 * Face detection itself is not here. The caller runs the landmarker
 * (src/lib/client/landmarks.ts) and passes the face count and the reading
 * (src/lib/shared/face-reading.ts) in; this module decides what to do with
 * them.
 *
 * The frame is the master frame contract of src/lib/shared/frame-geometry.ts:
 * the width bands and the edge margins the gate applies are defined there and
 * imported here. Box, Frame and clampBox live in src/lib/shared/box.ts, a
 * leaf both modules read, so there is no cycle between the gate and the
 * geometry; they are re exported from here for the callers that always found
 * them here.
 */

import { clampBox, type Box, type Frame } from "./box";
import {
  evenness,
  facePixelsIn,
  meanLumaInside,
  type Blink,
  type FaceReading,
} from "./face-reading";
import {
  FACE_WIDTH_ENGINE_MIN,
  FACE_WIDTH_REJECT_BELOW,
  FRAME_OVAL_WIDTH,
  ovalTouchesEdge,
  type Point,
} from "./frame-geometry";
import type { FacePose } from "./pose";

export { clampBox };
export type { Box, Frame };

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

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * The one size sharpness is ever measured at.
 *
 * Laplacian variance is not a property of a photograph, it is a property of a
 * photograph at a resolution. Resampling smaller averages sensor noise away and
 * carries the same edge across fewer pixels, so one frame reads one number at
 * the burst's 512px measure copy and quite another at a small preview sample.
 * Two places in
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
 * resample up: the gate measures the face oval inside the burst's 512px copy
 * of the master frame (BURST_MEASURE_LONG_EDGE) and the guidance measures it
 * inside a 384px master sample (GUIDANCE_SAMPLE_LONG_EDGE), both sized so that
 * a face wide enough to send clears 96. A face smaller than that on either side
 * is a framing problem, and too_far comes long before anything sharpness could
 * say, so sharpness is never the thing a person is told about a face too small
 * to measure it on.
 */
export const SHARPNESS_MEASURE_LONG_EDGE = 96;

/**
 * What the normalized ratio is multiplied by before anybody compares it to a
 * threshold. Nothing but readability: it puts a typical face somewhere in the
 * tens rather than at 0.0x, so a logged value can be read at a glance.
 *
 * There is no sharpness threshold of any kind. Sharpness is measured, recorded
 * in the metrics for calibration, and used only to rank the frames of a burst
 * (frameScore). It refuses nothing and flags nothing: the engine publishes no
 * blur code (docs/04-integrations.md), and the one threshold this file ever
 * carried was set from synthetic stripes and called a sharp, deeply pigmented
 * face blurry on a real phone (2026-09-03). The measurement itself is
 * contrast normalized since 2026-09-07 (see sharpnessOf) so the recorded
 * number is a focus measure rather than a contrast measure.
 */
export const SHARPNESS_SCALE = 100;

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
 * The light over the face, on a 0 to 1 scale, measured as the mean luma inside
 * the face oval polygon (meanLumaInside in src/lib/shared/face-reading.ts), or
 * over the whole frame when there is no face to measure it on.
 *
 * This is the region and the scale the engine's own capture SDK measures face
 * brightness in (docs/04-integrations.md, the Camera Kit rows: lighting 0.55
 * to 0.80 RELAXED), so a window behind the person cannot mark the face as lit
 * and a dark wall cannot mark it as dark. The bands below are today's mean
 * luminance bands (40, 60, 205 and 225 of 255) mapped onto that scale and
 * nothing else: the numbers keep their values until the calibration report
 * (npm run calibration:report) shows the engine refusing on the other side of
 * one. CAMERA_KIT_RELAXED_LUMA_LOW and HIGH are recorded beside them for that
 * comparison and are applied nowhere.
 */
export const FACE_LUMA_REJECT_BELOW = 40 / 255;
export const FACE_LUMA_BORDERLINE_BELOW = 60 / 255;
export const FACE_LUMA_BORDERLINE_ABOVE = 205 / 255;
export const FACE_LUMA_REJECT_ABOVE = 225 / 255;

/** Camera Kit's RELAXED lighting band, for the calibration report only. */
export const CAMERA_KIT_RELAXED_LUMA_LOW = 0.55;
export const CAMERA_KIT_RELAXED_LUMA_HIGH = 0.8;

/**
 * How unevenly the face may be lit, as the luma difference between the two
 * eyes on the same 0 to 1 scale (evenness in face-reading.ts). Camera Kit's
 * RELAXED lighting_uneven. RECORDED in the metrics and not applied to the
 * verdict in this build: the capture-thresholds-engine-terms PR applies it
 * once the calibration report has rows to set it from.
 */
export const FACE_LUMA_UNEVEN_BORDERLINE_ABOVE = 0.2;

/**
 * An eyeBlink blendshape at or above this reads as a closed eye. The blendshape
 * midpoint; no published threshold exists. RECORDED in the metrics and not
 * applied to the verdict in this build: the capture-thresholds-engine-terms PR
 * applies it, with the burst extension that retakes a blink, once the report
 * has rows for it.
 */
export const EYES_CLOSED_AT_OR_ABOVE = 0.5;

// ---------------------------------------------------------------------------
// The provider's own rule, in the provider's own terms
// ---------------------------------------------------------------------------

/*
 * The rule the engine actually applies is FACE_WIDTH_ENGINE_MIN in
 * src/lib/shared/frame-geometry.ts, imported above and applied below.
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
 * and for the portrait master frame this app sends, the short axis is the
 * width.
 *
 * Since 2026-09-23 the width is cheek to cheek across the landmarker's face
 * oval over the frame width (FaceReading.widthRatio in
 * src/lib/shared/face-reading.ts), which is narrower than any detector's box,
 * so a frame that clears this number clears the engine's by construction. The
 * old height rule is gone with the box it was written against, and since the
 * master frame landed the frame it is measured on is the frame that is sent.
 *
 * The band, not just the floor. The same page asks for "approximately 60 to 80
 * percent of image width", and error_face_position_out_of_boundary is waiting
 * above it for a face that runs off the edge, so this is a window and the gate
 * checks both sides of it.
 *
 * Under the engine's floor the frame is flagged, not refused: a face that is
 * small in the picture is a framing failure the upload path's composition
 * (masterCropFor) can still fix. Under FACE_WIDTH_REJECT_BELOW
 * (frame-geometry.ts, the Camera Kit RELAXED floor) it is refused, because a
 * face that small is one no crop rescues without upscaling into a frame the
 * engine refuses anyway.
 */

/**
 * The top of the documented band. Above it the face starts leaving the frame,
 * and error_face_position_out_of_boundary is what the engine answers with.
 * The live line asks for "back" a little under this, at
 * FACE_WIDTH_BORDERLINE_ABOVE in frame-geometry.ts; the
 * capture-thresholds-engine-terms PR folds this constant into that band.
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
 * Two reasons, both about the estimate rather than the pose. A solved matrix
 * is still a head position solved off a single photograph, with the noise a
 * handheld phone puts into it. And the strictness level the engine is called
 * with is looser than this window, so a frame a little outside it is one the
 * engine may well still read.
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
 * caller happened to be holding a burst measure copy or a preview sample. Then
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
 * assessCapture measures these over the face oval's bounding box when there
 * is a reading and over the whole frame when there is not. The mean here is
 * over the box; the gate's own light measurement is the mean luma inside the
 * oval polygon (meanLumaInside), which is the region the engine's SDK reads.
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

/*
 * There is no auto framing here any more. Until 2026-09-23 this file composed
 * the upload around a face box (autoCropBoxFor and six AUTO_CROP_* constants,
 * derived from a detector box and the oval as it was then drawn). The master
 * frame replaced it: the camera path sends the master frame itself, and the
 * upload path composes a gallery photo into the same geometry with
 * masterCropFor in src/lib/shared/frame-geometry.ts, whose invariants are
 * proven in frame-geometry.test.ts.
 */

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Every reason a frame can be rejected or flagged, in the order they are shown
 * when a frame fails more than one check. The array is both the value set and
 * the precedence, so the two can never disagree.
 *
 * Unmeasured first: a frame the landmarker never looked at has nothing else to
 * say about a face. Face next: without one face and its reading, no other
 * measurement means anything. Light next: a badly lit frame also measures as
 * badly framed, so leading with framing would send the person to fix the wrong
 * thing. Framing next, because it is one clear instruction, with out of bounds
 * ahead of the distance lines since a face at the edge is answered by moving
 * back, not closer. Pose, then the eyes, last, because they are the
 * measurements most degraded by everything before them. There is no sharpness
 * reason: softness never decides.
 */
export const CAPTURE_REASON_PRECEDENCE = [
  "unmeasured",
  "no_face",
  "multiple_faces",
  "too_dark",
  "over_exposed",
  "face_out_of_bounds",
  "too_far",
  "too_close",
  "facing_away",
  "eyes_closed",
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

/**
 * Everything the gate measured, recorded whatever the verdict. These are the
 * calibration numbers captures.quality keeps (docs/03-architecture.md), so a
 * threshold can be checked against what the engine then did with the frame.
 * Numbers only: never a pixel, never a landmark.
 */
export type CaptureMetrics = {
  readonly sharpness: number;
  readonly blownFraction: number;
  readonly crushedFraction: number;
  /**
   * Mean luma inside the face oval, 0 to 1, or over the whole frame when there
   * is no face to measure it on.
   */
  readonly faceLuma: number;
  /** The luma difference between the two eyes, 0 to 1. Null without a face. */
  readonly faceLumaUneven: number | null;
  /**
   * Cheek to cheek over the frame width, which is the ratio the engine measures
   * (FACE_WIDTH_ENGINE_MIN). Null when there is no face.
   */
  readonly faceWidthRatio: number | null;
  /** The face oval's bounding box width over the frame width, 0 to 1. */
  readonly faceBboxRatio: number | null;
  /** Where the middle of the face oval sits, both axes 0 to 1. */
  readonly faceCenter: Point | null;
  /** Solved from the landmarker's matrix, or null. */
  readonly pose: FacePose | null;
  /** The eye blink blendshapes, 0 open to 1 closed, or null. */
  readonly blink: Blink | null;
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
  /** How many faces the landmarker found. Zero when it did not run. */
  readonly faceCount: number;
  /**
   * The reading of the face to judge (the largest, when there is more than
   * one), normalized to the frame the landmarker saw, or null when there is no
   * face. Its polygon and boxes are put onto the image's pixels here.
   */
  readonly reading: FaceReading | null;
  /**
   * True when the landmarker answered for this frame. False when it had not
   * loaded, or threw, and nothing measured the frame at all.
   *
   * A frame is measured or unmeasured; nothing in between. An unmeasured frame
   * is never refused: the gate has no face count to refuse on, and the
   * engine's own input gate is free, authoritative, and refuses for nothing
   * when it says no. So the frame is offered with the reason unmeasured and the
   * decision is left to the engine (docs/03-architecture.md, failure modes).
   */
  readonly measured: boolean;
};

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

/** 0 to 1, with anything unmeasurable left as the NaN it arrived as. */
function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Runs the whole gate and returns accept, borderline, or reject with the reason
 * key that names a line in copy.capture.rejection.
 *
 * Light is measured inside the face oval when there is a reading, so a bright
 * window behind the person cannot mark the frame as blown and a dark wall
 * cannot mark it as dark. Sharpness is measured over the oval's box for the
 * same reason. With no reading, the whole frame is measured.
 *
 * What can reach "reject", and nothing else can:
 *
 * - no_face and multiple_faces, when the landmarker measured the frame. Without
 *   exactly one face there is no reading to be had, and picking a face out of
 *   a group is not a decision this screen makes. An unmeasured frame is not
 *   refused on either: see CaptureAssessmentInput.measured.
 * - too_dark and over_exposed at the extremes: crushed or blown past the reject
 *   fractions, or a face luma outside the reject bands. Nothing can be read off
 *   a black or a white face, so sending one spends a credit on a refusal.
 * - too_far below FACE_WIDTH_REJECT_BELOW, where the engine's own
 *   error_src_face_too_small is certain.
 *
 * Sharpness is deliberately not on that list at any value, and neither is a
 * blink or uneven light in this build: both are recorded in the metrics for
 * the calibration report and applied by the capture-thresholds-engine-terms
 * PR, which moves every band here into the engine's accept and borderline
 * tiers once the report has rows to set them from.
 */
export function assessCapture(input: CaptureAssessmentInput): CaptureAssessment {
  const { image, faceCount, measured } = input;
  assertImage(image);

  const failures: CaptureFailure[] = [];

  /*
   * A reading is only read when it is the landmarker's. The caller never hands
   * one in for an unmeasured frame, and if it did, the numbers would not be
   * this frame's, so they are dropped here rather than trusted.
   */
  const reading = measured ? input.reading : null;
  const hasSingleFace = faceCount === 1 && reading !== null;

  if (!measured) {
    failures.push({ reason: "unmeasured", severity: "borderline" });
  } else if (faceCount > 1) {
    failures.push({ reason: "multiple_faces", severity: "reject" });
  } else if (!hasSingleFace) {
    failures.push({ reason: "no_face", severity: "reject" });
  }

  const pixels = reading === null ? null : facePixelsIn(reading, image);
  const ovalBox =
    pixels !== null && clampBox(pixels.ovalBox, image) !== null
      ? pixels.ovalBox
      : null;

  const exposure = exposureStats(
    ovalBox === null ? image : cropToBox(image, ovalBox),
  );
  /*
   * The oval box rather than the cropped copy, because sharpnessOf does its own
   * cropping and then its own resampling, and the resampling is the whole point:
   * it is what makes this number the same number the live guidance line got off
   * a preview sample of the same face.
   */
  const sharpness = sharpnessOf(image, ovalBox);
  const faceLuma =
    pixels === null
      ? meanLumaOf(image)
      : meanLumaInside(image, pixels.ovalPolygon);
  const faceLumaUneven =
    pixels === null
      ? null
      : evenness(image, pixels.eyeBoxes.left, pixels.eyeBoxes.right);

  if (
    exposure.crushedFraction > CRUSHED_FRACTION_REJECT_ABOVE ||
    faceLuma < FACE_LUMA_REJECT_BELOW
  ) {
    failures.push({ reason: "too_dark", severity: "reject" });
  } else if (
    exposure.crushedFraction > CRUSHED_FRACTION_BORDERLINE_ABOVE ||
    faceLuma < FACE_LUMA_BORDERLINE_BELOW
  ) {
    failures.push({ reason: "too_dark", severity: "borderline" });
  }

  if (
    exposure.blownFraction > BLOWN_FRACTION_REJECT_ABOVE ||
    faceLuma > FACE_LUMA_REJECT_ABOVE
  ) {
    failures.push({ reason: "over_exposed", severity: "reject" });
  } else if (
    exposure.blownFraction > BLOWN_FRACTION_BORDERLINE_ABOVE ||
    faceLuma > FACE_LUMA_BORDERLINE_ABOVE
  ) {
    failures.push({ reason: "over_exposed", severity: "borderline" });
  }

  /*
   * The engine's own framing rule, in the engine's own terms: cheek to cheek
   * over the frame width. Under the RELAXED floor the frame is refused, because
   * no composition rescues a face that small without upscaling into a frame the
   * engine refuses anyway. Between the floor and the engine's 0.60 it is
   * offered: the composition step can still close that gap. Above the top of
   * the band the face is starting to leave the picture.
   */
  const widthRatio = reading === null ? null : reading.widthRatio;
  if (widthRatio !== null) {
    if (widthRatio < FACE_WIDTH_REJECT_BELOW) {
      failures.push({ reason: "too_far", severity: "reject" });
    } else if (widthRatio < FACE_WIDTH_ENGINE_MIN) {
      failures.push({ reason: "too_far", severity: "borderline" });
    } else if (widthRatio > FACE_WIDTH_RATIO_MAX) {
      failures.push({ reason: "too_close", severity: "borderline" });
    }
  }

  /*
   * A face oval within the frame's edge margins, which is what
   * error_face_position_out_of_boundary names, asked before the upload. The
   * reframe path only ever crops tighter, so this is the one framing failure
   * it cannot answer, and saying so here is the difference between one
   * instruction and two wasted attempts.
   */
  if (reading !== null && ovalTouchesEdge(reading.ovalBox, { width: 1, height: 1 })) {
    failures.push({ reason: "face_out_of_bounds", severity: "borderline" });
  }

  const pose = reading === null ? null : reading.pose;
  const poseVerdict = poseVerdictFor(pose);
  if (poseVerdict !== "ok") {
    failures.push({
      reason: "facing_away",
      severity: poseVerdict === "reject" ? "reject" : "borderline",
    });
  }

  /*
   * Recorded, not applied. The blink blendshapes and the eye luma difference
   * land in the metrics for every frame so the calibration report can put
   * EYES_CLOSED_AT_OR_ABOVE and FACE_LUMA_UNEVEN_BORDERLINE_ABOVE beside what
   * the engine did. The capture-thresholds-engine-terms PR applies both, as
   * borderline, once those rows exist. Sharpness is recorded on the same terms
   * and decides nothing in any build: the engine publishes no blur code, and the
   * burst sends the sharpest frame of the tap (frameScore), so softness is
   * handled by choosing rather than by refusing.
   */

  const metrics: CaptureMetrics = {
    sharpness,
    blownFraction: exposure.blownFraction,
    crushedFraction: exposure.crushedFraction,
    faceLuma,
    faceLumaUneven,
    faceWidthRatio: widthRatio,
    /*
     * Both clamped to the frame: a face oval partly outside the picture has
     * landmarks beyond it, and a stored share of the frame is meant to be one.
     * The out of bounds flag above is what records that the face left it.
     */
    faceBboxRatio: reading === null ? null : clampUnit(reading.bboxRatio),
    faceCenter:
      reading === null
        ? null
        : { x: clampUnit(reading.center.x), y: clampUnit(reading.center.y) },
    pose,
    blink: reading === null ? null : reading.blink,
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

/** The mean of the whole frame, 0 to 1, for a frame with no face to read. */
function meanLumaOf(image: GrayscaleImage): number {
  const { data } = image;
  if (data.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    sum += data[index] ?? 0;
  }
  return sum / data.length / 255;
}

// ---------------------------------------------------------------------------
// Choosing between frames
// ---------------------------------------------------------------------------

/**
 * The span of face width ratio the score measures a miss against: half the
 * documented band, so a frame sitting on either edge of what the engine accepts
 * carries roughly a full unit of badness.
 */
const FRAME_SCORE_WIDTH_SPAN = (FACE_WIDTH_RATIO_MAX - FACE_WIDTH_ENGINE_MIN) / 2;

/**
 * The middle of the band of face luma the gate is willing to send, which is
 * halfway between the two borderline lines. Not the middle of 0 to 1: a frame
 * at 0.50 is not preferable to one at 0.52 for any reason except that both are
 * comfortably inside what an analyzer can read, and this is where that band
 * actually sits.
 */
export const FRAME_SCORE_LUMA_TARGET =
  (FACE_LUMA_BORDERLINE_BELOW + FACE_LUMA_BORDERLINE_ABOVE) / 2;

/** Half that band, so an edge of it is roughly a full unit of badness. */
const FRAME_SCORE_LUMA_SPAN =
  (FACE_LUMA_BORDERLINE_ABOVE - FACE_LUMA_BORDERLINE_BELOW) / 2;

/**
 * Pose, the heaviest term, because pose is what the engine actually refuses on.
 * Every refusal read off the live API has been one: error_face_angle_rightward,
 * error_face_not_forward_facing, error_face_angle_downward (see
 * POSE_YAW_MAX_DEGREES). A frame a degree squarer to the lens is worth more than
 * a frame a little better framed or a little sharper, because it is the
 * difference between a reading and a person told to try again.
 *
 * Measured against POSE_SLACK_DEGREES, since a head further outside the window
 * than that is a reject and has already scored minus infinity.
 *
 * PROVISIONAL, like every number in this file. It is a shape, set from what the
 * engine refuses on rather than from a set of scored frames.
 */
export const FRAME_SCORE_POSE_WEIGHT = 8;

/**
 * Framing next, at half of pose. Cheek to cheek over the frame width is the
 * engine's other published input rule (FACE_WIDTH_ENGINE_MIN), so it can
 * refuse on it too, but between frames taken 90ms apart what is left to rank
 * is the landmarker disagreeing with itself rather than a framing anybody
 * needs to fix. The target is the oval's own width (FRAME_OVAL_WIDTH in
 * frame-geometry.ts).
 *
 * PROVISIONAL.
 */
export const FRAME_SCORE_WIDTH_WEIGHT = 4;

/**
 * The eyes next, between framing and light. A blink is 100 to 400 ms, a burst
 * spans 360, so one frame of a burst with the eyes shut and another with them
 * open is the ordinary case, and the engine asks for the eyes open ("front
 * facing, neutral, mouth closed, eyes open" on the skin family). Between two
 * frames the gate was willing to send, the one whose eyes are open is worth
 * more than the one a little better lit and less than the one squarer to the
 * lens. Measured as the larger of the two blink blendshapes, which is already
 * 0 to 1.
 *
 * PROVISIONAL.
 */
export const FRAME_SCORE_BLINK_WEIGHT = 3;

/**
 * Light next. The extremes already refuse a frame outright, so this term only
 * ever separates frames the gate was willing to send: between two of those it
 * prefers the one nearer the middle of the band, which is the one an analyzer
 * has the most tone signal in.
 *
 * PROVISIONAL.
 */
export const FRAME_SCORE_LUMA_WEIGHT = 2;

/**
 * Sharpness, the lightest term, because the provider does not gate on it.
 * Perfect Corp publishes no blur error code anywhere, which is the same reason
 * assessCapture never refuses a frame for softness. So softness ranks and
 * nothing else.
 *
 * Lightest is not unimportant here. Between frames taken 90ms apart the pose,
 * the framing and the light barely move, so in practice this is the term that
 * decides a burst, and that is exactly what the burst is for: the frame at the
 * instant of the tap is the one the finger shook.
 *
 * PROVISIONAL.
 */
export const FRAME_SCORE_SHARPNESS_WEIGHT = 1;

/**
 * Where extra sharpness stops being worth anything, on the SHARPNESS_SCALE
 * measurement.
 *
 * A cap rather than an open scale, because the difference between a sharp frame
 * and a very sharp one is not a difference the engine will ever act on, and
 * without a cap one frame that happened to catch a high contrast edge would
 * outvote pose and framing together.
 *
 * A literal, since there is no sharpness threshold left to derive it from.
 * PROVISIONAL, and the one number here most likely to be wrong: if real faces
 * read far above it the term saturates and stops separating frames that it
 * should. The calibration report sets it from real captures.
 */
export const FRAME_SCORE_SHARPNESS_CAP = 100;

/**
 * What a borderline verdict costs, and why it is larger than everything above
 * put together.
 *
 * The gate has already made this call. An accepted frame goes straight to the
 * engine; a borderline one stops on the review screen and asks the person
 * whether to send it anyway. Preferring a borderline frame because it was a
 * little sharper would put somebody in front of "Use it anyway" while a clean
 * frame sat in memory unused, which is the opposite of what a burst is for. So
 * the five terms rank frames within a verdict and never across one, and one
 * more than their combined span is what guarantees it.
 */
export const FRAME_SCORE_BORDERLINE_PENALTY =
  FRAME_SCORE_POSE_WEIGHT +
  FRAME_SCORE_WIDTH_WEIGHT +
  FRAME_SCORE_BLINK_WEIGHT +
  FRAME_SCORE_LUMA_WEIGHT +
  FRAME_SCORE_SHARPNESS_WEIGHT +
  1;

/**
 * How good a frame is, relative to every other frame of the same face. Higher is
 * better, 0 is the best a frame can do, and a reject is minus infinity.
 *
 * Why this exists. A person taps the shutter and the finger pressing the glass
 * moves the phone, so the single frame at that instant is the one frame of the
 * second most likely to be shaken. This product gets one attempt: the reading is
 * paid for and nobody retakes. Every production face capture app answers that by
 * taking a short burst and sending the best of it, and this is how the best of
 * it is decided, in the gate's own terms rather than in a new set of them.
 *
 * The shape. Five penalties, each normalized to 0 to 1 over the span that
 * matters for that measurement so the weights above can be read against each
 * other directly, plus a flat penalty for a verdict of borderline. Nothing is
 * rewarded: a perfect frame is 0 and everything else is the distance below it.
 *
 * Where a measurement is simply absent, it is treated as nothing rather than as
 * something bad. A frame with no pose is not judged on pose, which is what
 * poseVerdictFor already does. A frame with no face has no width ratio and no
 * blink, and ranking on the absence of the landmarker's opinion would rank the
 * landmarker rather than the photograph. Those frames are usually rejects
 * anyway, and when they are not (unmeasured) they already carry the borderline
 * penalty.
 */
export function frameScore(assessment: CaptureAssessment): number {
  if (assessment.verdict === "reject") {
    return Number.NEGATIVE_INFINITY;
  }

  const { metrics } = assessment;

  const poseBadness = clampUnit(
    (metrics.pose === null ? 0 : poseExcessDegrees(metrics.pose)) /
      POSE_SLACK_DEGREES,
  );

  const widthBadness =
    metrics.faceWidthRatio === null
      ? 0
      : clampUnit(
          Math.abs(metrics.faceWidthRatio - FRAME_OVAL_WIDTH) /
            FRAME_SCORE_WIDTH_SPAN,
        );

  const blinkBadness =
    metrics.blink === null
      ? 0
      : clampUnit(Math.max(metrics.blink.left, metrics.blink.right));

  const lumaBadness = clampUnit(
    Math.abs(metrics.faceLuma - FRAME_SCORE_LUMA_TARGET) / FRAME_SCORE_LUMA_SPAN,
  );

  const softness =
    1 - clampUnit(metrics.sharpness / FRAME_SCORE_SHARPNESS_CAP);

  const penalty =
    FRAME_SCORE_POSE_WEIGHT * poseBadness +
    FRAME_SCORE_WIDTH_WEIGHT * widthBadness +
    FRAME_SCORE_BLINK_WEIGHT * blinkBadness +
    FRAME_SCORE_LUMA_WEIGHT * lumaBadness +
    FRAME_SCORE_SHARPNESS_WEIGHT * softness +
    (assessment.verdict === "borderline" ? FRAME_SCORE_BORDERLINE_PENALTY : 0);

  // Subtracted from a perfect frame rather than negated, so a frame with
  // nothing wrong with it scores zero rather than negative zero.
  return 0 - penalty;
}

/**
 * One frame of a burst: the gate's reading of it, and whatever the caller is
 * actually choosing between. The caller holds canvases; this module holds none.
 */
export type FrameCandidate<T> = {
  readonly assessment: CaptureAssessment;
  readonly value: T;
};

/**
 * The best frame of a burst, or null when the gate refused every one of them.
 *
 * Null is not a failure to answer, it is the answer: no frame here is one this
 * app is willing to send, and the caller has a refusal to show rather than a
 * photograph to upload.
 *
 * Ties go to the first candidate, which makes the choice deterministic and, for
 * a burst, makes it the earliest frame. That matters slightly: the frames are
 * ordered in time, so an unbroken tie hands back the frame closest to the
 * instant the person meant to take.
 *
 * Anything that does not produce a real number is skipped rather than compared,
 * so one frame whose metrics came back unmeasurable cannot win by being
 * incomparable.
 */
export function pickBestFrame<T>(
  candidates: ReadonlyArray<FrameCandidate<T>>,
): T | null {
  let best: FrameCandidate<T> | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const score = frameScore(candidate.assessment);
    if (!Number.isFinite(score)) {
      continue;
    }
    if (best === null || score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best === null ? null : best.value;
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
