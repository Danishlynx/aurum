import "server-only";

import type { z } from "zod";

import { ProviderError, issuePathsOf } from "../errors";
import {
  assertEndpointVerified,
  perfectCorpDownloadResult,
  perfectCorpJson,
  perfectCorpUploadBytes,
} from "./client";
import {
  CAPTURE_ANALYSIS_KEYS,
  PERFECTCORP_CREDIT_ENDPOINT,
  PERFECTCORP_FILE_ENDPOINT,
  getEndpoint,
  statusPathFor,
  unitsForCall,
  type CaptureAnalysisKey,
  type PerfectCorpEndpointKey,
} from "./endpoints";
import {
  creditBalanceResponseSchema,
  facialColorTonesResultSchema,
  faceAttributesResultSchema,
  fileResponseSchema,
  hairTypeResultSchema,
  normalizeTaskState,
  renderResultSchema,
  skinAnalysisResultSchema,
  taskCreateResponseSchema,
  taskStatusResponseSchema,
  type FaceAngleStrictnessLevel,
  type NormalizedTaskState,
  type SdSkinConcernKey,
} from "./schemas";

export {
  CAPTURE_ANALYSIS_KEYS,
  PERFECTCORP_AUTH,
  PERFECTCORP_CREDIT_ENDPOINT,
  PERFECTCORP_ENDPOINTS,
  PERFECTCORP_TASK_TIMEOUT_MS,
  getEndpoint,
  unitsForCall,
  verifiedEndpointKeys,
} from "./endpoints";
export type {
  AnalysisKind,
  CaptureAnalysisKey,
  PerfectCorpEndpoint,
  PerfectCorpEndpointKey,
} from "./endpoints";
export { SD_SKIN_CONCERN_KEYS, normalizeTaskState } from "./schemas";
export type { NormalizedTaskState } from "./schemas";
export { isPerfectCorpConfigured } from "./client";

const PROVIDER = "perfectcorp" as const;

/* ------------------------------------------------------------------ */
/* Account: what is left to spend                                      */
/* ------------------------------------------------------------------ */

/** One grant of units, as the account reports it. */
export interface CreditGrant {
  /** The grant kind, for example "ApiPaygToken". */
  readonly kind: string;
  readonly units: number;
  /** ISO date the grant lapses, or null when the account does not say. */
  readonly expiresAt: string | null;
}

export interface CreditBalance {
  /** Every grant added up. This is the number worth watching. */
  readonly totalUnits: number;
  readonly grants: readonly CreditGrant[];
}

/** Pure, so the summing rule is testable without a network call. */
export function totalCreditUnits(grants: readonly CreditGrant[]): number {
  return grants.reduce((sum, grant) => sum + grant.units, 0);
}

/**
 * Milliseconds since epoch to an ISO date. A value outside the range Date can
 * hold comes back as null: an unreadable expiry is not worth a thrown health
 * check.
 */
export function creditExpiryToIso(milliseconds: number | undefined): string | null {
  if (milliseconds === undefined) {
    return null;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Remaining units on the Perfect Corp account. A plain GET: it creates no task,
 * so it costs nothing and is safe to call from a health check.
 *
 * The daily cap in DAILY_CAP_PERFECTCORP_UNITS is our own guard rail. This is
 * the real ceiling behind it, which is the number that decides whether a demo
 * can run at all (docs/07-payments-and-judge-mode.md, "Caps").
 */
export async function getCreditBalance(args: {
  readonly timeoutMs?: number;
} = {}): Promise<CreditBalance> {
  const response = await perfectCorpJson({
    path: PERFECTCORP_CREDIT_ENDPOINT.path,
    method: "GET",
    schema: creditBalanceResponseSchema,
    context: "The credit balance request",
    timeoutMs: args.timeoutMs,
  });

  const grants: CreditGrant[] = response.results.map((entry) => ({
    kind: entry.type,
    units: entry.amount,
    expiresAt: creditExpiryToIso(entry.expiry),
  }));

  return { totalUnits: totalCreditUnits(grants), grants };
}

/* ------------------------------------------------------------------ */
/* Step 1 and 2: upload slot, then PUT the bytes                       */
/* ------------------------------------------------------------------ */

export interface UploadedFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly contentType: string;
}

export interface ImageToUpload {
  readonly fileName: string;
  readonly contentType: "image/jpeg" | "image/png";
  readonly bytes: ArrayBuffer;
}

/**
 * Uploads one or more images and returns their file ids. One file id is reused
 * across the capture analyses, so a selfie is uploaded once and the tasks fan
 * out from it.
 */
export async function uploadImages(
  images: readonly ImageToUpload[],
): Promise<UploadedFile[]> {
  if (images.length === 0) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_input",
      message: "An upload needs at least one image.",
    });
  }

  const slots = await perfectCorpJson({
    path: PERFECTCORP_FILE_ENDPOINT.createPath,
    method: "POST",
    schema: fileResponseSchema,
    context: "The capture upload slot request",
    body: {
      files: images.map((image) => ({
        content_type: image.contentType,
        file_name: image.fileName,
        file_size: image.bytes.byteLength,
      })),
    },
  });

  if (slots.data.files.length !== images.length) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: "The upload slot request returned a different number of slots than images sent.",
      issuePaths: ["data.files"],
    });
  }

  const uploaded: UploadedFile[] = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const slot = slots.data.files[index];
    const request = slot.requests[0];
    await perfectCorpUploadBytes({
      url: request.url,
      method: request.method,
      headers: request.headers,
      bytes: image.bytes,
    });
    uploaded.push({
      fileId: slot.file_id,
      fileName: slot.file_name,
      contentType: slot.content_type,
    });
  }
  return uploaded;
}

