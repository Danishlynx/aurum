import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  FACE_DETECTOR_MODEL_URL,
  MEDIAPIPE_VERSION,
  MEDIAPIPE_WASM_URL,
  poseFromDetectorKeypoints,
} from "./landmarks";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The face detector that replaced the colour threshold.
 *
 * Nothing here loads the model or touches the network: vitest.setup.ts takes
 * fetch away from every suite on purpose. What is testable without a browser is
 * the version pin and the keypoint geometry, and both of them are things that
 * would fail silently in production if they were wrong, which is exactly why
 * they are worth a test.
 */

describe("the pinned MediaPipe version", () => {
  /**
   * The JS loader is imported from node_modules and the WASM runtime it loads is
   * fetched from a URL built out of MEDIAPIPE_VERSION. If those two are not the
   * same version the detector fails to initialise, and landmarks.ts is written to
   * fall back quietly when initialisation fails, so a skew here would show up as
   * "the detector never works on any device" with no error anywhere.
   */
  it("matches the installed @mediapipe/tasks-vision", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const declared = manifest.dependencies?.["@mediapipe/tasks-vision"];
    expect(declared).toBeDefined();
    // Strip a caret or tilde: the pin has to match the range's base version.
    expect((declared ?? "").replace(/^[\^~]/u, "")).toBe(MEDIAPIPE_VERSION);
  });

  it("carries the version in the runtime URL", () => {
    expect(MEDIAPIPE_WASM_URL).toContain(MEDIAPIPE_VERSION);
  });

  it("pins the model to a version rather than to a floating path", () => {
    // A model URL without a version in it would change what the capture screen
    // measures without any commit saying so.
    expect(FACE_DETECTOR_MODEL_URL).toMatch(/\/\d+\//u);
    expect(FACE_DETECTOR_MODEL_URL.startsWith("https://")).toBe(true);
  });
});

describe("poseFromDetectorKeypoints", () => {
  /** Normalized keypoints for a face looking straight into a square frame. */
  const FRONTAL = [
    { x: 0.4, y: 0.42 },
    { x: 0.6, y: 0.42 },
    { x: 0.5, y: 0.53 },
    { x: 0.5, y: 0.62 },
  ];

  it("reads a frontal face as square to the lens", () => {
    const pose = poseFromDetectorKeypoints(FRONTAL, 400, 400);
    expect(pose).not.toBeNull();
    expect(Math.abs(pose?.rollDegrees ?? 99)).toBeLessThan(1);
    expect(Math.abs(pose?.yawDegrees ?? 99)).toBeLessThan(1);
  });

  /**
   * BlazeFace reports the eyes in a fixed order where "right" is the subject's
   * right and therefore the image's left. Rather than trust that convention,
   * landmarks.ts sorts the two eye points by x. A build of the model that swapped
   * them would otherwise produce a roll of the correct size and the wrong sign,
   * which would tell every person to tilt their phone the wrong way.
   */
  it("gives the same answer whichever order the eyes arrive in", () => {
    const tilted = [
      { x: 0.4, y: 0.38 },
      { x: 0.6, y: 0.46 },
      { x: 0.5, y: 0.53 },
      { x: 0.5, y: 0.62 },
    ];
    const swapped = [tilted[1], tilted[0], tilted[2], tilted[3]] as typeof tilted;
    const a = poseFromDetectorKeypoints(tilted, 400, 400);
    const b = poseFromDetectorKeypoints(swapped, 400, 400);
    expect(a?.rollDegrees ?? 0).toBeCloseTo(b?.rollDegrees ?? 99, 10);
    expect(a?.rollDegrees ?? 0).toBeGreaterThan(0);
  });

  it("scales normalized points by the frame, so aspect ratio does not skew an angle", () => {
    // The same face in a portrait frame reads the same roll as in a square one
    // only if the normalized coordinates are multiplied back into pixels.
    const tilted = [
      { x: 0.4, y: 0.4 },
      { x: 0.6, y: 0.5 },
      { x: 0.5, y: 0.56 },
      { x: 0.5, y: 0.66 },
    ];
    const square = poseFromDetectorKeypoints(tilted, 400, 400);
    const portrait = poseFromDetectorKeypoints(tilted, 400, 800);
    expect(square?.rollDegrees ?? 0).not.toBeCloseTo(
      portrait?.rollDegrees ?? 0,
      1,
    );
    // Both are real answers; neither is null and neither is nonsense.
    expect(Number.isFinite(square?.rollDegrees ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(portrait?.rollDegrees ?? Number.NaN)).toBe(true);
  });

  it("answers null rather than guessing when keypoints are missing or unusable", () => {
    expect(poseFromDetectorKeypoints(undefined, 400, 400)).toBeNull();
    expect(poseFromDetectorKeypoints([{ x: 0.5, y: 0.5 }], 400, 400)).toBeNull();
    expect(
      poseFromDetectorKeypoints(
        [{ x: 0.4, y: 0.4 }, { x: Number.NaN, y: 0.4 }, ...FRONTAL.slice(2)],
        400,
        400,
      ),
    ).toBeNull();
  });
});
