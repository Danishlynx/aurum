import "server-only";

import { createHash } from "node:crypto";

import { hasJpegMagic, readJpegHeader } from "@/lib/shared/jpeg-header";

import type { StoredObject } from "../db/storage";
import type { Capture } from "../db/types";
import { captureUnreadable } from "../http/responses";
import { PERFECTCORP_ENDPOINTS } from "../providers/perfectcorp/endpoints";

/**
 * The read of the stored bytes before any Perfect Corp reservation.
 *
 * docs/04-integrations.md, "Implementation rules". Until 2026-09-23 the docs
 * said the quality gate ran client side first and then server side, and the
 * server side half did not exist: the captures route receives no bytes, and
 * the analyze route spent twenty units after checking the session, the
 * consent, the caps and the credits, and nothing about the photo. The image
 * constraints recorded in endpoints.ts were enforced nowhere. Anything a
 * client PUT to the signed upload URL, a PNG, a 200 by 200 crop, an empty
 * object, a different file from the one whose digest it registered, went to
 * the engine as a paid task.
 *
 * This does not recompute the gate. The gate needs a face detector and a
 * decoded frame, and neither belongs in a serverless function that is paid
 * for by the second. What it checks is what a header and a digest can prove
 * without decoding a pixel:
 *
 *   size        at most 10 MB, and the whole object was downloaded
 *   format      JPEG, the one format every family of the engine accepts
 *   dimensions  the frame header equals the size the client registered
 *   short side  at least 480 px, the skin analysis SD floor
 *   long side   at most 2560 px, the skin analysis ceiling
 *   digest      sha256 of the bytes equals the row the capture was cached by
 *
 * The limits are the skin analysis row of endpoints.ts, which is the strictest
 * of the four families on the short side and the only one with a stated long
 * side ceiling. The digest is last because it is the only check that reads
 * every byte, and a file that failed on its header never needs it.
 *
 * On failure: one structured log line with the capture id, the check and the
 * numbers (never the bytes, never the digest), and a 409 capture_unreadable
 * whose body is copy.errors.captureUnreadable. The capture screen shows the
 * upload failed line with the step and status under it, so the person
 * retakes rather than retries the same object.
 */

const SKIN_LIMITS = PERFECTCORP_ENDPOINTS.skinAnalysis.imageConstraints;

/** The published figures, kept beside the row in case it is ever unrecorded. */
export const CAPTURE_MAX_BYTES = SKIN_LIMITS?.maxBytes ?? 10 * 1024 * 1024;
export const CAPTURE_MIN_SHORT_SIDE_PX = SKIN_LIMITS?.minShortSidePx ?? 480;
export const CAPTURE_MAX_LONG_SIDE_PX = SKIN_LIMITS?.maxLongSidePx ?? 2560;

export type CaptureCheck =
  | "size"
  | "format"
  | "dimensions"
  | "short_side"
  | "long_side"
  | "digest";

interface CaptureNumbers {
  readonly byteLength: number;
  readonly objectByteLength: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly registeredWidth: number | null;
  readonly registeredHeight: number | null;
}

function refuse(
  captureId: string,
  check: CaptureCheck,
  numbers: CaptureNumbers,
): never {
  console.warn(
    JSON.stringify({
      event: "aurum.capture_unreadable",
      captureId,
      check,
      ...numbers,
      maxBytes: CAPTURE_MAX_BYTES,
      minShortSidePx: CAPTURE_MIN_SHORT_SIDE_PX,
      maxLongSidePx: CAPTURE_MAX_LONG_SIDE_PX,
    }),
  );
  throw captureUnreadable();
}

export function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Throws a 409 capture_unreadable unless the stored object is a JPEG of the
 * registered size, inside the engine's limits, with the registered digest.
 */
export function validateCaptureObject(
  object: StoredObject,
  capture: Capture,
): void {
  const bytes = new Uint8Array(object.bytes);
  const numbers: CaptureNumbers = {
    byteLength: bytes.byteLength,
    objectByteLength: object.byteLength,
    width: null,
    height: null,
    registeredWidth: capture.width,
    registeredHeight: capture.height,
  };

  if (
    bytes.byteLength === 0 ||
    bytes.byteLength !== object.byteLength ||
    bytes.byteLength > CAPTURE_MAX_BYTES
  ) {
    refuse(capture.id, "size", numbers);
  }

  if (!hasJpegMagic(bytes)) {
    refuse(capture.id, "format", numbers);
  }

  const header = readJpegHeader(bytes);
  if (header === null) {
    refuse(capture.id, "format", numbers);
  }
  const measured = { ...numbers, width: header.width, height: header.height };

  if (
    capture.width === null ||
    capture.height === null ||
    header.width !== capture.width ||
    header.height !== capture.height
  ) {
    refuse(capture.id, "dimensions", measured);
  }

  const shortSide = Math.min(header.width, header.height);
  const longSide = Math.max(header.width, header.height);
  if (shortSide < CAPTURE_MIN_SHORT_SIDE_PX) {
    refuse(capture.id, "short_side", measured);
  }
  if (longSide > CAPTURE_MAX_LONG_SIDE_PX) {
    refuse(capture.id, "long_side", measured);
  }

  if (sha256HexOf(bytes) !== capture.sha256.toLowerCase()) {
    refuse(capture.id, "digest", measured);
  }
}
