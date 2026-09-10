/**
 * A real face detector, in the browser, on the phone the photo is being taken
 * with.
 *
 * What this replaces, and why it had to be replaced. src/lib/client/face.ts
 * asked for window.FaceDetector, the Shape Detection API. Safari has never
 * implemented it, Chrome has never shipped it on by default, and it is behind a
 * flag where it exists at all, so on essentially every phone that constructor is
 * undefined and the app fell through to a YCbCr skin colour threshold. That
 * fallback is what has been deciding, in production, whether a person's face was
 * in the picture and how big it was. Its failures are not subtle and they are not
 * evenly distributed:
 *
 * - the chroma box it thresholds on is the Chai and Ngan range, fitted to light
 *   and medium skin. Deep skin under warm indoor light falls outside it, the
 *   largest region comes back empty, and the gate answers no_face and refuses
 *   the frame outright. On the skin tones docs/00-product.md names as the wedge.
 * - any skin coloured background, which is most wooden and beige rooms, connects
 *   to the face and returns one region covering the frame.
 * - the neck and shoulders connect to the face whenever they are lit, which
 *   inflates the box, which is how a frame passed our own rule and came back
 *   error_src_face_too_small from the engine (2026-09-02).
 * - a bare arm is a second region, which reads as a second face and refuses a
 *   solo selfie with "Only your face can be read".
 *
 * What it is replaced with. MediaPipe's short range face detector, which is a
 * real model: a face box and six keypoints (both eyes, the nose tip, the mouth
 * centre, and both ear tragions). The keypoints are what let
 * src/lib/shared/pose.ts estimate yaw, pitch and roll, which is the measurement
 * the gate never had and which every refusal read off the wire has been about.
 *
 * Why the detector and not the landmarker. FaceLandmarker returns a 4 by 4
 * transformation matrix, so it can give an exact head pose rather than an
 * estimate, and pose.ts has the decoder for one. It also carries a 3.7MB model
 * against this one's 230KB, on top of a WASM runtime that is already the largest
 * thing the capture screen loads. The gate is asking a coarse question (is this
 * head within twenty or thirty degrees of square) and POSE_SLACK_DEGREES exists
 * to absorb exactly the uncertainty this trade introduces. If a future build
 * wants the matrix, poseFromTransformationMatrix is already there and this module
 * is the only thing that has to change.
 *
 * Where the files come from. Both are fetched from jsDelivr and Google's model
 * host at a pinned version rather than committed here: the WASM runtime alone is
 * 11.5MB per variant, and this repository is public and is cloned by judges. The
 * cost of that choice is a network dependency at capture time, and it is paid
 * for by the fallback below rather than by the person: a detector that does not
 * load leaves the app exactly where it was before this file existed.
 *
 * Nothing in this module sends anything anywhere. The model is a download and
 * the inference is local; no frame, no landmark and no measurement leaves the
 * device from here.
 */

import type { Box } from "@/lib/shared/quality";
import { poseFromLandmarks, type FacePose } from "@/lib/shared/pose";

/**
 * Pinned, because an unpinned model or runtime is a silent behaviour change in
 * the one part of the product that decides whether a photograph is usable.
 *
 * This must equal the @mediapipe/tasks-vision version in package.json. The JS
 * loader comes from the installed package and the WASM runtime it loads comes
 * from the URL below, so a version skew between the two is a broken detector on
 * every phone and a working one on none. src/lib/client/landmarks.test.ts reads
 * package.json and fails when they drift, because nothing else would notice: the
 * mismatch shows up as a model that quietly refuses to load, and the app is
 * built to fall back silently when that happens.
 */
export const MEDIAPIPE_VERSION = "1.0.1";
export const MEDIAPIPE_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
export const FACE_DETECTOR_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

/** Long enough that a slow network cannot hold the capture screen hostage. */
export const DETECTOR_LOAD_TIMEOUT_MS = 8_000;

export type DetectedFace = {
  readonly box: Box;
  readonly pose: FacePose | null;
  /** The detector's own confidence, 0 to 1, when it reports one. */
  readonly score: number | null;
};

export type DetectionResult = {
  readonly faces: readonly DetectedFace[];
};

type TasksVision = typeof import("@mediapipe/tasks-vision");

type Detector = {
  detect: (source: HTMLCanvasElement) => {
    detections?: ReadonlyArray<{
      boundingBox?: {
        originX?: number;
        originY?: number;
        width?: number;
        height?: number;
      };
      keypoints?: ReadonlyArray<{ x?: number; y?: number }>;
      categories?: ReadonlyArray<{ score?: number }>;
    }>;
  };
  close?: () => void;
};

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly promise: Promise<Detector | null> }
  | { readonly kind: "ready"; readonly detector: Detector }
  | { readonly kind: "unavailable" };

let state: LoadState = { kind: "idle" };

/**
 * Answers null after ms, without abandoning the work.
 *
 * The distinction is the whole point. The caller cannot wait: the capture screen
 * has to draw a guidance line now, on whatever estimate it can get. The download
 * can wait: it is 11.5MB of WASM runtime, it is already in flight, and on a phone
 * on mobile data it routinely takes longer than any timeout a screen can afford.
 *
 * Until 2026-09-10 a timeout here resolved null and the caller then recorded the
 * detector as permanently unavailable, so one slow load on one phone turned the
 * real detector off for the whole session and every capture after it ran on the
 * colour threshold. That is the failure mode this product was trying to leave
 * behind, reintroduced by its own loading code and completely silent.
 */
