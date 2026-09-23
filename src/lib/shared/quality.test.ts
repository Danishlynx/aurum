import { describe, expect, it } from "vitest";

import { syntheticFace } from "../../../evals/support/synthetic-face";
import { captureRejectionCopy } from "./copy";
import { faceReadingFrom, type Blink, type FaceReading } from "./face-reading";
import {
  FACE_WIDTH_ENGINE_MIN,
  FACE_WIDTH_REJECT_BELOW,
  FRAME_OVAL_WIDTH,
} from "./frame-geometry";
import type { FacePose } from "./pose";
import {
  AUTO_CROP_ASPECT,
  AUTO_CROP_FACE_WIDTH_TARGET,
  BLOWN_LUMINANCE_AT_OR_ABOVE,
  CAPTURE_REASON_PRECEDENCE,
  CRUSHED_LUMINANCE_AT_OR_BELOW,
  AUTO_CROP_CHIN_ROOM_BELOW,
  AUTO_CROP_HEAD_ROOM_ABOVE,
  FACE_LUMA_BORDERLINE_ABOVE,
  FACE_LUMA_BORDERLINE_BELOW,
  FACE_LUMA_REJECT_ABOVE,
  FACE_LUMA_REJECT_BELOW,
  FACE_LUMA_UNEVEN_BORDERLINE_ABOVE,
  FACE_WIDTH_RATIO_MAX,
  FACE_WIDTH_RATIO_MIN,
  FRAME_SCORE_BLINK_WEIGHT,
  FRAME_SCORE_BORDERLINE_PENALTY,
  FRAME_SCORE_LUMA_TARGET,
  FRAME_SCORE_LUMA_WEIGHT,
  FRAME_SCORE_POSE_WEIGHT,
  FRAME_SCORE_SHARPNESS_CAP,
  FRAME_SCORE_SHARPNESS_WEIGHT,
  FRAME_SCORE_WIDTH_WEIGHT,
  POSE_PITCH_MAX_DEGREES,
  POSE_PITCH_MIN_DEGREES,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
  SHARPNESS_MEASURE_LONG_EDGE,
  SHARPNESS_SCALE,
  assessCapture,
  autoCropBoxFor,
  clampBox,
  cropToBox,
  exposureStats,
  faceWidthRatio,
  frameScore,
  intensityVariance,
  laplacianVariance,
  pickBestFrame,
  resampleToLongEdge,
  scaleBox,
  sharpnessOf,
  type Box,
  type CaptureAssessment,
  type CaptureAssessmentInput,
  type CaptureVerdict,
  type GrayscaleImage,
} from "./quality";

/** A synthetic image where every pixel has the same luminance. */
function flat(value: number, width = 64, height = 64): GrayscaleImage {
  return {
    data: new Array<number>(width * height).fill(value),
    width,
    height,
  };
}

/** Alternating single pixel squares, the hardest edge an image can have. */
function checkerboard(
  low: number,
  high: number,
  width = 64,
  height = 64,
): GrayscaleImage {
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = (x + y) % 2 === 0 ? low : high;
    }
  }
  return { data, width, height };
}

/**
 * A stand in for a sharp, evenly lit face: plenty of local variation, nothing
 * clipped at either end, mean luminance in the middle of the range.
 */
function sharpMidtones(width = 100, height = 100): GrayscaleImage {
  const levels = [60, 120, 180];
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = levels[(x * 7 + y * 13) % 3] ?? 120;
    }
  }
  return { data, width, height };
}

/**
 * The same pattern, at a mean between FACE_LUMA_REJECT_BELOW and
 * FACE_LUMA_BORDERLINE_BELOW: a frame the gate is uneasy about and still
 * willing to send, which is the definition of borderline.
 */
function dimSharp(width = 100, height = 100): GrayscaleImage {
  const levels = [30, 45, 60];
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = levels[(x * 7 + y * 13) % 3] ?? 45;
    }
  }
  return { data, width, height };
}

/**
 * One picture that can be drawn at any size: sixteen vertical bands, always the
 * same share of the width. Two of these at different resolutions are the same
 * photograph at two scales, which is the thing the sharpness measurement has to
 * answer the same way twice.
 */
function stripes(width: number, height: number): GrayscaleImage {
  const period = width / 16;
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = Math.floor(x / period) % 2 === 0 ? 90 : 170;
    }
  }
  return { data, width, height };
}

/** A separable box blur, standing in for defocus. */
function boxBlur(image: GrayscaleImage, radius: number): GrayscaleImage {
  const { width, height, data } = image;
  const out = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sy = Math.min(height - 1, Math.max(0, y + dy));
          const sx = Math.min(width - 1, Math.max(0, x + dx));
          sum += data[sy * width + sx] ?? 0;
          count += 1;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return { data: out, width, height };
}

const FRAME: { width: number; height: number } = { width: 100, height: 100 };

/**
 * The frame the gate is tested on: 3 by 4, the shape of the master frame, so
 * a face filling the oval sits inside the edge margins the gate applies. On a
 * square frame the oval is taller than the picture.
 */
const GATE_FRAME = { width: 90, height: 120 } as const;

/** A reading of a synthetic face, normalized to the gate's frame. */
function face(options: Parameters<typeof syntheticFace>[0] = {}): FaceReading {
  const reading = faceReadingFrom(syntheticFace({ frame: GATE_FRAME, ...options }));
  if (reading === null) {
    throw new Error("The synthetic face did not read.");
  }
  return reading;
}

/** A face filling the oval, square to the lens, eyes open. */
const GOOD_FACE = face();

/** A measured frame with one good face, on the given picture. */
function measuredWith(
  image: GrayscaleImage,
  reading: FaceReading | null = GOOD_FACE,
  faceCount = reading === null ? 0 : 1,
): CaptureAssessmentInput {
  return { image, faceCount, reading, measured: true };
}

describe("laplacianVariance", () => {
  it("is zero for a flat image", () => {
    expect(laplacianVariance(flat(128))).toBe(0);
    expect(laplacianVariance(flat(0))).toBe(0);
    expect(laplacianVariance(flat(255))).toBe(0);
  });

  it("is large for a checkerboard", () => {
    const variance = laplacianVariance(checkerboard(40, 200));
    expect(variance).toBeGreaterThan(100000);
  });

  it("rises with contrast", () => {
    const low = laplacianVariance(checkerboard(120, 136));
    const high = laplacianVariance(checkerboard(40, 200));
    expect(high).toBeGreaterThan(low);
  });

  it("is zero when the image has no interior pixel", () => {
    expect(laplacianVariance({ data: [1, 2, 3, 4], width: 2, height: 2 })).toBe(
      0,
    );
    expect(
      laplacianVariance({ data: [1, 2, 3, 4, 5], width: 5, height: 1 }),
    ).toBe(0);
  });

  it("rejects an image whose data length does not match its size", () => {
    expect(() =>
      laplacianVariance({ data: [1, 2, 3], width: 2, height: 2 }),
    ).toThrow(/does not match/u);
  });

  it("rejects a zero sized image", () => {
    expect(() => laplacianVariance({ data: [], width: 0, height: 0 })).toThrow(
      /positive/u,
    );
  });
});

describe("resampleToLongEdge", () => {
  it("leaves an image that is already small enough alone", () => {
    const image = sharpMidtones(50, 40);
    expect(resampleToLongEdge(image, 96)).toBe(image);
    expect(resampleToLongEdge(image, 50)).toBe(image);
  });

  it("puts the long edge on the target and keeps the shape", () => {
    const result = resampleToLongEdge(sharpMidtones(400, 300), 96);
    expect(result.width).toBe(96);
    expect(result.height).toBe(72);
    expect(result.data.length).toBe(96 * 72);
  });

  it("averages the pixels it covers rather than sampling one of them", () => {
    const image: GrayscaleImage = { data: [0, 255, 255, 0], width: 2, height: 2 };
    const result = resampleToLongEdge(image, 1);
    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    expect(result.data[0]).toBeCloseTo(127.5, 5);
  });

  it("refuses a long edge of nothing", () => {
    expect(() => resampleToLongEdge(sharpMidtones(), 0)).toThrow(/positive/u);
  });
});