/** Convenience for the common single selfie case. */
export async function uploadImage(image: ImageToUpload): Promise<UploadedFile> {
  const [uploaded] = await uploadImages([image]);
  return uploaded;
}

/* ------------------------------------------------------------------ */
/* Step 3: create a task                                               */
/* ------------------------------------------------------------------ */

export interface CreatedTask {
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly taskId: string;
  /** Units the credit ledger should reserve, or null when the cost is unknown. */
  readonly unitsReserved: number | null;
}

/**
 * Creates one task. The endpoint is checked against the verification registry
 * first, so an unverified path is refused instead of spending credits.
 */
export async function createTask(args: {
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly body: Readonly<Record<string, unknown>>;
  /** Feeds the tiered cost table, for example the number of attributes asked for. */
  readonly itemCount?: number;
}): Promise<CreatedTask> {
  assertEndpointVerified(args.endpointKey);
  const endpoint = getEndpoint(args.endpointKey);

  const response = await perfectCorpJson({
    path: endpoint.createPath,
    method: "POST",
    schema: taskCreateResponseSchema,
    context: `The ${args.endpointKey} task request`,
    body: args.body,
  });

  return {
    endpointKey: args.endpointKey,
    taskId: response.data.task_id,
    unitsReserved: unitsForCall(args.endpointKey, args.itemCount ?? 1),
  };
}

/* ------------------------------------------------------------------ */
/* Step 4: one poll                                                    */
/* ------------------------------------------------------------------ */

export interface TaskSnapshot {
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly taskId: string;
  readonly state: NormalizedTaskState;
  /** Present only when the state is succeeded. */
  readonly results: unknown;
  /** Present only when the state is failed. */
  readonly errorCode: string | null;
  /** Seconds the provider asks us to wait, when it says. */
  readonly pollingIntervalSeconds: number | null;
}

/**
 * Reads a task once. There is no loop here on purpose: polling is driven by our
 * own GET /api/jobs handler, per docs/03-architecture.md.
 */
export async function getTaskSnapshot(args: {
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly taskId: string;
}): Promise<TaskSnapshot> {
  assertEndpointVerified(args.endpointKey);

  const response = await perfectCorpJson({
    path: statusPathFor(args.endpointKey, args.taskId),
    method: "GET",
    schema: taskStatusResponseSchema,
    context: `The ${args.endpointKey} task status request`,
  });

  const state = normalizeTaskState(response.data.task_status);
  const rawCode = response.data.error_code;
  return {
    endpointKey: args.endpointKey,
    taskId: args.taskId,
    state,
    results: state === "succeeded" ? response.data.results : undefined,
    errorCode:
      state === "failed"
        ? (rawCode === undefined ? (response.data.error ?? null) : String(rawCode))
        : null,
    pollingIntervalSeconds: response.data.polling_interval ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Result parsing                                                      */
/* ------------------------------------------------------------------ */

function parseResults<T extends z.ZodTypeAny>(
  snapshot: TaskSnapshot,
  schema: T,
): z.infer<T> {
  if (snapshot.state !== "succeeded") {
    throw new ProviderError({
      provider: PROVIDER,
      code: "task_failed",
      message: `The ${snapshot.endpointKey} task did not succeed.`,
      providerCode: snapshot.errorCode ?? undefined,
    });
  }
  const parsed = schema.safeParse(snapshot.results);
  if (!parsed.success) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: `The ${snapshot.endpointKey} result did not match the expected shape.`,
      issuePaths: issuePathsOf(parsed.error.issues),
    });
  }
  return parsed.data as z.infer<T>;
}

export const parseSkinAnalysisResult = (snapshot: TaskSnapshot) =>
  parseResults(snapshot, skinAnalysisResultSchema);

export const parseFacialColorTonesResult = (snapshot: TaskSnapshot) =>
  parseResults(snapshot, facialColorTonesResultSchema);

export const parseFaceAttributesResult = (snapshot: TaskSnapshot) =>
  parseResults(snapshot, faceAttributesResultSchema);

export const parseHairTypeResult = (snapshot: TaskSnapshot) =>
  parseResults(snapshot, hairTypeResultSchema);

