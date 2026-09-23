/**
 * The face landmarker, in the browser, on the phone the photo is being taken
 * with.
 *
 * What it is. MediaPipe's FaceLandmarker (tasks-vision, IMAGE mode): 478
 * landmarks per face, a 4 by 4 facial transformation matrix that solves for
 * the head's pose, and 52 blendshapes, of which the gate reads the two eye
 * blinks and the jaw. src/lib/shared/face-reading.ts turns one face of that
 * result into a FaceReading in the engine's own terms (cheek to cheek over the
 * frame width, the oval's box and centre, the pose from the matrix, the eyes),
 * and that reading is what the live line and the gate measure.
 *
 * What it replaced, and why. Until 2026-09-23 this module loaded BlazeFace, a
 * detector: a box whose extent is undocumented and six keypoints a heuristic
 * turned into a pose with guessed scales. No 60 percent rule could be built on
 * that box, no pose refusal could be predicted from that heuristic, and when
 * the detector had not loaded a YCbCr skin colour threshold in face.ts stood
 * in for it, guessing at faces from lit skin. All of that is gone. A frame is
 * now measured by the landmarker or it is unmeasured, and an unmeasured frame
 * is offered to the person as exactly that (assessCapture in
 * src/lib/shared/quality.ts).
 *
 * Where the files come from. The WASM runtime and the .task model are served
 * from this deployment's public/ folder, put there on postinstall by
 * scripts/prepare-face-model.ts and pinned by sha256
 * (src/lib/shared/face-model.ts), so the capture path does not depend on a
 * third party CDN answering from a phone. The CDN and Google's model host are
 * the fallback for a deploy whose install could not download the model: the
 * loader asks for the local model first (one HEAD request) and falls back when
 * it is missing or will not create.
 *
 * GPU first, then CPU, twice over. The GPU delegate is what makes a detection
 * cheap enough to run on every preview frame, so it is asked for first. Two
 * things go wrong with it on real phones. createFromOptions can throw (older
 * Android WebViews, some iOS builds), which is answered by creating on the CPU
 * instead. And on iOS Safari a GPU landmarker can create cleanly and then
 * throw on its first detect ("framebuffer not complete"), which is answered
 * once: the GPU instance is closed and a CPU one created in its place, and the
 * frame is read again. A CPU landmarker is slower and still a landmarker.
 *
 * Nothing in this module sends anything anywhere. The model is a download and
 * the inference is local; no frame, no landmark and no measurement leaves the
 * device from here.
 *
 * On validation. The e2e seam's injected result is parsed with zod
 * (src/lib/client/landmarks-seam.ts) because it is an arbitrary object a test
 * put on the window. The model's own result is not: it is the typed return of
 * a library call in the same process, read on every preview frame, and
 * readingsFromLandmarkerResult checks the shape it reads by hand (a finite
 * number where one is expected, a face dropped where it is not) rather than
 * building 478 landmark objects through a schema three times a second. The
 * failure mode is the same either way: a face that does not read is left out,
 * never thrown on.
 */

import { faceReadingFrom, type FaceReading } from "@/lib/shared/face-reading";
import {
  FACE_LANDMARKER_MODEL_LOCAL_PATH,
  FACE_LANDMARKER_MODEL_URL,
  MEDIAPIPE_VERSION,
  MEDIAPIPE_WASM_CDN_URL,
  MEDIAPIPE_WASM_LOCAL_PATH,
} from "@/lib/shared/face-model";
import type { Size } from "@/lib/shared/frame-geometry";

import { injectedLandmarker, type InjectedLandmarker } from "./landmarks-seam";

/**
 * Re exported from face-model.ts, where both the browser loader and the
 * postinstall script read it. src/lib/client/landmarks.test.ts holds it equal
 * to package.json, because a skew between the JS loader in node_modules and
 * the runtime it loads is a landmarker that quietly refuses to initialise.
 */
export { MEDIAPIPE_VERSION };

/** Long enough that a slow network cannot hold the capture screen hostage. */
export const DETECTOR_LOAD_TIMEOUT_MS = 8_000;

/**
 * Deliberately low. A second face in the frame is a refusal
 * (error_multiple_people is a documented provider failure and every face
 * endpoint we call is single face only), so the landmarker is asked to be
 * generous about noticing one rather than confident about it, and the
 * decision about what to do with two is made in the gate.
 */
