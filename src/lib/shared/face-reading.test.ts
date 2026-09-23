import { describe, expect, it } from "vitest";

import { syntheticFace } from "../../../evals/support/synthetic-face";
import {
  CHEEK_LEFT,
  CHEEK_RIGHT,
  CHIN,
  FACE_OVAL_LANDMARKS,
  FOREHEAD,
  LEFT_EYE_LANDMARKS,
  RIGHT_EYE_LANDMARKS,
  evenness,
  facePixelsIn,
  faceReadingFrom,
  meanLumaInside,
} from "./face-reading";
import {
  FRAME_FACE_CENTER_X,
  FRAME_FACE_CENTER_Y,
  FRAME_OVAL_WIDTH,
  ovalBoxIn,
} from "./frame-geometry";
import type { GrayscaleImage } from "./quality";

/**
 * The reading is what the gate will measure, in the engine's terms: cheek to
 * cheek over the frame width, the oval's box and centre, a solved pose, the
 * eyes. Proven here on a synthetic landmarker result whose numbers are known
 * before they are read.
 */

describe("the landmark index tables", () => {
  it("name the MediaPipe face oval, 36 points from the forehead round to it again", () => {
    expect(FACE_OVAL_LANDMARKS).toHaveLength(36);
    expect(FACE_OVAL_LANDMARKS[0]).toBe(FOREHEAD);
    expect(FACE_OVAL_LANDMARKS).toContain(CHIN);
    expect(FACE_OVAL_LANDMARKS).toContain(CHEEK_LEFT);
    expect(FACE_OVAL_LANDMARKS).toContain(CHEEK_RIGHT);
    expect(new Set(FACE_OVAL_LANDMARKS).size).toBe(36);
  });

  it("name the two 16 point eye contours without sharing a point", () => {
    expect(LEFT_EYE_LANDMARKS).toHaveLength(16);
    expect(RIGHT_EYE_LANDMARKS).toHaveLength(16);
    const shared = LEFT_EYE_LANDMARKS.filter((index) =>
      RIGHT_EYE_LANDMARKS.includes(index),
    );
    expect(shared).toEqual([]);
  });
});

