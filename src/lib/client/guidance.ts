/**
 * The one line of live guidance under the capture oval.
 *
 * docs/01-user-flow.md section D: one line at a time, replaced as conditions
 * change, never stacked. The order below is the order a person can act on:
 * light first, because a dark frame also measures as unsharp and badly framed;
 * then the height of the phone, because moving it changes the framing under
 * every measurement after it; then distance, which is one clear instruction;
 * then stillness; then ready.
 *
 * These are the live measurements taken off the preview. The gate that decides
 * what happens to the frame runs in src/lib/shared/quality.ts, and the two are
 * held to the same thresholds on purpose: "Good. Tap to capture." is a promise
 * about what the next tap will do, so every condition the gate can refuse or
 * flag a frame for is a condition this line refuses to say "Good" under.
 */

import { copy } from "@/lib/shared/copy";
import type { FacePose } from "@/lib/shared/pose";
import {
  FACE_COVERAGE_REJECT_BELOW,
  MEAN_LUMINANCE_BORDERLINE_BELOW,
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
 * PROVISIONAL, calibrated by hand on a phone, to be checked against the
 * exported outcome rows (docs/05-evals.md). It errs high on purpose: the burst sends the
 * sharpest of five frames, so a moment of motion this line missed is caught by
 * choosing, and a still moment this line called motion is a wall.
 */
export const MOTION_STILL_AT_OR_BELOW = 14;

/**
 * How low the middle of the face can sit, as a share of the frame height,
 * before the phone is being held below the person's eyes.
 *
 * A stand in for pitch, and read only when there is no pitch to read. A face
 * framed by somebody holding a phone at eye level sits high in the picture.
 * That is why the auto framing centres its crop at 42 percent of the frame
 * height (REFRAME_VERTICAL_CENTER in src/lib/shared/reframe.ts) and why the
 * reveal draws its vignette at the same 42 percent: people put their head in
 * the upper half and leave the shoulders below it. A face whose middle has slid
 * well past the middle of the frame is therefore not a person standing
 * differently, it is a lens pointing up from below at somebody looking down at
 * it, which is exactly the pose the engine refused on 2026-09-03 with
 * error_face_angle_downward.
 *
 * 0.62, raised from 0.55 on 2026-09-14, from a reading off a phone: a face
 * filling the oval, phone level, pitch measured at three degrees, had its box
 * middle at 0.58 of the frame. The detector's box runs from the hairline to
 * under the chin, and the oval it is being asked to fill is drawn below the
 * middle of the stage, so 0.58 is where a correctly framed face sits, not a
 * face that has slid. That reading held the line at "Hold the phone at eye
 * level" with a pitch the engine would have been happy with, which is the
 * proxy contradicting the measurement it was standing in for; guidanceKey now
 * asks the proxy only when the measurement is absent. PROVISIONAL, like the
 * other thresholds here.
 */
export const FACE_CENTER_TOO_LOW_ABOVE = 0.62;

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
  /**
   * Where the middle of the face sits, as a share of the frame height from the
   * top. Null when nothing face sized was found.
   */
  readonly faceCenterY?: number | null;
  /** Mean absolute frame difference, 0 to 255. */
  readonly motion: number;
  /**
   * sharpnessOf over the face in the preview sample. The same function, at the
   * same measurement size, that the gate will run on the frame this line is
   * talking a person into taking.
   */
  readonly sharpness: number;
  /**
   * The head position, when the preview is being measured by a detector that can
   * solve for one. Null or absent means the line simply says nothing about pose,
   * which is what it did before 2026-09-07.
   */
  readonly pose?: FacePose | null;
  /**
   * Face width over the preview's short axis, the ratio the engine gates on
   * and the one the crop is built to satisfy. Null when nothing face sized was
   * found.
   */
  readonly faceWidthRatio?: number | null;
  /**
   * False when the box and pose came from the colour threshold fallback rather
   * than a detector. Absent reads as true. See faceEstimateTrusted on the gate.
   */
  readonly faceEstimateTrusted?: boolean;
};

/**
 * The preview width ratio under which the line asks the person to come closer.
 *
 * Deliberately far below the engine's own 0.60, because the engine never sees
 * the preview. autoCropBoxFor composes the uploaded frame to
 * AUTO_CROP_FACE_WIDTH_TARGET of the width from whatever the sensor gave it, so
 * a face at 0.40 of the preview width becomes a face at 0.66 of the upload. The
 * limit is pixels, not framing: the crop of a face this size on a 1920 pixel
 * sensor frame is well over CAPTURE_MIN_SHORT_EDGE, and under this the crop
 * starts upscaling into a soft frame. PROVISIONAL, like every number in the
 * gate, and set to err on letting the tap happen: the burst and the gate are
 * both measuring behind it.
 */
export const LIVE_FACE_WIDTH_RATIO_MIN = 0.4;

