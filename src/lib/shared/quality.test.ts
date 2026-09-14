import { describe, expect, it } from "vitest";

import { captureRejectionCopy } from "./copy";
import type { FacePose } from "./pose";
import {
  AUTO_CROP_ASPECT,
  AUTO_CROP_FACE_WIDTH_TARGET,
  BLOWN_LUMINANCE_AT_OR_ABOVE,
  CAPTURE_REASON_PRECEDENCE,
  CRUSHED_LUMINANCE_AT_OR_BELOW,
  FACE_COVERAGE_BORDERLINE_MIN,
  FACE_COVERAGE_MIN,
  AUTO_CROP_CHIN_ROOM_BELOW,
  AUTO_CROP_HEAD_ROOM_ABOVE,
  FACE_WIDTH_RATIO_MAX,
  FACE_WIDTH_RATIO_MIN,
  FRAME_SCORE_BORDERLINE_PENALTY,
  FRAME_SCORE_LUMINANCE_TARGET,
  FRAME_SCORE_LUMINANCE_WEIGHT,
  FRAME_SCORE_POSE_WEIGHT,
  FRAME_SCORE_SHARPNESS_CAP,
  FRAME_SCORE_SHARPNESS_WEIGHT,
  FRAME_SCORE_WIDTH_WEIGHT,
  POSE_SLACK_DEGREES,
  POSE_YAW_MAX_DEGREES,
  SHARPNESS_BORDERLINE_BELOW,
  SHARPNESS_MEASURE_LONG_EDGE,
  SHARPNESS_SCALE,
  assessCapture,
  autoCropBoxFor,
  clampBox,
  cropToBox,
  exposureStats,
  faceCoverageCheck,
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
 * The same pattern, at a mean between MEAN_LUMINANCE_REJECT_BELOW and
 * MEAN_LUMINANCE_BORDERLINE_BELOW: a frame the gate is uneasy about and still
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

/** A face box that meets the 60 percent height rule in a 100px tall frame. */
const GOOD_FACE_BOX: Box = { x: 15, y: 15, width: 70, height: 70 };

describe("laplacianVariance", () => {
  it("is zero for a flat image", () => {
    expect(laplacianVariance(flat(128))).toBe(0);
    expect(laplacianVariance(flat(0))).toBe(0);
    expect(laplacianVariance(flat(255))).toBe(0);
  });

  it("is large for a checkerboard", () => {
    const variance = laplacianVariance(checkerboard(40, 200));
    expect(variance).toBeGreaterThan(SHARPNESS_BORDERLINE_BELOW);
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
   * capture." while the gate measured the 1024px capture and said "A little
   * blurry." (Samsung S26 Ultra, indoors at night, 2026-09-03).
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
   * blurry, and it was being called blurry on exactly the skin tones
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

describe("faceCoverageCheck", () => {
  it("passes at exactly 60 percent of the frame height", () => {
    const result = faceCoverageCheck(
      { x: 0, y: 0, width: 40, height: 60 },
      FRAME,
    );
    expect(result.coverage).toBeCloseTo(FACE_COVERAGE_MIN, 5);
    expect(result.meetsMinimum).toBe(true);
    expect(result.isBorderline).toBe(false);
  });

  it("is borderline just under the rule", () => {
    const result = faceCoverageCheck(
      { x: 0, y: 0, width: 40, height: 55 },
      FRAME,
    );
    expect(result.meetsMinimum).toBe(false);
    expect(result.isBorderline).toBe(true);
  });

  it("fails outright well under the rule", () => {
    const result = faceCoverageCheck(
      { x: 0, y: 0, width: 20, height: 30 },
      FRAME,
    );
    expect(result.meetsMinimum).toBe(false);
    expect(result.isBorderline).toBe(false);
  });

  it("measures height only, so a wide box does not rescue a short one", () => {
    const result = faceCoverageCheck(
      { x: 0, y: 0, width: 100, height: 30 },
      FRAME,
    );
    expect(result.meetsMinimum).toBe(false);
  });

  it("rejects a frame with no height", () => {
    expect(() =>
      faceCoverageCheck({ x: 0, y: 0, width: 10, height: 10 }, {
        width: 10,
        height: 0,
      }),
    ).toThrow(/positive/u);
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

  /** What the gate will measure once the crop has been drawn. */
  function coverageOf(box: Box, crop: Box): number {
    return box.height / crop.height;
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
     * hair and head turn. The two values at and above 1 are the colour
     * threshold in src/lib/client/face.ts reporting a neck and two shoulders,
     * which is a box the geometry has to survive rather than one it can assume
     * away.
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

  it("does nothing when the face already meets both rules", () => {
    /*
     * "Both" is the 2026-09-07 change. A gallery frame is 3 by 4, so the face has
     * to be tall enough for our height rule and wide enough for the engine's
     * width rule before there is nothing left to compose. At the 0.72 aspect this
     * helper draws, a face needs about 0.83 of the frame height before its width
     * clears 0.60 of the short axis, which is why the coverages that satisfy this
     * now start well above FACE_COVERAGE_MIN.
     */
    for (const coverage of [0.85, 0.9, 0.95]) {
      const { faceBox, frame } = gallery(coverage);
      expect(autoCropBoxFor({ faceBox, frame })).toBeNull();
    }
  });

  /**
   * The frame that used to slip through: tall enough for us, too narrow for the
   * engine. It was sent whole and refused with error_src_face_too_small.
   */
  it("composes a face that clears the height rule and fails the width rule", () => {
    const { faceBox, frame } = gallery(0.62);
    expect(faceCoverageCheck(faceBox, frame).meetsMinimum).toBe(true);
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

  it("lands every one of those crops above the gate's own minimum", () => {
    for (const coverage of [0.3, 0.35, 0.4, 0.45, 0.5, 0.59]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame }) as Box;
      expect(
        faceCoverageCheck(faceBox, {
          width: crop.width,
          height: crop.height,
        }).meetsMinimum,
      ).toBe(true);
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

  it("fills the width too, which is the framing the engine asks for", () => {
    /*
     * endpoints.ts, facialColorTones: "face width greater than 60 percent of
     * image width". The height rule alone does not give that on a narrow face,
     * so the crop is capped on width as well.
     */
    for (const coverage of [0.3, 0.4, 0.5]) {
      for (const aspect of [0.6, 0.72, 0.8]) {
        const { faceBox, frame } = gallery(coverage, aspect);
        const crop = autoCropBoxFor({ faceBox, frame }) as Box;
        expect(faceBox.width / crop.width).toBeGreaterThanOrEqual(
          FACE_COVERAGE_MIN,
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
    expect(coverageOf(faceBox, crop)).toBeGreaterThanOrEqual(FACE_COVERAGE_MIN);
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

  it("stays portrait when the skin region ran into bare shoulders", () => {
    // The YCbCr fallback's worst case: a region far wider than it is tall,
    // because the neck and shoulders were lit like the face. A box that already
    // fills the picture has nothing left to compose, so null is a real answer
    // here and the only thing that matters is that a crop, if there is one, is
    // never landscape.
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
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
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

  it("keeps coverage the same on both sides of the scale", () => {
    const box: Box = { x: 0, y: 0, width: 620, height: 1000 };
    const frame = { width: 1000, height: 1600 };
    const scale = 3.5;
    expect(
      faceCoverageCheck(scaleBox(box, scale), {
        width: frame.width * scale,
        height: frame.height * scale,
      }).coverage,
    ).toBeCloseTo(faceCoverageCheck(box, frame).coverage, 10);
  });
});

describe("assessCapture", () => {
  it("accepts a sharp, evenly lit frame with the face filling the oval", () => {
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("accept");
    expect(result.reason).toBeNull();
    expect(result.canUseAnyway).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.metrics.sharpness).toBeGreaterThan(SHARPNESS_BORDERLINE_BELOW);
    expect(result.metrics.faceCoverage).toBeCloseTo(0.7, 5);
  });

  /**
   * The colour threshold does not get to refuse a photograph.
   *
   * When the detector has not loaded, the face count and box come from a YCbCr
   * skin rule that misses deep skin under warm light entirely and reads a bare
   * arm as a second person. Refusing on that is how a person with a perfectly
   * good photograph gets told there is no face in it, over and over, which is
   * exactly what was happening in production on 2026-09-10.
   */
  it("offers rather than refuses when the face estimate cannot be trusted", () => {
    const noFace = assessCapture({
      image: sharpMidtones(),
      faceCount: 0,
      faceBox: null,
      faceEstimateTrusted: false,
    });
    expect(noFace.verdict).toBe("borderline");
    expect(noFace.reason).toBe("no_face");
    expect(noFace.canUseAnyway).toBe(true);

    const twoFaces = assessCapture({
      image: sharpMidtones(),
      faceCount: 2,
      faceBox: GOOD_FACE_BOX,
      faceEstimateTrusted: false,
    });
    expect(twoFaces.verdict).toBe("borderline");
    expect(twoFaces.canUseAnyway).toBe(true);
  });

  it("still refuses when a real detector says there is no face", () => {
    for (const trusted of [true, undefined]) {
      const result = assessCapture({
        image: sharpMidtones(),
        faceCount: 0,
        faceBox: null,
        ...(trusted === undefined ? {} : { faceEstimateTrusted: trusted }),
      });
      expect(result.verdict).toBe("reject");
      expect(result.canUseAnyway).toBe(false);
    }
  });

  it("rejects a frame with no face", () => {
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 0,
      faceBox: null,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("no_face");
    expect(result.canUseAnyway).toBe(false);
  });

  it("rejects a frame with a face count of one but no box", () => {
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 1,
      faceBox: null,
    });
    expect(result.reason).toBe("no_face");
  });

  it("rejects a frame with more than one face, ahead of every other reason", () => {
    const result = assessCapture({
      image: flat(0),
      faceCount: 2,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("multiple_faces");
    expect(result.canUseAnyway).toBe(false);
  });

  it("rejects an all white frame on exposure", () => {
    const result = assessCapture({
      image: flat(255, 100, 100),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("over_exposed");
    expect(result.metrics.blownFraction).toBe(1);
  });

  it("rejects an all black frame on exposure", () => {
    const result = assessCapture({
      image: flat(0, 100, 100),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("too_dark");
    expect(result.metrics.crushedFraction).toBe(1);
  });

  it("reports light before sharpness when a frame fails both", () => {
    const result = assessCapture({
      image: flat(0, 100, 100),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.reason).toBe("too_dark");
    expect(
      result.failures.some((failure) => failure.reason === "blurry"),
    ).toBe(true);
  });

  /**
   * The policy, and the reason the sharpness reject threshold does not exist:
   * a frame with no local contrast at all, which is what motion blur converges
   * to, is still offered. The engine's own input gate is free and authoritative,
   * so the worst case of being wrong here is a couple of seconds, and the worst
   * case of the old behaviour was a person on a real phone tapping the shutter
   * over and over with no way through (2026-09-03).
   */
  it("flags a flat, correctly exposed frame as borderline rather than refusing it", () => {
    const result = assessCapture({
      image: flat(128, 100, 100),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("borderline");
    expect(result.reason).toBe("blurry");
    expect(result.canUseAnyway).toBe(true);
    expect(result.metrics.sharpness).toBe(0);
  });

  it("never refuses a frame for sharpness, at any value", () => {
    /*
     * The whole range, from a dead flat frame through the borderline line and
     * out the other side. Below the line the verdict is borderline and the way
     * forward is offered; at or above it, sharpness says nothing at all.
     */
    for (const step of [0, 1, 2, 4, 8, 16, 32, 64, 128]) {
      const image = checkerboard(128 - step / 2, 128 + step / 2, 100, 100);
      const result = assessCapture({
        image,
        faceCount: 1,
        faceBox: GOOD_FACE_BOX,
      });
      expect(result.verdict).not.toBe("reject");
      const flagged = result.failures.some(
        (failure) => failure.reason === "blurry",
      );
      expect(flagged).toBe(result.metrics.sharpness < SHARPNESS_BORDERLINE_BELOW);
      if (flagged) {
        expect(result.canUseAnyway).toBe(true);
      }
    }
  });

  it("rejects a face that is far too small", () => {
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 1,
      faceBox: { x: 30, y: 30, width: 20, height: 20 },
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("too_far");
    expect(result.canUseAnyway).toBe(false);
  });

  it("flags a face just under the rule as borderline and offers use it anyway", () => {
    const height = Math.round(
      FRAME.height * ((FACE_COVERAGE_MIN + FACE_COVERAGE_BORDERLINE_MIN) / 2),
    );
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 1,
      faceBox: { x: 20, y: 10, width: 60, height },
    });
    expect(result.verdict).toBe("borderline");
    expect(result.reason).toBe("too_far");
    expect(result.canUseAnyway).toBe(true);
  });

  /**
   * docs/01-user-flow.md section D: "Use it anyway" is "only shown for
   * borderline frames, never for failed face detection". The screen reads
   * canUseAnyway and nothing else, so the promise is only kept if the two are
   * the same fact. This asserts the equivalence over every verdict the gate can
   * reach rather than over the one borderline case above: a new check that
   * forgot to set the flag would leave a person with a frame the gate is willing
   * to send and no way to send it.
   */
  it("offers use it anyway on every borderline frame and on no other", () => {
    const underRule = Math.round(
      FRAME.height * ((FACE_COVERAGE_MIN + FACE_COVERAGE_BORDERLINE_MIN) / 2),
    );
    const cases: CaptureAssessmentInput[] = [
      // Accept.
      { image: sharpMidtones(), faceCount: 1, faceBox: GOOD_FACE_BOX },
      // Borderline framing.
      {
        image: sharpMidtones(),
        faceCount: 1,
        faceBox: { x: 20, y: 10, width: 60, height: underRule },
      },
      // Borderline light: the same pattern, lit like a room at night.
      { image: dimSharp(), faceCount: 1, faceBox: GOOD_FACE_BOX },
      /*
       * Borderline softness, across the range. A flat frame is the limit motion
       * blur converges to and a low contrast checkerboard is just under the
       * line; neither is a refusal any more, so both have to carry the offer.
       */
      { image: flat(128, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
      {
        image: checkerboard(127, 128, 100, 100),
        faceCount: 1,
        faceBox: GOOD_FACE_BOX,
      },
      // Rejects, one per reason that can still produce one.
      { image: sharpMidtones(), faceCount: 0, faceBox: null },
      { image: sharpMidtones(), faceCount: 2, faceBox: GOOD_FACE_BOX },
      { image: flat(0, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
      { image: flat(255, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
      {
        image: sharpMidtones(),
        faceCount: 1,
        faceBox: { x: 30, y: 30, width: 20, height: 20 },
      },
    ];

    const seen = new Set<string>();
    for (const input of cases) {
      const result = assessCapture(input);
      seen.add(result.verdict);
      expect(result.canUseAnyway).toBe(result.verdict === "borderline");
      // And a frame with no face is never borderline, whatever else is wrong.
      if (result.reason === "no_face" || result.reason === "multiple_faces") {
        expect(result.verdict).toBe("reject");
      }
      /*
       * The policy, asserted over the whole matrix rather than over one frame:
       * softness is flagged, never refused. A reject is only ever reached
       * through the face checks, the exposure extremes, or a face far too small
       * to read, which are the three things a credit cannot survive.
       */
      for (const failure of result.failures) {
        if (failure.reason === "blurry") {
          expect(failure.severity).toBe("borderline");
        }
      }
    }
    // The matrix really did produce all three, so the equivalence was tested
    // rather than trivially satisfied by ten accepts.
    expect([...seen].sort()).toEqual(["accept", "borderline", "reject"]);
  });

  it("measures light and sharpness inside the face box, not the background", () => {
    // A dark frame with a well exposed, sharp face box in the middle.
    const width = 100;
    const height = 100;
    const face = sharpMidtones(70, 70);
    const data = new Array<number>(width * height).fill(0);
    for (let y = 0; y < 70; y += 1) {
      for (let x = 0; x < 70; x += 1) {
        data[(y + 15) * width + (x + 15)] = face.data[y * 70 + x] ?? 0;
      }
    }
    const result = assessCapture({
      image: { data, width, height },
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("accept");
    expect(result.metrics.crushedFraction).toBe(0);
  });

  it("returns metrics on every verdict", () => {
    const result = assessCapture({
      image: sharpMidtones(),
      faceCount: 0,
      faceBox: null,
    });
    expect(result.metrics.meanLuminance).toBeGreaterThan(0);
    expect(result.metrics.faceCoverage).toBeNull();
  });
});

/**
 * A gate reading with nothing wrong with it, and only the things a test cares
 * about moved off it. frameScore reads a verdict and four numbers, so this is
 * every input it has.
 */
function reading(
  overrides: {
    readonly verdict?: CaptureVerdict;
    readonly sharpness?: number;
    readonly meanLuminance?: number;
    readonly faceWidthRatio?: number | null;
    readonly pose?: FacePose | null;
  } = {},
): CaptureAssessment {
  const verdict = overrides.verdict ?? "accept";
  return {
    verdict,
    reason: verdict === "accept" ? null : "blurry",
    canUseAnyway: verdict === "borderline",
    failures: [],
    metrics: {
      sharpness: overrides.sharpness ?? FRAME_SCORE_SHARPNESS_CAP,
      blownFraction: 0,
      crushedFraction: 0,
      meanLuminance: overrides.meanLuminance ?? FRAME_SCORE_LUMINANCE_TARGET,
      faceCoverage: 0.7,
      faceWidthRatio:
        overrides.faceWidthRatio === undefined
          ? AUTO_CROP_FACE_WIDTH_TARGET
          : overrides.faceWidthRatio,
      pose: overrides.pose ?? null,
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

  it("ranks a frame at the width target above one off it", () => {
    const onTarget = frameScore(
      reading({ faceWidthRatio: AUTO_CROP_FACE_WIDTH_TARGET }),
    );
    expect(onTarget).toBeGreaterThan(
      frameScore(reading({ faceWidthRatio: FACE_WIDTH_RATIO_MIN })),
    );
    // Both sides of the target, not just the small one.
    expect(onTarget).toBeGreaterThan(
      frameScore(reading({ faceWidthRatio: FACE_WIDTH_RATIO_MAX })),
    );
  });

  it("ranks a frame in the middle of the light band above one at the edge", () => {
    expect(frameScore(reading({ meanLuminance: FRAME_SCORE_LUMINANCE_TARGET })))
      .toBeGreaterThan(
        frameScore(
          reading({ meanLuminance: FRAME_SCORE_LUMINANCE_TARGET - 50 }),
        ),
      );
    expect(frameScore(reading({ meanLuminance: FRAME_SCORE_LUMINANCE_TARGET })))
      .toBeGreaterThan(
        frameScore(
          reading({ meanLuminance: FRAME_SCORE_LUMINANCE_TARGET + 50 }),
        ),
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
      meanLuminance: 255,
      sharpness: 0,
    });
    const bestBorderline = reading({ verdict: "borderline" });
    expect(frameScore(worstAccept)).toBeGreaterThan(
      frameScore(bestBorderline),
    );
  });

  /**
   * The order of the weights, as one assertion rather than four separate
   * beliefs: one full unit of badness on each term, measured on its own.
   */
  it("weighs pose over framing, framing over light, and light over sharpness", () => {
    const pose = frameScore(reading({ pose: FULLY_TURNED }));
    const width = frameScore(reading({ faceWidthRatio: 0 }));
    const light = frameScore(reading({ meanLuminance: 255 }));
    const sharpness = frameScore(reading({ sharpness: 0 }));

    expect(pose).toBeCloseTo(-FRAME_SCORE_POSE_WEIGHT, 10);
    expect(width).toBeCloseTo(-FRAME_SCORE_WIDTH_WEIGHT, 10);
    expect(light).toBeCloseTo(-FRAME_SCORE_LUMINANCE_WEIGHT, 10);
    expect(sharpness).toBeCloseTo(-FRAME_SCORE_SHARPNESS_WEIGHT, 10);

    expect(pose).toBeLessThan(width);
    expect(width).toBeLessThan(light);
    expect(light).toBeLessThan(sharpness);
    expect(sharpness).toBeLessThan(frameScore(reading()));
  });

  /**
   * A measurement that was never made is not a measurement that came out badly.
   * Ranking a frame on the absence of the detector's opinion would rank the
   * detector rather than the photograph.
   */
  it("does not charge a frame for a measurement the detector did not make", () => {
    expect(frameScore(reading({ pose: null }))).toBe(
      frameScore(reading({ pose: turned(0) })),
    );
    expect(frameScore(reading({ faceWidthRatio: null }))).toBe(
      frameScore(reading({ faceWidthRatio: AUTO_CROP_FACE_WIDTH_TARGET })),
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
      { assessment: reading({ meanLuminance: 255 }), value: "bright" },
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
