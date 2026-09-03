/**
 * The photo the capture screen sent, kept in memory in case the engine refuses
 * the way it was framed.
 *
 * The live failure this exists for. On 2026-09-03 the founder's phone sent a
 * selfie twice and both times the skin analysis answered
 * error_src_face_too_small. That browser has no FaceDetector, so the framing was
 * composed around the skin region heuristic (src/lib/client/face.ts), which had
 * run down the neck and shoulders and reported a box much larger than the face:
 * the crop looked right to us and was loose to the engine. The person was shown
 * a refusal and asked to take the same photo again.
 *
 * A refused task is charged nothing (docs/04-integrations.md, "Input errors"),
 * so trying again costs nothing but a few seconds. This module is that retry:
 * the source frame is held here, /analyzing asks for a tighter crop of it when a
 * refusal is one a crop could fix, and the person sees one status line instead
 * of a dead end. After the last attempt the honest refusal is what shows.
 *
 * In memory, and only in memory. The frame is pixels of a person's face, so it
 * is never written to storage of any kind: a reload of /analyzing finds nothing
 * here and the screen behaves exactly as it did before this existed. It is
 * dropped as soon as a reading succeeds or the attempts run out.
 */

import {
  createCapture,
  startAnalysis,
  uploadCaptureImage,
  type CaptureQualityPayload,
} from "@/lib/client/api";
import { rememberCapturePreview } from "@/lib/client/capture-handoff";
import { estimateFaceForCapture, SKIN_SAMPLE_LONG_EDGE } from "@/lib/client/face";
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_LONG_EDGE,
  CAPTURE_MIN_SHORT_EDGE,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_LONG_EDGE,
  drawCropToCanvas,
  drawToCanvas,
  readImageData,
  sha256Hex,
  toDataUrl,
  toGrayscale,
  toJpegBlob,
} from "@/lib/client/image";
import { assessCapture } from "@/lib/shared/quality";
import type { CaptureAssessment } from "@/lib/shared/quality";
import { hasReframeLeft, reframeBoxFor } from "@/lib/shared/reframe";

type HeldSource = {
  /** The photo as it was decoded, upright and free of EXIF. */
  readonly canvas: HTMLCanvasElement;
  /** 1 for the frame the person sent, 2 and 3 for the reframes. */
  readonly attempt: number;
  /** The capture the current attempt was sent as, null before it is created. */
  readonly captureId: string | null;
};

/**
 * One slot, not a map. A person takes one photo at a time, and holding the
 * frames of every capture of a session would be a pile of faces in memory for
 * no purpose.
 */
let held: HeldSource | null = null;

/** Keeps the frame about to be sent. Called once per photo, before upload. */
export function rememberCaptureSource(canvas: HTMLCanvasElement): void {
  held = { canvas, attempt: 1, captureId: null };
}

/** Ties the held frame to the capture id the server gave it. */
export function bindCaptureSource(captureId: string): void {
  if (held === null) {
    return;
  }
  held = { ...held, captureId };
}

export function forgetCaptureSource(): void {
  held = null;
}

/** True when this capture has a frame here and an attempt left to spend. */
export function canReframeCapture(captureId: string): boolean {
  return (
    held !== null && held.captureId === captureId && hasReframeLeft(held.attempt)
  );
}

/**
 * Why a retry did not happen:
 *
 * - no_source: nothing is held for this capture, so there is nothing to send.
 * - gate: every remaining crop failed our own gate, so none of them was sent.
 * - request: the crop was good and the server could not take it.
 */
export type ReframeOutcome =
  | { readonly ok: true; readonly captureId: string }
  | { readonly ok: false; readonly reason: "no_source" | "gate" | "request" };

/**
 * Sends the held photo again, cropped tighter, as a new capture.
 *
 * Each attempt is spent the moment it is tried, whatever happens to it, so this
 * cannot loop: three attempts is three, counting the one the person took.
 *
 * A crop our own gate rejects is never sent (docs/04-integrations.md: never send
 * a photo that failed the gate, which the route enforces as well). It costs
 * nothing to find out, so the next, tighter crop is tried instead of giving up.
 */
export async function resubmitReframedCapture(
  captureId: string,
): Promise<ReframeOutcome> {
  const source = held;
  if (source === null || source.captureId !== captureId) {
    return { ok: false, reason: "no_source" };
  }

  let attempt = source.attempt;
  while (hasReframeLeft(attempt)) {
    attempt += 1;
    held = { ...source, attempt };

    const box = reframeBoxFor({
      frame: { width: source.canvas.width, height: source.canvas.height },
      attempt,
    });
    if (box === null) {
      break;
    }

    const canvas = drawCropToCanvas(
      source.canvas,
      box,
      CAPTURE_LONG_EDGE,
      CAPTURE_MIN_SHORT_EDGE,
    );
    const assessment = await assess(canvas);
    if (assessment.verdict === "reject") {
      continue;
    }

    const sent = await submit(canvas, assessment);
    if (sent === null) {
      return { ok: false, reason: "request" };
    }

    held = { canvas: source.canvas, attempt, captureId: sent };
    // The reveal opens on the frame that is being read, which is now the crop.
    rememberCapturePreview(
      sent,
      toDataUrl(
        drawToCanvas(
          canvas,
          { width: canvas.width, height: canvas.height },
          PREVIEW_LONG_EDGE,
        ),
        PREVIEW_JPEG_QUALITY,
      ),
    );
    return { ok: true, captureId: sent };
  }

  return { ok: false, reason: "gate" };
}

/** The same gate the capture screen runs, on the reframed crop. */
async function assess(canvas: HTMLCanvasElement): Promise<CaptureAssessment> {
  const full = readImageData(canvas);
  const sample = readImageData(
    drawToCanvas(
      canvas,
      { width: canvas.width, height: canvas.height },
      SKIN_SAMPLE_LONG_EDGE,
    ),
  );
  const estimate = await estimateFaceForCapture(canvas, full, sample);
  return assessCapture({
    image: toGrayscale(full),
    faceCount: estimate.faceCount,
    faceBox: estimate.faceBox,
  });
}

/**
 * Registers the crop as a capture of its own and starts its readings.
 *
 * It is a new capture because it is a new photo: a different crop hashes
 * differently, and the cache is keyed by content hash. Nothing here counts down
 * the judge banner. The capture this one replaces produced no charged reading,
 * so the server gives that analysis back when it refuses it
 * (src/lib/server/jobs/index.ts), and counting this one down as well would show
 * a judge two analyses spent where one was.
 */
async function submit(
  canvas: HTMLCanvasElement,
  assessment: CaptureAssessment,
): Promise<string | null> {
  let blob: Blob;
  let sha256: string;
  try {
    blob = await toJpegBlob(canvas, CAPTURE_JPEG_QUALITY);
    sha256 = await sha256Hex(blob);
  } catch {
    return null;
  }

  const quality: CaptureQualityPayload = {
    verdict: assessment.verdict,
    reason: assessment.reason,
    ...assessment.metrics,
  };
  const created = await createCapture({
    sha256,
    width: canvas.width,
    height: canvas.height,
    quality,
  });
  if (!created.ok) {
    return null;
  }

  if (created.data.status === "new") {
    const put = await uploadCaptureImage(created.data.uploadUrl, blob);
    if (!put.ok) {
      return null;
    }
  }

  const started = await startAnalysis(created.data.captureId);
  if (!started.ok) {
    return null;
  }
  return created.data.captureId;
}
