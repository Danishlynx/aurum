/**
 * The browser side of the wardrobe routes /wardrobe calls.
 *
 * It lives beside the screen for the same reason
 * src/components/makeup/renders-client.ts does: these are one screen's own
 * calls. The rules are src/lib/client/api.ts's rules. Every response is parsed
 * with zod before it reaches a component, and no sentence a person reads is ever
 * taken from a response body: a route returns {error: string} for the log and
 * the network tab, and the screen picks its line from copy.ts.
 *
 * Routes, docs/01-user-flow.md section J and the Layer 4 contract:
 *
 *   GET    /api/wardrobe                the grid, after every change
 *   POST   /api/garments                one signed upload slot per photo
 *   PUT    <slot.uploadUrl>             the bytes, straight to storage
 *   POST   /api/garments/{id}/classify  reads one photo and fills its chips
 *   PATCH  /api/garments/{id}           "Tap a chip to correct it."
 *
 * No image bytes pass through this app's own server, which is what
 * docs/03-architecture.md asks for: the browser uploads to the signed URL and
 * the server never holds the file.
 *
 * Failures are typed rather than described. "read_only" is the honest 403 the
 * demo profile answers with, "full" is the wardrobe ceiling, and everything else
 * is one kind, because from the person's side a 500, a dropped connection, and a
 * schema that did not match are the same event: it did not save.
 */

import { z } from "zod";

import { isSafeListingUrl } from "@/components/ui/remote-image";
import {
  MAX_GARMENTS_PER_REQUEST,
  type GarmentPatchRequest,
  type GarmentView,
  type WardrobeView,
} from "@/lib/shared/wardrobe-view";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * An image source a card may draw: a same origin path this app serves (the
 * fixture silhouettes) or an http or https URL (a signed read of the person's
 * own object). Anything else, including javascript: and data:, never reaches an
 * img src.
 */
function isDrawableImage(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return true;
  }
  return isSafeListingUrl(value);
}

const imageSourceSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isDrawableImage, "Expected an image path or an http URL.");

const garmentColorSchema = z.object({
  name: z.string().min(1),
  hex: z.string().min(1),
});

/**
 * GarmentView from src/lib/shared/wardrobe-view.ts, as a schema.
 *
 * type, pattern, and formality are read as plain strings here and turned into
 * chips by garmentTypeLabel and friends, which return null for a word outside
 * the vocabulary. A value the app cannot draw therefore becomes a missing chip
 * rather than a failed parse that would blank the whole grid.
 */
const garmentViewSchema = z.object({
  id: z.string().min(1),
  imageUrl: imageSourceSchema.nullable(),
  type: z.string().nullable(),
  colors: z.array(garmentColorSchema),
  pattern: z.string().nullable(),
  formality: z.enum(["casual", "smart", "formal"]).nullable(),
  userEdited: z.boolean(),
  classificationStatus: z.enum(["pending", "succeeded", "failed"]),
});

const wardrobeViewSchema = z.object({
  garments: z.array(garmentViewSchema),
});

const uploadSlotSchema = z.object({
  garmentId: z.string().min(1),
  uploadUrl: z.string().min(1),
  storagePath: z.string().min(1),
  /** Carried by the route for a client using uploadToSignedUrl. Not used here. */
  uploadToken: z.string().min(1).optional(),
  expiresInSeconds: z.number().optional(),
});

export type GarmentSlot = z.infer<typeof uploadSlotSchema>;

const garmentCreateResponseSchema = z.object({
  slots: z.array(uploadSlotSchema).min(1).max(MAX_GARMENTS_PER_REQUEST),
});

const classifyResponseSchema = z.object({
  jobId: z.string().min(1),
  garmentId: z.string().min(1),
  status: z.enum(["pending", "succeeded", "failed"]),
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Why a call did not do what it was asked.
 *
 * "read_only" is the 403 the demo profile answers every write with, and it is
 * kept apart from the rest so the screen can say so instead of claiming an
 * ordinary failure. "full" is the 409 from the wardrobe ceiling.
 */
export type WardrobeFailure = "read_only" | "full" | "other";

export type WardrobeResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: WardrobeFailure };

function failureFor(status: number): WardrobeFailure {
  if (status === 403) {
    return "read_only";
  }
  if (status === 409) {
    return "full";
  }
  return "other";
}

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function call<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<WardrobeResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    return { ok: false, failure: "other" };
  }

  if (!response.ok) {
    return { ok: false, failure: failureFor(response.status) };
  }

  const parsed = schema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false, failure: "other" };
  }
  return { ok: true, data: parsed.data };
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** The grid as it stands. Re read after every upload, classification, and correction. */
export function fetchWardrobe(): Promise<WardrobeResult<WardrobeView>> {
  return call("/api/wardrobe", { method: "GET", cache: "no-store" }, wardrobeViewSchema);
}

/** One row and one signed upload slot per photo the person picked. */
export function createGarmentSlots(
  count: number,
): Promise<WardrobeResult<{ slots: GarmentSlot[] }>> {
  return call(
    "/api/garments",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
    },
    garmentCreateResponseSchema,
  );
}

/**
 * The bytes, straight to storage. The URL is short lived and single use, and
 * nothing about it is stored (the same PUT the capture flow makes).
 */
export async function uploadGarmentImage(
  uploadUrl: string,
  blob: Blob,
): Promise<boolean> {
  try {
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": blob.type },
      body: blob,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reads one garment photo and fills its chips.
 *
 * The answer carries a job id, not a garment: the screen re reads
 * GET /api/wardrobe afterwards, so every chip it draws comes from the stored row
 * rather than from the response to the call that produced it. A refusal (no key,
 * a cap, the kill switch) leaves the row with empty chips and a failed job,
 * which the grid then shows as the failed card. Nothing is guessed in its place.
 */
export function classifyGarment(
  garmentId: string,
): Promise<WardrobeResult<z.infer<typeof classifyResponseSchema>>> {
  return call(
    `/api/garments/${encodeURIComponent(garmentId)}/classify`,
    { method: "POST" },
    classifyResponseSchema,
  );
}

/**
 * "Tap a chip to correct it." The answer is the stored row, so the card redraws
 * from what was written rather than from what was asked for.
 */
export function patchGarment(
  garmentId: string,
  patch: GarmentPatchRequest,
): Promise<WardrobeResult<GarmentView>> {
  return call(
    `/api/garments/${encodeURIComponent(garmentId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
    garmentViewSchema,
  );
}
