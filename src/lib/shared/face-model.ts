/**
 * Where the face model and its runtime come from, pinned.
 *
 * The capture screen measures a face with MediaPipe's FaceLandmarker: a WASM
 * runtime (six files, three variants) and one .task model file. Both are self
 * hosted from public/ so that the capture path never depends on a third party
 * CDN being reachable from a phone: scripts/prepare-face-model.ts copies the
 * runtime out of node_modules and downloads the model on postinstall, checks
 * the model's sha256 against the pin below, and public/mediapipe and
 * public/models are gitignored because the runtime alone is 35 MB and this
 * repository is public and is cloned by judges.
 *
 * The CDN paths stay as a fallback for a deploy whose postinstall could not
 * download the model (offline npm ci, a blocked host): the loader in
 * src/lib/client/landmarks.ts asks for the local model first and falls back to
 * these when it is missing. A silent version skew between the JS loader in
 * node_modules and the runtime it loads is a detector that quietly refuses to
 * initialise, so the version is pinned here and a test holds it equal to
 * package.json.
 *
 * Pure constants, no imports: both the postinstall script (Node) and the
 * browser loader read this file.
 */

/** Must equal the @mediapipe/tasks-vision version in package.json. */
export const MEDIAPIPE_VERSION = "1.0.1";

/** The six runtime files @mediapipe/tasks-vision ships under wasm/. */
export const MEDIAPIPE_WASM_FILES = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_module_internal.js",
  "vision_wasm_module_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
] as const;

/** The runtime, served from public/mediapipe/wasm. */
export const MEDIAPIPE_WASM_LOCAL_PATH = "/mediapipe/wasm";

/** The runtime on jsDelivr at the pinned version, the fallback. */
export const MEDIAPIPE_WASM_CDN_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

/** The model, served from public/models. */
export const FACE_LANDMARKER_MODEL_LOCAL_PATH = "/models/face_landmarker.task";

/**
 * The float16 FaceLandmarker, version 1, on Google's model host: 478
 * landmarks, the transformation matrix and the 52 blendshapes. The fallback,
 * and the source the postinstall script downloads from.
 */
export const FACE_LANDMARKER_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

/**
 * The sha256 of that file, computed from a download on 2026-09-23 (3758596
 * bytes). The postinstall script refuses a download that does not hash to
 * this, so a model swapped under the same URL can never reach public/.
 */
export const FACE_LANDMARKER_MODEL_SHA256 =
  "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";