describe("sharpnessOf", () => {
  /**
   * The bug this measurement exists to stop, stated as a test.
   *
   * Laplacian variance is a number about a picture at a resolution: the same
   * bands measured at two sizes disagree by a factor of several, which is how a
   * live line measured off a small preview sample could say "Good. Tap to
   * capture." while the gate measured the 1024px capture and called that same
   * frame soft (Samsung S26 Ultra, indoors at night, 2026-09-03).
   */
  it("is the same for the same picture at two resolutions, where the raw variance is not", () => {
    const big = stripes(640, 800);
    const small = stripes(160, 200);

    const rawRatio = laplacianVariance(small) / laplacianVariance(big);
    expect(rawRatio).toBeGreaterThan(2);

    const ratio = sharpnessOf(small) / sharpnessOf(big);
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(1.34);
  });

  it("measures the region it is given, not the frame around it", () => {
    const width = 200;
    const height = 200;
    // A flat frame with a banded patch in the middle, at the face box.
    const patch = stripes(120, 120);
    const data = new Array<number>(width * height).fill(128);
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 120; x += 1) {
        data[(y + 40) * width + (x + 40)] = patch.data[y * 120 + x] ?? 128;
      }
    }
    const image: GrayscaleImage = { data, width, height };
    const region: Box = { x: 40, y: 40, width: 120, height: 120 };

    /*
     * The region reads as the patch does, and the frame around it reads as
     * something else. Which of the two is the larger number is not the point and
     * is not asserted: since 2026-09-07 the measurement is normalized by the
     * contrast of whatever it was pointed at, so a mostly flat frame with one
     * detailed patch in it can read high precisely because that patch is all the
     * contrast it has. What matters, and what this asserts, is that pointing the
     * measurement at the face gives the face's own answer rather than the
     * background's.
     */
    expect(sharpnessOf(image, region)).toBeCloseTo(sharpnessOf(patch), 5);
    expect(sharpnessOf(image, region)).not.toBeCloseTo(sharpnessOf(image), 1);
  });

  it("falls back to the whole frame when the region is off the picture", () => {
    const image = stripes(200, 200);
    expect(sharpnessOf(image, { x: 500, y: 500, width: 10, height: 10 })).toBe(
      sharpnessOf(image),
    );
  });

  it("is zero for a frame with nothing in it, at any size", () => {
    expect(sharpnessOf(flat(128, 640, 640))).toBe(0);
    expect(sharpnessOf(flat(128, 40, 40))).toBe(0);
  });

  it("measures at SHARPNESS_MEASURE_LONG_EDGE and nowhere else", () => {
    // The same answer whether the caller crops first or hands over the region.
    const image = stripes(600, 600);
    const region: Box = { x: 100, y: 100, width: 400, height: 400 };
    const resampled = resampleToLongEdge(
      cropToBox(image, region),
      SHARPNESS_MEASURE_LONG_EDGE,
    );
    expect(sharpnessOf(image, region)).toBeCloseTo(
      (laplacianVariance(resampled) / intensityVariance(resampled)) *
        SHARPNESS_SCALE,
      10,
    );
  });

  /**
   * The reason the measurement was changed on 2026-09-07, as an assertion.
   *
   * The same pattern at the same focus, once at full contrast and once at a
   * fraction of it. A bare Laplacian variance reads these far apart, because
   * edge energy scales with the contrast of the thing being measured, and a
   * deeply pigmented face in soft light carries less local contrast than a pale
   * one under the same lamp. That is how a sharp photograph was being called
   * soft, and it was being called soft on exactly the skin tones
   * docs/00-product.md says this product exists to serve.
   */
  it("reads the same focus the same way at any contrast", () => {
    const strong = sharpnessOf(checkerboard(40, 200, 100, 100));
    const faint = sharpnessOf(checkerboard(120, 136, 100, 100));
    expect(faint).toBeCloseTo(strong, 6);

    // And the raw measurement, which is what it used to return, does not.
    expect(laplacianVariance(checkerboard(120, 136, 100, 100))).toBeLessThan(
      laplacianVariance(checkerboard(40, 200, 100, 100)) / 10,
    );
  });

  it("still falls when the picture goes soft", () => {
    const sharp = stripes(400, 400);
    const softened = boxBlur(sharp, 3);
    expect(sharpnessOf(softened)).toBeLessThan(sharpnessOf(sharp));
  });
});

describe("exposureStats", () => {
  it("reports an all white image as fully blown", () => {
    const stats = exposureStats(flat(255));
    expect(stats.blownFraction).toBe(1);
    expect(stats.crushedFraction).toBe(0);
    expect(stats.meanLuminance).toBe(255);
    expect(stats.pixelsMeasured).toBe(64 * 64);
  });

  it("reports an all black image as fully crushed", () => {
    const stats = exposureStats(flat(0));
    expect(stats.crushedFraction).toBe(1);
    expect(stats.blownFraction).toBe(0);
    expect(stats.meanLuminance).toBe(0);
  });

  it("reports a midtone image as clean", () => {
    const stats = exposureStats(flat(128));
    expect(stats.blownFraction).toBe(0);
    expect(stats.crushedFraction).toBe(0);
    expect(stats.meanLuminance).toBe(128);
  });

  it("counts the threshold values themselves", () => {
    expect(exposureStats(flat(BLOWN_LUMINANCE_AT_OR_ABOVE)).blownFraction).toBe(
      1,
    );
    expect(
      exposureStats(flat(CRUSHED_LUMINANCE_AT_OR_BELOW)).crushedFraction,
    ).toBe(1);
    expect(
      exposureStats(flat(BLOWN_LUMINANCE_AT_OR_ABOVE - 1)).blownFraction,
    ).toBe(0);
  });

  it("measures a mixed image proportionally", () => {
    const stats = exposureStats(checkerboard(0, 255, 10, 10));
    expect(stats.blownFraction).toBeCloseTo(0.5, 5);
    expect(stats.crushedFraction).toBeCloseTo(0.5, 5);
  });
});

describe("clampBox and cropToBox", () => {
  it("clamps a box that runs past the edges", () => {
    expect(clampBox({ x: -5, y: -5, width: 20, height: 20 }, FRAME)).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 15,
    });
  });

  it("returns null for a box entirely outside the image", () => {
    expect(clampBox({ x: 200, y: 200, width: 10, height: 10 }, FRAME)).toBeNull();
  });

  it("crops the pixels it says it crops", () => {
    const image: GrayscaleImage = {
      data: [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23],
      width: 4,
      height: 3,
    };
    const crop = cropToBox(image, { x: 1, y: 1, width: 2, height: 2 });
    expect(crop.width).toBe(2);
    expect(crop.height).toBe(2);
    expect(Array.from(crop.data)).toEqual([11, 12, 21, 22]);
  });
});

/**
 * Kept for one more build: the capture-master-frame PR replaces autoCropBoxFor
 * with masterCropFor and deletes this describe. The face box it is fed is now
 * the landmarker's oval box scaled to pixels, which is taller than the
 * detector box these cases were written against; the invariants hold either
 * way, and the width the crop lands the face at is the engine's rule.
 */
