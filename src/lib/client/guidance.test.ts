import { describe, expect, it } from "vitest";

import {
  GUIDANCE_SAMPLE_LONG_EDGE,
  MOTION_STILL_AT_OR_BELOW,
  guidanceKey,
  guidanceLine,
  meanLuminanceOf,
  motionBetween,
} from "./guidance";
import { copy } from "@/lib/shared/copy";
import {
  FACE_COVERAGE_MIN,
  MEAN_LUMINANCE_BORDERLINE_BELOW,
  SHARPNESS_BORDERLINE_BELOW,
  SHARPNESS_MEASURE_LONG_EDGE,
  assessCapture,
  sharpnessOf,
} from "@/lib/shared/quality";
import type { Box, GrayscaleImage } from "@/lib/shared/quality";

/**
 * The live line and the gate, held to each other.
 *
 * The failure this file exists to catch happened on a real phone on 2026-09-03:
 * a Samsung S26 Ultra indoors in the evening, the line under the oval reading
 * "Good. Tap to capture." and the gate answering "A little blurry. Hold still
 * and tap again." on the very frame that had just been tapped. Every shot. The
 * two were measuring the same face at two different resolutions and comparing
 * the results to one threshold, which is not a comparison at all.
 *
 * So the test is the promise: whatever the line says, the gate agrees with it.
 */

/** One picture, drawable at any size: bands at a fixed share of the width. */
function bands(
  width: number,
  height: number,
  contrast: number,
): GrayscaleImage {
  const period = width / 12;
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const high = Math.floor(x / period) % 2 === 0;
      data[y * width + x] = 130 + (high ? contrast : -contrast);
    }
  }
  return { data, width, height };
}

/** A face box filling exactly the framing rule, centered. */
function faceBoxIn(width: number, height: number): Box {
  const boxHeight = Math.round(height * FACE_COVERAGE_MIN);
  const boxWidth = Math.round(boxHeight * 0.68);
  return {
    x: Math.round((width - boxWidth) / 2),
    y: Math.round((height - boxHeight) / 2),
    width: boxWidth,
    height: boxHeight,
  };
}

/**
 * The two frames the same face arrives in.
 *
 * The preview sample the guidance line is measured off, at the size
 * src/components/capture/CaptureScreen.tsx draws it, and the 1024px capture the
 * gate measures, both at 9 by 16, which is what a front camera hands back in
 * portrait. Same picture, resolutions a factor of three apart.
 */
const PREVIEW = {
  width: Math.round((GUIDANCE_SAMPLE_LONG_EDGE * 9) / 16),
  height: GUIDANCE_SAMPLE_LONG_EDGE,
} as const;
const CAPTURE = { width: 576, height: 1024 } as const;

const CONTRASTS = [0, 1, 2, 3, 6, 12, 24, 48] as const;

describe("guidanceKey", () => {
  const READY = {
    meanLuminance: 140,
    faceCoverage: 0.7,
    motion: 0,
    sharpness: SHARPNESS_BORDERLINE_BELOW * 4,
  };

  it("says the frame is good only when every check the gate runs is clear", () => {
    expect(guidanceKey(READY)).toBe("ready");
    expect(guidanceLine(READY)).toBe(copy.capture.guidance.ready);
  });

  it("asks for light first, because a dark frame measures wrong everywhere", () => {
    expect(
      guidanceKey({
        ...READY,
        meanLuminance: MEAN_LUMINANCE_BORDERLINE_BELOW - 1,
        faceCoverage: null,
        motion: 100,
        sharpness: 0,
      }),
    ).toBe("light");
  });

  it("asks for distance before stillness", () => {
    expect(
      guidanceKey({
        ...READY,
        faceCoverage: FACE_COVERAGE_MIN - 0.01,
        motion: 100,
        sharpness: 0,
      }),
    ).toBe("closer");
    expect(guidanceKey({ ...READY, faceCoverage: null })).toBe("closer");
  });

  it("says hold still for a moving frame and for a soft one alike", () => {
    expect(
      guidanceKey({ ...READY, motion: MOTION_STILL_AT_OR_BELOW + 1 }),
    ).toBe("hold");
    expect(
      guidanceKey({ ...READY, sharpness: SHARPNESS_BORDERLINE_BELOW - 1 }),
    ).toBe("hold");
    // And at the line itself the frame is good, the same way the gate reads it.
    expect(
      guidanceKey({ ...READY, sharpness: SHARPNESS_BORDERLINE_BELOW }),
    ).toBe("ready");
  });

  it("never promises a frame the gate would then call blurry", () => {
    for (const sharpness of [0, 1, 30, 59, 60, 61, 500]) {
      const said = guidanceKey({ ...READY, sharpness });
      const flagged = sharpness < SHARPNESS_BORDERLINE_BELOW;
      expect(said === "ready").toBe(!flagged);
    }
  });
});

