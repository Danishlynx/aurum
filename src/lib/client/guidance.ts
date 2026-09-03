/**
 * The one line of live guidance under the capture oval.
 *
 * docs/01-user-flow.md section D: one line at a time, replaced as conditions
 * change, never stacked. The order below is the order a person can act on:
 * light first, because a dark frame also measures as unsharp and badly framed;
 * then distance, which is one clear instruction; then stillness; then ready.
 *
 * These are the live measurements taken off the preview. The gate that decides
 * what happens to the frame runs in src/lib/shared/quality.ts, and the two are
 * held to the same thresholds on purpose: "Good. Tap to capture." is a promise
 * about what the next tap will do, so every condition the gate can refuse or
 * flag a frame for is a condition this line refuses to say "Good" under.
 */

import { copy } from "@/lib/shared/copy";
import {
  FACE_COVERAGE_MIN,
  MEAN_LUMINANCE_BORDERLINE_BELOW,
  SHARPNESS_BORDERLINE_BELOW,
} from "@/lib/shared/quality";
import type { GrayscaleImage } from "@/lib/shared/quality";

export type GuidanceKey = keyof typeof copy.capture.guidance;

/**
 * Mean absolute luminance change between two consecutive preview frames. Above
 * this the camera or the person is moving enough to blur the capture.
 * PROVISIONAL, calibrated by hand on a phone, to be checked against
 * evals/fixtures/captures-bad.
 */
export const MOTION_STILL_AT_OR_BELOW = 7;

/**
 * The long edge the preview is sampled at for the guidance line.
 *
 * Sized so that the face box inside this sample is never smaller than
 * SHARPNESS_MEASURE_LONG_EDGE, which is what lets the guidance and the gate
 * resample down to the same 96 and compare like with like. A face that clears
 * FACE_COVERAGE_MIN fills 60 percent of the frame height, and the widest frame a
 * front camera hands us is 16 by 9 in landscape, so the short edge has to be at
 * least 96 over 0.6, which is 160, and the long edge at least 160 times 16 over
 * 9, which is 285. 320 is the next round number above it and still a sample of
 * about 57 thousand pixels, which is nothing four times every two seconds.
 *
 * A face under the rule samples smaller than 96 and is not resampled up, but the
 * line for that face is "Move closer" either way: closer comes before hold here,
 * and too_far comes before blurry in CAPTURE_REASON_PRECEDENCE.
 */
export const GUIDANCE_SAMPLE_LONG_EDGE = 320;

export type LiveFrameStats = {
  readonly meanLuminance: number;
  /** Null when nothing face sized was found in the preview. */
  readonly faceCoverage: number | null;
  /** Mean absolute frame difference, 0 to 255. */
  readonly motion: number;
  /**
   * sharpnessOf over the face in the preview sample. The same function, at the
   * same measurement size, that the gate will run on the frame this line is
   * talking a person into taking.
   */
  readonly sharpness: number;
};

export function guidanceKey(stats: LiveFrameStats): GuidanceKey {
  if (stats.meanLuminance < MEAN_LUMINANCE_BORDERLINE_BELOW) {
    return "light";
  }
  if (stats.faceCoverage === null || stats.faceCoverage < FACE_COVERAGE_MIN) {
    return "closer";
  }
  /*
   * Motion and softness are one line, because they are one instruction. Motion
   * is what the person can still fix before the tap; sharpness is what the gate
   * is about to measure. Saying "Good" over a frame the gate would then call
   * blurry is the contradiction this whole module exists to not produce.
   */
  if (
    stats.motion > MOTION_STILL_AT_OR_BELOW ||
    stats.sharpness < SHARPNESS_BORDERLINE_BELOW
  ) {
    return "hold";
  }
  return "ready";
}

export function guidanceLine(stats: LiveFrameStats): string {
  return copy.capture.guidance[guidanceKey(stats)];
}

export function meanLuminanceOf(image: GrayscaleImage): number {
  const { data } = image;
  if (data.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) {
    sum += data[index] ?? 0;
  }
  return sum / data.length;
}

/**
 * Mean absolute difference between two grayscale buffers of the same length.
 * Returns 0 when there is nothing to compare, which reads as "still" and lets
 * the first frame of a session settle rather than flashing "Hold still".
 */
export function motionBetween(
  previous: ArrayLike<number> | null,
  current: ArrayLike<number>,
): number {
  if (previous === null || previous.length !== current.length || current.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let index = 0; index < current.length; index += 1) {
    sum += Math.abs((current[index] ?? 0) - (previous[index] ?? 0));
  }
  return sum / current.length;
}
