/**
 * The master frame: one portrait 3:4 frame with fixed geometry, identical on
 * every device. The live view shows exactly it, the oval is defined in its
 * coordinates, the gate measures it, and the upload is it.
 *
 * Why this exists. Until 2026-09-23 the oval on the camera screen was a
 * contract with nothing. It was drawn in stage pixels over an object-cover
 * crop of whatever sensor frame getUserMedia granted, and the tap captured the
 * whole sensor frame, so a face that filled the oval was 0.25 of the picture
 * on a 16:9 laptop track and 0.57 on a 3:4 phone track. Every threshold in the
 * gate was tuned against that moving target, and every fix moved a threshold.
 *
 * This module is the single source for the geometry: the master rect cut from
 * a track, the target oval inside the master frame, the upload composer that
 * puts a gallery photo into the same geometry, the bounds test, and the one
 * bounded reframe retry. docs/01-user-flow.md section D names the contract;
 * docs/04-integrations.md, "Face angle strictness", carries the engine rows
 * and the Camera Kit presets the numbers below are derived from.
 *
 * Pure: no DOM, no canvas, no pixels. Every function here is geometry over
 * numbers, and src/lib/client/image.ts draws what this module computes. Box and
 * Size come from src/lib/shared/quality.ts so the gate and the geometry speak
 * the same coordinates.
 */

import { clampBox, type Box, type Frame } from "./quality";

/** Width and height of a track, a frame, or a source photo, in its pixels. */
export type Size = Frame;

/** A point in the same pixels as the frame it is read against. */
export type Point = {
  readonly x: number;
  readonly y: number;
};

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Width over height of the master frame: 3:4 portrait.
 *
 * Portrait strongly recommended; a 9:16 phone track keeps its full width as a
 * centred 3:4 crop.
 */
export const MASTER_ASPECT = 3 / 4;

/**
 * The longest edge the encoded master frame is ever sent at, in pixels.
 *
 * 1440 puts the short side at the 1080 HD floor; family B downscales above
 * 1080 anyway.
 */
export const MASTER_MAX_LONG_EDGE = 1440;

/**
 * The shortest edge the encoded master frame is ever sent at, in pixels.
 *
 * 480 is the SD floor, enforced on both paths (camera and upload).
 */
export const MASTER_MIN_SHORT_EDGE = 480;

// ---------------------------------------------------------------------------
// The oval
// ---------------------------------------------------------------------------

/**
 * The target face width, cheek to cheek, as a share of the master frame width.
 *
 * Inside 60 to 80, above MODERATE 0.65, margin both sides.
 */
export const FRAME_OVAL_WIDTH = 0.7;

/**
 * The oval's height over its width.
 *
 * Forehead to chin over cheek to cheek on the MediaPipe oval; forehead
 * revealed by construction.
 */
export const FRAME_OVAL_HEIGHT_RATIO = 1.35;

/**
 * Where the face centre sits across the master frame, as a share of its width.
 *
 * Centred; slightly high so shoulders sit below the chin.
 */
export const FRAME_FACE_CENTER_X = 0.5;

/**
 * Where the face centre sits down the master frame, as a share of its height.
 *
 * Centred; slightly high so shoulders sit below the chin.
 */
export const FRAME_FACE_CENTER_Y = 0.47;

/**
 * How close the face oval may come to the left, right and bottom edges before
 * the frame is out of bounds, as a share of the frame's width or height.
 *
 * Engine boundaries are 0..1 with no margin; hair above the oval.
 */
export const FRAME_OVAL_EDGE_MARGIN = 0.03;

/**
 * The same margin at the top edge, larger.
 *
 * Engine boundaries are 0..1 with no margin; hair above the oval.
 */
export const FRAME_OVAL_EDGE_MARGIN_TOP = 0.08;

// ---------------------------------------------------------------------------
// Face width bands
// ---------------------------------------------------------------------------

/**
 * The engine's own face width rule, as a share of the image width.
 *
 * The engine's rule verbatim, reference for the report.
 */
export const FACE_WIDTH_ENGINE_MIN = 0.6;

