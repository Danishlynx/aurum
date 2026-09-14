import { describe, expect, it } from "vitest";

import { copy } from "@/lib/shared/copy";
import {
  FACE_COVERAGE_MIN,
  FACE_COVERAGE_REJECT_BELOW,
  MEAN_LUMINANCE_BORDERLINE_BELOW,
  POSE_PITCH_MAX_DEGREES,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
  SHARPNESS_BORDERLINE_BELOW,
  SHARPNESS_MEASURE_LONG_EDGE,
  assessCapture,
  sharpnessOf,
} from "@/lib/shared/quality";
import type { Box, GrayscaleImage } from "@/lib/shared/quality";

import {
  FACE_CENTER_TOO_LOW_ABOVE,
  GUIDANCE_SAMPLE_LONG_EDGE,
  LIVE_FACE_WIDTH_RATIO_MIN,
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

/**
 * A frame with nothing wrong with it: lit, framed, held still, eye level.
 *
 * faceWidthRatio is the framing number the line reads since 2026-09-14, at a
 * value a face filling the oval actually produces on a 3 by 4 preview (about
 * half, before the crop lifts it to the engine's 0.66). faceCoverage stays
 * because the line still refuses on a face too small to crop at all.
 */
const READY: LiveFrameStats = {
  meanLuminance: 140,
  faceCoverage: 0.5,
  faceWidthRatio: 0.5,
  faceCenterY: 0.42,
  faceEstimateTrusted: true,
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
      guidanceKey({ ...READY, faceWidthRatio: LIVE_FACE_WIDTH_RATIO_MIN - 0.1 }),
    ).toBe("closer");
    expect(
      guidanceKey({
        ...READY,
        faceCoverage: null,
        faceWidthRatio: null,
        faceCenterY: null,
      }),
    ).toBe("closer");
  });

  it("says nothing about the phone when there is no face center to measure", () => {
    // No estimate is not an estimate of a low face. A stats object that never
    // carried the optional field reads exactly as a good frame would.
    const withoutTheField: LiveFrameStats = {
      meanLuminance: 140,
      faceCoverage: 0.5,
      faceWidthRatio: 0.5,
      motion: 0,
      sharpness: READY.sharpness,
    };
    expect(guidanceKey(withoutTheField)).toBe("ready");
  });

  it("says hold still for a moving frame, and for nothing else", () => {
    expect(guidanceKey({ ...READY, motion: MOTION_STILL_AT_OR_BELOW + 1 })).toBe(
      "hold",
    );
    expect(guidanceKey({ ...READY, motion: MOTION_STILL_AT_OR_BELOW })).toBe(
      "ready",
    );
  });

  /**
   * Softness never holds the line, since 2026-09-14. The threshold it used to
   * be held against was set from synthetic stripes, and a smooth face at
   * preview size can read under it at any focus, which is a line that never
   * says "Good" and a person who never learns why. The gate no longer flags
   * softness either (assessCapture), so the promise "Good" makes still holds;
   * and the burst sends the sharpest of five frames, which answers a soft
   * moment better than asking a person to wait for a sharp one.
   */
  it("says good at any sharpness, because the gate no longer flags it", () => {
    for (const sharpness of [0, 1, 30, 59, 60, 61, 500]) {
      expect(guidanceKey({ ...READY, sharpness })).toBe("ready");
    }
  });

  /**
   * The framing question is asked about the frame the gate will see, which is
   * the composed one. The crop lifts a face to 0.66 of the width from almost
   * anything, so the live line asks only whether there is enough face to crop.
   */
  it("asks for closer only under the live width floor", () => {
    expect(
      guidanceKey({ ...READY, faceWidthRatio: LIVE_FACE_WIDTH_RATIO_MIN - 0.01 }),
    ).toBe("closer");
    expect(
      guidanceKey({ ...READY, faceWidthRatio: LIVE_FACE_WIDTH_RATIO_MIN }),
    ).toBe("ready");
    // A face a detector would report for somebody filling the oval on a 3 by 4
    // preview is about half the width. The old height rule called that too far.
    expect(
      guidanceKey({ ...READY, faceCoverage: 0.45, faceWidthRatio: 0.48 }),
    ).toBe("ready");
    // No width at all is no face at all.
    expect(guidanceKey({ ...READY, faceWidthRatio: null })).toBe("closer");
  });

  it("still asks for closer on a face too small to crop", () => {
    expect(
      guidanceKey({
        ...READY,
        faceCoverage: FACE_COVERAGE_REJECT_BELOW - 0.01,
        faceWidthRatio: 0.45,
      }),
    ).toBe("closer");
  });

  /**
   * The colour threshold's box runs into the neck, so where its middle sits
   * says nothing about the phone. Only a detector's box gets the eye level line
   * from position.
   */
  it("does not read the phone height off a colour threshold box", () => {
    expect(
      guidanceKey({ ...READY, faceCenterY: 0.7, faceEstimateTrusted: false }),
    ).toBe("ready");
    expect(
      guidanceKey({ ...READY, faceCenterY: 0.7, faceEstimateTrusted: true }),
    ).toBe("eyeLevel");
  });

  /**
   * The pose lines, added 2026-09-07 with the detector that can measure one.
   *
   * Every refusal this product has read off the live API has been about pose,
   * and until the detector landed the live line had nothing to say about it. A
   * person was told the frame was good, tapped, waited for an upload and a task,
   * and was then told the engine would not read their face.
   */
  it("says nothing about pose when there is no pose to read", () => {
    expect(guidanceKey({ ...READY, pose: null })).toBe("ready");
    expect(guidanceKey(READY)).toBe("ready");
  });

  it("leaves a head inside the window alone", () => {
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 },
      }),
    ).toBe("ready");
  });

  it("asks for a square head when it is turned or the phone is tilted", () => {
    const turned = guidanceKey({
      ...READY,
      pose: { yawDegrees: 40, pitchDegrees: 0, rollDegrees: 0 },
    });
    const tilted = guidanceKey({
      ...READY,
      pose: { yawDegrees: 0, pitchDegrees: 0, rollDegrees: -40 },
    });
    expect(turned).toBe("square");
    expect(tilted).toBe("square");
    expect(guidanceLine({ ...READY, pose: { yawDegrees: 40, pitchDegrees: 0, rollDegrees: 0 } })).toBe(
      copy.capture.guidance.square,
    );
  });

  /**
   * A phone held at chest height is the ordinary grip and it is the one the
   * engine's pitch budget has least room for. It gets the line about the phone,
   * not the line about the head, because the phone is what is wrong.
   */
  it("asks for the phone when the problem is pitch", () => {
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: 0, pitchDegrees: 35, rollDegrees: 0 },
      }),
    ).toBe("eyeLevel");
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: 0, pitchDegrees: -40, rollDegrees: 0 },
      }),
    ).toBe("eyeLevel");
  });

  /**
   * A pose the gate would merely flag does not hold the line, since 2026-09-14.
   * The gate offers a borderline pose with "Use it anyway", the burst sends the
   * squarest of five frames, and the pitch estimate off four keypoints is a
   * heuristic that held a level phone at "Hold the phone at eye level" for as
   * long as the person cared to wait. Only a pose the gate would refuse holds.
   */
  it("lets a borderline pose through and holds only a refused one", () => {
    const justOutside = POSE_YAW_MAX_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: justOutside, pitchDegrees: 0, rollDegrees: 0 },
      }),
    ).toBe("ready");
    const pitchJustOver = POSE_PITCH_MAX_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: 0, pitchDegrees: pitchJustOver, rollDegrees: 0 },
      }),
    ).toBe("ready");
    const refused = POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        pose: { yawDegrees: refused, pitchDegrees: 0, rollDegrees: 0 },
      }),
    ).toBe("square");
  });

  it("answers pose before framing, because framing cannot fix a turned head", () => {
    expect(
      guidanceKey({
        ...READY,
        faceCoverage: 0.2,
        pose: { yawDegrees: 40, pitchDegrees: 0, rollDegrees: 0 },
      }),
    ).toBe("square");
  });

  it("still asks for light first, because a dark frame measures wrong everywhere", () => {
    expect(
      guidanceKey({
        ...READY,
        meanLuminance: MEAN_LUMINANCE_BORDERLINE_BELOW - 1,
        pose: { yawDegrees: 40, pitchDegrees: 0, rollDegrees: 0 },
      }),
    ).toBe("light");
  });

  it("has a line for every key it can return", () => {
    const keys = [
      "light",
      "square",
      "eyeLevel",
      "closer",
      "hold",
      "ready",
    ] as const;
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
   * to be the same fact. Since 2026-09-14 that fact is: softness flags nothing
   * on either side. The sweep still runs the full contrast range, on the same
   * face, through both, and asserts that neither of them ever mentions it.
   */
  it("says good at every contrast, and the gate never flags softness either", () => {
    for (const contrast of CONTRASTS) {
      const previewBox = faceBoxIn(PREVIEW.width, PREVIEW.height);
      const said = guidanceKey({
        meanLuminance: meanLuminanceOf(bands(PREVIEW.width, PREVIEW.height, contrast)),
        faceCoverage: previewBox.height / PREVIEW.height,
        faceWidthRatio: previewBox.width / Math.min(PREVIEW.width, PREVIEW.height),
        faceCenterY: 0.42,
        faceEstimateTrusted: true,
        motion: 0,
        sharpness: sharpnessOf(
          bands(PREVIEW.width, PREVIEW.height, contrast),
          previewBox,
        ),
      });

      const verdict = assessCapture({
        image: bands(CAPTURE.width, CAPTURE.height, contrast),
        faceCount: 1,
        faceBox: faceBoxIn(CAPTURE.width, CAPTURE.height),
      });
      const flagged = verdict.failures.some((failure) => failure.reason === "blurry");

      expect(said).toBe("ready");
      expect(flagged).toBe(false);
      // And whatever else it decided, the frame is never refused for softness.
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
