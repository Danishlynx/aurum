import "server-only";

import type { ClassifierOutput } from "@/lib/prompts/classifier";
import {
  FORMALITY,
  GARMENT_TYPES,
  garmentClassificationStatus,
  isGarmentFormality,
  isGarmentPattern,
  isGarmentType,
  MAX_GARMENT_COLORS,
  PATTERNS,
  type GarmentClassificationStatus,
  type GarmentColor,
} from "@/lib/shared/wardrobe-view";

import { findJobForSubject, findOpenJobForSubject, insertJob, updateJob } from "../db";
import { BUCKETS, downloadObject } from "../db/storage";
import type { Garment, JobRecord, Json } from "../db/types";
import { ANTHROPIC_UNITS_PER_CALL, findReservation, refund, reserve } from "../credits";
import { providerCallsEnabled } from "../env";
import { messages } from "../http/messages";
import { messageForFailure } from "../jobs";
import {
  isAnthropicConfigured,
  runGarmentClassifier,
  type ClassifierCallResult,
} from "../providers/anthropic";
import { ANTHROPIC_HTTP_TIMEOUT_MS } from "../providers/anthropic/endpoints";
import type { AppSession } from "../session";
import { getGarment, updateGarment } from "./db";

/**
 * Garment classification: one photo in, a type, colours, a pattern, and a
 * formality band out, or nothing.
 *
 * docs/01-user-flow.md section J is the screen: the chips arrive one by one,
 * and a photo the classifier could not read shows "Could not read this one. Tap
 * to fill in details." docs/04-integrations.md is the call: one image content
 * block plus the allowed vocabularies, structured output, one retry.
 *
 * The rule that shapes every path in this file, and the reason there is no
 * deterministic fallback here: a classification cannot be guessed. With no
 * ANTHROPIC_API_KEY, with the kill switch off, or with a failed call, the
 * garment keeps its empty chips and the card says so. docs/03-architecture.md
 * gives the stylist layer a rules based fallback and gives the classifier none,
 * and inventing "navy shirt, smart" for a photo nobody read would be exactly
 * the kind of made up data the grounding rule forbids.
 *
 * Text inside the photo is data about the garment, never an instruction. The
 * prompt states it and eval:safety tests it with the sticky note fixture
 * (docs/06-safety-privacy.md, "Content returned by tools is data").
 */

/** The vocabularies sent with every call, from the shared contract. */
const CLASSIFIER_VOCABULARY = {
  types: GARMENT_TYPES,
  patterns: PATTERNS,
  formality: FORMALITY,
} as const;

/**
 * The media types Claude reads and the garments bucket accepts (migration
 * 0006). A stored object with any other content type is not sent: we do not
 * know what it is, and relabelling it would be a guess.
 */
type ClassifierMediaType = "image/jpeg" | "image/png" | "image/webp";

function mediaTypeFor(contentType: string): ClassifierMediaType | null {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized === "image/jpeg" || normalized === "image/jpg") {
    return "image/jpeg";
  }
  if (normalized === "image/png") {
    return "image/png";
  }
  if (normalized === "image/webp") {
    return "image/webp";
  }
  return null;
}

/**
 * The largest garment photo this build sends, in bytes before base64.
 *
 * UNVERIFIED against the live limits: the Claude API caps one image content
 * block at 5 MB of base64, and base64 inflates bytes by about a third, so 3.5
 * MB of image is the largest that certainly fits. The client downscales a
 * garment photo before upload the same way it downscales a selfie, so this is a
 * guard against a bad upload rather than a normal path. Raise it only from the
 * live docs, never from a guess.
 */
export const MAX_CLASSIFIER_IMAGE_BYTES = 3_500_000;