describe("faceReadingFrom", () => {
  it("reads a face filling the oval as 0.70 wide, centred at (0.50, 0.47), square, eyes open", () => {
    const face = syntheticFace();
    const reading = faceReadingFrom(face);
    expect(reading).not.toBeNull();
    if (reading === null) {
      return;
    }
    expect(reading.widthRatio).toBeCloseTo(FRAME_OVAL_WIDTH, 6);
    expect(reading.bboxRatio).toBeCloseTo(FRAME_OVAL_WIDTH, 6);
    expect(reading.center.x).toBeCloseTo(FRAME_FACE_CENTER_X, 6);
    expect(reading.center.y).toBeCloseTo(FRAME_FACE_CENTER_Y, 6);
    expect(reading.pose).not.toBeNull();
    expect(reading.pose?.yawDegrees ?? 99).toBeCloseTo(0, 6);
    expect(reading.pose?.pitchDegrees ?? 99).toBeCloseTo(0, 6);
    expect(reading.pose?.rollDegrees ?? 99).toBeCloseTo(0, 6);
    expect(reading.blink).toEqual({ left: 0, right: 0 });
    expect(reading.jawOpen).toBe(0);
  });

  it("lands the oval box on the frame's target oval, to the pixel", () => {
    const face = syntheticFace();
    const reading = faceReadingFrom(face, face.frame);
    const target = ovalBoxIn(face.frame);
    expect(reading?.pixels).not.toBeNull();
    const box = reading?.ovalBox;
    expect((box?.x ?? 0) * face.frame.width).toBeCloseTo(target.x, 6);
    expect((box?.y ?? 0) * face.frame.height).toBeCloseTo(target.y, 6);
    expect((box?.width ?? 0) * face.frame.width).toBeCloseTo(target.width, 6);
    expect((box?.height ?? 0) * face.frame.height).toBeCloseTo(target.height, 6);
  });

  it("reads a turned head as signed yaw, a lifted chin as positive pitch, a tipped head as signed roll", () => {
    const turned = faceReadingFrom(syntheticFace({ yaw: 20 }));
    expect(turned?.pose?.yawDegrees ?? 0).toBeCloseTo(20, 4);
    expect(turned?.pose?.pitchDegrees ?? 99).toBeCloseTo(0, 4);
    expect(turned?.pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);

    const turnedTheOtherWay = faceReadingFrom(syntheticFace({ yaw: -12 }));
    expect(turnedTheOtherWay?.pose?.yawDegrees ?? 0).toBeCloseTo(-12, 4);

    const lifted = faceReadingFrom(syntheticFace({ pitch: 8 }));
    expect(lifted?.pose?.pitchDegrees ?? 0).toBeCloseTo(8, 4);

    const tipped = faceReadingFrom(syntheticFace({ roll: -9 }));
    expect(tipped?.pose?.rollDegrees ?? 0).toBeCloseTo(-9, 4);
  });

  it("reads a combined turn exactly on every axis", () => {
    /*
     * The decoder is exact for the Rz(roll) Rx(pitch) Ry(yaw) product the
     * synthetic matrix is built from, since 2026-09-23: until then roll was
     * read off the wrong pair of elements and a combined turn carried a
     * spurious roll that grew with yaw times pitch.
     */
    const reading = faceReadingFrom(syntheticFace({ yaw: 6, pitch: -5, roll: 4 }));
    expect(reading?.pose?.yawDegrees ?? 0).toBeCloseTo(6, 4);
    expect(reading?.pose?.pitchDegrees ?? 0).toBeCloseTo(-5, 4);
    expect(reading?.pose?.rollDegrees ?? 0).toBeCloseTo(4, 4);

    const turnedAndDown = faceReadingFrom(syntheticFace({ yaw: 15, pitch: -20 }));
    expect(turnedAndDown?.pose?.rollDegrees ?? 99).toBeCloseTo(0, 4);
  });

  it("puts the oval box, polygon and eye boxes onto any frame's pixels", () => {
    const face = syntheticFace();
    const reading = faceReadingFrom(face);
    expect(reading).not.toBeNull();
    if (reading === null) {
      return;
    }
    const frame = { width: 300, height: 400 };
    const pixels = facePixelsIn(reading, frame);
    expect(pixels.ovalBox.width).toBeCloseTo(FRAME_OVAL_WIDTH * frame.width, 6);
    expect(pixels.ovalPolygon).toHaveLength(36);
    expect(pixels.eyeBoxes.left.x).toBeGreaterThan(pixels.eyeBoxes.right.x);
    const target = ovalBoxIn(frame);
    expect(pixels.ovalBox.x).toBeCloseTo(target.x, 6);
    expect(pixels.ovalBox.y).toBeCloseTo(target.y, 6);
  });

  it("reads a face away from the target at its own width and centre", () => {
    const face = syntheticFace({ widthRatio: 0.5, center: { x: 0.3, y: 0.6 } });
    const reading = faceReadingFrom(face);
    expect(reading?.widthRatio ?? 0).toBeCloseTo(0.5, 6);
    expect(reading?.center.x ?? 0).toBeCloseTo(0.3, 6);
    expect(reading?.center.y ?? 0).toBeCloseTo(0.6, 6);
  });

  it("reads the blink and jaw blendshapes, from a Map or a record", () => {
    const face = syntheticFace({ blink: { left: 0.9, right: 0.1 }, jawOpen: 0.3 });
    const fromMap = faceReadingFrom(face);
    expect(fromMap?.blink).toEqual({ left: 0.9, right: 0.1 });
    expect(fromMap?.jawOpen).toBe(0.3);

    const fromRecord = faceReadingFrom({
      ...face,
      blendshapes: Object.fromEntries(face.blendshapes),
    });
    expect(fromRecord?.blink).toEqual({ left: 0.9, right: 0.1 });
  });

  it("leaves pose, blink and jaw null when the landmarker did not give them", () => {
    const face = syntheticFace();
    const reading = faceReadingFrom({
      landmarks: face.landmarks,
      matrix: null,
      blendshapes: null,
    });
    expect(reading?.pose).toBeNull();
    expect(reading?.blink).toBeNull();
    expect(reading?.jawOpen).toBeNull();
    expect(reading?.widthRatio ?? 0).toBeCloseTo(FRAME_OVAL_WIDTH, 6);
  });

  it("keeps the person's left eye on the image's right, in an un mirrored frame", () => {
    const reading = faceReadingFrom(syntheticFace());
    expect(reading?.eyeBoxes.left.x ?? 0).toBeGreaterThan(
      reading?.eyeBoxes.right.x ?? 1,
    );
    expect(reading?.eyeBoxes.left.width ?? 0).toBeGreaterThan(0);
    expect(reading?.eyeBoxes.right.height ?? 0).toBeGreaterThan(0);
  });

  it("refuses a landmark list too short to carry the points it reads", () => {
    const face = syntheticFace();
    expect(
      faceReadingFrom({ ...face, landmarks: face.landmarks.slice(0, 400) }),
    ).toBeNull();
    expect(faceReadingFrom({ ...face, landmarks: [] })).toBeNull();
  });

  it("carries the oval polygon and the eye boxes in pixels when given a frame", () => {
    const face = syntheticFace();
    const reading = faceReadingFrom(face, face.frame);
    expect(reading?.pixels?.ovalPolygon).toHaveLength(36);
    const cheekRight = reading?.pixels?.ovalPolygon[FACE_OVAL_LANDMARKS.indexOf(CHEEK_RIGHT)];
    expect(cheekRight?.x ?? 0).toBeCloseTo(
      face.frame.width * (FRAME_FACE_CENTER_X + FRAME_OVAL_WIDTH / 2),
      6,
    );
    expect(faceReadingFrom(face)?.pixels).toBeNull();
  });
});

