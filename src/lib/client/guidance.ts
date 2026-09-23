/**
 * The one line of live guidance under the capture oval.
 *
 * docs/01-user-flow.md section D: one line at a time, replaced as conditions
 * change, never stacked. The order below is the order a person can act on:
 * light first, because a dark or a blown face also measures wrong everywhere
 * else; then the phone's orientation, because turning it changes the frame
 * under every measurement after it; then pose, because no amount of framing
 * fixes a turned head; then distance, which is one clear instruction; then
 * stillness; then ready.
 *
 * These are the live measurements taken off the preview, read from the same
 * FaceReading the gate reads (src/lib/shared/face-reading.ts). The gate that
 * decides what happens to the frame runs in src/lib/shared/quality.ts, and the
 * two are held to the same thresholds on purpose: "Good. Tap to capture." is a
 * promise about what the next tap will do, so every condition the gate can
 * refuse a frame for is a condition this line refuses to say "Good" under.
 *
 * An unmeasured preview, one the landmarker has not answered for, gets the
 * two light lines (over the whole frame: too dark, too bright), hold, and then
 * a line that says the check did not load and the tap is still theirs.
 * Nothing about a face is said on a frame nothing has looked at.
 */

import { copy } from "@/lib/shared/copy";
import type { FaceReading } from "@/lib/shared/face-reading";
import { ovalTouchesEdge, type Size } from "@/lib/shared/frame-geometry";
import {
  FACE_LUMA_BORDERLINE_ABOVE,
  FACE_LUMA_BORDERLINE_BELOW,
  FACE_WIDTH_RATIO_MAX,
  POSE_PITCH_MAX_DEGREES,
  POSE_PITCH_MIN_DEGREES,
  poseVerdictFor,
} from "@/lib/shared/quality";
import type { GrayscaleImage } from "@/lib/shared/quality";

export type GuidanceKey = keyof typeof copy.capture.guidance;

/**
 * Mean absolute luminance change between two consecutive preview frames. Above
 * this the camera or the person is moving enough to blur the capture.
 *
 * 14, raised from 7 on 2026-09-14. Sensor noise alone moves a still frame: at a
 * per pixel noise of five levels, which is ordinary indoors, the mean absolute
 * difference between two frames of a phone that has not moved is about eight.
 * Seven therefore said "Hold still" to a phone on a table in a dim room, and
 * said it for as long as the room stayed dim. A real shake reads in the tens.
 *
 * PROVISIONAL, calibrated by hand on a phone. It errs high on purpose: the
 * burst sends the sharpest of its frames, so a moment of motion this line
 * missed is caught by choosing, and a still moment this line called motion is
 * a wall.
 */
export const MOTION_STILL_AT_OR_BELOW = 14;

/**
 * What the live line is measured from. Everything about the face comes from
 * the reading; the two luma numbers are measured on the preview sample by the
 * caller because the reading carries geometry, not pixels.
 */
export type LiveFrameStats = {
  /** True when the landmarker answered for this preview frame. */
  readonly measured: boolean;
  /**
   * The preview sample the reading is normalized to, in pixels. Its aspect is
   * what puts the reading's width, a share of the frame WIDTH, onto the short
   * axis for the live floor (liveWidthRatioOf).
   */
  readonly sample: Size;
  /** True when the camera track is wider than it is tall. */
  readonly trackIsLandscape: boolean;
  /** True on a touch device, where a landscape track means a turned phone. */
  readonly coarsePointer: boolean;
  /** Mean luma over the whole preview sample, 0 to 1. */
  readonly frameLuma: number;
  /** Mean luma inside the face oval, 0 to 1, or null without a face. */
  readonly faceLuma: number | null;
  /** The luma difference between the eyes, 0 to 1, or null without a face. */
  readonly faceLumaUneven: number | null;
  /** The face, or null when the landmarker found none (or did not run). */
  readonly reading: FaceReading | null;
  /** Mean absolute frame difference, 0 to 255. */
  readonly motion: number;
  /**
   * sharpnessOf over the face in the preview sample. The same function, at the
   * same measurement size, that the gate will run on the frame this line is
   * talking a person into taking. Recorded on the readout; decides nothing.
   */
  readonly sharpness: number;
};

/**
 * The preview width ratio under which the line asks the person to come closer,
 * measured on the sample's SHORT axis (liveWidthRatioOf).
 *
 * Deliberately far below the engine's own 0.60, because in this build the
 * engine never sees the preview. autoCropBoxFor composes the uploaded frame
 * around the face from whatever the sensor gave it, so a face at 0.40 of the
 * sensor frame's short axis becomes a face at 0.66 of the upload. The limit is
 * pixels, not framing: under this the crop starts upscaling into a soft frame.
 *
 * The capture-master-frame PR removes the sensor snapshot and the composition
 * step, measures the preview on the master frame the person sees, and moves
 * this floor to FACE_WIDTH_BORDERLINE_BELOW in src/lib/shared/frame-geometry.ts,
 * so that "Move closer" asks for the oval and nothing else.
 */