const MIN_FACE_DETECTION_CONFIDENCE = 0.3;

/** Two, so a second face is seen and refused rather than silently ignored. */
const MAX_FACES = 2;

export type LandmarkerDelegate = "gpu" | "cpu";

/** Every face in one frame, converted, with what the reading cost. */
export type FaceReadingsResult = {
  readonly faces: readonly FaceReading[];
  /** How long the landmarker took on this frame, in milliseconds. */
  readonly inferMs: number;
  readonly delegate: LandmarkerDelegate;
};

/**
 * The parts of a FaceLandmarkerResult this module reads, typed loosely on
 * purpose: the result is external input, and a field that is missing or the
 * wrong shape leaves that face out rather than throwing inside a frame loop.
 */
type RawLandmark = { readonly x?: number; readonly y?: number; readonly z?: number };

export type RawLandmarkerResult = {
  readonly faceLandmarks?: ReadonlyArray<ReadonlyArray<RawLandmark>>;
  readonly facialTransformationMatrixes?: ReadonlyArray<{
    readonly data?: ArrayLike<number>;
  }>;
  readonly faceBlendshapes?: ReadonlyArray<{
    readonly categories?: ReadonlyArray<{
      readonly categoryName?: string;
      readonly score?: number;
    }>;
  }>;
};

/** The adapter the rest of this module holds: one detect, one close. */
type Landmarker = {
  readonly delegate: LandmarkerDelegate;
  readonly detect: (source: HTMLCanvasElement) => RawLandmarkerResult;
  readonly close: () => void;
};

type TasksVision = typeof import("@mediapipe/tasks-vision");
type WasmFileset = Parameters<TasksVision["FaceLandmarker"]["createFromOptions"]>[0];

/** Where the runtime and the model were loaded from. */
type ModelSource = {
  readonly label: "local" | "cdn";
  readonly wasm: string;
  readonly model: string;
};

const LOCAL_SOURCE: ModelSource = {
  label: "local",
  wasm: MEDIAPIPE_WASM_LOCAL_PATH,
  model: FACE_LANDMARKER_MODEL_LOCAL_PATH,
};

const CDN_SOURCE: ModelSource = {
  label: "cdn",
  wasm: MEDIAPIPE_WASM_CDN_URL,
  model: FACE_LANDMARKER_MODEL_URL,
};

/** A created landmarker with what is needed to create it again on the CPU. */
type Loaded = {
  readonly landmarker: Landmarker;
  readonly vision: TasksVision;
  readonly fileset: WasmFileset;
  readonly source: ModelSource;
};

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly promise: Promise<Loaded | null> }
  | {
      readonly kind: "ready";
      readonly loaded: Loaded;
      /** True once a GPU detect has thrown and the CPU was tried in its place. */
      readonly cpuRetried: boolean;
    }
  | { readonly kind: "unavailable" };

let state: LoadState = { kind: "idle" };

/** The one CPU replacement in flight, so two frames that throw share it. */
let replacing: Promise<Landmarker | null> | null = null;

/**
 * Answers null after ms, without abandoning the work.
 *
 * The distinction is the whole point. The caller cannot wait: the capture screen
 * has to draw a guidance line now, on whatever it can measure. The download
 * can wait: it is 11.5MB of WASM runtime, it is already in flight, and on a
 * phone on mobile data it routinely takes longer than any timeout a screen can
 * afford.
 *
 * Until 2026-09-10 a timeout here resolved null and the caller then recorded the
 * detector as permanently unavailable, so one slow load on one phone turned the
 * real detector off for the whole session and every capture after it went
 * unmeasured. That is the failure mode this product was trying to leave behind,
 * reintroduced by its own loading code and completely silent.
 */