function raceWithoutCancelling<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function createDetector(): Promise<Detector | null> {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const vision: TasksVision = await import("@mediapipe/tasks-vision");
    const fileset = await vision.FilesetResolver.forVisionTasks(
      MEDIAPIPE_WASM_URL,
    );
    const detector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: FACE_DETECTOR_MODEL_URL,
        /*
         * GPU where it exists, because this runs on every preview frame. The
         * library falls back to CPU on its own when a device has no usable
         * WebGL context, so this is a preference and not a requirement.
         */
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      /*
       * Deliberately low. A second face in the frame is a refusal
       * (error_multiple_people is a documented provider failure and every face
       * endpoint we call is single face only), so the detector is asked to be
       * generous about noticing one rather than confident about it, and the
       * decision about what to do with two is made in the gate.
       */
      minDetectionConfidence: 0.3,
    });
    return detector as unknown as Detector;
  } catch {
    return null;
  }
}

/**
 * Starts loading the detector without waiting for it.
 *
 * Called from the consent screen so the model is warm by the time the camera
 * opens. The download is a few hundred kilobytes plus the WASM runtime, and
 * paying for it while somebody is reading the consent copy is the difference
 * between a capture screen that can measure a face and one that cannot.
 */
export function warmFaceDetector(): void {
  if (state.kind !== "idle") {
    return;
  }
  void loadFaceDetector();
}

export async function loadFaceDetector(): Promise<Detector | null> {
  if (state.kind === "ready") {
    return state.detector;
  }
  if (state.kind === "unavailable") {
    return null;
  }

  /*
   * One load, however many callers. The preview loop asks several times a second
   * and the gate asks again at the shutter; they all wait on the same download
   * rather than starting their own.
   */
  if (state.kind === "idle") {
    const load = createDetector().then((detector) => {
      /*
       * Only a real failure latches. A load that simply has not finished stays
       * loading, so the next caller waits on the same promise and picks it up the
       * moment it lands. This is what stops one slow network moment from turning
       * the detector off for the rest of the session.
       */
      state =
        detector === null
          ? { kind: "unavailable" }
          : { kind: "ready", detector };
      return detector;
    });
    state = { kind: "loading", promise: load };
  }

  const pending = state.kind === "loading" ? state.promise : null;
  if (pending === null) {
    return null;
  }
  /*
   * The caller gets an answer inside its own budget. The download keeps going
   * either way, which is why this races rather than cancels.
   */
  return raceWithoutCancelling(pending, DETECTOR_LOAD_TIMEOUT_MS);
}

/** True once a real detector is answering, which the gate logs for telemetry. */
export function faceDetectorIsReady(): boolean {
  return state.kind === "ready";
}

/** Test seam. Never called by the app. */
export function resetFaceDetectorForTests(): void {
  state = { kind: "idle" };
}

function finite(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The six keypoints as a pose, or null when they are not all present.
 *
 * BlazeFace reports them in a fixed order (right eye, left eye, nose tip, mouth,
 * right ear tragion, left ear tragion) where "right" is the subject's right and
 * therefore the image's left. Rather than depend on that convention holding, the
 * two eye points are sorted by their x coordinate here, so a build of the model
 * that swapped them would still produce the right roll sign instead of a
 * silently mirrored one.
 */
export function poseFromDetectorKeypoints(
  keypoints: ReadonlyArray<{ x?: number; y?: number }> | undefined,
  frameWidth: number,
  frameHeight: number,
): FacePose | null {
  if (keypoints === undefined || keypoints.length < 4) {
    return null;
  }
  const points = keypoints.slice(0, 4).map((point) => {
    const x = finite(point.x);
    const y = finite(point.y);
    if (x === null || y === null) {
      return null;
    }
    /*
     * The detector reports normalized coordinates. Multiplying back into frame
     * pixels keeps every angle in pose.ts independent of the aspect ratio of
     * whatever the caller happened to hand in.
     */
    return { x: x * frameWidth, y: y * frameHeight };
  });
  if (points.some((point) => point === null)) {
    return null;
  }

  const [eyeA, eyeB, noseTip, mouth] = points as Array<{
    x: number;
    y: number;
  }>;
  const leftEye = eyeA.x <= eyeB.x ? eyeA : eyeB;
  const rightEye = eyeA.x <= eyeB.x ? eyeB : eyeA;

  return poseFromLandmarks({
    leftEye,
    rightEye,
    noseTip,
    mouthLeft: mouth,
    mouthRight: mouth,
  });
}

/**
 * Every face in the frame, in the frame's own pixels.
 *
 * Returns null, distinctly from an empty list, when there is no detector to ask.
 * The caller needs the difference: an empty list means the model looked and found
 * nothing, which is a refusal, and null means nothing looked, which is a reason
 * to fall back rather than to refuse a person's photograph.
 */
export async function detectFaces(
  canvas: HTMLCanvasElement,
): Promise<DetectionResult | null> {
  const detector = await loadFaceDetector();
  if (detector === null) {
    return null;
  }

  let raw: ReturnType<Detector["detect"]>;
  try {
    raw = detector.detect(canvas);
  } catch {
    return null;
  }

  const detections = raw.detections ?? [];
  const faces: DetectedFace[] = [];

  for (const detection of detections) {
    const originX = finite(detection.boundingBox?.originX);
    const originY = finite(detection.boundingBox?.originY);
    const width = finite(detection.boundingBox?.width);
    const height = finite(detection.boundingBox?.height);
    if (
      originX === null ||
      originY === null ||
      width === null ||
      height === null ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }
    faces.push({
      box: { x: originX, y: originY, width, height },
      pose: poseFromDetectorKeypoints(
        detection.keypoints,
        canvas.width,
        canvas.height,
      ),
      score: finite(detection.categories?.[0]?.score),
    });
  }

  return { faces };
}
