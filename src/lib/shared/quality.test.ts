import { describe, expect, it } from "vitest";

import { captureRejectionCopy } from "./copy";
import {
  BLOWN_LUMINANCE_AT_OR_ABOVE,
  CAPTURE_REASON_PRECEDENCE,
  CRUSHED_LUMINANCE_AT_OR_BELOW,
  FACE_COVERAGE_BORDERLINE_MIN,
  FACE_COVERAGE_MIN,
  SHARPNESS_BORDERLINE_BELOW,
  SHARPNESS_REJECT_BELOW,
  assessCapture,
  clampBox,
  cropToBox,
  exposureStats,
  faceCoverageCheck,
  laplacianVariance,
  type Box,
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

  it("rejects a flat, correctly exposed frame as blurry", () => {
    const result = assessCapture({
      image: flat(128, 100, 100),
      faceCount: 1,
      faceBox: GOOD_FACE_BOX,
    });
    expect(result.verdict).toBe("reject");
    expect(result.reason).toBe("blurry");
    expect(result.metrics.sharpness).toBeLessThan(SHARPNESS_REJECT_BELOW);
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