/**
 * Below this face width ratio a frame is refused.
 *
 * Camera Kit RELAXED floor (our measure is narrower than any box); band edges
 * with the same 0.04 margin the oval sits above 0.65.
 */
export const FACE_WIDTH_REJECT_BELOW = 0.55;

/**
 * Below this face width ratio a frame is borderline.
 *
 * Camera Kit RELAXED floor (our measure is narrower than any box); band edges
 * with the same 0.04 margin the oval sits above 0.65.
 */
export const FACE_WIDTH_BORDERLINE_BELOW = 0.64;

/**
 * Above this face width ratio a frame is borderline.
 *
 * Camera Kit RELAXED floor (our measure is narrower than any box); band edges
 * with the same 0.04 margin the oval sits above 0.65.
 */
export const FACE_WIDTH_BORDERLINE_ABOVE = 0.85;

// ---------------------------------------------------------------------------
// The retry
// ---------------------------------------------------------------------------

/**
 * The share of both frame dimensions the one reframe retry keeps.
 *
 * 0.70 + 2 x 0.03: tightest concentric crop that still contains the oval and
 * its margin.
 */
export const REFRAME_KEEP_FRACTION = 0.76;

// ---------------------------------------------------------------------------
// Sample sizes and timing
// ---------------------------------------------------------------------------

/**
 * The long edge of the master sample the live guidance line is measured on.
 *
 * Cheek span above 150 px at 0.55 width; eyes readable for the uneven measure.
 */
export const GUIDANCE_SAMPLE_LONG_EDGE = 384;

/**
 * The long edge of the copy each burst frame is measured on.
 *
 * Cheek span above 150 px at 0.55 width; eyes readable for the uneven measure.
 */
export const BURST_MEASURE_LONG_EDGE = 512;

/**
 * How long the frame has to read ready before the oval turns solid.
 *
 * Camera Kit's 800 ms good quality rule; a countdown short enough not to
 * invite movement.
 */
export const READY_HOLD_MS = 800;

/**
 * How long the countdown runs after the hold before the shutter fires itself.
 *
 * Camera Kit's 800 ms good quality rule; a countdown short enough not to
 * invite movement.
 */
export const AUTO_CAPTURE_COUNTDOWN_MS = 700;

/**
 * Which geometry a stored capture was measured and composed under. Written to
 * captures.quality so a calibration report never compares numbers taken under
 * two different frames. Bump it when any constant above changes.
 */
export const FRAME_GEOMETRY_VERSION = 1;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function isPositiveSize(size: Size): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

function isFiniteBox(box: Box): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * The largest centred 3:4 crop of a track, in whole track pixels.
 *
 * A portrait phone track (1080x1920) keeps its full width and gives 1080x1440
 * at y 240; a landscape laptop track (1920x1080) keeps its full height and
 * gives 810x1080 at x 555. The derived edge is floored rather than rounded so
 * the rect is always inside the track, which costs at most one pixel of
 * aspect.
 *
 * Read after the first delivered frame and again on the video resize event:
 * iOS reports the landscape sensor size for the first few hundred milliseconds
 * of a track and then the portrait size, and the shutter stays disabled until
 * this has been computed from a delivered frame.
 *
 * Throws on a track without positive finite dimensions, because a rect for no
 * picture is not a rect and the caller has nothing to draw.
 */
export function masterRectFor(track: Size): Box {
  if (!isPositiveSize(track)) {
    throw new Error("masterRectFor needs a track with positive dimensions.");
  }
  const wide = track.width / track.height > MASTER_ASPECT;
  if (wide) {
    const height = Math.floor(track.height);
    const width = Math.min(Math.floor(height * MASTER_ASPECT), Math.floor(track.width));
    return {
      x: Math.floor((track.width - width) / 2),
      y: 0,
      width,
      height,
    };
  }
  const width = Math.floor(track.width);
  const height = Math.min(Math.floor(width / MASTER_ASPECT), Math.floor(track.height));
  return {
    x: 0,
    y: Math.floor((track.height - height) / 2),
    width,
    height,
  };
}