export const LIVE_FACE_WIDTH_RATIO_MIN = 0.4;

/**
 * The reading's cheek to cheek width as a share of the sample's short axis.
 *
 * A FaceReading's widthRatio is over the frame WIDTH, which is the right
 * measure on the portrait master frame and the wrong one on the landscape
 * track a laptop webcam hands over in this build: on a 16:9 sample a face at
 * 0.40 of the width has an oval taller than the frame, so a floor read against
 * the width could never be cleared without the "back" line firing first, and
 * the line never said ready on a laptop (reviewed 2026-09-23). Until the
 * master frame PR lands, the floor is read the way the composition step reads
 * it, against the short axis, which is what the detector's box was measured
 * against before the landmarker. On a portrait sample the two are the same.
 */
export function liveWidthRatioOf(reading: FaceReading, sample: Size): number {
  if (!(sample.width > 0) || !(sample.height > 0)) {
    return reading.widthRatio;
  }
  return reading.widthRatio * Math.max(1, sample.width / sample.height);
}

export function guidanceKey(stats: LiveFrameStats): GuidanceKey {
  const { reading } = stats;

  /*
   * Light over the face when there is one, over the frame when there is not.
   * The bands are the gate's own (FACE_LUMA_BORDERLINE_BELOW and ABOVE), so
   * the line holds exactly where the gate would flag the frame.
   */
  const luma =
    stats.measured && stats.faceLuma !== null ? stats.faceLuma : stats.frameLuma;
  if (luma < FACE_LUMA_BORDERLINE_BELOW) {
    return "light";
  }
  if (luma > FACE_LUMA_BORDERLINE_ABOVE) {
    return "bright";
  }

  /*
   * Nothing measured this frame. The person still has a tap, and the only
   * things worth saying are the ones that need no face to measure: the two
   * light lines above, and hold.
   */
  if (!stats.measured) {
    if (stats.motion > MOTION_STILL_AT_OR_BELOW) {
      return "hold";
    }
    return "unmeasured";
  }

  /*
   * A phone held landscape hands the camera a landscape track, and the frame
   * that is sent is portrait: the face the person sees in the oval is a small
   * share of it. Only on a touch device, because a laptop webcam is landscape
   * by construction and asking somebody to turn their laptop is not a line.
   */
  if (stats.trackIsLandscape && stats.coarsePointer) {
    return "upright";
  }

  /*
   * Pose, before every framing line. Every refusal this product has read off
   * the live API has been a pose refusal, and framing cannot fix a turned
   * head. Only a pose the gate would REFUSE holds the line: a borderline pose
   * is offered by the gate rather than refused, and the burst picks the
   * squarest frame anyway, so a line that demanded perfection here would be
   * demanding more than the gate does.
   *
   * Pitch is separated from the other two axes because it has its own
   * instruction. A head tipped back or dropped forward is almost always a phone
   * held at the wrong height, which is what the eyeLevel line asks about, and
   * it is the axis the engine's own budget is tightest on in the direction a
   * phone at chest height pushes it.
   */
  const pose = reading?.pose ?? null;
  if (pose !== null && poseVerdictFor(pose) === "reject") {
    const pitchIsTheProblem =
      pose.pitchDegrees > POSE_PITCH_MAX_DEGREES ||
      pose.pitchDegrees < POSE_PITCH_MIN_DEGREES;
    return pitchIsTheProblem ? "eyeLevel" : "square";
  }

  /*
   * No face, or a face too small to compose from, is "Move closer". No face
   * at all reads the same way on purpose: the landmarker did look, and the
   * one thing a person can do about a face it could not find is bring it
   * into the oval.
   */
  if (
    reading === null ||
    liveWidthRatioOf(reading, stats.sample) < LIVE_FACE_WIDTH_RATIO_MIN
  ) {
    return "closer";
  }

  /*
   * The other side. A face wider than the band the engine reads, or one whose
   * oval runs into the frame's edge margins, is refused by the engine as out
   * of boundary and no crop fixes it. The edge test is the gate's own
   * (ovalTouchesEdge), on the normalized oval box against a unit frame.
   */
  if (
    reading.widthRatio > FACE_WIDTH_RATIO_MAX ||
    ovalTouchesEdge(reading.ovalBox, { width: 1, height: 1 })
  ) {
    return "back";
  }

  /*
   * Motion alone decides "Hold still". Sharpness used to be asked here as
   * well, with a threshold set from synthetic patterns, and a smooth face at
   * preview size has every chance of reading under it whatever the focus. The
   * gate never flags softness either, so the two agree, and the burst sends
   * the sharpest of its frames, which is a better answer to a soft moment than
   * asking the person to wait for one.
   */
  if (stats.motion > MOTION_STILL_AT_OR_BELOW) {
    return "hold";
  }
  return "ready";
}

export function guidanceLine(stats: LiveFrameStats): string {
  return copy.capture.guidance[guidanceKey(stats)];
}

/** Mean luminance of a grayscale buffer, 0 to 255. */
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
