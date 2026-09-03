import { describe, expect, it } from "vitest";

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

import {
  FACE_CENTER_TOO_LOW_ABOVE,
  GUIDANCE_SAMPLE_LONG_EDGE,
  MOTION_STILL_AT_OR_BELOW,
  guidanceKey,
  guidanceLine,
  meanLuminanceOf,
  motionBetween,
  type LiveFrameStats,
} from "./guidance";

/**
 * The live guidance line, docs/01-user-flow.md section D: one line at a time,
 * replaced as conditions change, never stacked.
 *
 * Two things this file has to prove at once. First, docs/01 section D's own
 * shape: light, then the height of the phone, then distance, then stillness,
 * then ready. Second, the promise "Good. Tap to capture." makes about what the
 * gate in src/lib/shared/quality.ts is about to do with the same frame, which
 * failed for real on a Samsung S26 Ultra on 2026-09-03: the line said good, the
 * gate answered blurry, on the very frame that had just been tapped.
 *
 * The eyeLevel line is also 2026-09-03: the engine refused the founder's photo
 * with error_face_angle_downward, a phone held at chest height, which the gate
 * cannot measure directly but which shows up as a face slid low in the frame.
 */

/** A frame with nothing wrong with it: lit, framed, held still, eye level. */
const READY: LiveFrameStats = {
  meanLuminance: 140,
  faceCoverage: 0.7,
  faceCenterY: 0.42,
  motion: 0,
  sharpness: SHARPNESS_BORDERLINE_BELOW * 4,
};

describe("guidanceKey", () => {
  it("says the frame is good only when every check the gate runs is clear", () => {
    expect(guidanceKey(READY)).toBe("ready");
    expect(guidanceLine(READY)).toBe(copy.capture.guidance.ready);
  });

  it("asks for light first, because a dark frame measures wrong everywhere", () => {
    expect(
      guidanceKey({
        ...READY,
        meanLuminance: MEAN_LUMINANCE_BORDERLINE_BELOW - 1,
        faceCenterY: 0.9,
        faceCoverage: null,
        motion: 100,
        sharpness: 0,
      }),
    ).toBe("light");
  });

  it("asks for the phone at eye level when the face sits low in the frame", () => {
    expect(guidanceKey({ ...READY, faceCenterY: 0.7 })).toBe("eyeLevel");
    expect(guidanceLine({ ...READY, faceCenterY: 0.7 })).toBe(
      copy.capture.guidance.eyeLevel,
    );
  });

  it("leaves a face framed where a face belongs alone", () => {
    // A person holding the phone up has their face high in the picture, which is
    // the framing the auto crop aims at. Nothing to say about it.
    for (const centerY of [0.2, 0.35, 0.42, 0.5, FACE_CENTER_TOO_LOW_ABOVE]) {
      expect(guidanceKey({ ...READY, faceCenterY: centerY })).toBe("ready");
    }
  });

  it("answers the height of the phone before the distance", () => {
    /*
     * Lifting the phone moves the face inside the frame as well as squaring it
     * to the lens, so asking for the distance first would ask for two
     * corrections where one will do.
     */
    expect(guidanceKey({ ...READY, faceCenterY: 0.8, faceCoverage: 0.2 })).toBe(
      "eyeLevel",
    );
  });

  it("still asks for the distance when the face is where it should be", () => {
    expect(
      guidanceKey({ ...READY, faceCoverage: FACE_COVERAGE_MIN - 0.1 }),
    ).toBe("closer");
    expect(
      guidanceKey({ ...READY, faceCoverage: null, faceCenterY: null }),
    ).toBe("closer");
  });

  it("says nothing about the phone when there is no face center to measure", () => {
    // No estimate is not an estimate of a low face. A stats object that never
    // carried the optional field reads exactly as a good frame would.
    const withoutTheField: LiveFrameStats = {
      meanLuminance: 140,
      faceCoverage: 0.7,
      motion: 0,
      sharpness: READY.sharpness,
    };
    expect(guidanceKey(withoutTheField)).toBe("ready");
  });

  it("says hold still for a moving frame and for a soft one alike", () => {
    expect(guidanceKey({ ...READY, motion: MOTION_STILL_AT_OR_BELOW + 1 })).toBe(
      "hold",
    );
    expect(
      guidanceKey({ ...READY, sharpness: SHARPNESS_BORDERLINE_BELOW - 1 }),
    ).toBe("hold");
    // And at the line itself the frame is good, the same way the gate reads it.
    expect(guidanceKey({ ...READY, sharpness: SHARPNESS_BORDERLINE_BELOW })).toBe(
      "ready",
    );
  });

  it("never promises a frame the gate would then call blurry", () => {
    for (const sharpness of [0, 1, 30, 59, 60, 61, 500]) {
      const said = guidanceKey({ ...READY, sharpness });
      const flagged = sharpness < SHARPNESS_BORDERLINE_BELOW;
      expect(said === "ready").toBe(!flagged);
    }
  });

  it("has a line for every key it can return", () => {
    const keys = ["light", "eyeLevel", "closer", "hold", "ready"] as const;
    // Built from character codes on purpose, never typed as a literal glyph:
    // this file lives under src, where the em dash and en dash rule is
    // enforced on the source itself.
    const dashPattern = "[" + String.fromCharCode(0x2013, 0x2014) + "]";
    const dashes = new RegExp(dashPattern, "u");
    for (const key of keys) {
      expect(copy.capture.guidance[key].length).toBeGreaterThan(0);
      expect(copy.capture.guidance[key]).not.toMatch(dashes);
    }
  });
});

/** One picture, drawable at any size: bands at a fixed share of the width. */
function bands(width: number, height: number, contrast: number): GrayscaleImage {
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
        meanLuminance: meanLuminanceOf(bands(PREVIEW.width, PREVIEW.height, contrast)),
        faceCoverage: FACE_COVERAGE_MIN,
        faceCenterY: 0.42,
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
      const flagged = verdict.failures.some((failure) => failure.reason === "blurry");

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