describe("autoCropBoxFor", () => {
  /**
   * A gallery photo: portrait, and the face at the share of the frame height a
   * phone selfie taken at arm's length actually lands on.
   */
  function gallery(coverage: number, aspect = 0.72) {
    const frame = { width: 3024, height: 4032 };
    const height = frame.height * coverage;
    const width = height * aspect;
    return {
      frame,
      faceBox: {
        x: (frame.width - width) / 2,
        y: (frame.height - height) / 2,
        width,
        height,
      },
    };
  }

  it("does nothing when there is no face box", () => {
    expect(autoCropBoxFor({ faceBox: null, frame: FRAME })).toBeNull();
  });

  /**
   * The properties that matter, swept rather than sampled.
   *
   * These are the two ways a composed crop fails at the provider, and both were
   * live on 2026-09-10: a crop that cuts the forehead off, which is refused as
   * unreadable and which no retry recovers, and a crop whose face does not fill
   * enough of the width, which is refused as too small.
   *
   * A face box from MediaPipe is eyebrows to chin, so "room above the box" is
   * forehead and hair. The old geometry centred the crop on the box and left 0.3
   * face heights above it, which was fine for the skin colour box it was written
   * for (that one already covered the forehead) and cut into the face of every
   * real detection after the detector was replaced.
   */
  describe("the properties a composed crop has to have", () => {
    const FRAMES = [
      { width: 768, height: 1024 },
      { width: 576, height: 1024 },
      { width: 1080, height: 1080 },
      { width: 3024, height: 4032 },
      /*
       * A landscape frame, because a photo somebody else took of you is often
       * one. It is the shape where the crop's own height cap can pull the width
       * in under the width of the face box, which is how a composed crop came
       * to cut a face down the side.
       */
      { width: 1024, height: 768 },
    ] as const;
    /*
     * The coverages between 0.5 and 0.6 are where the width rule and the height
     * rule disagree, which is the band this function exists for: a face that
     * clears our own coverage minimum and is still too narrow for the engine.
     */
    const COVERAGES = [0.2, 0.3, 0.4, 0.5, 0.55, 0.58, 0.59, 0.6, 0.7] as const;
    /*
     * A face box is usually taller than it is wide, and how much varies with
     * hair and head turn. The two values at and above 1 are a box wider than
     * it is tall, which the geometry has to survive rather than assume away.
     */
    const ASPECTS = [0.62, 0.72, 0.85, 0.95, 1.1] as const;

    function faceIn(frame: { width: number; height: number }, coverage: number, aspect: number): Box {
      const height = frame.height * coverage;
      const width = height * aspect;
      return {
        x: (frame.width - width) / 2,
        y: (frame.height - height) / 2,
        width,
        height,
      };
    }

    it("never cuts into the face box itself", () => {
      for (const frame of FRAMES) {
        for (const coverage of COVERAGES) {
          for (const aspect of ASPECTS) {
            const faceBox = faceIn(frame, coverage, aspect);
            const crop = autoCropBoxFor({ faceBox, frame });
            if (crop === null) {
              continue;
            }
            const label = `${frame.width}x${frame.height} c=${coverage} a=${aspect}`;
            expect(crop.x, label).toBeLessThanOrEqual(faceBox.x + 1);
            expect(crop.y, label).toBeLessThanOrEqual(faceBox.y + 1);
            expect(crop.x + crop.width, label).toBeGreaterThanOrEqual(
              faceBox.x + faceBox.width - 1,
            );
            expect(crop.y + crop.height, label).toBeGreaterThanOrEqual(
              faceBox.y + faceBox.height - 1,
            );
          }
        }
      }
    });

    it("keeps room above the face for the forehead and the hair", () => {
      for (const frame of FRAMES) {
        for (const coverage of COVERAGES) {
          for (const aspect of ASPECTS) {
            const faceBox = faceIn(frame, coverage, aspect);
            const crop = autoCropBoxFor({ faceBox, frame });
            if (crop === null) {
              continue;
            }
            const above = faceBox.y - crop.y;
            const below = crop.y + crop.height - (faceBox.y + faceBox.height);
            const label = `${frame.width}x${frame.height} c=${coverage} a=${aspect}`;

            /*
             * The jaw always has somewhere to sit. A crop ending exactly at the
             * bottom of the face box is a face on the boundary of its own
             * picture, which the engine refuses.
             */
            expect(below, label).toBeGreaterThan(0);

            /*
             * And the room is asymmetric: most of what is spare goes above,
             * because that is where the forehead and the hair are and where a
             * crop can actually fail. Two frames where it is not, and neither is
             * a fault:
             *
             * A face already near the top of the original picture. There was
             * never that much above it and the crop cannot invent any.
             *
             * A crop with more spare height than the margins asked for, which is
             * what a wide face box produces: the crop is built from the width,
             * so a box that is nearly square makes it far taller than 1.61 face
             * heights, the room above is capped at what was asked for
             * (AUTO_CROP_HEAD_ROOM_ABOVE), and the remainder falls below the
             * chin, where it is neck and costs nothing.
             */
            const spareAboveInSource = faceBox.y;
            const spare = crop.height - faceBox.height;
            const wanted =
              faceBox.height *
              (AUTO_CROP_HEAD_ROOM_ABOVE + AUTO_CROP_CHIN_ROOM_BELOW);
            if (spareAboveInSource > faceBox.height && spare <= wanted) {
              expect(above, label).toBeGreaterThan(below);
            }
          }
        }
      }
    });

    it("lands the face inside the band the engine asks for", () => {
      for (const frame of FRAMES) {
        for (const coverage of COVERAGES) {
          for (const aspect of ASPECTS) {
            const faceBox = faceIn(frame, coverage, aspect);
            const crop = autoCropBoxFor({ faceBox, frame });
            if (crop === null) {
              continue;
            }
            const ratio = faceWidthRatio(faceBox, crop);
            const label = `${frame.width}x${frame.height} c=${coverage} a=${aspect} ratio=${ratio.toFixed(3)}`;
            expect(ratio, label).toBeGreaterThanOrEqual(FACE_WIDTH_RATIO_MIN);

            /*
             * The top of the band is the one side of this that the crop cannot
             * always reach, and the reason is the picture rather than the
             * geometry. When the face is already wider than the band allows of
             * the frame it was shot in, every crop is at least that wide,
             * because the alternative is cutting the face. The most the
             * composition can do there is hand back the whole width, and the
             * gate says too_close about it before anything is sent.
             */
            if (faceBox.width / frame.width > FACE_WIDTH_RATIO_MAX) {
              expect(crop.width, label).toBe(frame.width);
              continue;
            }
            expect(ratio, label).toBeLessThanOrEqual(FACE_WIDTH_RATIO_MAX);
          }
        }
      }
    });

    it("never runs outside the picture it was cut from", () => {
      for (const frame of FRAMES) {
        for (const coverage of COVERAGES) {
          for (const aspect of ASPECTS) {
            const crop = autoCropBoxFor({
              faceBox: faceIn(frame, coverage, aspect),
              frame,
            });
            if (crop === null) {
              continue;
            }
            expect(crop.x).toBeGreaterThanOrEqual(0);
            expect(crop.y).toBeGreaterThanOrEqual(0);
            expect(crop.x + crop.width).toBeLessThanOrEqual(frame.width);
            expect(crop.y + crop.height).toBeLessThanOrEqual(frame.height);
          }
        }
      }
    });
  });

  it("does nothing when the face already meets the width rule", () => {
    /*
     * A gallery frame is 3 by 4, so at the 0.72 aspect this helper draws a
     * face needs about 0.83 of the frame height before its width clears 0.60
     * of the short axis, which is why the coverages that satisfy this start
     * high.
     */
    for (const coverage of [0.85, 0.9, 0.95]) {
      const { faceBox, frame } = gallery(coverage);
      expect(autoCropBoxFor({ faceBox, frame })).toBeNull();
    }
  });

  /**
   * The frame that used to slip through: tall in the picture, too narrow for
   * the engine. It was sent whole and refused with error_src_face_too_small.
   */
  it("composes a face that fails the width rule", () => {
    const { faceBox, frame } = gallery(0.62);
    expect(faceWidthRatio(faceBox, frame)).toBeLessThan(FACE_WIDTH_RATIO_MIN);

    const crop = autoCropBoxFor({ faceBox, frame });
    expect(crop).not.toBeNull();
    if (crop === null) {
      return;
    }
    expect(faceWidthRatio(faceBox, crop)).toBeGreaterThanOrEqual(
      FACE_WIDTH_RATIO_MIN,
    );
  });

  /**
   * The crop is built from the width, not the height, since 2026-09-10.
   *
   * The height rule is ours and the width rule is the engine's, and only one of
   * them decides whether a reading happens. Building from the width means the
   * number the provider measures is the number the crop targets, rather than a
   * consequence of a height rule that happened to be close.
   */
  it("frames the face at the width the engine asks for, from 30 to 50 percent", () => {
    for (const coverage of [0.3, 0.35, 0.4, 0.45, 0.5, 0.59]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame });
      expect(crop).not.toBeNull();
      expect(faceWidthRatio(faceBox, crop as Box)).toBeCloseTo(
        AUTO_CROP_FACE_WIDTH_TARGET,
        2,
      );
    }
  });

  it("lands every one of those crops inside the band the gate sends", () => {
    for (const coverage of [0.3, 0.35, 0.4, 0.45, 0.5, 0.59]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame }) as Box;
      const ratio = faceWidthRatio(faceBox, crop);
      expect(ratio).toBeGreaterThanOrEqual(FACE_WIDTH_RATIO_MIN);
      expect(ratio).toBeLessThanOrEqual(FACE_WIDTH_RATIO_MAX);
    }
  });

  /**
   * The margin that matters is above the face, and it is asked for by name
   * rather than falling out of centring. See AUTO_CROP_HEAD_ROOM_ABOVE: a face
   * box is eyebrows to chin, so what sits above it is the forehead and the hair,
   * and cutting into that is the one framing mistake no retry recovers.
   */
  it("keeps the whole face inside the crop, with the head room above it", () => {
    for (const coverage of [0.3, 0.4, 0.5]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame }) as Box;
      expect(crop.x).toBeLessThanOrEqual(faceBox.x);
      expect(crop.x + crop.width).toBeGreaterThanOrEqual(
        faceBox.x + faceBox.width,
      );
      expect(crop.y + crop.height).toBeGreaterThanOrEqual(
        faceBox.y + faceBox.height,
      );
      /*
       * The room above is what was asked for, or its share of whatever height
       * was spare when the crop could not give the whole amount. It is never
       * the whole of the spare, because the chin needs somewhere to sit.
       */
      const above = faceBox.y - crop.y;
      const below = crop.y + crop.height - (faceBox.y + faceBox.height);
      const spare = crop.height - faceBox.height;
      const share =
        AUTO_CROP_HEAD_ROOM_ABOVE /
        (AUTO_CROP_HEAD_ROOM_ABOVE + AUTO_CROP_CHIN_ROOM_BELOW);
      expect(above).toBeGreaterThanOrEqual(
        Math.min(faceBox.height * AUTO_CROP_CHIN_ROOM_BELOW,
  AUTO_CROP_HEAD_ROOM_ABOVE, spare * share) - 1,
      );
      expect(above).toBeGreaterThan(below);
      expect(below).toBeGreaterThan(0);
    }
  });

  it("comes out portrait, never landscape", () => {
    for (const coverage of [0.3, 0.4, 0.5]) {
      for (const aspect of [0.55, 0.72, 0.85, 1.1]) {
        const { faceBox, frame } = gallery(coverage, aspect);
        const crop = autoCropBoxFor({ faceBox, frame });
        /*
         * A wide box at a large coverage wants a crop bigger than the picture it
         * came from, which means the picture is already framed as tightly as it
         * can be and there is nothing to compose. Null is the right answer to
         * that, and the invariant is about the crops that do exist.
         */
        if (crop === null) {
          continue;
        }
        expect(crop.width).toBeLessThanOrEqual(crop.height);
      }
    }
  });

  it("fills the width, which is the framing the engine asks for, at any face aspect", () => {
    /*
     * endpoints.ts, facialColorTones: "face width greater than 60 percent of
     * image width". A narrow face and a wide one both land there, because the
     * crop is built from the width.
     */
    for (const coverage of [0.3, 0.4, 0.5]) {
      for (const aspect of [0.6, 0.72, 0.8]) {
        const { faceBox, frame } = gallery(coverage, aspect);
        const crop = autoCropBoxFor({ faceBox, frame }) as Box;
        expect(faceBox.width / crop.width).toBeGreaterThanOrEqual(
          FACE_WIDTH_RATIO_MIN,
        );
      }
    }
  });

  it("starts from the 3 by 4 target when nothing pulls it off", () => {
    // A face box at the aspect the target was chosen for: the width lands on
    // AUTO_CROP_ASPECT rather than on either margin.
    const { faceBox, frame } = gallery(0.4, AUTO_CROP_ASPECT);
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
    expect(crop.width / crop.height).toBeCloseTo(AUTO_CROP_ASPECT, 2);
  });

  it("centers on the face, not on the picture", () => {
    const frame = { width: 3024, height: 4032 };
    // A face high in the frame and off to one side, which is where a face in a
    // photo somebody else took usually is.
    const faceBox = { x: 400, y: 300, width: 800, height: 1100 };
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
    const faceCenterX = faceBox.x + faceBox.width / 2;
    const cropCenterX = crop.x + crop.width / 2;
    expect(Math.abs(cropCenterX - faceCenterX)).toBeLessThanOrEqual(1);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeLessThan(faceBox.y);
  });

  it("slides a crop back inside the picture rather than shrinking it", () => {
    const frame = { width: 1000, height: 1600 };
    // Hard against the top left corner.
    const faceBox = { x: 0, y: 0, width: 300, height: 500 };
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(0);
    expect(faceWidthRatio(faceBox, crop)).toBeGreaterThanOrEqual(FACE_WIDTH_RATIO_MIN);
  });

  it("never runs outside the picture, wherever the face is", () => {
    const frame = { width: 1200, height: 1600 };
    const corners: Box[] = [
      { x: 0, y: 0, width: 300, height: 420 },
      { x: 900, y: 0, width: 300, height: 420 },
      { x: 0, y: 1180, width: 300, height: 420 },
      { x: 900, y: 1180, width: 300, height: 420 },
      { x: 450, y: 590, width: 300, height: 420 },
    ];
    for (const faceBox of corners) {
      const crop = autoCropBoxFor({ faceBox, frame }) as Box;
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(frame.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(frame.height);
    }
  });

  it("stays portrait for a box far wider than it is tall", () => {
    // A box that already fills the picture has nothing left to compose, so
    // null is a real answer here and the only thing that matters is that a
    // crop, if there is one, is never landscape.
    const frame = { width: 3000, height: 4000 };
    const faceBox = { x: 300, y: 1200, width: 2400, height: 1400 };
    const crop = autoCropBoxFor({ faceBox, frame });
    if (crop !== null) {
      expect(crop.width).toBeLessThanOrEqual(crop.height);
    }
  });

  /**
   * The crop that cut a face down the side.
   *
   * A landscape frame with a wide, shallow box: the height cap is the frame's
   * own 768 pixels, the width was capped at the height to keep the crop
   * portrait, and 768 is narrower than the 800 pixel face. The crop was returned
   * anyway, with 16 pixels of cheek missing from each side. Losing the shape of
   * the frame is the cheaper mistake, so the face wins.
   */
  it("never comes in narrower than the face, even when that means landscape", () => {
    const frame = { width: 1024, height: 768 };
    const faceBox = { x: 112, y: 234, width: 800, height: 300 };
    const crop = autoCropBoxFor({ faceBox, frame });
    /*
     * This box already fills more than the engine asks of the short axis, so
     * since 2026-09-14 there is nothing to compose and null is the answer. The
     * invariant is about any crop that does exist: it never comes in narrower
     * than the face.
     */
    if (crop === null) {
      expect(faceWidthRatio(faceBox, frame)).toBeGreaterThanOrEqual(
        FACE_WIDTH_RATIO_MIN,
      );
      return;
    }
    expect(crop.width).toBeGreaterThanOrEqual(faceBox.width);
    expect(crop.x).toBeLessThanOrEqual(faceBox.x);
    expect(crop.x + crop.width).toBeGreaterThanOrEqual(
      faceBox.x + faceBox.width,
    );
  });

  /**
   * And a box wider than the picture it was found in is not a framing problem at
   * all: every crop would be at least that wide, so there is nothing to compose
   * and the untouched frame goes to the engine, which is the party that can
   * actually judge it.
   */
  it("composes nothing when the face box is wider than the frame", () => {
    expect(
      autoCropBoxFor({
        faceBox: { x: 0, y: 100, width: 1200, height: 400 },
        frame: { width: 1024, height: 768 },
      }),
    ).toBeNull();
  });

  it("refuses a box or a frame with nothing in it", () => {
    const frame = { width: 100, height: 100 };
    expect(
      autoCropBoxFor({ faceBox: { x: 0, y: 0, width: 0, height: 30 }, frame }),
    ).toBeNull();
    expect(
      autoCropBoxFor({ faceBox: { x: 0, y: 0, width: 30, height: 0 }, frame }),
    ).toBeNull();
    expect(
      autoCropBoxFor({
        faceBox: { x: 0, y: 0, width: 10, height: 10 },
        frame: { width: 0, height: 0 },
      }),
    ).toBeNull();
  });

  it("is stable: the same face box always gets the same crop", () => {
    const { faceBox, frame } = gallery(0.38);
    expect(autoCropBoxFor({ faceBox, frame })).toEqual(
      autoCropBoxFor({ faceBox, frame }),
    );
  });

  it("returns whole pixels", () => {
    const { faceBox, frame } = gallery(0.41);
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
    for (const value of [crop.x, crop.y, crop.width, crop.height]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

describe("scaleBox", () => {
  it("maps a box into the pixels of a larger copy of the same image", () => {
    expect(scaleBox({ x: 10, y: 20, width: 30, height: 40 }, 3)).toEqual({
      x: 30,
      y: 60,
      width: 90,
      height: 120,
    });
  });

  it("leaves a box alone at scale one", () => {
    const box: Box = { x: 1.5, y: 2.5, width: 3, height: 4 };
    expect(scaleBox(box, 1)).toEqual(box);
  });

  it("keeps the width ratio the same on both sides of the scale", () => {
    const box: Box = { x: 0, y: 0, width: 620, height: 1000 };
    const frame = { width: 1000, height: 1600 };
    const scale = 3.5;
    expect(
      faceWidthRatio(scaleBox(box, scale), {
        width: frame.width * scale,
        height: frame.height * scale,
      }),
    ).toBeCloseTo(faceWidthRatio(box, frame), 10);
  });
});

describe("assessCapture", () => {
  it("accepts a sharp, evenly lit frame with the face filling the oval", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120)));
    expect(result.verdict).toBe("accept");
    expect(result.reason).toBeNull();
    expect(result.canUseAnyway).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.metrics.sharpness).toBeGreaterThan(0);
    expect(result.metrics.faceWidthRatio).toBeCloseTo(FRAME_OVAL_WIDTH, 5);
    expect(result.metrics.faceBboxRatio).toBeCloseTo(FRAME_OVAL_WIDTH, 5);
    expect(result.metrics.faceCenter?.x ?? 0).toBeCloseTo(0.5, 5);
    expect(result.metrics.faceCenter?.y ?? 0).toBeCloseTo(0.47, 5);
    // Light over the face, on the engine's 0 to 1 scale: the pattern's mean.
    expect(result.metrics.faceLuma).toBeCloseTo(120 / 255, 1);
    expect(result.metrics.faceLumaUneven ?? 1).toBeLessThan(0.1);
    expect(result.metrics.pose).toEqual({ yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 });
    expect(result.metrics.blink).toEqual({ left: 0, right: 0 });
  });

  /**
   * A frame nothing measured is never refused.
   *
   * When the landmarker has not loaded there is no face count and no reading,
   * and refusing on that would be refusing a person's photograph for the
   * state of a download. The frame is offered with the reason unmeasured, and
   * the engine's own input gate, which is free and authoritative, decides.
   * Whatever a caller hands in beside measured false is not this frame's
   * reading and is dropped.
   */
  it("offers rather than refuses an unmeasured frame, whatever else was given", () => {
    const cases: CaptureAssessmentInput[] = [
      { image: sharpMidtones(90, 120), faceCount: 0, reading: null, measured: false },
      { image: sharpMidtones(90, 120), faceCount: 1, reading: GOOD_FACE, measured: false },
      { image: sharpMidtones(90, 120), faceCount: 2, reading: GOOD_FACE, measured: false },
      { image: sharpMidtones(90, 120), faceCount: 1, reading: face({ yaw: 40 }), measured: false },
    ];
    for (const input of cases) {
      const result = assessCapture(input);
      expect(result.verdict).toBe("borderline");
      expect(result.reason).toBe("unmeasured");
      expect(result.canUseAnyway).toBe(true);
      expect(result.metrics.faceWidthRatio).toBeNull();
      expect(result.metrics.pose).toBeNull();
      expect(result.failures.map((failure) => failure.reason)).toEqual(["unmeasured"]);
    }
  });

  it("still refuses an unmeasured frame nothing could be read from", () => {
    const black = assessCapture({
      image: flat(0, 90, 120),
      faceCount: 0,
      reading: null,
      measured: false,
    });
    expect(black.verdict).toBe("reject");
    expect(black.reason).toBe("too_dark");
  });

  it("rejects a measured frame with no face", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120), null));
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("no_face");
    expect(result.canUseAnyway).toBe(false);
  });

  it("rejects a measured frame with a face count of one but no reading", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120), null, 1));
    expect(result.reason).toBe("no_face");
  });

  it("rejects a frame with more than one face, ahead of every other reason", () => {
    const result = assessCapture(measuredWith(flat(0, 90, 120), GOOD_FACE, 2));
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("multiple_faces");
    expect(result.canUseAnyway).toBe(false);
  });

  it("rejects an all white frame on exposure", () => {
    const result = assessCapture(measuredWith(flat(255, 90, 120)));
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("over_exposed");
    expect(result.metrics.blownFraction).toBe(1);
    expect(result.metrics.faceLuma).toBe(1);
  });

  it("rejects an all black frame on exposure", () => {
    const result = assessCapture(measuredWith(flat(0, 90, 120)));
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("too_dark");
    expect(result.metrics.crushedFraction).toBe(1);
    expect(result.metrics.faceLuma).toBe(0);
  });

  it("applies today's luminance bands, mapped onto the face luma scale", () => {
    const at = (level: number) =>
      assessCapture(measuredWith(flat(level, 90, 120)));
    expect(FACE_LUMA_REJECT_BELOW).toBeCloseTo(40 / 255, 10);
    expect(FACE_LUMA_BORDERLINE_BELOW).toBeCloseTo(60 / 255, 10);
    expect(FACE_LUMA_BORDERLINE_ABOVE).toBeCloseTo(205 / 255, 10);
    expect(FACE_LUMA_REJECT_ABOVE).toBeCloseTo(225 / 255, 10);
    expect(at(39).verdict).toBe("reject");
    expect(at(39).reason).toBe("too_dark");
    expect(at(50).verdict).toBe("borderline");
    expect(at(50).reason).toBe("too_dark");
    expect(at(128).verdict).toBe("accept");
    expect(at(210).verdict).toBe("borderline");
    expect(at(210).reason).toBe("over_exposed");
    expect(at(230).verdict).toBe("reject");
    expect(at(230).reason).toBe("over_exposed");
  });

  it("reports light before framing when a frame fails both", () => {
    const result = assessCapture(measuredWith(flat(0, 90, 120), face({ widthRatio: 0.3 })));
    expect(result.reason).toBe("too_dark");
    // Softness is measured on the same frame and decides nothing.
    expect(result.metrics.sharpness).toBe(0);
  });

  /**
   * Softness decides nothing at the gate, since 2026-09-14, and since
   * 2026-09-23 there is no reason it could be reported under. It used to be a
   * borderline: a review screen saying "A little blurry" with Retake as the
   * primary answer, which in practice is a wall. The threshold behind it was
   * set from stripes and checkerboards, and a smooth face at 96 pixels has
   * every chance of reading under it at any focus. The engine publishes no
   * blur code, the burst sends the sharpest of its frames, and the number
   * still lands in the metrics for calibration. So a frame with no local
   * contrast at all, which is what motion blur converges to, is accepted here
   * and judged by the party that can actually judge it.
   */
  it("accepts a flat, correctly exposed frame and records that it is flat", () => {
    const result = assessCapture(measuredWith(flat(128, 90, 120)));
    expect(result.verdict).toBe("accept");
    expect(result.reason).toBeNull();
    expect(result.metrics.sharpness).toBe(0);
  });

  it("neither refuses nor flags a frame for sharpness, at any value", () => {
    for (const step of [0, 1, 2, 4, 8, 16, 32, 64, 128]) {
      const image = checkerboard(128 - step / 2, 128 + step / 2, 90, 120);
      const result = assessCapture(measuredWith(image));
      expect(result.verdict).toBe("accept");
      expect(result.failures).toEqual([]);
    }
  });

  it("rejects a face that is far too small, under the RELAXED floor", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120), face({ widthRatio: 0.3 })));
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("too_far");
    expect(result.canUseAnyway).toBe(false);

    const justUnder = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ widthRatio: FACE_WIDTH_REJECT_BELOW - 0.01 })),
    );
    expect(justUnder.verdict).toBe("reject");
    const onTheFloor = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ widthRatio: FACE_WIDTH_REJECT_BELOW })),
    );
    expect(onTheFloor.verdict).toBe("borderline");
    expect(onTheFloor.reason).toBe("too_far");
  });

  it("flags a face just under the engine's rule as borderline and offers use it anyway", () => {
    const narrow = assessCapture(measuredWith(sharpMidtones(90, 120), face({ widthRatio: 0.58 })));
    expect(narrow.verdict).toBe("borderline");
    expect(narrow.reason).toBe("too_far");
    expect(narrow.canUseAnyway).toBe(true);
    expect(narrow.metrics.faceWidthRatio).toBeCloseTo(0.58, 5);

    const onTheRule = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ widthRatio: FACE_WIDTH_RATIO_MIN })),
    );
    expect(onTheRule.verdict).toBe("accept");
  });

  it("keeps the width floor equal to the engine's own rule", () => {
    expect(FACE_WIDTH_RATIO_MIN).toBe(FACE_WIDTH_ENGINE_MIN);
    expect(FACE_WIDTH_REJECT_BELOW).toBeLessThan(FACE_WIDTH_RATIO_MIN);
    expect(FACE_WIDTH_RATIO_MAX).toBeGreaterThan(FRAME_OVAL_WIDTH);
  });

  /**
   * A face wider than the band and still inside the edge margins. On a 3 by 4
   * frame the oval is 1.35 times as tall as it is wide, so a face at 0.87 of
   * the width is 0.88 of the height and has to sit at 0.525 to keep the 0.08
   * top and 0.03 bottom margins; centred at the target it is out of bounds
   * first, which is the precedence the next test pins.
   */
  it("flags a face too close as borderline", () => {
    const close = assessCapture(
      measuredWith(
        sharpMidtones(90, 120),
        face({ widthRatio: 0.87, center: { x: 0.5, y: 0.525 } }),
      ),
    );
    expect(close.verdict).toBe("borderline");
    expect(close.reason).toBe("too_close");
    expect(close.canUseAnyway).toBe(true);
  });

  it("flags a face oval inside the edge margins as out of bounds, ahead of too close", () => {
    const high = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ center: { x: 0.5, y: 0.2 } })),
    );
    expect(high.verdict).toBe("borderline");
    expect(high.reason).toBe("face_out_of_bounds");

    const huge = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ widthRatio: 0.9 })),
    );
    expect(huge.reason).toBe("face_out_of_bounds");
    expect(huge.failures.map((failure) => failure.reason)).toEqual([
      "too_close",
      "face_out_of_bounds",
    ]);
  });

  it("offers a pose inside the slack and refuses one beyond it", () => {
    const image = sharpMidtones(90, 120);
    const offered = assessCapture(
      measuredWith(image, face({ yaw: POSE_YAW_MAX_DEGREES + 5 })),
    );
    expect(offered.verdict).toBe("borderline");
    expect(offered.reason).toBe("facing_away");
    expect(offered.metrics.pose?.yawDegrees ?? 0).toBeCloseTo(POSE_YAW_MAX_DEGREES + 5, 4);

    const refused = assessCapture(
      measuredWith(image, face({ yaw: POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES + 1 })),
    );
    expect(refused.verdict).toBe("reject");
    expect(refused.reason).toBe("facing_away");

    // Pitch keeps the provider's lopsided window: looking up has less room.
    const down = assessCapture(
      measuredWith(image, face({ pitch: POSE_PITCH_MIN_DEGREES - 5 })),
    );
    expect(down.verdict).toBe("borderline");
    const up = assessCapture(
      measuredWith(image, face({ pitch: POSE_PITCH_MAX_DEGREES + POSE_SLACK_DEGREES + 5 })),
    );
    expect(up.verdict).toBe("reject");
  });

  /**
   * Recorded, not applied, in this build. The blink and the uneven light land
   * in the metrics for the calibration report; the
   * capture-thresholds-engine-terms PR turns them into borderline reasons.
   */
  it("records a blink without acting on it", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120), face({ blink: 1 })));
    expect(result.verdict).toBe("accept");
    expect(result.metrics.blink).toEqual({ left: 1, right: 1 });
    expect(result.failures.some((failure) => failure.reason === "eyes_closed")).toBe(false);
  });

  it("records uneven light over the eyes without acting on it", () => {
    // Lit on the image's right (the person's left eye), dim on the left.
    const data = new Array<number>(90 * 120);
    for (let y = 0; y < 120; y += 1) {
      for (let x = 0; x < 90; x += 1) {
        data[y * 90 + x] = x < 45 ? 100 : 200;
      }
    }
    const result = assessCapture(measuredWith({ data, width: 90, height: 120 }));
    expect(result.verdict).toBe("accept");
    expect(result.metrics.faceLumaUneven ?? 0).toBeGreaterThan(
      FACE_LUMA_UNEVEN_BORDERLINE_ABOVE,
    );
    expect(result.metrics.faceLuma).toBeCloseTo(150 / 255, 1);
  });

  /**
   * docs/01-user-flow.md section D: "Use it anyway" is "only shown for
   * borderline frames, never for failed face detection". The screen reads
   * canUseAnyway and nothing else, so the promise is only kept if the two are
   * the same fact. This asserts the equivalence over every verdict the gate can
   * reach rather than over one borderline case: a new check that forgot to set
   * the flag would leave a person with a frame the gate is willing to send and
   * no way to send it.
   */
  it("offers use it anyway on every borderline frame and on no other", () => {
    const image = sharpMidtones(90, 120);
    const cases: CaptureAssessmentInput[] = [
      // Accept.
      measuredWith(image),
      // Borderline framing, both sides, and out of bounds.
      measuredWith(image, face({ widthRatio: 0.58 })),
      measuredWith(image, face({ widthRatio: 0.87, center: { x: 0.5, y: 0.525 } })),
      measuredWith(image, face({ center: { x: 0.5, y: 0.2 } })),
      // Borderline light: the same pattern, lit like a room at night.
      measuredWith(dimSharp(90, 120)),
      // Borderline pose.
      measuredWith(image, face({ yaw: POSE_YAW_MAX_DEGREES + 5 })),
      // Unmeasured.
      { image, faceCount: 0, reading: null, measured: false },
      /*
       * Softness, across the range. A flat frame is the limit motion blur
       * converges to and a low contrast checkerboard is just above it; neither
       * is a refusal or a flag, so both are accepts.
       */
      measuredWith(flat(128, 90, 120)),
      measuredWith(checkerboard(127, 128, 90, 120)),
      // Rejects, one per reason that can produce one.
      measuredWith(image, null),
      measuredWith(image, GOOD_FACE, 2),
      measuredWith(flat(0, 90, 120)),
      measuredWith(flat(255, 90, 120)),
      measuredWith(image, face({ widthRatio: 0.3 })),
      measuredWith(image, face({ yaw: 40 })),
    ];

    const seen = new Set<string>();
    for (const input of cases) {
      const result = assessCapture(input);
      seen.add(result.verdict);
      expect(result.canUseAnyway).toBe(result.verdict === "borderline");
      // And a measured frame with no face is never borderline, whatever else is wrong.
      if (result.reason === "no_face" || result.reason === "multiple_faces") {
        expect(result.verdict).toBe("reject");
      }
    }
    // The matrix really did produce all three, so the equivalence was tested
    // rather than trivially satisfied by ten accepts.
    expect([...seen].sort()).toEqual(["accept", "borderline", "reject"]);
  });

  it("measures light and sharpness inside the face oval, not the background", () => {
    // A black frame with a well exposed, sharp face where the oval is.
    const width = 90;
    const height = 120;
    const pattern = sharpMidtones(width, height);
    const data = new Array<number>(width * height).fill(0);
    const box = GOOD_FACE.ovalBox;
    const left = Math.floor(box.x * width);
    const right = Math.ceil((box.x + box.width) * width);
    const top = Math.floor(box.y * height);
    const bottom = Math.ceil((box.y + box.height) * height);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        data[y * width + x] = pattern.data[y * width + x] ?? 0;
      }
    }
    const result = assessCapture(measuredWith({ data, width, height }));
    expect(result.verdict).toBe("accept");
    expect(result.metrics.crushedFraction).toBe(0);
    expect(result.metrics.faceLuma).toBeGreaterThan(FACE_LUMA_BORDERLINE_BELOW);
  });

  it("returns metrics on every verdict", () => {
    const result = assessCapture(measuredWith(sharpMidtones(90, 120), null));
    expect(result.metrics.faceLuma).toBeGreaterThan(0);
    expect(result.metrics.faceWidthRatio).toBeNull();
    expect(result.metrics.faceBboxRatio).toBeNull();
    expect(result.metrics.faceCenter).toBeNull();
    expect(result.metrics.faceLumaUneven).toBeNull();
    expect(result.metrics.blink).toBeNull();
  });

  it("keeps the stored shares of the frame inside it for a face that left it", () => {
    const result = assessCapture(
      measuredWith(sharpMidtones(90, 120), face({ center: { x: 1.1, y: 0.5 } })),
    );
    expect(result.metrics.faceCenter).toEqual({ x: 1, y: 0.5 });
    expect(result.reason).toBe("face_out_of_bounds");
  });

  it("lists the reasons in the documented precedence, without a sharpness reason", () => {
    expect([...CAPTURE_REASON_PRECEDENCE]).toEqual([
      "unmeasured",
      "no_face",
      "multiple_faces",
      "too_dark",
      "over_exposed",
      "face_out_of_bounds",
      "too_far",
      "too_close",
      "facing_away",
      "eyes_closed",
    ]);
  });
});