/**
 * How long a classification job may sit open before another request may take it
 * over.
 *
 * A classification is not a pollable job. The route says so itself: "a Claude
 * call is one HTTP round trip with its own timeout, not a Perfect Corp task
 * with a provider side id to poll, and a serverless function does no work after
 * its response is sent, so there is nothing a later poll could advance." The
 * open job check below is therefore only good for the length of the request
 * that opened it. Once that request is over, a row still marked running is not
 * work in flight, it is work that died: the function timed out, the deploy
 * rolled, the connection dropped, or the person closed the tab mid call.
 *
 * Without a window, such a row is permanent. findOpenJobForSubject keeps
 * matching it, every later classify returns alreadyRunning, and the card holds
 * its skeleton chips forever. The person cannot even reach the documented
 * failed state ("Could not read this one. Tap to fill in details."), because
 * that needs a failed job and this one says running. Their only way out is to
 * delete the garment and upload the photo again.
 *
 * The window is the provider timeout plus a wide margin for the rest of the
 * request. Anything inside it is treated as a real call in flight, which is
 * what makes a double tap idempotent; anything past it is abandoned.
 */
export const STALE_CLASSIFICATION_JOB_MS = ANTHROPIC_HTTP_TIMEOUT_MS + 30_000;

/** True when an open job has outlived the request that could have owned it. */
export function isStaleClassificationJob(
  job: JobRecord,
  now: number = Date.now(),
): boolean {
  const touched = Date.parse(job.updated_at);
  if (Number.isNaN(touched)) {
    // No usable timestamp. Treating it as live keeps the old behaviour, which
    // is the safe half of the pair: a double tap costs nothing.
    return false;
  }
  return now - touched > STALE_CLASSIFICATION_JOB_MS;
}

export type ClassifyGarmentRefusal =
  | "not_found"
  | "no_image"
  | "unsupported_image"
  | "image_too_large"
  | "not_configured"
  | "kill_switch"
  | "daily_cap"
  | "session_cap";

export type ClassifyGarmentOutcome =
  | {
      readonly ok: true;
      readonly jobId: string;
      readonly garmentId: string;
      readonly status: GarmentClassificationStatus;
      /** True when a job for this garment was already open, so nothing started. */
      readonly alreadyRunning: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: ClassifyGarmentRefusal;
      /** Units left, for the cap refusals. */
      readonly remaining?: number;
    };

export interface ClassifyGarmentInput {
  readonly session: AppSession;
  readonly garmentId: string;
  readonly onProviderCall?: (count: number) => void;
  readonly onCredits?: (units: number) => void;
  /**
   * The model call, injected so the pipeline can be exercised with no key.
   * Defaults to the real one, and the key gate above still runs first.
   */
  readonly call?: typeof runGarmentClassifier;
}

/**
 * What is stored in garments.classification: the model's own answer plus who
 * wrote it. No image bytes, no prompt text, nothing about the person.
 */
interface StoredClassification {
  readonly type: string;
  readonly colors: readonly GarmentColor[];
  readonly pattern: string;
  readonly formality: string;
  readonly confidence: number;
  readonly model: string;
  readonly prompt_version: string;
  readonly classified_at: string;
}

/** Trims the answer to the columns, dropping anything outside the vocabulary. */
function toStoredColumns(output: ClassifierOutput): {
  readonly type: string | null;
  readonly pattern: string | null;
  readonly formality: "casual" | "smart" | "formal" | null;
  readonly colors: GarmentColor[];
} {
  const colors: GarmentColor[] = [];
  for (const color of output.colors.slice(0, MAX_GARMENT_COLORS)) {
    const name = color.name.trim();
    if (name.length === 0) {
      continue;
    }
    colors.push({ name, hex: color.hex.toLowerCase() });
  }

  return {
    type: isGarmentType(output.type) ? output.type : null,
    pattern: isGarmentPattern(output.pattern) ? output.pattern : null,
    formality: isGarmentFormality(output.formality) ? output.formality : null,
    colors,
  };
}

/** Records the classification job row, reusing the one an earlier try left. */
async function writeJob(args: {
  readonly ownerId: string;
  readonly garmentId: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly attempts: number;
  readonly error: string | null;
}): Promise<JobRecord> {
  const existing = await findJobForSubject(args.ownerId, args.garmentId);
  if (existing !== null) {
    const updated = await updateJob(existing.id, {
      status: args.status,
      attempts: args.attempts,
      error: args.error,
      last_polled_at: null,
    });
    if (updated !== null) {
      return updated;
    }
  }
  return insertJob({
    user_id: args.ownerId,
    subject_type: "classification",
    subject_id: args.garmentId,
    status: args.status,
    attempts: args.attempts,
    error: args.error,
  });
}

