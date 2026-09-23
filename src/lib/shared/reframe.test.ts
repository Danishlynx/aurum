import { describe, expect, it } from "vitest";

import { atLeastShortEdge, fitWithin } from "@/lib/client/image";
import {
  FRAME_FACE_CENTER_X,
  FRAME_FACE_CENTER_Y,
  MASTER_MAX_LONG_EDGE,
  MASTER_MIN_SHORT_EDGE,
  REFRAME_KEEP_FRACTION,
  ovalBoxIn,
  reframeBoxFor,
} from "./frame-geometry";
import {
  FIRST_REFRAME_ATTEMPT,
  MAX_CAPTURE_ATTEMPTS,
  hasReframeLeft,
} from "./reframe";

/**
 * The one reframe retry: the attempt bookkeeping here, and the crop it draws
 * from src/lib/shared/frame-geometry.ts, against the frames it actually
 * meets. The source is the master frame the capture screen sent (3:4, at
 * least 480 on the short edge), and the crop is one bounded step centred on
 * the face the gate read.
 */

/** The master frame on a phone. */
const PHONE = { width: 1080, height: 1440 } as const;
/** The smallest master frame, from a 640 by 480 track after the floor. */
const SMALLEST = { width: 480, height: 640 } as const;

describe("the attempt bookkeeping", () => {
  it("gives a capture two attempts in total: the frame sent and one reframe", () => {
    expect(FIRST_REFRAME_ATTEMPT).toBe(2);
    expect(MAX_CAPTURE_ATTEMPTS).toBe(2);
  });

  it("has a reframe left only for the frame the person sent", () => {
    expect(hasReframeLeft(1)).toBe(true);
    expect(hasReframeLeft(FIRST_REFRAME_ATTEMPT)).toBe(false);
    expect(hasReframeLeft(MAX_CAPTURE_ATTEMPTS)).toBe(false);
    expect(hasReframeLeft(MAX_CAPTURE_ATTEMPTS + 1)).toBe(false);
    expect(hasReframeLeft(Number.NaN)).toBe(false);
  });
});

describe("the one reframe step", () => {
  it("keeps 0.76 of the master frame as a 3:4 box that still holds the oval", () => {
    for (const frame of [PHONE, SMALLEST]) {
      const crop = reframeBoxFor(frame);
      expect(crop.width).toBeLessThanOrEqual(frame.width * REFRAME_KEEP_FRACTION);
      expect(Math.abs(crop.width / crop.height - 3 / 4)).toBeLessThan(0.01);
      const oval = ovalBoxIn(frame);
      expect(crop.x).toBeLessThanOrEqual(oval.x);
      expect(crop.y).toBeLessThanOrEqual(oval.y);
      expect(crop.x + crop.width).toBeGreaterThanOrEqual(oval.x + oval.width);
      expect(crop.y + crop.height).toBeGreaterThanOrEqual(oval.y + oval.height);
    }
  });

  it("centres on the face the gate read, not on the picture", () => {
    // A face a little right of and below the target centre, as the gate
    // would have read it in the master frame's pixels.
    const face = { x: 600, y: 760 };
    const crop = reframeBoxFor(PHONE, face);
    // To the pixel: the box is whole and its height is odd, so its centre
    // sits on a half pixel.
    expect(Math.abs(crop.x + crop.width / 2 - face.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(crop.y + crop.height / 2 - face.y)).toBeLessThanOrEqual(1);
  });

  it("centres on the frame's target when no face centre was read", () => {
    const crop = reframeBoxFor(PHONE);
    expect(
      Math.abs(crop.x + crop.width / 2 - PHONE.width * FRAME_FACE_CENTER_X),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(crop.y + crop.height / 2 - PHONE.height * FRAME_FACE_CENTER_Y),
    ).toBeLessThanOrEqual(1);
  });

  it("slides inside the frame rather than leaving it for a face near an edge", () => {
    const crop = reframeBoxFor(PHONE, { x: 40, y: 40 });
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(0);
    const far = reframeBoxFor(PHONE, { x: 1070, y: 1430 });
    expect(far.x + far.width).toBe(PHONE.width);
    expect(far.y + far.height).toBe(PHONE.height);
  });

  /**
   * The reason src/lib/client/capture-source.ts draws the crop with the
   * engine's floor: on a source that is already small, the tightest crop is
   * under the skin analysis minimum at its own size, and sending it would buy
   * a refusal rather than a reading. An 800 by 600 source (a landscape photo
   * a browser without frame callbacks might hand over) keeps 456 of its
   * height, and the 3:4 box on that is 342 wide.
   */
  it("comes out under the engine's minimum on a small source, which the draw lifts", () => {
    const small = { width: 800, height: 600 };
    const crop = reframeBoxFor(small);
    expect(Math.min(crop.width, crop.height)).toBeLessThan(MASTER_MIN_SHORT_EDGE);

    // What drawCropToCanvas does with it: fit the cap, then lift to the floor.
    const drawn = atLeastShortEdge(
      fitWithin({ width: crop.width, height: crop.height }, MASTER_MAX_LONG_EDGE),
      MASTER_MIN_SHORT_EDGE,
    );
    expect(Math.min(drawn.width, drawn.height)).toBe(MASTER_MIN_SHORT_EDGE);
    expect(Math.abs(drawn.width / drawn.height - crop.width / crop.height)).toBeLessThan(
      0.01,
    );

    // And the smallest master frame the camera path produces lands the same way.
    const smallest = reframeBoxFor(SMALLEST);
    expect(Math.min(smallest.width, smallest.height)).toBeLessThan(MASTER_MIN_SHORT_EDGE);
    const lifted = atLeastShortEdge(
      fitWithin({ width: smallest.width, height: smallest.height }, MASTER_MAX_LONG_EDGE),
      MASTER_MIN_SHORT_EDGE,
    );
    expect(Math.min(lifted.width, lifted.height)).toBe(MASTER_MIN_SHORT_EDGE);
  });

  it("stays inside the phone's cap on the phone's own frame", () => {
    const crop = reframeBoxFor(PHONE);
    expect(Math.max(crop.width, crop.height)).toBeLessThanOrEqual(MASTER_MAX_LONG_EDGE);
    expect(Math.min(crop.width, crop.height)).toBeGreaterThanOrEqual(MASTER_MIN_SHORT_EDGE);
  });
});
