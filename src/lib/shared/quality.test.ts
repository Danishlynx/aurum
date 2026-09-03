import { describe, expect, it } from "vitest";

import { captureRejectionCopy } from "./copy";
import {
  AUTO_CROP_ASPECT,
  AUTO_CROP_FACE_COVERAGE,
  AUTO_CROP_MIN_FACE_MARGIN,
  BLOWN_LUMINANCE_AT_OR_ABOVE,
  CAPTURE_REASON_PRECEDENCE,
  CRUSHED_LUMINANCE_AT_OR_BELOW,
  FACE_COVERAGE_BORDERLINE_MIN,
  FACE_COVERAGE_MIN,
  SHARPNESS_BORDERLINE_BELOW,
  SHARPNESS_REJECT_BELOW,
  assessCapture,
  autoCropBoxFor,
  clampBox,
  cropToBox,
  exposureStats,
  faceCoverageCheck,
  laplacianVariance,
  scaleBox,
  type Box,
  type CaptureAssessmentInput,
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

  it("does nothing when the face already meets the rule", () => {
    for (const coverage of [0.6, 0.62, 0.75, 0.95]) {
      const { faceBox, frame } = gallery(coverage);
      expect(autoCropBoxFor({ faceBox, frame })).toBeNull();
    }
  });

  it("frames the face at 62 percent of the crop, from 30 to 50 percent", () => {
    for (const coverage of [0.3, 0.35, 0.4, 0.45, 0.5, 0.59]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame });
      expect(crop).not.toBeNull();
      expect(coverageOf(faceBox, crop as Box)).toBeCloseTo(
        AUTO_CROP_FACE_COVERAGE,
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

  it("keeps the whole face plus the margin inside the crop", () => {
    for (const coverage of [0.3, 0.4, 0.5]) {
      const { faceBox, frame } = gallery(coverage);
      const crop = autoCropBoxFor({ faceBox, frame }) as Box;
      const margin = AUTO_CROP_MIN_FACE_MARGIN / 2;
      expect(crop.x).toBeLessThanOrEqual(faceBox.x - faceBox.width * margin);
      expect(crop.y).toBeLessThanOrEqual(faceBox.y - faceBox.height * margin);
      expect(crop.x + crop.width).toBeGreaterThanOrEqual(
        faceBox.x + faceBox.width * (1 + margin),
      );
      expect(crop.y + crop.height).toBeGreaterThanOrEqual(
        faceBox.y + faceBox.height * (1 + margin),
      );
    }
  });

  it("comes out portrait, never landscape", () => {
    for (const coverage of [0.3, 0.4, 0.5]) {
      for (const aspect of [0.55, 0.72, 0.85, 1.1]) {
        const { faceBox, frame } = gallery(coverage, aspect);
        const crop = autoCropBoxFor({ faceBox, frame }) as Box;
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
    // because the neck and shoulders were lit like the face.
    const frame = { width: 3000, height: 4000 };
    const faceBox = { x: 300, y: 1200, width: 2400, height: 1400 };
    const crop = autoCropBoxFor({ faceBox, frame }) as Box;
    expect(crop.width).toBeLessThanOrEqual(crop.height);
    expect(coverageOf(faceBox, crop)).toBeGreaterThanOrEqual(FACE_COVERAGE_MIN);
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
      // Rejects, one per reason that can produce one.
      { image: sharpMidtones(), faceCount: 0, faceBox: null },
      { image: sharpMidtones(), faceCount: 2, faceBox: GOOD_FACE_BOX },
      { image: flat(0, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
      { image: flat(255, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
      { image: flat(128, 100, 100), faceCount: 1, faceBox: GOOD_FACE_BOX },
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
    }
    // The matrix really did produce all three, so the equivalence was tested
    // rather than trivially satisfied by nine accepts.
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
