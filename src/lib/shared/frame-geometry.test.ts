import { describe, expect, it } from "vitest";

import {
  FRAME_FACE_CENTER_X,
  FRAME_FACE_CENTER_Y,
  FRAME_OVAL_EDGE_MARGIN,
  FRAME_OVAL_EDGE_MARGIN_TOP,
  FRAME_OVAL_HEIGHT_RATIO,
  FRAME_OVAL_WIDTH,
  MASTER_ASPECT,
  REFRAME_KEEP_FRACTION,
  masterCropFor,
  masterRectFor,
  ovalBoxIn,
  ovalStageStyle,
  ovalTouchesEdge,
  reframeBoxFor,
  type Size,
} from "./frame-geometry";
import type { Box } from "./quality";

/**
 * The master frame is the contract: what the person sees, what is measured and
 * what is uploaded are one 3:4 frame with the oval at a fixed place in it.
 * These tests are the invariants the capture PRs build on, proven on the
 * geometry alone before any of them touches a canvas.
 */

function isWhole(box: Box): boolean {
  return (
    Number.isInteger(box.x) &&
    Number.isInteger(box.y) &&
    Number.isInteger(box.width) &&
    Number.isInteger(box.height)
  );
}

function isInside(box: Box, frame: Size): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= frame.width &&
    box.y + box.height <= frame.height
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** 3:4 to within one pixel of rounding on either edge. */
function expectPortrait34(box: Box): void {
  expect(Math.abs(box.width - box.height * MASTER_ASPECT)).toBeLessThanOrEqual(1);
}

describe("masterRectFor", () => {
  it("keeps the full width of a portrait phone track as a centred 3:4 crop", () => {
    expect(masterRectFor({ width: 1080, height: 1920 })).toEqual({
      x: 0,
      y: 240,
      width: 1080,
      height: 1440,
    });
  });

  it("keeps the full height of a landscape laptop track as a centred 3:4 crop", () => {
    expect(masterRectFor({ width: 1920, height: 1080 })).toEqual({
      x: 555,
      y: 0,
      width: 810,
      height: 1080,
    });
  });

  it.each([
    [1080, 1920],
    [1920, 1080],
    [1280, 720],
    [640, 480],
    [1080, 1080],
  ])("is 3:4, centred, whole and inside the track on %i by %i", (width, height) => {
    const track = { width, height };
    const rect = masterRectFor(track);
    expectPortrait34(rect);
    expect(isWhole(rect)).toBe(true);
    expect(isInside(rect, track)).toBe(true);
    /* Centred: the slack on each side differs by at most the odd pixel. */
    expect(Math.abs(rect.x - (track.width - rect.width - rect.x))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y - (track.height - rect.height - rect.y))).toBeLessThanOrEqual(1);
    /* Largest: one of the two track edges is kept whole. */
    expect(rect.width === track.width || rect.height === track.height).toBe(true);
  });

  it("gives a 640 by 480 webcam track a 360 by 480 frame", () => {
    expect(masterRectFor({ width: 640, height: 480 })).toEqual({
      x: 140,
      y: 0,
      width: 360,
      height: 480,
    });
  });

  it("keeps the e2e flat camera's 360 by 480 portrait track whole", () => {
    // e2e/support/flat-camera.ts: the draw then lifts it to 480 by 640.
    expect(masterRectFor({ width: 360, height: 480 })).toEqual({
      x: 0,
      y: 0,
      width: 360,
      height: 480,
    });
  });

  it("refuses a track with no size, because there is nothing to draw", () => {
    expect(() => masterRectFor({ width: 0, height: 1920 })).toThrow();
    expect(() => masterRectFor({ width: Number.NaN, height: 1920 })).toThrow();
  });
});

describe("the oval", () => {
  const MASTER = { width: 1080, height: 1440 };

  it("sits at 0.70 of the width, 1.35 times as tall, centred at (0.50, 0.47)", () => {
    const oval = ovalBoxIn(MASTER);
    expect(oval.width).toBeCloseTo(756, 6);
    expect(oval.height).toBeCloseTo(756 * FRAME_OVAL_HEIGHT_RATIO, 6);
    expect(oval.x + oval.width / 2).toBeCloseTo(540, 6);
    expect(oval.y + oval.height / 2).toBeCloseTo(1440 * FRAME_FACE_CENTER_Y, 6);
  });

  it("is drawn on the stage at the same pixels it is measured at", () => {
    const style = ovalStageStyle();
    const oval = ovalBoxIn(MASTER);
    expect((style.leftPercent / 100) * MASTER.width).toBeCloseTo(oval.x, 6);
    expect((style.topPercent / 100) * MASTER.height).toBeCloseTo(oval.y, 6);
    expect((style.widthPercent / 100) * MASTER.width).toBeCloseTo(oval.width, 6);
    expect((style.heightPercent / 100) * MASTER.height).toBeCloseTo(oval.height, 6);
  });

  it("fits inside the master frame with the top margin to spare", () => {
    const oval = ovalBoxIn(MASTER);
    expect(ovalTouchesEdge(oval, MASTER)).toBe(false);
    expect(oval.y).toBeGreaterThan(MASTER.height * FRAME_OVAL_EDGE_MARGIN_TOP);
  });
});