/** An image whose left half is black and right half is white. */
function halfDark(width: number, height: number): GrayscaleImage {
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = x < width / 2 ? 0 : 255;
    }
  }
  return { data, width, height };
}

describe("meanLumaInside", () => {
  const image = halfDark(100, 80);

  it("reads a polygon over the whole picture as half lit", () => {
    const whole = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ];
    expect(meanLumaInside(image, whole)).toBeCloseTo(0.5, 6);
  });

  it("reads a polygon on the dark side as 0 and on the lit side as 1", () => {
    const dark = [
      { x: 5, y: 5 },
      { x: 45, y: 5 },
      { x: 45, y: 75 },
      { x: 5, y: 75 },
    ];
    const lit = [
      { x: 55, y: 5 },
      { x: 95, y: 5 },
      { x: 95, y: 75 },
      { x: 55, y: 75 },
    ];
    expect(meanLumaInside(image, dark)).toBe(0);
    expect(meanLumaInside(image, lit)).toBe(1);
  });

  it("fills an oval rather than its bounding box", () => {
    /*
     * An ellipse centred on the seam covers equal areas of both halves, so it
     * reads 0.5 too; a triangle leaning into the lit half reads above it.
     */
    const ellipse: Array<{ x: number; y: number }> = [];
    for (let step = 0; step < 64; step += 1) {
      const angle = (step / 64) * 2 * Math.PI;
      ellipse.push({ x: 50 + 30 * Math.cos(angle), y: 40 + 20 * Math.sin(angle) });
    }
    expect(meanLumaInside(image, ellipse)).toBeCloseTo(0.5, 1);

    const triangle = [
      { x: 40, y: 10 },
      { x: 95, y: 10 },
      { x: 95, y: 70 },
    ];
    expect(meanLumaInside(image, triangle)).toBeGreaterThan(0.9);
  });

  it("answers 0 for an empty or degenerate polygon", () => {
    expect(meanLumaInside(image, [])).toBe(0);
    expect(meanLumaInside(image, [{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(0);
    expect(
      meanLumaInside(image, [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 30, y: 10 },
      ]),
    ).toBe(0);
  });

  it("ignores the part of a polygon outside the picture", () => {
    const beyond = [
      { x: -50, y: -50 },
      { x: 50, y: -50 },
      { x: 50, y: 200 },
      { x: -50, y: 200 },
    ];
    expect(meanLumaInside(image, beyond)).toBe(0);
  });
});

describe("evenness", () => {
  const image = halfDark(100, 80);

  it("reads one eye in the dark and one in the light as fully uneven", () => {
    const left = { x: 60, y: 30, width: 20, height: 10 };
    const right = { x: 20, y: 30, width: 20, height: 10 };
    expect(evenness(image, left, right)).toBeCloseTo(1, 6);
  });

  it("reads two eyes in the same light as even", () => {
    const left = { x: 70, y: 30, width: 20, height: 10 };
    const right = { x: 55, y: 30, width: 10, height: 10 };
    expect(evenness(image, left, right)).toBe(0);
  });
});
