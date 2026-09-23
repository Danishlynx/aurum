import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { syntheticFace } from "../../../evals/support/synthetic-face";
import {
  FACE_LANDMARKER_MODEL_LOCAL_PATH,
  FACE_LANDMARKER_MODEL_SHA256,
  FACE_LANDMARKER_MODEL_URL,
  MEDIAPIPE_WASM_CDN_URL,
  MEDIAPIPE_WASM_FILES,
  MEDIAPIPE_WASM_LOCAL_PATH,
} from "@/lib/shared/face-model";
import { FRAME_OVAL_WIDTH } from "@/lib/shared/frame-geometry";

import { MEDIAPIPE_VERSION, readingsFromLandmarkerResult } from "./landmarks";
import { injectedLandmarker } from "./landmarks-seam";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

/**
 * The face landmarker, and where it comes from.
 *
 * Nothing here loads the model or touches the network: vitest.setup.ts takes
 * fetch away from every suite on purpose. What is testable without a browser is
 * the version pin, the model pin, the fallback URLs, the conversion of a
 * landmarker result into a reading, and the e2e seam being off, and every one
 * of those would fail silently in production if it were wrong, which is exactly
 * why they are worth a test.
 */

describe("the pinned MediaPipe version", () => {
  /**
   * The JS loader is imported from node_modules and the WASM runtime it loads is
   * copied out of the same package, or fetched from a URL built out of
   * MEDIAPIPE_VERSION. If those two are not the same version the landmarker
   * fails to initialise, and landmarks.ts is written to fall back quietly when
   * initialisation fails, so a skew here would show up as "the landmarker never
   * works on any device" with no error anywhere.
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

  it("carries the version in the fallback runtime URL", () => {
    expect(MEDIAPIPE_WASM_CDN_URL).toContain(MEDIAPIPE_VERSION);
    expect(MEDIAPIPE_WASM_CDN_URL.startsWith("https://")).toBe(true);
  });

  it("pins the fallback model to a version rather than to a floating path", () => {
    // A model URL without a version in it would change what the capture screen
    // measures without any commit saying so.
    expect(FACE_LANDMARKER_MODEL_URL).toMatch(/\/\d+\/[^/]+\.task$/u);
    expect(FACE_LANDMARKER_MODEL_URL.startsWith("https://")).toBe(true);
  });

  it("pins the model bytes to a sha256", () => {
    expect(FACE_LANDMARKER_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("names the six runtime files and root relative local paths", () => {
    expect(MEDIAPIPE_WASM_FILES).toHaveLength(6);
    expect(new Set(MEDIAPIPE_WASM_FILES).size).toBe(6);
    expect(MEDIAPIPE_WASM_LOCAL_PATH.startsWith("/")).toBe(true);
    expect(FACE_LANDMARKER_MODEL_LOCAL_PATH.startsWith("/")).toBe(true);
    expect(FACE_LANDMARKER_MODEL_LOCAL_PATH.endsWith(".task")).toBe(true);
  });
});

describe("readingsFromLandmarkerResult", () => {
  /** A landmarker result shaped as tasks-vision returns it, from a synthetic face. */
  function resultFor(...faces: ReturnType<typeof syntheticFace>[]) {
    return {
      faceLandmarks: faces.map((face) => face.landmarks.map((point) => ({ ...point }))),
      facialTransformationMatrixes: faces.map((face) => ({
        rows: 4,
        columns: 4,
        data: [...face.matrix],
      })),
      faceBlendshapes: faces.map((face) => ({
        headIndex: 0,
        categories: [...face.blendshapes].map(([categoryName, score], index) => ({
          categoryName,
          score,
          index,
          displayName: "",
        })),
      })),
    };
  }

  it("converts each face through faceReadingFrom, matrix and blendshapes included", () => {
    const frame = { width: 480, height: 640 };
    const faces = readingsFromLandmarkerResult(
      resultFor(syntheticFace({ yaw: 12, blink: { left: 0.8, right: 0.1 } })),
      frame,
    );
    expect(faces).toHaveLength(1);
    const [face] = faces;
    expect(face?.widthRatio ?? 0).toBeCloseTo(FRAME_OVAL_WIDTH, 6);
    expect(face?.pose?.yawDegrees ?? 0).toBeCloseTo(12, 4);
    expect(face?.blink).toEqual({ left: 0.8, right: 0.1 });
    // The polygon is put onto the frame the landmarker saw.
    expect(face?.pixels?.frame).toEqual(frame);
  });

  it("keeps every face and leaves the matrix and the eyes null when absent", () => {
    const two = resultFor(syntheticFace(), syntheticFace({ widthRatio: 0.4 }));
    const faces = readingsFromLandmarkerResult(
      { faceLandmarks: two.faceLandmarks },
      { width: 100, height: 100 },
    );
    expect(faces).toHaveLength(2);
    expect(faces[1]?.widthRatio ?? 0).toBeCloseTo(0.4, 6);
    expect(faces[0]?.pose).toBeNull();
    expect(faces[0]?.blink).toBeNull();
  });

  it("drops a face whose landmark list is too short, and answers none for an empty result", () => {
    const short = resultFor(syntheticFace());
    expect(
      readingsFromLandmarkerResult(
        { ...short, faceLandmarks: [short.faceLandmarks[0]?.slice(0, 100) ?? []] },
        { width: 100, height: 100 },
      ),
    ).toEqual([]);
    expect(readingsFromLandmarkerResult({}, { width: 100, height: 100 })).toEqual([]);
  });
});

describe("the e2e seam", () => {
  /**
   * NEXT_PUBLIC_AURUM_E2E_SEAMS is set by playwright.config.ts for the fixture
   * server and nowhere else. With it unset, which is every build that is not
   * that server, the seam answers nothing whatever a page put on the window.
   */
  it("answers null with the environment variable unset", () => {
    expect(process.env.NEXT_PUBLIC_AURUM_E2E_SEAMS).not.toBe("true");
    expect(injectedLandmarker()).toBeNull();
  });
});
