/**
 * The photo the capture screen sent, kept in memory in case the engine refuses
 * the way it was framed.
 *
 * The live failure this exists for. On 2026-09-03 the founder's phone sent a
 * selfie twice and both times the skin analysis answered
 * error_src_face_too_small. That browser had no face model loaded, so the
 * framing was composed around a skin colour heuristic (deleted since), which
 * had run down the neck and shoulders and reported a box much larger than the
 * face: the crop looked right to us and was loose to the engine. The person was
 * shown a refusal and asked to take the same photo again.
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
  type ApiResult,
  type CaptureQualityPayload,
  type ClientJob,
} from "@/lib/client/api";
import { rememberCapturePreview } from "@/lib/client/capture-handoff";
import { readFaces } from "@/lib/client/landmarks";
import { currentPlatform } from "@/lib/client/platform";
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
  resubmitting = null;
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
/**
 * The capture id a resubmit is currently running for, or null.
 *
 * A second call for the same capture is refused rather than queued, because the
 * thing being guarded is a purchase. Every attempt this function spends creates
 * a capture, uploads a face, and starts a provider fan out that reserves and
 * spends real units, so two concurrent calls for one refusal do not race to a
 * duplicate result: they race to two separate charges, and only one of them ends
 * up on screen.
 *
 * That is not hypothetical. Until 2026-09-10 the poll on /analyzing had no in
 * flight guard, so two overlapping polls both reached the reframe and both
 * called this. On a real account eight capture taps consumed twenty four
 * analyses and 402 units. The poll now guards itself, and this guards the money
 * directly, because the poll is one caller and the next one will not know.
 */
let resubmitting: string | null = null;

export async function resubmitReframedCapture(
  captureId: string,
): Promise<ReframeOutcome> {
  if (resubmitting !== null) {
    return { ok: false, reason: "no_source" };
  }
  const source = held;
  if (source === null || source.captureId !== captureId) {
    return { ok: false, reason: "no_source" };
  }
  resubmitting = captureId;
  try {
    return await runResubmit(captureId, source);
  } finally {
    resubmitting = null;
  }
}

async function runResubmit(
  captureId: string,
  source: HeldSource,
): Promise<ReframeOutcome> {

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
    const read = await assess(canvas);
    if (read.assessment.verdict === "reject") {
      continue;
    }

    const sent = await submit(canvas, read, attempt);
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

/** The gate's reading of one crop, with what the stored row says about it. */
type GateReading = {
  readonly assessment: CaptureAssessment;
  /** True when the landmarker measured the crop. */
  readonly measured: boolean;
  /** How long the landmarker took, or null when it did not run. */
  readonly landmarkerMs: number | null;
};

/**
 * The same gate the capture screen runs, on the reframed crop: the landmarker
 * reads the crop, the largest face is judged, and whether anything measured
 * the frame at all travels with the verdict so the stored row says so.
 */
async function assess(canvas: HTMLCanvasElement): Promise<GateReading> {
  const image = toGrayscale(readImageData(canvas));
  const result = await readFaces(canvas);
  const faces = result?.faces ?? [];
  const largest =
    faces.length === 0
      ? null
      : faces.reduce((best, face) =>
          face.ovalBox.height > best.ovalBox.height ? face : best,
        );
  return {
    assessment: assessCapture({
      image,
      faceCount: faces.length,
      reading: largest,
      measured: result !== null,
    }),
    measured: result !== null,
    landmarkerMs: result === null ? null : result.inferMs,
  };
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
  read: GateReading,
  attempt: number,
): Promise<string | null> {
  const { assessment } = read;
  let blob: Blob;
  let sha256: string;
  try {
    blob = await toJpegBlob(canvas, CAPTURE_JPEG_QUALITY);
    sha256 = await sha256Hex(blob);
  } catch {
    return null;
  }

  /*
   * The calibration fields, written so a reframed row can be told from the
   * frame the person sent: path "reframe" with its attempt number, whether the
   * face model measured the crop, and what it cost (docs/03, data model).
   */
  const quality: CaptureQualityPayload = {
    verdict: assessment.verdict,
    reason: assessment.reason,
    ...assessment.metrics,
    measured: read.measured,
    platform: currentPlatform(),
    path: "reframe",
    // Bounded by hasReframeLeft already; the clamp keeps the schema's 1 to 3.
    attempt: Math.min(3, Math.max(1, attempt)),
    ...(read.landmarkerMs === null ? {} : { landmarkerMs: read.landmarkerMs }),
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

  if (!(await startAnalysisWithOneRetry(created.data.captureId)).ok) {
    return null;
  }
  return created.data.captureId;
}

/**
 * Starts the readings, and asks a second time if the first request never got an
 * answer.
 *
 * The failure this covers is the expensive one. POST analyze creates the leader
 * task at the provider and charges 20 units for it. If the response is lost on
 * the way back, a dropped connection, a phone changing network, a gateway that
 * timed out after the work was done, the client sees !ok and treats the capture
 * as failed: it never navigates to it, never polls it, and nothing ever
 * reconciles the reservation or reads the result. Paid for, and thrown away
 * before it was looked at.
 *
 * Asking again is safe because the route is idempotent for a capture that
 * already has jobs: it reads the existing rows, starts nothing, charges nothing,
 * and does not count a second analysis against a judge session. So the second
 * request either finds the first one's work and hands it back, or does the work
 * the first one never did.
 *
 * Only a transport failure is retried. A 401, a 403 and a 429 are answers, and
 * the server gave them before it spent anything; repeating those buys a second
 * identical refusal and nothing else. status 0 is the only case where the
 * request may have landed and the answer may not have come back.
 *
 * Exported since 2026-09-23 because the capture screen has the same exposure on
 * the same request and was asking exactly once. The result of the last attempt
 * is returned whole, not reduced to a boolean, so that screen can still tell a
 * cap from a missing session from a server error.
 */
export async function startAnalysisWithOneRetry(
  captureId: string,
): Promise<ApiResult<{ jobs: ClientJob[] }>> {
  const first = await startAnalysis(captureId);
  if (first.ok || first.kind !== "network") {
    return first;
  }
  return startAnalysis(captureId);
}

