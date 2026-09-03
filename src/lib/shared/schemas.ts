/**
 * zod schemas for the boundaries both sides of the app share: route request
 * bodies, the job polling response, and the normalized listing.
 *
 * docs/03-architecture.md, "Security boundaries in code": all route inputs are
 * parsed with zod and unknown fields are stripped. z.object strips unknown keys
 * by default, which is exactly that behaviour, so these schemas are used as
 * written on the server.
 *
 * Provider wire formats do not live here. Each provider module owns its own
 * schemas.ts (docs/04-integrations.md). This file is only for shapes that cross
 * between our client and our server.
 */

import { z } from "zod";

import { CONCERN_KEYS } from "./concerns";
import { CAPTURE_REASON_PRECEDENCE, CAPTURE_VERDICTS } from "./quality";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A SHA 256 digest as 64 lowercase hex characters. The client hashes the
 * downscaled, EXIF stripped image and sends this; the server looks it up in
 * captures before spending a credit (docs/03-architecture.md, "Caching").
 */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Expected a 64 character lowercase sha256 digest.");

/**
 * An image edge in pixels. The client downscales to a 1024px long edge before
 * upload, so the ceiling is generous rather than tight.
 */
export const imageDimensionSchema = z
  .number()
  .int()
  .min(1)
  .max(8192);

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * An http or https URL. Anything else, including javascript: and data:, is
 * rejected. Listing URLs come from SerpApi, which is untrusted input, and the
 * app puts them in an anchor.
 */
export const httpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isHttpUrl, "Expected an http or https URL.");

export const concernKeySchema = z.enum(CONCERN_KEYS);

export const captureVerdictSchema = z.enum(CAPTURE_VERDICTS);

export const captureRejectionReasonSchema = z.enum(CAPTURE_REASON_PRECEDENCE);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * The quality gate output the client sends with a capture, stored in
 * captures.quality (docs/03-architecture.md data model). It is a superset of
 * the sharpness, exposure, and face coverage the doc names, because assessCapture
 * already produces the rest and the eval suite wants the raw numbers.
 *
 * The server recomputes the gate on the uploaded object. These values are for
 * the record and for eval:capture, never the sole basis for spending a credit.
 */
export const captureQualitySchema = z.object({
  verdict: captureVerdictSchema,
  reason: captureRejectionReasonSchema.nullable(),
  /** Laplacian variance. Not bounded above; a sharp image can be in the thousands. */
  sharpness: z.number().nonnegative(),
  blownFraction: z.number().min(0).max(1),
  crushedFraction: z.number().min(0).max(1),
  meanLuminance: z.number().min(0).max(255),
  /** Null when no face box was available. */
  faceCoverage: z.number().min(0).max(1).nullable(),
});

export type CaptureQuality = z.infer<typeof captureQualitySchema>;

/**
 * POST /api/captures. The body carries no image bytes: the server answers with
 * a signed upload URL, or with the existing capture when the hash is a cache
 * hit (docs/03-architecture.md, "Request flow for a capture").
 *
 * A frame the gate rejected is refused here, because docs/04-integrations.md
 * says never send a photo that failed our quality gate. "Use it anyway" sends a
 * borderline frame, which is allowed.
 */
export const captureCreateRequestSchema = z
  .object({
    sha256: sha256HexSchema,
    width: imageDimensionSchema,
    height: imageDimensionSchema,
    quality: captureQualitySchema,
  })
  .refine(
    (body) => body.quality.verdict !== "reject",
    "A capture that failed the quality gate is not uploaded.",
  );

export type CaptureCreateRequest = z.infer<typeof captureCreateRequestSchema>;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * The version of the consent text on /welcome, and the single source of truth
 * for it. docs/06-safety-privacy.md: "Consent text is versioned. If it changes,
 * people re consent on next visit."
 *
 * The value matches the default on profiles.consent_version in migration
 * 0002_identity_and_capture.sql, so a row written by a route and a row that fell
 * back to the column default read the same. Bump both together, and only when a
 * string under copy.welcome or copy.privacy changes.
 */