/**
 * The target oval's bounding box in the pixels of a frame, from the four oval
 * constants: width FRAME_OVAL_WIDTH of the frame width, height
 * FRAME_OVAL_HEIGHT_RATIO times that, centred at (FRAME_FACE_CENTER_X,
 * FRAME_FACE_CENTER_Y).
 *
 * Defined from the frame's width, because the master frame is 3:4 and the
 * engine's rule is about width. Not rounded: the oval is a target, not a crop,
 * and the stage draws it as percentages (ovalStageStyle) that this must equal
 * to the pixel.
 */
export function ovalBoxIn(frame: Size): Box {
  const width = frame.width * FRAME_OVAL_WIDTH;
  const height = width * FRAME_OVAL_HEIGHT_RATIO;
  return {
    x: frame.width * FRAME_FACE_CENTER_X - width / 2,
    y: frame.height * FRAME_FACE_CENTER_Y - height / 2,
    width,
    height,
  };
}

export type OvalStageStyle = {
  readonly leftPercent: number;
  readonly topPercent: number;
  readonly widthPercent: number;
  readonly heightPercent: number;
};

/**
 * The same oval as percentages of a 3:4 stage, for the CSS that draws it.
 *
 * The stage is aspect-[3/4] and shows exactly the master frame, so percentages
 * of the stage are shares of the master frame, and the oval drawn from these
 * lands on the same pixels ovalBoxIn names. The height is a share of the
 * frame's height, which is 4/3 of its width, hence the division.
 */
export function ovalStageStyle(): OvalStageStyle {
  const widthShare = FRAME_OVAL_WIDTH;
  const heightShare = FRAME_OVAL_WIDTH * FRAME_OVAL_HEIGHT_RATIO * MASTER_ASPECT;
  return {
    leftPercent: (FRAME_FACE_CENTER_X - widthShare / 2) * 100,
    topPercent: (FRAME_FACE_CENTER_Y - heightShare / 2) * 100,
    widthPercent: widthShare * 100,
    heightPercent: heightShare * 100,
  };
}

/**
 * The crop that puts a gallery photo into the master geometry, or null for
 * degenerate input.
 *
 * The camera path frames a person inside the oval; the upload path has no oval
 * to aim at, so it composes the frame around the face the landmarker found and
 * lands on the same geometry the camera would have. The rule, in order:
 *
 * 1. The crop width is the face width over FRAME_OVAL_WIDTH, so the face fills
 *    the same 0.70 of the crop it fills of the oval, and the height is the
 *    width at MASTER_ASPECT.
 * 2. When the source is smaller than that, the crop shrinks to fit it, keeping
 *    3:4.
 * 3. The crop is never narrower than the face. This outranks the aspect: a
 *    crop narrower than the face is a face cut down the side, which no retry
 *    recovers, so on a source too short to hold a 3:4 box as wide as the face
 *    the crop keeps the face's width and takes the source's full height.
 * 4. The face centre is placed at (FRAME_FACE_CENTER_X, FRAME_FACE_CENTER_Y)
 *    of the crop, and the crop is slid inside the source rather than shrunk
 *    when that would put it over an edge.
 *
 * Whole pixels: the width is ceiled so rounding can never make it narrower
 * than the face, and every edge is clamped to the source. A crop that covers
 * the whole source is returned as it is; the caller decides whether drawing it
 * is worth a canvas pass.
 *
 * Null when a dimension is missing, zero or negative, or when the face is
 * wider or taller than the source, which is a detection that has gone wrong
 * rather than a framing problem.
 */