export function guidanceKey(stats: LiveFrameStats): GuidanceKey {
  if (stats.meanLuminance < MEAN_LUMINANCE_BORDERLINE_BELOW) {
    return "light";
  }

  /*
   * Pose, when there is a real measurement of it, and before every framing line.
   *
   * This is the whole reason the detector was added. Every refusal this product
   * has read off the live API has been a pose refusal, and until now the only
   * thing the live line could say about pose was inferred from how far down the
   * frame a skin coloured blob had slid. A person was told "Good. Tap to
   * capture.", tapped, waited, and was then told the engine would not read their
   * face. Saying it here costs them a second instead of a round trip.
   *
   * Pitch is separated from the other two axes because it has its own
   * instruction. A head tipped back or dropped forward is almost always a phone
   * held at the wrong height, which is what the eyeLevel line already asks about,
   * and it is the axis the engine's own budget is tightest on in the direction a
   * phone at chest height pushes it.
   */
  /*
   * Only a pose the gate would REFUSE holds the line. A borderline pose is
   * offered by the gate, not refused, and the burst picks the squarest of five
   * frames anyway, so a line that demanded perfection here was demanding more
   * than the gate does. It also demanded it from an estimator that cannot give
   * it: pitch off four keypoints is a heuristic with a guessed neutral point
   * (src/lib/shared/pose.ts), and on 2026-09-14 that guess held a level phone at
   * "Hold the phone at eye level" for as long as the person cared to wait.
   */
  const pose = stats.pose ?? null;
  if (pose !== null && poseVerdictFor(pose) === "reject") {
    const pitchIsTheProblem =
      pose.pitchDegrees > POSE_PITCH_MAX_DEGREES ||
      pose.pitchDegrees < POSE_PITCH_MIN_DEGREES;
    return pitchIsTheProblem ? "eyeLevel" : "square";
  }

  /*
   * Before "move closer", because a phone lifted to eye level moves the face
   * inside the frame as well as squaring it to the lens, so answering the
   * distance first would ask for two corrections where one will do.
   *
   * Two conditions on the proxy, and both are about not contradicting a better
   * reading.
   *
   * Only when the box came from a detector. The colour threshold's box runs
   * down the neck and into whatever bare skin is below it, which drags its
   * middle down the frame, and that is a reading about a neckline, not about
   * where the phone is. A line that held on it held for as long as the person
   * stood there.
   *
   * And only when there is no pose. Where the face sits in the frame was only
   * ever a way of guessing at pitch, and a detector that has measured pitch has
   * answered the question the proxy was asking. On 2026-09-14 a level phone,
   * pitch three degrees, was held at "Hold the phone at eye level" because the
   * box middle read 0.58, which is where a face filling the oval sits. The
   * pose check above has already let that frame through; asking the guess
   * after the measurement can only take the answer back.
   */
  const centerY = stats.faceCenterY ?? null;
  if (
    pose === null &&
    (stats.faceEstimateTrusted ?? true) &&
    centerY !== null &&
    centerY > FACE_CENTER_TOO_LOW_ABOVE
  ) {
    return "eyeLevel";
  }

  /*
   * "Move closer" is asked about the frame the GATE will see, not this one.
   *
   * The gate never sees the preview. It sees the frame after autoCropBoxFor has
   * composed it around the face, which puts the face at AUTO_CROP_FACE_WIDTH_TARGET
   * of the width whatever the person did, as long as there are enough pixels
   * to cut from. So the question here is not "does the face fill the oval" but
   * "is there a face big enough to compose", and the answer is the width ratio
   * of this preview against LIVE_FACE_WIDTH_RATIO_MIN.
   *
   * Until 2026-09-14 this line asked for FACE_COVERAGE_MIN of the frame height,
   * a number calibrated against the old skin colour box, which was a head. A
   * detector reports a face, two thirds of that, so a person filling the oval
   * measured as too far and was told to come closer forever, while the gate,
   * measuring the composed frame, would have let the tap through.
   */
  const widthRatio = stats.faceWidthRatio ?? null;
  if (
    widthRatio === null ||
    widthRatio < LIVE_FACE_WIDTH_RATIO_MIN ||
    stats.faceCoverage === null ||
    stats.faceCoverage < FACE_COVERAGE_REJECT_BELOW
  ) {
    return "closer";
  }
  /*
   * Motion alone decides "Hold still", since 2026-09-14. Sharpness used to be
   * asked here as well, with a threshold set from synthetic patterns, and a
   * smooth face at preview size has every chance of reading under it whatever
   * the focus: that is a line that never says "Good" and a person who never
   * finds out why. The gate no longer flags softness either (assessCapture), so
   * the two still agree, and the burst sends the sharpest of five frames, which
   * is a better answer to a soft moment than asking the person to wait for one.
   */
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
