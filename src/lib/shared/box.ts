/**
 * A rectangle and a frame, in pixels, and the one operation on them that both
 * the gate and the geometry need: clamping a box to a frame.
 *
 * A leaf module on purpose. src/lib/shared/quality.ts (the gate) and
 * src/lib/shared/frame-geometry.ts (the master frame) speak the same
 * coordinates and each needs these types and this function; until 2026-09-23
 * frame-geometry imported them from quality while quality imported the width
 * bands from frame-geometry, and a value read across that cycle at module load
 * was undefined. Both now import from here and neither imports the other's
 * constants at load time.
 *
 * Pure: no DOM, no canvas.
 */

/** A rectangle in image pixels, origin top left. */
export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** The frame a box is read against: a track, a canvas, a source photo. */
export type Frame = {
  readonly width: number;
  readonly height: number;
};

/** Width and height of a track, a frame, or a source photo, in its pixels. */
export type Size = Frame;

/** Clamps a box to the frame's bounds. Returns null when nothing is left. */
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
