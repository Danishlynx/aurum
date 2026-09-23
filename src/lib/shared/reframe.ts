/**
 * How many times a refused capture is sent back, and which attempt is which.
 *
 * Why this exists. On 2026-09-03 the founder's phone uploaded a selfie twice and
 * the skin analysis refused both with error_src_face_too_small. A refused task
 * is charged nothing (docs/04-integrations.md, "Input errors"), so a second
 * framing of the same photo costs nothing but the seconds, and /analyzing sends
 * one back cropped tighter before it shows the person a refusal.
 *
 * The crop itself is geometry of the master frame and lives in
 * src/lib/shared/frame-geometry.ts (reframeBoxFor): one bounded step, a
 * concentric 3:4 box keeping REFRAME_KEEP_FRACTION of both dimensions, centred
 * on the face centre the gate read, which by construction cannot cut inside
 * the target oval. One step rather than a ladder, because the retry answers
 * exactly one refusal and a face that was inside the oval is inside that crop.
 * The two step ladder this module used to hold (72 then 55 percent of the
 * height at a guessed centre) could decapitate a camera capture, and is gone
 * with the sensor frame it was cut from.
 *
 * This module is only the bookkeeping: which attempt number the frame the
 * person sent has, and whether an attempt is left. Pure, no geometry.
 */

/** The first attempt is the frame as it was sent, so reframing starts at 2. */
export const FIRST_REFRAME_ATTEMPT = 2;

/**
 * How many attempts a capture gets in total, the original included: the frame
 * the person sent, and the one reframe of it.
 */
export const MAX_CAPTURE_ATTEMPTS = 2;

/** True while a capture on this attempt still has a reframe left to try. */
export function hasReframeLeft(attempt: number): boolean {
  return Number.isFinite(attempt) && attempt < MAX_CAPTURE_ATTEMPTS;
}
