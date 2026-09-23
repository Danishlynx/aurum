/**
 * Puts the face model and its runtime under public/, so the capture screen
 * loads both from this deployment rather than from a CDN.
 *
 * Runs on postinstall (package.json) and is idempotent: the six WASM runtime
 * files are copied out of node_modules/@mediapipe/tasks-vision/wasm when they
 * are missing or a different size, and the FaceLandmarker model is downloaded
 * once, hashed, and kept only when its sha256 equals the pin in
 * src/lib/shared/face-model.ts. A model already on disk with the right hash is
 * left alone, so a second install costs nothing.
 *
 * A failed download warns and exits 0. An offline npm ci still has to install:
 * the browser loader falls back to the CDN when the local model is missing,
 * and a dependency install that fails because a model host was unreachable
 * would be a worse outcome than a capture screen that fetches the model from
 * where it always used to.
 *
 * Both output folders are gitignored. Nothing here reads an environment
 * variable or a secret.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FACE_LANDMARKER_MODEL_LOCAL_PATH,
  FACE_LANDMARKER_MODEL_SHA256,
  FACE_LANDMARKER_MODEL_URL,
  MEDIAPIPE_WASM_FILES,
  MEDIAPIPE_WASM_LOCAL_PATH,
} from "../src/lib/shared/face-model";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(REPO_ROOT, "public");
const WASM_SOURCE_DIR = resolve(
  REPO_ROOT,
  "node_modules",
  "@mediapipe",
  "tasks-vision",
  "wasm",
);
const WASM_TARGET_DIR = resolve(PUBLIC_DIR, ...MEDIAPIPE_WASM_LOCAL_PATH.split("/").filter(Boolean));
const MODEL_TARGET = resolve(
  PUBLIC_DIR,
  ...FACE_LANDMARKER_MODEL_LOCAL_PATH.split("/").filter(Boolean),
);

/** How long the model download may take before it is given up as offline. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

function log(line: string): void {
  process.stdout.write(`prepare-face-model: ${line}\n`);
}

function warn(line: string): void {
  process.stderr.write(`prepare-face-model: warning: ${line}\n`);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Copies each runtime file that is missing or not the same size. */
export function copyWasmRuntime(): { copied: number; kept: number } {
  if (!existsSync(WASM_SOURCE_DIR)) {
    warn(
      `${WASM_SOURCE_DIR} is missing; is @mediapipe/tasks-vision installed? The runtime will load from the CDN.`,
    );
    return { copied: 0, kept: 0 };
  }
  mkdirSync(WASM_TARGET_DIR, { recursive: true });
  let copied = 0;
  let kept = 0;
  for (const name of MEDIAPIPE_WASM_FILES) {
    const source = resolve(WASM_SOURCE_DIR, name);
    const target = resolve(WASM_TARGET_DIR, name);
    if (!existsSync(source)) {
      warn(`${name} is not in the installed package; skipped.`);
      continue;
    }
    if (existsSync(target) && statSync(target).size === statSync(source).size) {
      kept += 1;
      continue;
    }
    copyFileSync(source, target);
    copied += 1;
  }
  return { copied, kept };
}

/** True when the model on disk hashes to the pin. */
export function localModelIsPinned(): boolean {
  if (!existsSync(MODEL_TARGET)) {
    return false;
  }
  return sha256Of(readFileSync(MODEL_TARGET)) === FACE_LANDMARKER_MODEL_SHA256;
}

/**
 * Downloads the model and keeps it only when the hash matches. Returns a word
 * for the log: "kept" when it was already right, "downloaded" on success,
 * "unreachable" or "mismatch" when the deploy will fall back to the CDN.
 */
export async function ensureModel(): Promise<
  "kept" | "downloaded" | "unreachable" | "mismatch"
> {
  if (localModelIsPinned()) {
    return "kept";
  }
  mkdirSync(dirname(MODEL_TARGET), { recursive: true });

  let bytes: Uint8Array;
  try {
    const response = await fetch(FACE_LANDMARKER_MODEL_URL, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      warn(
        `${FACE_LANDMARKER_MODEL_URL} answered ${String(response.status)}; the model will load from the CDN.`,
      );
      return "unreachable";
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(
      `could not download the face model (${message}); the model will load from the CDN.`,
    );
    return "unreachable";
  }

  const digest = sha256Of(bytes);
  if (digest !== FACE_LANDMARKER_MODEL_SHA256) {
    warn(
      `the downloaded model hashes to ${digest}, not the pinned ${FACE_LANDMARKER_MODEL_SHA256}; not kept. Check the URL and the pin before changing either.`,
    );
    if (existsSync(MODEL_TARGET)) {
      unlinkSync(MODEL_TARGET);
    }
    return "mismatch";
  }

  writeFileSync(MODEL_TARGET, bytes);
  return "downloaded";
}

async function main(): Promise<void> {
  const runtime = copyWasmRuntime();
  log(
    `runtime: ${String(runtime.copied)} copied, ${String(runtime.kept)} already in place under ${WASM_TARGET_DIR}.`,
  );
  const model = await ensureModel();
  log(`model: ${model} (${MODEL_TARGET}).`);
}

/* Only when run directly: the functions above are importable by a test. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().then(
    () => {
      process.exit(0);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      warn(`stopped early (${message}); the capture screen will fall back to the CDN.`);
      process.exit(0);
    },
  );
}