/**
 * A gate reading with nothing wrong with it, and only the things a test cares
 * about moved off it. frameScore reads a verdict and five numbers, so this is
 * every input it has.
 */
function reading(
  overrides: {
    readonly verdict?: CaptureVerdict;
    readonly sharpness?: number;
    readonly faceLuma?: number;
    readonly faceWidthRatio?: number | null;
    readonly pose?: FacePose | null;
    readonly blink?: Blink | null;
  } = {},
): CaptureAssessment {
  const verdict = overrides.verdict ?? "accept";
  return {
    verdict,
    reason: verdict === "accept" ? null : "too_far",
    canUseAnyway: verdict === "borderline",
    failures: [],
    metrics: {
      sharpness: overrides.sharpness ?? FRAME_SCORE_SHARPNESS_CAP,
      blownFraction: 0,
      crushedFraction: 0,
      faceLuma: overrides.faceLuma ?? FRAME_SCORE_LUMA_TARGET,
      faceLumaUneven: 0,
      faceWidthRatio:
        overrides.faceWidthRatio === undefined
          ? FRAME_OVAL_WIDTH
          : overrides.faceWidthRatio,
      faceBboxRatio: FRAME_OVAL_WIDTH,
      faceCenter: { x: 0.5, y: 0.47 },
      pose: overrides.pose ?? null,
      blink: overrides.blink === undefined ? { left: 0, right: 0 } : overrides.blink,
    },
  };
}

