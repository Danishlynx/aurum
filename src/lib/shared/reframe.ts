/**
 * The crop a refused capture is sent back with.
 *
 * Why this exists. On 2026-09-03 the founder's phone uploaded a selfie twice and
 * the skin analysis refused both with error_src_face_too_small. That phone's
 * browser has no FaceDetector, so the framing in src/lib/shared/quality.ts
 * (autoCropBoxFor) was composed around the skin region heuristic in
 * src/lib/client/face.ts, which had run down the neck and shoulders and returned
 * a box far larger than the face. The crop was therefore far looser than it
 * looked, and the engine measured what we actually sent.
 *
 * A refused task is charged nothing (docs/04-integrations.md, "Input errors"),
 * so a second and a third framing of the same photo cost nothing but the
 * seconds. This module is the geometry of those two attempts. It deliberately
 * uses no face estimate at all: the estimate is the thing that was wrong, and a
 * fixed centre crop cannot be misled by lit shoulders.
 *
 * The numbers, and where they come from:
 *
 * - 72 percent of the frame height, then 55 percent. Two steps rather than one
 *   jump, because a photo taken at arm's length and a photo taken across a room
 *   need different amounts, and the cheaper step is tried first.
 * - 3 by 4 portrait, the same shape autoCropBoxFor aims at and the shape the
 *   capture stage shows a frame in.
 * - Centred horizontally, because a person taking a selfie puts themselves in
 *   the middle of the frame.
 * - Vertical centre at 42 percent of the frame height, not 50. Faces sit high:
 *   people frame their head in the upper half and leave the shoulders below,
 *   and the reveal's own vignette is drawn at "circle at 50% 42%" for the same
 *   reason (src/components/analyzing/AnalyzingScreen.tsx).
 *
 * Pure geometry. No canvas, no pixels, no DOM: the caller draws the box.
 */

import type { Box, Frame } from "./quality";

/**
 * The share of the frame height each retry keeps, in order. Attempt 1 is the
 * frame the person sent, so index 0 is attempt 2.
 */
export const REFRAME_HEIGHT_FRACTIONS = [0.72, 0.55] as const;

/** Width over height the crop aims for: 3 by 4 portrait. */
export const REFRAME_ASPECT = 0.75;

/** Where the crop is centred vertically, as a share of the frame height. */
export const REFRAME_VERTICAL_CENTER = 0.42;

/** The first attempt is the frame as it was sent, so reframing starts at 2. */
export const FIRST_REFRAME_ATTEMPT = 2;

/** How many attempts a capture gets in total, the original included. */
export const MAX_CAPTURE_ATTEMPTS =
  FIRST_REFRAME_ATTEMPT + REFRAME_HEIGHT_FRACTIONS.length - 1;

export type ReframeInput = {
  /** The source photo, in its own pixels. */
  readonly frame: Frame;
  /** 1 for the frame the person sent, 2 and 3 for the reframes. */
  readonly attempt: number;
};

/**
 * The crop for one attempt, or null when this attempt has nothing to reframe:
 * attempt 1 is the frame as sent, and anything past the last fraction is the end
 * of the loop.
 *
 * The box is always inside the frame and never wider than it is tall, so what a
 * tight crop trims is shoulder rather than face.
 */
export function reframeBoxFor(input: ReframeInput): Box | null {
  const { frame, attempt } = input;
  if (frame.width <= 0 || frame.height <= 0) {
    return null;
  }
  if (!Number.isFinite(attempt)) {
    return null;
  }
  const fraction = REFRAME_HEIGHT_FRACTIONS[attempt - FIRST_REFRAME_ATTEMPT];
  if (fraction === undefined) {
    return null;
  }

  const height = Math.min(frame.height * fraction, frame.height);
  const width = Math.min(height * REFRAME_ASPECT, frame.width);
  const x = Math.max(0, (frame.width - width) / 2);
  const y = Math.min(
    Math.max(frame.height * REFRAME_VERTICAL_CENTER - height / 2, 0),
    frame.height - height,
  );

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** True while a capture on this attempt still has a reframe left to try. */
export function hasReframeLeft(attempt: number): boolean {
  return (
    REFRAME_HEIGHT_FRACTIONS[attempt + 1 - FIRST_REFRAME_ATTEMPT] !== undefined
  );
}