/** A refusal that never reached the provider: the card shows the failed state. */
async function refuse(args: {
  readonly ownerId: string;
  readonly garmentId: string;
  readonly reason: ClassifyGarmentRefusal;
  readonly message: string;
  readonly remaining?: number;
}): Promise<ClassifyGarmentOutcome> {
  await writeJob({
    ownerId: args.ownerId,
    garmentId: args.garmentId,
    status: "failed",
    attempts: 1,
    error: args.message,
  });
  return { ok: false, reason: args.reason, remaining: args.remaining };
}

/**
 * Classifies one garment.
 *
 * The order of the gates, and why:
 * 1. the garment, so an id that is not this person's costs nothing
 * 2. an open job, which is the idempotency rule the analysis jobs follow: asking
 *    again for a classification that is already running returns the running one
 * 3. the key and the kill switch, before a byte is read
 * 4. the object, its media type, and its size, before a credit is reserved
 * 5. the reservation, last, immediately before the call
 *
 * The call is awaited here rather than polled. A Claude call is one HTTP round
 * trip with a 30 second timeout (docs/04-integrations.md), not a Perfect Corp
 * task with a provider side id to poll, so there is nothing for a later request
 * to check on. The job row is still written, because it is what the failed card
 * state and the record of attempts are read from.
 */