describe("the live line and the gate, on the same face", () => {
  it("measures the preview sample and the capture at the same size", () => {
    const preview = bands(PREVIEW.width, PREVIEW.height, 20);
    const capture = bands(CAPTURE.width, CAPTURE.height, 20);
    // Both face crops are larger than the measurement size, so both resample
    // down to it and neither is stretched up to meet the other.
    expect(faceBoxIn(PREVIEW.width, PREVIEW.height).height).toBeGreaterThan(
      SHARPNESS_MEASURE_LONG_EDGE,
    );
    expect(faceBoxIn(CAPTURE.width, CAPTURE.height).height).toBeGreaterThan(
      SHARPNESS_MEASURE_LONG_EDGE,
    );
    expect(preview.height * 3).toBeLessThan(capture.height);
  });

  it("reads the same sharpness off both, across the whole range", () => {
    for (const contrast of CONTRASTS) {
      const live = sharpnessOf(
        bands(PREVIEW.width, PREVIEW.height, contrast),
        faceBoxIn(PREVIEW.width, PREVIEW.height),
      );
      const gate = sharpnessOf(
        bands(CAPTURE.width, CAPTURE.height, contrast),
        faceBoxIn(CAPTURE.width, CAPTURE.height),
      );
      if (contrast === 0) {
        expect(live).toBe(0);
        expect(gate).toBe(0);
        continue;
      }
      expect(live / gate).toBeGreaterThan(0.75);
      expect(live / gate).toBeLessThan(1.34);
    }
  });

  /**
   * The whole point. "Good. Tap to capture." is a promise about what the next
   * tap will do, so for every frame in the sweep the line and the verdict have
   * to be the same fact.
   */
  it("says good exactly when the gate would not flag the frame", () => {
    for (const contrast of CONTRASTS) {
      const said = guidanceKey({
        meanLuminance: meanLuminanceOf(
          bands(PREVIEW.width, PREVIEW.height, contrast),
        ),
        faceCoverage: FACE_COVERAGE_MIN,
        motion: 0,
        sharpness: sharpnessOf(
          bands(PREVIEW.width, PREVIEW.height, contrast),
          faceBoxIn(PREVIEW.width, PREVIEW.height),
        ),
      });

      const verdict = assessCapture({
        image: bands(CAPTURE.width, CAPTURE.height, contrast),
        faceCount: 1,
        faceBox: faceBoxIn(CAPTURE.width, CAPTURE.height),
      });
      const flagged = verdict.failures.some(
        (failure) => failure.reason === "blurry",
      );

      expect(said === "ready").toBe(!flagged);
      // And whatever it decided, the frame is never refused for softness.
      expect(verdict.verdict).not.toBe("reject");
    }
  });
});

describe("motionBetween", () => {
  it("reads still when there is nothing to compare against", () => {
    expect(motionBetween(null, [1, 2, 3])).toBe(0);
    expect(motionBetween([1, 2], [1, 2, 3])).toBe(0);
    expect(motionBetween([], [])).toBe(0);
  });

  it("is the mean absolute difference between two frames", () => {
    expect(motionBetween([0, 0, 0, 0], [10, 10, 10, 10])).toBe(10);
    expect(motionBetween([10, 10], [10, 10])).toBe(0);
  });
});

describe("meanLuminanceOf", () => {
  it("is the mean, and zero for an empty buffer", () => {
    expect(meanLuminanceOf({ data: [0, 255], width: 2, height: 1 })).toBe(127.5);
    expect(meanLuminanceOf({ data: [], width: 0, height: 0 })).toBe(0);
  });
});