/** A head turned by this much, square in the other two axes. */
function turned(yawDegrees: number): FacePose {
  return { yawDegrees, pitchDegrees: 0, rollDegrees: 0 };
}

/** Far enough outside the pose window to carry a full unit of badness. */
const FULLY_TURNED = turned(POSE_YAW_MAX_DEGREES + POSE_SLACK_DEGREES);

describe("frameScore", () => {
  it("is minus infinity for a frame the gate refused", () => {
    /*
     * Perfect on every measurement the score reads, and still not a candidate.
     * A reject is not a frame that ranks badly, it is a frame this app will not
     * send, and the burst has to be unable to choose one however good the rest
     * of it looked.
     */
    expect(frameScore(reading({ verdict: "reject" }))).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it("is zero for a frame with nothing wrong with it", () => {
    // Every term is a penalty, so the top of the range is the absence of them.
    expect(frameScore(reading())).toBe(0);
  });

  it("ranks a turned head below a square one", () => {
    expect(frameScore(reading({ pose: FULLY_TURNED }))).toBeLessThan(
      frameScore(reading({ pose: turned(0) })),
    );
    // And further out is further down, not just different.
    expect(frameScore(reading({ pose: turned(POSE_YAW_MAX_DEGREES + 10) }))).
      toBeLessThan(
        frameScore(reading({ pose: turned(POSE_YAW_MAX_DEGREES + 4) })),
      );
  });

  it("does not charge a head that is inside the window", () => {
    // poseExcessDegrees is zero anywhere in the window, so the score is too.
    expect(frameScore(reading({ pose: turned(POSE_YAW_MAX_DEGREES) }))).toBe(
      frameScore(reading({ pose: turned(0) })),
    );
  });

  it("ranks a frame at the oval's width above one off it", () => {
    const onTarget = frameScore(reading({ faceWidthRatio: FRAME_OVAL_WIDTH }));
    expect(onTarget).toBeGreaterThan(
      frameScore(reading({ faceWidthRatio: FACE_WIDTH_RATIO_MIN })),
    );
    // Both sides of the target, not just the small one.
    expect(onTarget).toBeGreaterThan(
      frameScore(reading({ faceWidthRatio: FACE_WIDTH_RATIO_MAX })),
    );
  });

  it("ranks open eyes above a blink", () => {
    expect(frameScore(reading({ blink: { left: 0, right: 0 } }))).toBeGreaterThan(
      frameScore(reading({ blink: { left: 0.7, right: 0.1 } })),
    );
    // The worse eye decides: one shut eye is a blink.
    expect(frameScore(reading({ blink: { left: 0.7, right: 0.1 } }))).toBe(
      frameScore(reading({ blink: { left: 0.1, right: 0.7 } })),
    );
  });

  it("ranks a frame in the middle of the light band above one at the edge", () => {
    expect(frameScore(reading({ faceLuma: FRAME_SCORE_LUMA_TARGET })))
      .toBeGreaterThan(
        frameScore(reading({ faceLuma: FRAME_SCORE_LUMA_TARGET - 0.2 })),
      );
    expect(frameScore(reading({ faceLuma: FRAME_SCORE_LUMA_TARGET })))
      .toBeGreaterThan(
        frameScore(reading({ faceLuma: FRAME_SCORE_LUMA_TARGET + 0.2 })),
      );
  });

  it("prefers the sharper frame, and stops caring above the cap", () => {
    expect(frameScore(reading({ sharpness: FRAME_SCORE_SHARPNESS_CAP / 2 })))
      .toBeLessThan(
        frameScore(reading({ sharpness: FRAME_SCORE_SHARPNESS_CAP })),
      );
    /*
     * Capped, because the difference between sharp and very sharp is not one
     * the engine will ever act on, and without the cap a frame that caught one
     * high contrast edge would outvote pose and framing together.
     */
    expect(frameScore(reading({ sharpness: FRAME_SCORE_SHARPNESS_CAP }))).toBe(
      frameScore(reading({ sharpness: FRAME_SCORE_SHARPNESS_CAP * 40 })),
    );
    expect(FRAME_SCORE_SHARPNESS_CAP).toBe(100);
  });

  it("puts borderline below accept for two otherwise identical frames", () => {
    expect(frameScore(reading({ verdict: "borderline" }))).toBeLessThan(
      frameScore(reading({ verdict: "accept" })),
    );
    expect(frameScore(reading({ verdict: "borderline" }))).toBe(
      -FRAME_SCORE_BORDERLINE_PENALTY,
    );
  });

  /**
   * The verdict outranks every measurement, and that is the point of it.
   *
   * An accepted frame goes straight to the engine; a borderline one stops on
   * the review screen and asks. Preferring a borderline frame because it was a
   * little sharper would put somebody in front of "Use it anyway" with a clean
   * frame sitting in memory unused.
   */
  it("prefers the worst accepted frame to the best borderline one", () => {
    const worstAccept = reading({
      pose: FULLY_TURNED,
      faceWidthRatio: 0,
      faceLuma: 1,
      sharpness: 0,
      blink: { left: 1, right: 1 },
    });
    const bestBorderline = reading({ verdict: "borderline" });
    expect(frameScore(worstAccept)).toBeGreaterThan(
      frameScore(bestBorderline),
    );
  });

  /**
   * The order of the weights, as one assertion rather than five separate
   * beliefs: one full unit of badness on each term, measured on its own.
   */
  it("weighs pose over framing, framing over the eyes, the eyes over light, and light over sharpness", () => {
    const pose = frameScore(reading({ pose: FULLY_TURNED }));
    const width = frameScore(reading({ faceWidthRatio: 0 }));
    const blink = frameScore(reading({ blink: { left: 1, right: 1 } }));
    const light = frameScore(reading({ faceLuma: 1 }));
    const sharpness = frameScore(reading({ sharpness: 0 }));

    expect(pose).toBeCloseTo(-FRAME_SCORE_POSE_WEIGHT, 10);
    expect(width).toBeCloseTo(-FRAME_SCORE_WIDTH_WEIGHT, 10);
    expect(blink).toBeCloseTo(-FRAME_SCORE_BLINK_WEIGHT, 10);
    expect(light).toBeCloseTo(-FRAME_SCORE_LUMA_WEIGHT, 10);
    expect(sharpness).toBeCloseTo(-FRAME_SCORE_SHARPNESS_WEIGHT, 10);

    expect(pose).toBeLessThan(width);
    expect(width).toBeLessThan(blink);
    expect(blink).toBeLessThan(light);
    expect(light).toBeLessThan(sharpness);
    expect(sharpness).toBeLessThan(frameScore(reading()));
  });

  /**
   * A measurement that was never made is not a measurement that came out badly.
   * Ranking a frame on the absence of the landmarker's opinion would rank the
   * landmarker rather than the photograph.
   */
  it("does not charge a frame for a measurement the landmarker did not make", () => {
    expect(frameScore(reading({ pose: null }))).toBe(
      frameScore(reading({ pose: turned(0) })),
    );
    expect(frameScore(reading({ faceWidthRatio: null }))).toBe(
      frameScore(reading({ faceWidthRatio: FRAME_OVAL_WIDTH })),
    );
    expect(frameScore(reading({ blink: null }))).toBe(
      frameScore(reading({ blink: { left: 0, right: 0 } })),
    );
  });
});

describe("pickBestFrame", () => {
  it("returns null when the gate refused every frame", () => {
    expect(
      pickBestFrame([
        { assessment: reading({ verdict: "reject" }), value: "a" },
        { assessment: reading({ verdict: "reject" }), value: "b" },
      ]),
    ).toBeNull();
  });

  it("returns null for a burst with nothing in it", () => {
    expect(pickBestFrame<string>([])).toBeNull();
  });

  it("returns the highest scoring frame", () => {
    const best = pickBestFrame([
      { assessment: reading({ pose: FULLY_TURNED }), value: "turned" },
      { assessment: reading({ sharpness: 0 }), value: "soft" },
      { assessment: reading(), value: "clean" },
      { assessment: reading({ faceLuma: 1 }), value: "bright" },
      { assessment: reading({ blink: { left: 1, right: 1 } }), value: "blinked" },
    ]);
    expect(best).toBe("clean");
  });

  it("skips the rejects and picks the best of what is left", () => {
    const best = pickBestFrame([
      // A reject with perfect numbers still cannot win.
      { assessment: reading({ verdict: "reject" }), value: "refused" },
      { assessment: reading({ verdict: "borderline" }), value: "offered" },
      { assessment: reading({ sharpness: 0 }), value: "soft" },
    ]);
    expect(best).toBe("soft");
  });

  /**
   * Deterministic on a tie, first wins. The frames of a burst are in the order
   * they were taken, so an unbroken tie hands back the one closest to the
   * instant the person meant to take.
   */
  it("keeps the first of two equally good frames", () => {
    const candidates = [
      { assessment: reading({ sharpness: 0 }), value: "first" },
      { assessment: reading({ sharpness: 0 }), value: "second" },
    ];
    expect(pickBestFrame(candidates)).toBe("first");
    expect(pickBestFrame([...candidates].reverse())).toBe("second");
  });
});

describe("rejection copy", () => {
  it("has one line of copy for every reason the gate can return", () => {
    for (const reason of CAPTURE_REASON_PRECEDENCE) {
      const line = captureRejectionCopy(reason);
      expect(line.length).toBeGreaterThan(0);
      expect(line.endsWith(".")).toBe(true);
    }
  });

  it("lists every reason exactly once in the precedence order", () => {
    expect(new Set(CAPTURE_REASON_PRECEDENCE).size).toBe(
      CAPTURE_REASON_PRECEDENCE.length,
    );
  });
});
