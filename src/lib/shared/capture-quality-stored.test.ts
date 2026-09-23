import { describe, expect, it } from "vitest";

import {
  STORED_QUALITY_CALIBRATION_KEYS,
  STORED_QUALITY_ORIGINAL_KEYS,
  storedCaptureQualityFrom,
} from "./capture-quality-stored";
import { captureQualitySchema, type CaptureQuality } from "./schemas";

/**
 * The defect this pins: the captures route validated pose, faceWidthRatio and
 * faceSource and then wrote a row without them. A field the schema accepts and
 * the writer drops is a measurement nobody will ever see, so every key the
 * schema declares has to come out the other side.
 */

const MINIMAL: CaptureQuality = {
  verdict: "accept",
  reason: null,
  sharpness: 12.5,
  blownFraction: 0.01,
  crushedFraction: 0.02,
  meanLuminance: 128,
  faceCoverage: 0.66,
};

const FULL: CaptureQuality = {
  ...MINIMAL,
  faceWidthRatio: 0.71,
  pose: { yawDegrees: -3, pitchDegrees: 2, rollDegrees: 1 },
  faceSource: "model",
  measured: true,
  platform: "ios",
  path: "camera",
  attempt: 1,
  frame: { sourceWidth: 1080, sourceHeight: 1920, masterWidth: 1080, masterHeight: 1440 },
  faceBboxRatio: 0.31,
  faceCenter: { x: 0.5, y: 0.47 },
  faceLuma: 0.58,
  faceLumaUneven: 0.05,
  blink: { left: 0.1, right: 0.12 },
  burstLosers: [
    {
      yaw: 4,
      pitch: 1,
      roll: 0,
      faceWidthRatio: 0.69,
      faceLuma: 0.57,
      blinkMax: 0.6,
      sharpness: 9,
      score: 3.2,
    },
  ],
  landmarkerMs: 41,
  frameGeometryVersion: 1,
};

describe("storedCaptureQualityFrom", () => {
  it("writes the eight original keys for a row from before the change", () => {
    const stored = storedCaptureQualityFrom(MINIMAL);
    expect(Object.keys(stored).sort()).toEqual(
      [...STORED_QUALITY_ORIGINAL_KEYS].sort(),
    );
    expect(stored.exposure).toBe(128);
    expect(stored.mean_luminance).toBe(128);
    expect(stored.face_coverage).toBe(0.66);
  });

  it("writes every validated field, snake cased, when the client sends them", () => {
    const stored = storedCaptureQualityFrom(FULL);
    expect(Object.keys(stored).sort()).toEqual(
      [...STORED_QUALITY_ORIGINAL_KEYS, ...STORED_QUALITY_CALIBRATION_KEYS].sort(),
    );
    expect(stored.pose).toEqual({
      yaw_degrees: -3,
      pitch_degrees: 2,
      roll_degrees: 1,
    });
    expect(stored.face_width_ratio).toBe(0.71);
    expect(stored.face_source).toBe("model");
    expect(stored.frame).toEqual({
      source_width: 1080,
      source_height: 1920,
      master_width: 1080,
      master_height: 1440,
    });
    expect(stored.burst_losers).toEqual([
      {
        yaw: 4,
        pitch: 1,
        roll: 0,
        face_width_ratio: 0.69,
        face_luma: 0.57,
        blink_max: 0.6,
        sharpness: 9,
        score: 3.2,
      },
    ]);
    expect(stored.frame_geometry_version).toBe(1);
  });

  it("covers every key the schema declares, so a new field cannot be dropped", () => {
    /*
     * The schema is the list of what the client may send. Each camel case key
     * there has to map onto exactly one stored key; a key added to the schema
     * without a line in the writer fails here rather than silently vanishing
     * from every row.
     */
    const schemaKeys = Object.keys(captureQualitySchema.shape);
    const stored = storedCaptureQualityFrom(FULL);
    const storedKeys = new Set(Object.keys(stored));
    const toSnake = (key: string) =>
      key.replace(/[A-Z]/gu, (upper) => `_${upper.toLowerCase()}`);
    for (const key of schemaKeys) {
      if (key === "meanLuminance") {
        expect(storedKeys.has("mean_luminance")).toBe(true);
        expect(storedKeys.has("exposure")).toBe(true);
        continue;
      }
      expect(storedKeys.has(toSnake(key)), `schema key ${key} is not stored`).toBe(
        true,
      );
    }
  });

  it("keeps a measured null apart from a field that was never sent", () => {
    const stored = storedCaptureQualityFrom({ ...MINIMAL, pose: null, blink: null });
    expect(stored).toHaveProperty("pose", null);
    expect(stored).toHaveProperty("blink", null);
    expect(stored).not.toHaveProperty("face_luma");
  });

  it("survives a JSON round trip unchanged", () => {
    const stored = storedCaptureQualityFrom(FULL);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });

  it("still parses a row shape from before the change", () => {
    expect(captureQualitySchema.safeParse(MINIMAL).success).toBe(true);
  });
});