/** Pulls the render URLs out of whichever result shape the endpoint uses. */
export function parseRenderUrls(snapshot: TaskSnapshot): string[] {
  const result = parseResults(snapshot, renderResultSchema);
  if (Array.isArray(result)) {
    return result.map((entry) => entry.url);
  }
  if ("urls" in result) {
    return [...result.urls];
  }
  return [result.url];
}

/* ------------------------------------------------------------------ */
/* Capture fan out                                                     */
/* ------------------------------------------------------------------ */

export interface CaptureFanOutInput {
  /** The one uploaded selfie every analysis reads. */
  readonly fileId: string;
  /** SD concern keys for the skin analysis call. SD and HD cannot be mixed. */
  readonly skinConcerns: readonly SdSkinConcernKey[];
  /** Face attribute names for the face attributes call. */
  readonly faceAttributes: readonly string[];
  readonly faceAngleStrictness?: FaceAngleStrictnessLevel;
  /**
   * Hair type detection takes three photos of the same size (front, right,
   * left). Leave this empty to skip it: the capture flow only has one selfie.
   */
  readonly hairTypeFileIds?: readonly string[];
}

export type CaptureFanOutOutcome =
  | { readonly key: CaptureAnalysisKey; readonly ok: true; readonly task: CreatedTask }
  | { readonly key: CaptureAnalysisKey; readonly ok: false; readonly error: ProviderError }
  | { readonly key: CaptureAnalysisKey; readonly ok: false; readonly skipped: true; readonly reason: string };

function bodyForCaptureAnalysis(
  key: CaptureAnalysisKey,
  input: CaptureFanOutInput,
): Record<string, unknown> {
  switch (key) {
    case "skinAnalysis":
      return {
        src_file_id: input.fileId,
        dst_actions: [...input.skinConcerns],
        format: "json",
      };
    case "fitzpatrick":
      return { src_file_id: input.fileId };
    case "facialColorTones":
      return {
        src_file_id: input.fileId,
        face_angle_strictness_level: input.faceAngleStrictness ?? "high",
      };
    case "faceAttributes":
      return {
        src_file_id: input.fileId,
        dst_actions: [...input.faceAttributes],
      };
    case "hairType":
      return { src_file_ids: [...(input.hairTypeFileIds ?? [])] };
  }
}

function itemCountForCaptureAnalysis(
  key: CaptureAnalysisKey,
  input: CaptureFanOutInput,
): number {
  if (key === "skinAnalysis") {
    return input.skinConcerns.length;
  }
  if (key === "faceAttributes") {
    return input.faceAttributes.length;
  }
  return 1;
}

/**
 * Starts the capture analyses in parallel from one uploaded file id. Each
 * outcome is reported on its own so the reveal can show results as they land
 * and a single refused endpoint does not sink the whole capture.
 */
export async function createCaptureAnalysisTasks(
  input: CaptureFanOutInput,
): Promise<CaptureFanOutOutcome[]> {
  const jobs = CAPTURE_ANALYSIS_KEYS.map(
    async (key): Promise<CaptureFanOutOutcome> => {
      if (key === "hairType") {
        const ids = input.hairTypeFileIds ?? [];
        const needed = getEndpoint("hairType").imageConstraints?.imagesPerCall ?? 3;
        if (ids.length !== needed) {
          return {
            key,
            ok: false,
            skipped: true,
            reason: `Hair type detection needs ${needed} photos of the same size and received ${ids.length}.`,
          };
        }
      }
      try {
        const task = await createTask({
          endpointKey: key,
          body: bodyForCaptureAnalysis(key, input),
          itemCount: itemCountForCaptureAnalysis(key, input),
        });
        return { key, ok: true, task };
      } catch (thrown) {
        if (thrown instanceof ProviderError) {
          return { key, ok: false, error: thrown };
        }
        throw thrown;
      }
    },
  );

  return Promise.all(jobs);
}

/**
 * Total units one full capture set reserves. Returns null when any endpoint in
 * the set still has an unknown cost, which the credits layer reads as "do not
 * reserve until the credit table is filled".
 */
export function unitsForCaptureSet(input: CaptureFanOutInput): number | null {
  let total = 0;
  for (const key of CAPTURE_ANALYSIS_KEYS) {
    if (key === "hairType" && (input.hairTypeFileIds ?? []).length === 0) {
      continue;
    }
    const units = unitsForCall(key, itemCountForCaptureAnalysis(key, input));
    if (units === null) {
      return null;
    }
    total += units;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Result download                                                     */
/* ------------------------------------------------------------------ */

export interface DownloadedAsset {
  readonly sourceUrl: string;
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}

/**
 * Downloads mask or render outputs. Result URLs expire, so this runs as soon as
 * a task succeeds and the bytes go into our private buckets.
 */
export async function downloadResultAssets(
  urls: readonly string[],
): Promise<DownloadedAsset[]> {
  return Promise.all(
    urls.map(async (url) => {
      const { bytes, contentType } = await perfectCorpDownloadResult(url);
      return { sourceUrl: url, bytes, contentType };
    }),
  );
}