export function raceWithoutCancelling<T>(
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

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * True when this deployment serves the model. One HEAD request: a deploy whose
 * postinstall could not download the model has no file there, and asking the
 * runtime to create from a 404 would only fail slower.
 */
async function localModelPresent(): Promise<boolean> {
  try {
    const response = await fetch(FACE_LANDMARKER_MODEL_LOCAL_PATH, {
      method: "HEAD",
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function createOn(
  vision: TasksVision,
  fileset: WasmFileset,
  model: string,
  delegate: LandmarkerDelegate,
): Promise<Landmarker> {
  const real = await vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: model,
      delegate: delegate === "gpu" ? "GPU" : "CPU",
    },
    runningMode: "IMAGE",
    numFaces: MAX_FACES,
    minFaceDetectionConfidence: MIN_FACE_DETECTION_CONFIDENCE,
    outputFacialTransformationMatrixes: true,
    outputFaceBlendshapes: true,
  });
  return {
    delegate,
    detect: (source) => real.detect(source) as RawLandmarkerResult,
    close: () => {
      real.close();
    },
  };
}

/** GPU first, CPU second, and the second attempt is not optional. */
async function createWithCpuFallback(
  vision: TasksVision,
  fileset: WasmFileset,
  model: string,
): Promise<Landmarker> {
  try {
    return await createOn(vision, fileset, model, "gpu");
  } catch {
    return createOn(vision, fileset, model, "cpu");
  }
}

async function createLandmarker(): Promise<Loaded | null> {
  if (typeof window === "undefined") {
    return null;
  }
  let vision: TasksVision;
  try {
    vision = await import("@mediapipe/tasks-vision");
  } catch {
    return null;
  }

  /*
   * Local first, CDN second. The local runtime and model are the same bytes
   * at the same pinned version, served from this deployment; the CDN is where
   * they came from and is only asked when the deploy has no model of its own
   * or the local one will not create.
   */
  const sources = (await localModelPresent())
    ? [LOCAL_SOURCE, CDN_SOURCE]
    : [CDN_SOURCE];

  for (const source of sources) {
    try {
      const fileset = await vision.FilesetResolver.forVisionTasks(source.wasm);
      const landmarker = await createWithCpuFallback(vision, fileset, source.model);
      return { landmarker, vision, fileset, source };
    } catch {
      // The next source, or null when this was the last.
    }
  }
  return null;
}

/**
 * Starts loading the landmarker without waiting for it.
 *
 * Called from the consent screen so the model is warm by the time the camera
 * opens. The download is the WASM runtime plus a 3.7MB model, and paying for it
 * while somebody is reading the consent copy is the difference between a
 * capture screen that can measure a face and one that cannot.
 */
export function warmFaceDetector(): void {
  if (state.kind !== "idle") {
    return;
  }
  void loadFaceDetector();
}

/**
 * The landmarker, once it has loaded, or null within the caller's budget.
 *
 * The e2e seam is consulted first: with NEXT_PUBLIC_AURUM_E2E_SEAMS on and a
 * result injected on the window, that result stands in for the model's and
 * goes through the same conversion (src/lib/client/landmarks-seam.ts).
 */
export async function loadFaceDetector(): Promise<Landmarker | null> {
  const injected = injectedLandmarker();
  if (injected !== null) {
    return seamLandmarker(injected);
  }

  if (state.kind === "ready") {
    return state.loaded.landmarker;
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
    const load = createLandmarker().then((loaded) => {
      /*
       * Only a real failure latches. A load that simply has not finished stays
       * loading, so the next caller waits on the same promise and picks it up the
       * moment it lands. This is what stops one slow network moment from turning
       * the landmarker off for the rest of the session.
       */
      state =
        loaded === null
          ? { kind: "unavailable" }
          : { kind: "ready", loaded, cpuRetried: false };
      return loaded;
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
  const loaded = await raceWithoutCancelling(pending, DETECTOR_LOAD_TIMEOUT_MS);
  return loaded === null ? null : loaded.landmarker;
}

/** True once a real landmarker is answering, which the gate logs for telemetry. */
export function faceDetectorIsReady(): boolean {
  return state.kind === "ready" || injectedLandmarker() !== null;
}

/** Test seam. Never called by the app. */
export function resetFaceDetectorForTests(): void {
  state = { kind: "idle" };
  replacing = null;
}

/**
 * The iOS case: a GPU landmarker that created cleanly and threw on its first
 * detect. Closed and replaced with a CPU one, once. A second throw from the
 * replacement, or a throw from a landmarker that is no longer the current one,
 * leaves the frame unmeasured and the state as it is.
 */
async function replaceAfterGpuThrow(thrown: Landmarker): Promise<Landmarker | null> {
  if (state.kind !== "ready" || state.loaded.landmarker !== thrown) {
    return null;
  }
  if (thrown.delegate !== "gpu" || state.cpuRetried) {
    return null;
  }
  if (replacing !== null) {
    return replacing;
  }
  const { loaded } = state;
  replacing = (async () => {
    try {
      thrown.close();
    } catch {
      // Already broken; nothing more to release.
    }
    try {
      const cpu = await createOn(
        loaded.vision,
        loaded.fileset,
        loaded.source.model,
        "cpu",
      );
      state = {
        kind: "ready",
        loaded: { ...loaded, landmarker: cpu },
        cpuRetried: true,
      };
      return cpu;
    } catch {
      state = { kind: "unavailable" };
      return null;
    } finally {
      replacing = null;
    }
  })();
  return replacing;
}

function finite(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Every face of a landmarker result as a FaceReading, normalized to the frame
 * the landmarker saw, with the polygon and eye boxes in that frame's pixels.
 *
 * faceLandmarks[i] is the i'th face's 478 normalized points,
 * facialTransformationMatrixes[i].data its column major matrix (which
 * faceReadingFrom hands to poseFromLandmarkerMatrix), and
 * faceBlendshapes[i].categories its blendshapes, read by categoryName. A face
 * whose landmark list is too short to read is left out. Exported for its test
 * and for nothing else.
 */
export function readingsFromLandmarkerResult(
  raw: RawLandmarkerResult,
  frame: Size,
): FaceReading[] {
  const faces: FaceReading[] = [];
  const lists = raw.faceLandmarks ?? [];
  for (let index = 0; index < lists.length; index += 1) {
    const points = lists[index] ?? [];
    const landmarks = points.map((point) => ({
      x: finite(point.x),
      y: finite(point.y),
      z: point.z,
    }));

    const matrixData = raw.facialTransformationMatrixes?.[index]?.data;
    const matrix =
      matrixData !== undefined && matrixData.length === 16 ? matrixData : null;

    const categories = raw.faceBlendshapes?.[index]?.categories;
    let blendshapes: Record<string, number> | null = null;
    if (categories !== undefined) {
      blendshapes = {};
      for (const category of categories) {
        if (
          typeof category.categoryName === "string" &&
          typeof category.score === "number" &&
          Number.isFinite(category.score)
        ) {
          blendshapes[category.categoryName] = category.score;
        }
      }
    }

    const reading = faceReadingFrom({ landmarks, matrix, blendshapes }, frame);
    if (reading !== null) {
      faces.push(reading);
    }
  }
  return faces;
}

/** The injected result shaped as the landmarker's, so it converts the same way. */
function seamLandmarker(injected: InjectedLandmarker): Landmarker {
  return {
    delegate: "cpu",
    close: () => {},
    detect: () => ({
      faceLandmarks: injected.faces.map((face) => face.landmarks),
      facialTransformationMatrixes: injected.faces.map((face) => ({
        data: face.matrix ?? undefined,
      })),
      faceBlendshapes: injected.faces.map((face) => ({
        categories:
          face.blendshapes === null
            ? undefined
            : Object.entries(face.blendshapes).map(([categoryName, score]) => ({
                categoryName,
                score,
              })),
      })),
    }),
  };
}

/**
 * Every face in the frame, read in the frame's own pixels.
 *
 * Returns null, distinctly from an empty list, when there is no landmarker to
 * ask or the one there is could not read the frame. The caller needs the
 * difference: an empty list means the model looked and found nothing, which is
 * a refusal, and null means nothing measured the frame, which is a reason to
 * offer it as unmeasured rather than to refuse a person's photograph.
 */
export async function readFaces(
  canvas: HTMLCanvasElement,
): Promise<FaceReadingsResult | null> {
  const landmarker = await loadFaceDetector();
  if (landmarker === null) {
    return null;
  }
  const frame: Size = { width: canvas.width, height: canvas.height };

  const started = now();
  let raw: RawLandmarkerResult;
  let delegate = landmarker.delegate;
  try {
    raw = landmarker.detect(canvas);
  } catch {
    const replacement = await replaceAfterGpuThrow(landmarker);
    if (replacement === null) {
      return null;
    }
    try {
      raw = replacement.detect(canvas);
    } catch {
      return null;
    }
    delegate = replacement.delegate;
  }
  const inferMs = now() - started;

  return { faces: readingsFromLandmarkerResult(raw, frame), inferMs, delegate };
}