export function masterCropFor(faceOval: Box, source: Size): Box | null {
  if (!isPositiveSize(source) || !isFiniteBox(faceOval)) {
    return null;
  }
  if (faceOval.width <= 0 || faceOval.height <= 0) {
    return null;
  }
  if (faceOval.width > source.width || faceOval.height > source.height) {
    return null;
  }

  let width = faceOval.width / FRAME_OVAL_WIDTH;
  let height = width / MASTER_ASPECT;

  const fit = Math.min(1, source.width / width, source.height / height);
  width *= fit;
  height *= fit;

  if (width < faceOval.width) {
    width = faceOval.width;
    height = Math.min(width / MASTER_ASPECT, source.height);
  }

  /*
   * Ceiled so rounding never makes the crop narrower than the face, less a
   * millionth of a pixel so a width that is whole up to float noise (1058.4
   * over 0.7 is 1512 and computes as a hair above it) stays whole.
   */
  const wholeWidth = Math.min(
    Math.floor(source.width),
    Math.ceil(width - 1e-6),
  );
  const wholeHeight = Math.min(
    Math.floor(source.height),
    Math.round(wholeWidth / MASTER_ASPECT),
  );

  const faceCenterX = faceOval.x + faceOval.width / 2;
  const faceCenterY = faceOval.y + faceOval.height / 2;
  const x = clamp(
    Math.round(faceCenterX - wholeWidth * FRAME_FACE_CENTER_X),
    0,
    Math.floor(source.width) - wholeWidth,
  );
  const y = clamp(
    Math.round(faceCenterY - wholeHeight * FRAME_FACE_CENTER_Y),
    0,
    Math.floor(source.height) - wholeHeight,
  );

  return clampBox({ x, y, width: wholeWidth, height: wholeHeight }, source);
}

/**
 * True when the face oval, expanded by the edge margins, crosses an edge of
 * the frame. This is what error_face_position_out_of_boundary names, asked
 * before the upload.
 *
 * The margins are shares of the frame, not of the face, because the engine's
 * boundaries are 0..1 of the image. The top margin is larger
 * (FRAME_OVAL_EDGE_MARGIN_TOP) because the hair sits above the oval and the
 * engine asks for the forehead to be revealed.
 */
export function ovalTouchesEdge(faceOval: Box, frame: Size): boolean {
  const marginX = frame.width * FRAME_OVAL_EDGE_MARGIN;
  const marginBottom = frame.height * FRAME_OVAL_EDGE_MARGIN;
  const marginTop = frame.height * FRAME_OVAL_EDGE_MARGIN_TOP;
  return (
    faceOval.x - marginX < 0 ||
    faceOval.y - marginTop < 0 ||
    faceOval.x + faceOval.width + marginX > frame.width ||
    faceOval.y + faceOval.height + marginBottom > frame.height
  );
}

/**
 * The one bounded retry crop: a concentric 3:4 box keeping
 * REFRAME_KEEP_FRACTION of both frame dimensions, centred on the face centre
 * (the frame's target centre when none is given), slid inside the frame.
 *
 * One step rather than a ladder, because the retry answers exactly one
 * refusal, error_src_face_too_small, and a face that was inside the oval is
 * inside this crop by construction: the crop is 0.76 of the frame wide and
 * the oval is 0.70, so the oval and its 0.03 margin on each side fit. On a
 * frame that is not 3:4 the crop is the largest 3:4 box that keeps at most
 * REFRAME_KEEP_FRACTION of either dimension.
 *
 * Whole pixels, floored so the box is always inside the frame. Throws on a
 * frame without positive dimensions, like masterRectFor.
 */
export function reframeBoxFor(frame: Size, faceCenter?: Point): Box {
  if (!isPositiveSize(frame)) {
    throw new Error("reframeBoxFor needs a frame with positive dimensions.");
  }
  const keptWidth = frame.width * REFRAME_KEEP_FRACTION;
  const keptHeight = frame.height * REFRAME_KEEP_FRACTION;
  const width = Math.max(
    1,
    Math.floor(Math.min(keptWidth, keptHeight * MASTER_ASPECT)),
  );
  const height = Math.max(
    1,
    Math.min(Math.floor(width / MASTER_ASPECT), Math.floor(frame.height)),
  );

  const center: Point =
    faceCenter !== undefined &&
    Number.isFinite(faceCenter.x) &&
    Number.isFinite(faceCenter.y)
      ? faceCenter
      : {
          x: frame.width * FRAME_FACE_CENTER_X,
          y: frame.height * FRAME_FACE_CENTER_Y,
        };

  const x = clamp(
    Math.round(center.x - width / 2),
    0,
    Math.floor(frame.width) - width,
  );
  const y = clamp(
    Math.round(center.y - height / 2),
    0,
    Math.floor(frame.height) - height,
  );

  return { x, y, width, height };
}
