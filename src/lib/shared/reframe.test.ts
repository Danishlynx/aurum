import { describe, expect, it } from "vitest";

import {
  FIRST_REFRAME_ATTEMPT,
  MAX_CAPTURE_ATTEMPTS,
  REFRAME_HEIGHT_FRACTIONS,
  REFRAME_VERTICAL_CENTER,
  hasReframeLeft,
  reframeBoxFor,
} from "./reframe";
import type { Box, Frame } from "./quality";

/**
 * The retry crop, against the two frames it actually meets: a phone gallery
 * photo, which is portrait, and a laptop or phone camera track, which is
 * landscape and the shape that used to leave a crop under the engine's own
 * minimum.
 */
const PORTRAIT: Frame = { width: 768, height: 1024 };
const LANDSCAPE: Frame = { width: 1920, height: 1080 };

function box(frame: Frame, attempt: number): Box {
  const result = reframeBoxFor({ frame, attempt });
  expect(result).not.toBeNull();
  return result as Box;
}

describe("reframeBoxFor", () => {
  it("leaves the frame the person sent alone", () => {
    // Attempt 1 is that frame. There is nothing to reframe about it yet.
    expect(reframeBoxFor({ frame: PORTRAIT, attempt: 1 })).toBeNull();
    expect(reframeBoxFor({ frame: PORTRAIT, attempt: 0 })).toBeNull();
  });

  it("stops after the last fraction rather than cropping forever", () => {
    expect(
      reframeBoxFor({ frame: PORTRAIT, attempt: MAX_CAPTURE_ATTEMPTS }),
    ).not.toBeNull();
    expect(
      reframeBoxFor({ frame: PORTRAIT, attempt: MAX_CAPTURE_ATTEMPTS + 1 }),
    ).toBeNull();
    expect(hasReframeLeft(1)).toBe(true);
    expect(hasReframeLeft(MAX_CAPTURE_ATTEMPTS - 1)).toBe(true);
    expect(hasReframeLeft(MAX_CAPTURE_ATTEMPTS)).toBe(false);
  });

  it("keeps the documented share of the height, and tightens each attempt", () => {
    const heights = REFRAME_HEIGHT_FRACTIONS.map(
      (_, index) => box(PORTRAIT, FIRST_REFRAME_ATTEMPT + index).height,
    );
    expect(heights[0]).toBe(Math.round(PORTRAIT.height * 0.72));
    expect(heights[1]).toBe(Math.round(PORTRAIT.height * 0.55));
    expect(heights[1]).toBeLessThan(heights[0] ?? 0);
  });

  it("is portrait and centred across the frame", () => {
    for (const frame of [PORTRAIT, LANDSCAPE]) {
      for (let attempt = FIRST_REFRAME_ATTEMPT; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const crop = box(frame, attempt);
        expect(crop.width).toBeLessThanOrEqual(crop.height);
        // The same margin on both sides, to the rounding.
        const left = crop.x;
        const right = frame.width - (crop.x + crop.width);
        expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("sits high, because faces do", () => {
    for (const frame of [PORTRAIT, LANDSCAPE]) {
      for (let attempt = FIRST_REFRAME_ATTEMPT; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const crop = box(frame, attempt);
        const center = (crop.y + crop.height / 2) / frame.height;
        // Either centred where a face is, or pushed against the top by a crop
        // too tall to sit there, which is the only reason to be higher.
        expect(center).toBeLessThanOrEqual(REFRAME_VERTICAL_CENTER + 0.01);
        expect(crop.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never leaves the picture", () => {
    for (const frame of [PORTRAIT, LANDSCAPE, { width: 400, height: 400 }]) {
      for (let attempt = FIRST_REFRAME_ATTEMPT; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
        const crop = box(frame, attempt);
        expect(crop.x).toBeGreaterThanOrEqual(0);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.x + crop.width).toBeLessThanOrEqual(frame.width);
        expect(crop.y + crop.height).toBeLessThanOrEqual(frame.height);
      }
    }
  });

  it("answers nothing for a frame with no size", () => {
    expect(reframeBoxFor({ frame: { width: 0, height: 0 }, attempt: 2 })).toBeNull();
    expect(
      reframeBoxFor({ frame: PORTRAIT, attempt: Number.NaN }),
    ).toBeNull();
  });

  /**
   * The reason src/lib/client/image.ts scales a retry crop up to a 480px short
   * side: on the landscape track a phone camera hands us, the tightest crop is
   * well under the skin analysis minimum at its own size, and sending it would
   * buy a refusal rather than a reading.
   */
  it("comes out under the engine's minimum on a landscape frame, which the draw fixes", () => {
    const tightest = box(LANDSCAPE, MAX_CAPTURE_ATTEMPTS);
    expect(Math.min(tightest.width, tightest.height)).toBeLessThan(480);
  });
});