export const CONSENT_VERSION = "v2";

/**
 * POST from /welcome. Both boxes are required, so both are literal true rather
 * than boolean: a false value is a validation failure, not a stored no.
 * docs/06-safety-privacy.md, "Consent".
 *
 * consentVersion is the version of the consent text the person actually read.
 * When the text changes, the version changes and people re consent.
 */
export const consentRequestSchema = z.object({
  isAdultConfirmed: z.literal(true),
  agreesToProcessing: z.literal(true),
  /** "Keep my original photo so I can compare later". Default off. */
  keepOriginals: z.boolean(),
  consentVersion: z.string().min(1).max(32),
});

export type ConsentRequest = z.infer<typeof consentRequestSchema>;

// ---------------------------------------------------------------------------
// Judge session
// ---------------------------------------------------------------------------

/**
 * POST /api/judge/session. The code is compared against JUDGE_ACCESS_CODE_HASH
 * on the server; it is never stored or logged in the clear
 * (docs/07-payments-and-judge-mode.md and docs/06-safety-privacy.md).
 */
export const judgeSessionRequestSchema = z.object({
  code: z.string().trim().min(4).max(64),
});

export type JudgeSessionRequest = z.infer<typeof judgeSessionRequestSchema>;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** analyses.kind in docs/03-architecture.md. */
export const analysisKindSchema = z.enum([
  "skin",
  "fitzpatrick",
  "attributes",
  "face_shape",
  "hair_type",
]);

/** jobs.subject_type in docs/03-architecture.md. */
export const jobSubjectTypeSchema = z.enum([
  "analysis",
  "render",
  "classification",
]);

export const jobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

/** succeeded and failed are terminal. The reveal advances on terminal states. */
export const TERMINAL_JOB_STATUSES = ["succeeded", "failed"] as const;

export const jobSchema = z.object({
  id: z.uuid(),
  subjectType: jobSubjectTypeSchema,
  subjectId: z.uuid(),
  /** The analysis kind for an analysis job, null for renders and classification. */
  kind: analysisKindSchema.nullable(),
  status: jobStatusSchema,
  attempts: z.number().int().min(0),
  /**
   * A sentence from copy.errors, never a provider message. Null unless failed.
   * docs/01-user-flow.md: errors say what happened and what to do.
   */
  error: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export type Job = z.infer<typeof jobSchema>;

/**
 * GET /api/jobs?capture={id}. The client polls this every 1.5 seconds and the
 * reveal advances as results land, in any order
 * (docs/03-architecture.md, "Request flow for a capture" step 5).
 */
export const jobStatusResponseSchema = z.object({
  captureId: z.uuid(),
  jobs: z.array(jobSchema),
  /** True when every job for this capture is terminal. */
  complete: z.boolean(),
});

export type JobStatusResponse = z.infer<typeof jobStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

/**
 * The normalized product listing from SerpApi
 * (docs/04-integrations.md: Listing { title, priceText, priceValue, currency,
 * url, imageUrl, store }).
 *
 * url and priceValue are required and not nullable. That is the grounding rule
 * in one line: a product is only shown if we fetched a real listing with a
 * source URL and a price. No listing, no product.
 *
 * priceText is what we display, exactly as returned. priceValue exists only for
 * sorting within a relevance band; it is never rendered and never converted.
 *
 * currency is UNVERIFIED in shape. SerpApi returns a code for some engines and
 * a symbol for others, so this accepts a short string. Tighten it in the
 * SerpApi provider module once the field shapes are confirmed against the live
 * docs, per the verify first task in docs/04-integrations.md.
 */
export const listingSchema = z.object({
  title: z.string().min(1).max(300),
  priceText: z.string().min(1).max(64),
  priceValue: z.number().positive(),
  currency: z.string().min(1).max(8),
  url: httpUrlSchema,
  /** Null when the result had no usable thumbnail. */
  imageUrl: httpUrlSchema.nullable(),
  store: z.string().min(1).max(120),
});

export type Listing = z.infer<typeof listingSchema>;

export const listingsSchema = z.array(listingSchema);
