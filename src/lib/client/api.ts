/**
 * The browser side of the app's own routes.
 *
 * Every response is parsed with zod before it reaches a screen, because a route
 * handler is an external boundary like any other (CLAUDE.md, "Conventions").
 * Nothing here reads a provider, a key, or an environment secret.
 *
 * Error copy is never taken from the response body. A route returns
 * {error: string} and that string is for the log and for a human reading the
 * network tab; the sentence a person sees is chosen here from copy.ts, so the
 * voice rules hold even if a route is changed.
 */

import { z } from "zod";

import { ANALYSIS_FAILURE_REASONS } from "@/lib/shared/analysis-failure";
import {
  analysisKindSchema,
  CONSENT_VERSION,
  httpUrlSchema,
  jobStatusSchema,
  type CaptureCreateRequest,
  type ConsentRequest,
} from "@/lib/shared/schemas";

export { CONSENT_VERSION };

export type ApiFailureKind =
  /** The request never reached the server. */
  | "network"
  /** 401. No session, or a code that did not match. */
  | "unauthorized"
  /** 403. Consent is missing. */
  | "forbidden"
  /** 429. A judge session or a daily cap is exhausted. */
  | "capped"
  /** The response arrived but did not match its schema. */
  | "invalid"
  /** Any other non success status. */
  | "server";

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly kind: ApiFailureKind; readonly status: number };

function failureKind(status: number): ApiFailureKind {
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "capped";
  }
  return "server";
}

async function request<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    return { ok: false, kind: "network", status: 0 };
  }

  if (!response.ok) {
    return { ok: false, kind: failureKind(response.status), status: response.status };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "invalid", status: response.status };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, kind: "invalid", status: response.status };
  }
  return { ok: true, data: parsed.data };
}

function postJson<T>(
  url: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  return request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    schema,
  );
}

// ---------------------------------------------------------------------------
// Judge session
// ---------------------------------------------------------------------------

const judgeSessionResponseSchema = z.object({
  analysesRemaining: z.number().int().min(0),
  /**
   * What the session was given, which is not always three. A build that gives
   * judges the saved demo profile and no live readings sets
   * JUDGE_ANALYSES_ALLOWED=0 (docs/07-payments-and-judge-mode.md), and a screen
   * cannot tell that apart from a spent session without this number.
   */
  analysesAllowed: z.number().int().min(0),
});

export type JudgeSessionResponse = z.infer<typeof judgeSessionResponseSchema>;

export function createJudgeSession(
  code: string,
): Promise<ApiResult<JudgeSessionResponse>> {
  return postJson("/api/judge/session", { code }, judgeSessionResponseSchema);
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

const consentResponseSchema = z.object({ ok: z.literal(true) });

/**
 * POST /api/consent. The body is consentRequestSchema from
 * src/lib/shared/schemas.ts, which is what the route parses, so the shape is
 * checked at compile time on the way out and at run time on the way in.
 *
 * Both answers are literal true: this is only ever called once both boxes are
 * checked, and a false would be a validation failure rather than a stored no.
 */
export function saveConsent(
  keepOriginals: boolean,
): Promise<ApiResult<{ ok: true }>> {
  const body: ConsentRequest = {
    isAdultConfirmed: true,
    agreesToProcessing: true,
    keepOriginals,
    consentVersion: CONSENT_VERSION,
  };
  return postJson("/api/consent", body, consentResponseSchema);
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

const captureCreateResponseSchema = z.union([
  z.object({
    captureId: z.string().min(1),
    status: z.literal("exists"),
  }),
  z.object({
    captureId: z.string().min(1),
    status: z.literal("new"),
    uploadUrl: z.string().min(1),
    storagePath: z.string().min(1),
  }),
]);

export type CaptureCreateResponse = z.infer<typeof captureCreateResponseSchema>;

/**
 * The capture body is captureCreateRequestSchema from
 * src/lib/shared/schemas.ts, which is what the route parses. quality is the
 * flattened assessCapture output: verdict, reason, and the five metrics.
 *
 * There is no separate "exposure" field. The exposure measure the architecture
 * doc names is meanLuminance, 0 to 255, and the route stores it under
 * quality.exposure in the captures row.
 */
export type CaptureCreateBody = CaptureCreateRequest;

export type CaptureQualityPayload = CaptureCreateRequest["quality"];

export function createCapture(
  body: CaptureCreateBody,
): Promise<ApiResult<CaptureCreateResponse>> {
  return postJson("/api/captures", body, captureCreateResponseSchema);
}

/**
 * Uploads the image bytes to the signed URL the capture route returned. The URL
 * is short lived and single use; nothing about it is stored.
 */
export async function uploadCaptureImage(
  uploadUrl: string,
  blob: Blob,
): Promise<ApiResult<null>> {
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": blob.type },
      body: blob,
    });
  } catch {
    return { ok: false, kind: "network", status: 0 };
  }
  if (!response.ok) {
    return { ok: false, kind: failureKind(response.status), status: response.status };
  }
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * The job as the polling routes return it. Narrower than jobSchema in
 * src/lib/shared/schemas.ts, which describes the stored row.
 *
 * An unknown kind is read as null rather than failing the parse, so a new
 * analysis kind added on the server cannot strand the reveal screen.
 */
export const clientJobSchema = z.object({
  id: z.string().min(1),
  kind: analysisKindSchema.nullable().catch(null),
  status: jobStatusSchema,
  error: z.string().nullable().optional(),
  /**
   * Why a failed reading failed, as a class rather than a sentence: the engine's
   * own code decides it on the server (src/lib/shared/analysis-failure.ts) and
   * the class is what tells the reveal whether a tighter crop of the same photo
   * is worth sending. The sentence in `error` cannot answer that, because two
   * classes can honestly share one line of copy.
   *
   * Absent on every job that has not failed, and read as null when it carries a
   * class this build does not know, so an older or newer server cannot strand
   * the screen.
   */
  reason: z.enum(ANALYSIS_FAILURE_REASONS).nullable().optional().catch(null),
});

export type ClientJob = z.infer<typeof clientJobSchema>;

const analyzeResponseSchema = z.object({ jobs: z.array(clientJobSchema) });

const jobsResponseSchema = z.object({
  jobs: z.array(clientJobSchema),
  complete: z.boolean().optional(),
  /**
   * A signed URL for the mask the reveal blooms, present once the skin analysis
   * has come back with one. Optional because it is absent from every poll before
   * that, and because a build that cannot sign it still has a screen to show:
   * src/components/analyzing/RevealMask.tsx falls back to the oval.
   */
  maskUrl: httpUrlSchema.nullable().optional(),
});

export type JobsResponse = z.infer<typeof jobsResponseSchema>;

export function startAnalysis(
  captureId: string,
): Promise<ApiResult<{ jobs: ClientJob[] }>> {
  return postJson(
    `/api/captures/${encodeURIComponent(captureId)}/analyze`,
    {},
    analyzeResponseSchema,
  );
}

export function fetchJobs(captureId: string): Promise<ApiResult<JobsResponse>> {
  return request(
    `/api/jobs?capture=${encodeURIComponent(captureId)}`,
    { method: "GET", cache: "no-store" },
    jobsResponseSchema,
  );
}
