/**
 * The one line of live guidance under the capture oval.
 *
 * docs/01-user-flow.md section D: one line at a time, replaced as conditions
 * change, never stacked. The order below is the order a person can act on:
 * light first, because a dark frame also measures as unsharp and badly framed;
 * then distance, which is one clear instruction; then stillness; then ready.
 *
 * These are the live, cheap measurements taken off the preview. The real gate
 * runs on the captured frame in src/lib/shared/quality.ts.
 */

import { copy } from "@/lib/shared/copy";
import {
  FACE_COVERAGE_MIN,
  MEAN_LUMINANCE_BORDERLINE_BELOW,
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

export type LiveFrameStats = {
  readonly meanLuminance: number;
  /** Null when nothing face sized was found in the preview. */
  readonly faceCoverage: number | null;
  /** Mean absolute frame difference, 0 to 255. */
  readonly motion: number;
};

export function guidanceKey(stats: LiveFrameStats): GuidanceKey {
  if (stats.meanLuminance < MEAN_LUMINANCE_BORDERLINE_BELOW) {
    return "light";
  }
  if (stats.faceCoverage === null || stats.faceCoverage < FACE_COVERAGE_MIN) {
    return "closer";
  }
  if (stats.motion > MOTION_STILL_AT_OR_BELOW) {
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
