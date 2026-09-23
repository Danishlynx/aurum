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
 * These are the live measurements taken off the preview, which since the
 * master frame landed is the master crop of the video at
 * GUIDANCE_SAMPLE_LONG_EDGE: the same 3:4 frame the shutter sends, so a width
 * read here is the width the engine will read. They come from the same
 * FaceReading the gate reads (src/lib/shared/face-reading.ts). The gate that
 * decides what happens to the frame runs in src/lib/shared/quality.ts, and the
 * two are held to the same thresholds on purpose: "Good. Tap to capture." is a
 * promise about what the next tap will do, so every condition the gate can
 * refuse a frame for is a condition this line refuses to say "Good" under.
 * After READY_HOLD_MS of "ready" the screen turns the oval solid and takes the
 * photo itself (docs/01-user-flow.md section D); the tap works at any time.
 *
 * An unmeasured preview, one the landmarker has not answered for, gets the
 * two light lines (over the whole frame: too dark, too bright), hold, and then
 * a line that says the check did not load and the tap is still theirs.
 * Nothing about a face is said on a frame nothing has looked at.
 */

import { copy } from "@/lib/shared/copy";
import type { FaceReading } from "@/lib/shared/face-reading";
import {
  FACE_WIDTH_BORDERLINE_ABOVE,
  FACE_WIDTH_BORDERLINE_BELOW,
  ovalTouchesEdge,
  type Size,
} from "@/lib/shared/frame-geometry";
import {
  FACE_LUMA_BORDERLINE_ABOVE,
  FACE_LUMA_BORDERLINE_BELOW,
  POSE_PITCH_MAX_DEGREES,
  POSE_PITCH_MIN_DEGREES,
  poseVerdictFor,
} from "@/lib/shared/quality";
import type { GrayscaleImage } from "@/lib/shared/quality";

/**
 * Every line the screen can show under the oval. guidanceKey below returns all
 * of them but "taking", which the capture screen sets itself once the line has
 * read "ready" for READY_HOLD_MS and the countdown to the auto capture runs.
 */
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
   * The preview sample the reading is normalized to, in pixels. Since the
   * master frame landed this is a 3:4 master crop on every device, so the
   * reading's width is already a share of the short axis; the field stays so
   * liveWidthRatioOf can say so rather than assume it.
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
 * The reading's cheek to cheek width as a share of the sample's short axis.
 *
 * A FaceReading's widthRatio is over the frame WIDTH, which is the engine's
 * measure on a portrait frame ("Portrait mode: horizontal ratio. Landscape
 * mode: vertical ratio.", docs/04-integrations.md). The live sample is the
 * master crop, which is 3:4 on every device, so on it this is the identity
 * and the floor below is the oval's own band. The function is kept for the
 * one thing it states: the floor is read against the short axis, whatever
 * shape a sample has. A landscape master never exists; a landscape sample is
 * answered anyway rather than assumed away.
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
   * No face, or a face under the oval's band, is "Move closer". The sample IS
   * the master frame the upload will be, so the floor is the band's own lower
   * edge (FACE_WIDTH_BORDERLINE_BELOW, 0.64: the engine's 0.60 with the same
   * margin the oval sits above MODERATE), and "Move closer" asks for the oval
   * and nothing else. No face at all reads the same way on purpose: the
   * landmarker did look, and the one thing a person can do about a face it
   * could not find is bring it into the oval.
   */
  if (
    reading === null ||
    liveWidthRatioOf(reading, stats.sample) < FACE_WIDTH_BORDERLINE_BELOW
  ) {
    return "closer";
  }

  /*
   * The other side. A face wider than the band (FACE_WIDTH_BORDERLINE_ABOVE,
   * 0.85), or one whose oval runs into the frame's edge margins, is refused by
   * the engine as out of boundary and no crop fixes it. The edge test is the
   * gate's own (ovalTouchesEdge), on the normalized oval box against a unit
   * frame.
   */
  if (
    reading.widthRatio > FACE_WIDTH_BORDERLINE_ABOVE ||
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
