import { describe, expect, it } from "vitest";

import { syntheticFace } from "../../../evals/support/synthetic-face";
import { copy } from "@/lib/shared/copy";
import { faceReadingFrom, type FaceReading } from "@/lib/shared/face-reading";
import { GUIDANCE_SAMPLE_LONG_EDGE } from "@/lib/shared/frame-geometry";
import type { FacePose } from "@/lib/shared/pose";
import {
  FACE_LUMA_BORDERLINE_ABOVE,
  FACE_LUMA_BORDERLINE_BELOW,
  FACE_WIDTH_RATIO_MAX,
  POSE_PITCH_MAX_DEGREES,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
  SHARPNESS_MEASURE_LONG_EDGE,
  assessCapture,
  sharpnessOf,
} from "@/lib/shared/quality";
import type { Box, GrayscaleImage } from "@/lib/shared/quality";

import {
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
 * shape: light, then the phone, then pose, then distance, then stillness, then
 * ready. Second, the promise "Good. Tap to capture." makes about what the
 * gate in src/lib/shared/quality.ts is about to do with the same frame, which
 * failed for real on a Samsung S26 Ultra on 2026-09-03: the line said good,
 * the gate answered blurry, on the very frame that had just been tapped.
 *
 * Since 2026-09-23 the line reads the same FaceReading the gate reads, so the
 * stats here are built from a synthetic landmarker result rather than from a
 * box and a guessed centre.
 */

/** A face filling the oval, square to the lens, eyes open. */
const OVAL_FACE: FaceReading = (() => {
  const reading = faceReadingFrom(syntheticFace());
  if (reading === null) {
    throw new Error("The synthetic face did not read.");
  }
  return reading;
})();

/** A reading of a synthetic face with the given numbers. */
function face(options: Parameters<typeof syntheticFace>[0]): FaceReading {
  const reading = faceReadingFrom(syntheticFace(options));
  if (reading === null) {
    throw new Error("The synthetic face did not read.");
  }
  return reading;
}

/** The oval face with its pose replaced. */
function withPose(pose: FacePose | null): FaceReading {
  return { ...OVAL_FACE, pose };
}

/**
 * A frame with nothing wrong with it: lit, framed, held still, square, on a
 * phone held upright, measured by the landmarker.
 */
const READY: LiveFrameStats = {
  measured: true,
  trackIsLandscape: false,
  coarsePointer: true,
  frameLuma: 0.5,
  faceLuma: 0.55,
  faceLumaUneven: 0.02,
  reading: OVAL_FACE,
  motion: 0,
  sharpness: 80,
};

/** A preview frame nothing measured. */
const UNMEASURED: LiveFrameStats = {
  ...READY,
  measured: false,
  faceLuma: null,
  faceLumaUneven: null,
  reading: null,
};

describe("guidanceKey", () => {
  it("says the frame is good only when every check the gate runs is clear", () => {
    expect(guidanceKey(READY)).toBe("ready");
    expect(guidanceLine(READY)).toBe(copy.capture.guidance.ready);
  });

  it("asks for light first, because a dark face measures wrong everywhere", () => {
    expect(
      guidanceKey({
        ...READY,
        faceLuma: FACE_LUMA_BORDERLINE_BELOW - 0.01,
        trackIsLandscape: true,
        reading: face({ yaw: 40, widthRatio: 0.2 }),
        motion: 100,
        sharpness: 0,
      }),
    ).toBe("light");
    expect(
      guidanceKey({ ...READY, faceLuma: FACE_LUMA_BORDERLINE_BELOW }),
    ).toBe("ready");
  });

  it("reads the light off the frame when there is no face to read it off", () => {
    // Unmeasured: the frame mean is all there is.
    expect(guidanceKey({ ...UNMEASURED, frameLuma: 0.1 })).toBe("light");
    // Measured with no face: the same.
    expect(
      guidanceKey({ ...READY, reading: null, faceLuma: null, frameLuma: 0.1 }),
    ).toBe("light");
    // With a face, the face decides and the frame does not.
    expect(guidanceKey({ ...READY, frameLuma: 0.1 })).toBe("ready");
  });

  /**
   * The other side of the light band, added with the face luma measurement.
   * The engine's own capture SDK bounds lighting above as well as below
   * (docs/04-integrations.md), and a face in direct sun is the frame it names.
   */
  it("asks for less light on a blown face, after light and before everything else", () => {
    expect(
      guidanceKey({
        ...READY,
        faceLuma: FACE_LUMA_BORDERLINE_ABOVE + 0.01,
        trackIsLandscape: true,
        reading: face({ yaw: 40 }),
        motion: 100,
      }),
    ).toBe("bright");
    expect(guidanceLine({ ...READY, faceLuma: 0.95 })).toBe(
      copy.capture.guidance.bright,
    );
    expect(guidanceKey({ ...READY, faceLuma: FACE_LUMA_BORDERLINE_ABOVE })).toBe(
      "ready",
    );
  });

  /**
   * A frame nothing measured says so, and says nothing about a face. The
   * person still has a tap: the gate offers the frame as unmeasured and the
   * engine's own input gate reads it for free.
   */
  it("says the check did not load on an unmeasured frame, after light and hold", () => {
    expect(guidanceKey(UNMEASURED)).toBe("unmeasured");
    expect(guidanceLine(UNMEASURED)).toBe(copy.capture.guidance.unmeasured);
    expect(guidanceKey({ ...UNMEASURED, motion: MOTION_STILL_AT_OR_BELOW + 1 })).toBe(
      "hold",
    );
    expect(guidanceKey({ ...UNMEASURED, frameLuma: 0.05 })).toBe("light");
    // Nothing a phone held landscape or a stale reading could add.
    expect(guidanceKey({ ...UNMEASURED, trackIsLandscape: true })).toBe(
      "unmeasured",
    );
  });

  /**
   * A phone held landscape hands the camera a landscape track, and the frame
   * that is sent is portrait. Only on a touch device: a laptop webcam is
   * landscape by construction.
   */
  it("asks for the phone upright on a landscape track from a touch device", () => {
    expect(guidanceKey({ ...READY, trackIsLandscape: true })).toBe("upright");
    expect(guidanceLine({ ...READY, trackIsLandscape: true })).toBe(
      copy.capture.guidance.upright,
    );
    expect(
      guidanceKey({ ...READY, trackIsLandscape: true, coarsePointer: false }),
    ).toBe("ready");
    // Before pose and framing: turning the phone changes both.
    expect(
      guidanceKey({
        ...READY,
        trackIsLandscape: true,
        reading: face({ yaw: 40, widthRatio: 0.2 }),
      }),
    ).toBe("upright");
  });

  it("asks for closer when the landmarker found no face", () => {
    expect(guidanceKey({ ...READY, reading: null, faceLuma: null })).toBe(
      "closer",
    );
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
   * says "Good" and a person who never learns why. The gate never flags
   * softness either (assessCapture), so the promise "Good" makes still holds;
   * and the burst sends the sharpest of its frames, which answers a soft
   * moment better than asking a person to wait for a sharp one.
   */
  it("says good at any sharpness, because the gate never flags it", () => {
    for (const sharpness of [0, 1, 30, 59, 60, 61, 500]) {
      expect(guidanceKey({ ...READY, sharpness })).toBe("ready");
    }
  });

  /**
   * The framing question is asked about the frame the gate will see, which in
   * this build is the composed one: autoCropBoxFor lifts a face to 0.66 of the
   * width from almost anything, so the live line asks only whether there is
   * enough face to compose. The capture-master-frame PR moves this floor to
   * the oval's own band.
   */
  it("asks for closer only under the live width floor", () => {
    expect(
      guidanceKey({
        ...READY,
        reading: face({ widthRatio: LIVE_FACE_WIDTH_RATIO_MIN - 0.01 }),
      }),
    ).toBe("closer");
    expect(
      guidanceKey({
        ...READY,
        reading: face({ widthRatio: LIVE_FACE_WIDTH_RATIO_MIN + 0.001 }),
      }),
    ).toBe("ready");
    // A face filling the oval on a 3 by 4 preview, and one a little back.
    expect(guidanceKey({ ...READY, reading: face({ widthRatio: 0.48 }) })).toBe(
      "ready",
    );
    expect(guidanceLine({ ...READY, reading: face({ widthRatio: 0.2 }) })).toBe(
      copy.capture.guidance.closer,
    );
  });

  /**
   * The other side of "Move closer", added 2026-09-23: a face wider than the
   * band the engine reads, or one whose oval runs into the edge margins, is
   * refused by the engine as out of boundary and no crop fixes it.
   */
  it("asks for back on a face too wide for the band or touching the edge", () => {
    expect(
      guidanceKey({ ...READY, reading: face({ widthRatio: FACE_WIDTH_RATIO_MAX + 0.01 }) }),
    ).toBe("back");
    expect(guidanceLine({ ...READY, reading: face({ widthRatio: 0.9 }) })).toBe(
      copy.capture.guidance.back,
    );
    // A face of the right width sitting into the top margin.
    expect(
      guidanceKey({ ...READY, reading: face({ center: { x: 0.5, y: 0.2 } }) }),
    ).toBe("back");
    // And one at the top of the band, inside the margins, is fine. At that
    // width the oval is 0.87 of a 3 by 4 frame's height, so it has to sit at
    // 0.525 to keep the 0.08 top margin; centred at the target it touches.
    expect(
      guidanceKey({
        ...READY,
        reading: face({
          widthRatio: FACE_WIDTH_RATIO_MAX - 0.001,
          center: { x: 0.5, y: 0.525 },
        }),
      }),
    ).toBe("ready");
    // Back comes after closer and before hold.
    expect(
      guidanceKey({
        ...READY,
        reading: face({ widthRatio: 0.9 }),
        motion: MOTION_STILL_AT_OR_BELOW + 1,
      }),
    ).toBe("back");
  });

  /**
   * The pose lines, added 2026-09-07 with a detector that could estimate one
   * and read since 2026-09-23 from a solved matrix.
   *
   * Every refusal this product has read off the live API has been about pose,
   * and until the detector landed the live line had nothing to say about it. A
   * person was told the frame was good, tapped, waited for an upload and a task,
   * and was then told the engine would not read their face.
   */
  it("says nothing about pose when there is no pose to read", () => {
    expect(guidanceKey({ ...READY, reading: withPose(null) })).toBe("ready");
  });

  it("leaves a head inside the window alone", () => {
    expect(
      guidanceKey({
        ...READY,
        reading: withPose({ yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 }),
      }),
    ).toBe("ready");
  });

  it("asks for a square head when it is turned or the phone is tilted", () => {
    const turned = guidanceKey({ ...READY, reading: face({ yaw: 40 }) });
    const tilted = guidanceKey({ ...READY, reading: face({ roll: -40 }) });
    expect(turned).toBe("square");
    expect(tilted).toBe("square");
    expect(guidanceLine({ ...READY, reading: face({ yaw: 40 }) })).toBe(
      copy.capture.guidance.square,
    );
  });

  /**
   * A phone held at chest height is the ordinary grip and it is the one the
   * engine's pitch budget has least room for. It gets the line about the phone,
   * not the line about the head, because the phone is what is wrong.
   */
  it("asks for the phone when the problem is pitch", () => {
    expect(guidanceKey({ ...READY, reading: face({ pitch: 35 }) })).toBe("eyeLevel");
    expect(guidanceKey({ ...READY, reading: face({ pitch: -40 }) })).toBe("eyeLevel");
    expect(guidanceLine({ ...READY, reading: face({ pitch: 35 }) })).toBe(
      copy.capture.guidance.eyeLevel,
    );
  });

  /**
   * A pose the gate would merely flag does not hold the line, since 2026-09-14.
   * The gate offers a borderline pose with "Use it anyway" and the burst sends
   * the squarest of its frames. Only a pose the gate would refuse holds.
   */
  it("lets a borderline pose through and holds only a refused one", () => {
    const justOutside = POSE_YAW_MAX_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        reading: withPose({ yawDegrees: justOutside, pitchDegrees: 0, rollDegrees: 0 }),
      }),
    ).toBe("ready");
    const pitchJustOver = POSE_PITCH_MAX_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        reading: withPose({ yawDegrees: 0, pitchDegrees: pitchJustOver, rollDegrees: 0 }),
      }),
    ).toBe("ready");
    const refused = POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES + 1;
    expect(
      guidanceKey({
        ...READY,
        reading: withPose({ yawDegrees: refused, pitchDegrees: 0, rollDegrees: 0 }),
      }),
    ).toBe("square");
  });

  it("answers pose before framing, because framing cannot fix a turned head", () => {
    expect(
      guidanceKey({ ...READY, reading: face({ yaw: 40, widthRatio: 0.2 }) }),
    ).toBe("square");
    expect(
      guidanceKey({ ...READY, reading: face({ yaw: 40, widthRatio: 0.95 }) }),
    ).toBe("square");
  });

  it("still asks for light first, because a dark frame measures wrong everywhere", () => {
    expect(
      guidanceKey({
        ...READY,
        faceLuma: FACE_LUMA_BORDERLINE_BELOW - 0.01,
        reading: face({ yaw: 40 }),
      }),
    ).toBe("light");
  });

  it("has a line for every key it can return", () => {
    const keys = [
      "light",
      "bright",
      "upright",
      "square",
      "eyeLevel",
      "closer",
      "back",
      "hold",
      "ready",
      "unmeasured",
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
    expect(Object.keys(copy.capture.guidance).sort()).toEqual([...keys].sort());
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

/** The oval's bounding box in a frame's pixels, centered as the oval is. */
function ovalBoxIn(width: number, height: number): Box {
  const boxWidth = Math.round(width * 0.7);
  const boxHeight = Math.round(boxWidth * 1.35);
  return {
    x: Math.round((width - boxWidth) / 2),
    y: Math.round(height * 0.47 - boxHeight / 2),
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
 * portrait. Same picture, resolutions a factor of two and a half apart.
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
    expect(ovalBoxIn(PREVIEW.width, PREVIEW.height).height).toBeGreaterThan(
      SHARPNESS_MEASURE_LONG_EDGE,
    );
    expect(ovalBoxIn(CAPTURE.width, CAPTURE.height).height).toBeGreaterThan(
      SHARPNESS_MEASURE_LONG_EDGE,
    );
    expect(preview.height * 2).toBeLessThan(capture.height);
  });

  it("reads the same sharpness off both, across the whole range", () => {
    for (const contrast of CONTRASTS) {
      const live = sharpnessOf(
        bands(PREVIEW.width, PREVIEW.height, contrast),
        ovalBoxIn(PREVIEW.width, PREVIEW.height),
      );
      const gate = sharpnessOf(
        bands(CAPTURE.width, CAPTURE.height, contrast),
        ovalBoxIn(CAPTURE.width, CAPTURE.height),
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
  it("says good at every contrast, and the gate accepts every one", () => {
    const reading = face({ frame: CAPTURE });
    for (const contrast of CONTRASTS) {
      const preview = bands(PREVIEW.width, PREVIEW.height, contrast);
      const said = guidanceKey({
        ...READY,
        frameLuma: meanLuminanceOf(preview) / 255,
        faceLuma: meanLuminanceOf(preview) / 255,
        reading,
        sharpness: sharpnessOf(preview, ovalBoxIn(PREVIEW.width, PREVIEW.height)),
      });

      const verdict = assessCapture({
        image: bands(CAPTURE.width, CAPTURE.height, contrast),
        faceCount: 1,
        reading,
        measured: true,
      });

      expect(said).toBe("ready");
      expect(verdict.verdict).toBe("accept");
      expect(verdict.failures).toEqual([]);
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