describe("masterCropFor", () => {
  const SOURCES: readonly Size[] = [
    { width: 1080, height: 1440 },
    { width: 1080, height: 1920 },
    { width: 1920, height: 1080 },
    { width: 1000, height: 1000 },
    { width: 3024, height: 4032 },
  ];
  const WIDTH_SHARES = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  function faceAt(source: Size, share: number, where: "centre" | "corner"): Box {
    const width = source.width * share;
    const height = Math.min(width * FRAME_OVAL_HEIGHT_RATIO, source.height);
    if (where === "centre") {
      return {
        x: (source.width - width) / 2,
        y: (source.height - height) / 2,
        width,
        height,
      };
    }
    return { x: 0, y: 0, width, height };
  }

  function cases(): Array<{ source: Size; face: Box; label: string }> {
    const out: Array<{ source: Size; face: Box; label: string }> = [];
    for (const source of SOURCES) {
      for (const share of WIDTH_SHARES) {
        for (const where of ["centre", "corner"] as const) {
          out.push({
            source,
            face: faceAt(source, share, where),
            label: `${source.width}x${source.height} face ${share} at the ${where}`,
          });
        }
      }
    }
    return out;
  }

  it.each(cases().map((entry) => [entry.label, entry]))(
    "composes the master geometry for %s",
    (_label, { source, face }) => {
      const crop = masterCropFor(face, source);
      expect(crop).not.toBeNull();
      if (crop === null) {
        return;
      }

      expect(isWhole(crop)).toBe(true);
      expect(isInside(crop, source)).toBe(true);

      /* Never narrower than the face, whatever else had to give. */
      expect(crop.width).toBeGreaterThanOrEqual(Math.floor(face.width));

      /*
       * 3:4 wherever the source can hold a 3:4 box as wide as the face. When it
       * cannot, the face's width wins and the crop takes the source's height.
       */
      const sourceHolds34 = face.width / MASTER_ASPECT <= source.height;
      if (sourceHolds34) {
        expectPortrait34(crop);
      } else {
        expect(crop.height).toBe(source.height);
      }

      /* The face fills 0.70 of the crop unless the source clamped the crop. */
      const wanted = face.width / FRAME_OVAL_WIDTH;
      const clampedBySource =
        wanted > source.width || wanted / MASTER_ASPECT > source.height;
      if (!clampedBySource) {
        expect(face.width / crop.width).toBeCloseTo(FRAME_OVAL_WIDTH, 2);
      }

      /* The face centre lands at (0.50, 0.47) of the crop unless it was slid. */
      const faceCenterX = face.x + face.width / 2;
      const faceCenterY = face.y + face.height / 2;
      const slidX = crop.x === 0 || crop.x + crop.width === source.width;
      const slidY = crop.y === 0 || crop.y + crop.height === source.height;
      if (!slidX) {
        expect(Math.abs(crop.x + crop.width * FRAME_FACE_CENTER_X - faceCenterX)).toBeLessThanOrEqual(1);
      }
      if (!slidY) {
        expect(Math.abs(crop.y + crop.height * FRAME_FACE_CENTER_Y - faceCenterY)).toBeLessThanOrEqual(1);
      }
    },
  );

  it("puts a phone gallery face at the oval on the phone's own frame", () => {
    /* A face at 0.35 of a 3024 by 4032 photo, centred: the crop is exactly half the width. */
    const source = { width: 3024, height: 4032 };
    const face = { x: 983, y: 1500, width: 1058.4, height: 1428.84 };
    const crop = masterCropFor(face, source);
    expect(crop).toEqual({ x: 756, y: 1267, width: 1512, height: 2016 });
  });

  it("slides rather than shrinks when the face sits in a corner", () => {
    const source = { width: 1080, height: 1440 };
    const face = { x: 0, y: 0, width: 540, height: 729 };
    const crop = masterCropFor(face, source);
    expect(crop).toEqual({ x: 0, y: 0, width: 772, height: 1029 });
  });

  it("answers null only for input it cannot compose around", () => {
    const source = { width: 1080, height: 1440 };
    expect(masterCropFor({ x: 0, y: 0, width: 0, height: 100 }, source)).toBeNull();
    expect(masterCropFor({ x: 0, y: 0, width: 100, height: -1 }, source)).toBeNull();
    expect(masterCropFor({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
    expect(masterCropFor({ x: 0, y: 0, width: 2000, height: 100 }, source)).toBeNull();
    expect(masterCropFor({ x: 0, y: 0, width: Number.NaN, height: 100 }, source)).toBeNull();
  });
});

describe("ovalTouchesEdge", () => {
  const MASTER = { width: 1080, height: 1440 };
  const target = ovalBoxIn(MASTER);

  function moved(dx: number, dy: number): Box {
    return { ...target, x: target.x + dx, y: target.y + dy };
  }

  it("is false for the target oval", () => {
    expect(ovalTouchesEdge(target, MASTER)).toBe(false);
  });

  it("is true inside the side margin and false just outside it", () => {
    const margin = MASTER.width * FRAME_OVAL_EDGE_MARGIN;
    expect(ovalTouchesEdge(moved(-(target.x - margin + 1), 0), MASTER)).toBe(true);
    expect(ovalTouchesEdge(moved(-(target.x - margin - 1), 0), MASTER)).toBe(false);
    const right = MASTER.width - (target.x + target.width);
    expect(ovalTouchesEdge(moved(right - margin + 1, 0), MASTER)).toBe(true);
    expect(ovalTouchesEdge(moved(right - margin - 1, 0), MASTER)).toBe(false);
  });

  it("asks for more room above the oval than below it", () => {
    const top = MASTER.height * FRAME_OVAL_EDGE_MARGIN_TOP;
    const bottom = MASTER.height * FRAME_OVAL_EDGE_MARGIN;
    expect(top).toBeGreaterThan(bottom);

    /* Top edge: an oval 0.05 of the height from the top is inside the 0.08 margin. */
    expect(ovalTouchesEdge(moved(0, -(target.y - MASTER.height * 0.05)), MASTER)).toBe(true);
    expect(ovalTouchesEdge(moved(0, -(target.y - top - 1)), MASTER)).toBe(false);

    /* Bottom edge: the same 0.05 of the height is outside the 0.03 margin. */
    const below = MASTER.height - (target.y + target.height);
    expect(ovalTouchesEdge(moved(0, below - MASTER.height * 0.05), MASTER)).toBe(false);
    expect(ovalTouchesEdge(moved(0, below - bottom + 1), MASTER)).toBe(true);
  });
});

describe("reframeBoxFor", () => {
  const FRAMES: readonly Size[] = [
    { width: 1080, height: 1440 },
    { width: 810, height: 1080 },
    { width: 360, height: 480 },
    { width: 1512, height: 2016 },
    { width: 1080, height: 1920 },
  ];

  it.each(FRAMES.map((frame) => [`${frame.width}x${frame.height}`, frame]))(
    "keeps 0.76 of a %s frame as a 3:4 box that contains the target oval",
    (_label, frame) => {
      const box = reframeBoxFor(frame);
      expect(isWhole(box)).toBe(true);
      expect(isInside(box, frame)).toBe(true);
      expectPortrait34(box);
      expect(contains(box, ovalBoxIn(frame))).toBe(true);
      expect(box.width).toBeLessThanOrEqual(frame.width * REFRAME_KEEP_FRACTION);
      expect(box.height).toBeLessThanOrEqual(frame.height * REFRAME_KEEP_FRACTION + 1);
    },
  );

  it("follows a face centre and still holds an oval sized face around it", () => {
    const frame = { width: 1080, height: 1440 };
    const target = ovalBoxIn(frame);
    for (const center of [
      { x: 540, y: 676.8 },
      { x: 420, y: 560 },
      { x: 700, y: 800 },
      { x: 60, y: 60 },
      { x: 1060, y: 1400 },
    ]) {
      const box = reframeBoxFor(frame, center);
      expect(isWhole(box)).toBe(true);
      expect(isInside(box, frame)).toBe(true);
      expectPortrait34(box);
      /*
       * A face of the oval's size centred here fits in the box wherever that
       * face fits in the frame. Near an edge the box slides and the face would
       * have been out of bounds anyway.
       */
      const face: Box = {
        x: center.x - target.width / 2,
        y: center.y - target.height / 2,
        width: target.width,
        height: target.height,
      };
      if (isInside(face, frame)) {
        expect(contains(box, face)).toBe(true);
      }
    }
  });

  it("uses the frame's target centre when no face centre is given", () => {
    const frame = { width: 1080, height: 1440 };
    const box = reframeBoxFor(frame);
    expect(box.x + box.width / 2).toBeCloseTo(frame.width * FRAME_FACE_CENTER_X, 0);
    expect(box.y + box.height / 2).toBeCloseTo(frame.height * FRAME_FACE_CENTER_Y, 0);
  });
});