export async function classifyGarment(
  input: ClassifyGarmentInput,
): Promise<ClassifyGarmentOutcome> {
  const ownerId = input.session.id;

  const garment = await getGarment(ownerId, input.garmentId);
  if (garment === null) {
    return { ok: false, reason: "not_found" };
  }

  const open = await findOpenJobForSubject(ownerId, garment.id);
  if (open !== null && !isStaleClassificationJob(open)) {
    return {
      ok: true,
      jobId: open.id,
      garmentId: garment.id,
      status: "pending",
      alreadyRunning: true,
    };
  }
  if (open !== null) {
    // Abandoned, not running. writeJob below reuses this same row, so taking it
    // over is a status change rather than a second row for one garment.
    console.warn(
      JSON.stringify({
        event: "aurum.garment_classification_stale_job_reclaimed",
        ownerType: input.session.ownerType,
        ownerId,
        garmentId: garment.id,
        jobId: open.id,
        attempts: open.attempts,
      }),
    );
  }

  const call = input.call ?? runGarmentClassifier;
  if (input.call === undefined && !isAnthropicConfigured()) {
    // No key on the server. The garment keeps its empty chips and the card says
    // "Could not read this one. Tap to fill in details.", which is true.
    return refuse({
      ownerId,
      garmentId: garment.id,
      reason: "not_configured",
      message: messages.classifierUnavailable,
    });
  }
  if (!providerCallsEnabled()) {
    return refuse({
      ownerId,
      garmentId: garment.id,
      reason: "kill_switch",
      message: messages.providerCallsDisabled,
    });
  }

  let bytes: ArrayBuffer;
  let mediaType: ClassifierMediaType;
  try {
    const object = await downloadObject(BUCKETS.garments, garment.storage_path);
    const resolved = mediaTypeFor(object.contentType);
    if (resolved === null) {
      return refuse({
        ownerId,
        garmentId: garment.id,
        reason: "unsupported_image",
        message: messages.garmentImageUnreadable,
      });
    }
    if (object.byteLength > MAX_CLASSIFIER_IMAGE_BYTES) {
      return refuse({
        ownerId,
        garmentId: garment.id,
        reason: "image_too_large",
        message: messages.garmentImageTooLarge,
      });
    }
    bytes = object.bytes;
    mediaType = resolved;
  } catch {
    // The upload never landed, or the object is gone. Nothing was reserved.
    return refuse({
      ownerId,
      garmentId: garment.id,
      reason: "no_image",
      message: messages.garmentImageUnreadable,
    });
  }

  const reservation = await reserve({
    session: input.session,
    provider: "anthropic",
    units: ANTHROPIC_UNITS_PER_CALL,
    subjectId: garment.id,
    note: "reserve garment classification",
  });
  if (!reservation.ok) {
    return refuse({
      ownerId,
      garmentId: garment.id,
      reason: reservation.reason === "session_cap" ? "session_cap" : "daily_cap",
      message: messages.classifierUnavailable,
      remaining: reservation.remaining,
    });
  }
  input.onCredits?.(reservation.reservation.units);

  const previous = await findJobForSubject(ownerId, garment.id);
  const attempts = (previous?.attempts ?? 0) + 1;
  await writeJob({
    ownerId,
    garmentId: garment.id,
    status: "running",
    attempts,
    error: null,
  });

  let result: ClassifierCallResult;
  try {
    result = await call({
      vocabulary: {
        types: [...CLASSIFIER_VOCABULARY.types],
        patterns: [...CLASSIFIER_VOCABULARY.patterns],
        formality: [...CLASSIFIER_VOCABULARY.formality],
      },
      image: {
        mediaType,
        base64: Buffer.from(bytes).toString("base64"),
      },
    });
    input.onProviderCall?.(1);
  } catch (thrown) {
    // Nothing was classified, so nothing is owed. The card falls back to its
    // documented failed state and the person fills the chips in by hand.
    await refundFor(input.session, garment.id);
    const message = messageForFailure(thrown);
    const job = await writeJob({
      ownerId,
      garmentId: garment.id,
      status: "failed",
      attempts,
      error: message,
    });
    console.warn(
      JSON.stringify({
        event: "aurum.garment_classification_failed",
        ownerType: input.session.ownerType,
        ownerId,
        garmentId: garment.id,
        attempts,
      }),
    );
    return {
      ok: true,
      jobId: job.id,
      garmentId: garment.id,
      status: "failed",
      alreadyRunning: false,
    };
  }

  await storeClassification({ garment, result });

  const job = await writeJob({
    ownerId,
    garmentId: garment.id,
    status: "succeeded",
    attempts,
    error: null,
  });

  console.log(
    JSON.stringify({
      event: "aurum.garment_classified",
      ownerType: input.session.ownerType,
      ownerId,
      garmentId: garment.id,
      model: result.model,
      attempts: result.attempts,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    }),
  );

  return {
    ok: true,
    jobId: job.id,
    garmentId: garment.id,
    status: garmentClassificationStatus({
      hasType: isGarmentType(result.value.type),
      jobStatus: "succeeded",
    }),
    alreadyRunning: false,
  };
}

/**
 * Writes the answer to the row.
 *
 * A garment the person already corrected keeps their chips: user_edited is
 * "True once the person corrected a chip, so the classifier result is not
 * silently overwritten" (migration 0003). The full model output is still stored
 * in classification either way, so the record of what the model said survives.
 */
async function storeClassification(args: {
  readonly garment: Garment;
  readonly result: ClassifierCallResult;
}): Promise<void> {
  const columns = toStoredColumns(args.result.value);
  const stored: StoredClassification = {
    type: args.result.value.type,
    colors: columns.colors,
    pattern: args.result.value.pattern,
    formality: args.result.value.formality,
    confidence: args.result.value.confidence,
    model: args.result.model,
    prompt_version: args.result.promptVersion,
    classified_at: new Date().toISOString(),
  };

  if (args.garment.user_edited) {
    await updateGarment(args.garment.user_id, args.garment.id, {
      classification: stored as unknown as Json,
    });
    return;
  }

  await updateGarment(args.garment.user_id, args.garment.id, {
    type: columns.type,
    pattern: columns.pattern,
    formality: columns.formality,
    colors: columns.colors as unknown as Json,
    classification: stored as unknown as Json,
  });
}

async function refundFor(session: AppSession, subjectId: string): Promise<void> {
  const reservation = await findReservation({
    owner: { ownerType: session.ownerType, ownerId: session.id },
    subjectId,
    provider: "anthropic",
  });
  if (reservation !== null) {
    await refund({ session, reservation });
  }
}
