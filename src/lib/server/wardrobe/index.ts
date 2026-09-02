import "server-only";

import { z } from "zod";

import {
  garmentClassificationStatus,
  isGarmentFormality,
  isGarmentPattern,
  isGarmentType,
  MAX_GARMENT_COLORS,
  MAX_GARMENTS_PER_REQUEST,
  MAX_GARMENTS_PER_WARDROBE,
  type ClassificationJobStatus,
  type GarmentColor,
  type GarmentPatchRequest,
  type GarmentUploadSlot,
  type GarmentView,
  type WardrobeView,
} from "@/lib/shared/wardrobe-view";

import { listJobsForSubjects } from "../db";
import {
  BUCKETS,
  createSignedRead,
  createSignedUpload,
  removeObjects,
} from "../db/storage";
import type { Garment, Insert, JobRecord, Json } from "../db/types";
import { demoFixtureNote, planDemoRead } from "../judge/demo";
import { DEMO_FIXTURE_WARDROBE } from "../profile/demo-fixture-wardrobe";
import type { AppSession } from "../session";
import {
  countGarments,
  deleteGarmentRow,
  getGarment,
  insertGarment,
  listGarments,
  updateGarment,
} from "./db";

export {
  classifyGarment,
  MAX_CLASSIFIER_IMAGE_BYTES,
  type ClassifyGarmentOutcome,
  type ClassifyGarmentRefusal,
} from "./classify";

/**
 * The wardrobe: garments in, chips corrected, garments out.
 *
 * docs/01-user-flow.md section J is the screen this fills: an empty state that
 * invites one specific action, an add flow that turns photos into cards, and a
 * grid of cards whose chips the person can correct.
 *
 * Three things this deliberately does not do:
 *
 * 1. It never invents an attribute. A garment nobody has read shows skeleton
 *    chips and a garment the classifier could not read shows the failed card
 *    copy. The classification itself is src/lib/server/wardrobe/classify.ts.
 * 2. It never accepts a word outside the vocabulary in
 *    src/lib/shared/wardrobe-view.ts, from the model or from the person, so the
 *    grid can only ever draw a chip it has a label for.
 * 3. It never returns a photo that is not this person's. Every read is a short
 *    lived signed URL for an object under their own prefix in the private
 *    garments bucket (docs/06-safety-privacy.md, "Access").
 */

/** garments/<owner_id>/<garment_id>.<ext>, the convention in migration 0006. */
export function garmentPath(
  ownerId: string,
  garmentId: string,
  extension = "jpg",
): string {
  return `${ownerId}/${garmentId}.${extension}`;
}

/**
 * The extension the path carries. The client downscales a garment photo to JPEG
 * before upload, the same as a capture, and the real content type comes from
 * the upload itself, so this is a naming convention rather than a claim about
 * the bytes.
 */
const GARMENT_EXTENSION = "jpg";

// ---------------------------------------------------------------------------
// Reading the row
// ---------------------------------------------------------------------------

const storedColorSchema = z.object({
  name: z.string().min(1).max(64),
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
});

const storedColorsSchema = z.array(storedColorSchema);

/**
 * garments.colors as the screen reads it.
 *
 * A column that does not parse reads as no colours rather than as a broken
 * card: the chips are one part of a garment, and a garment with an unreadable
 * colour list still has a photo, a type, and a place in a look.
 */
export function readStoredColors(value: Json | null): GarmentColor[] {
  if (value === null) {
    return [];
  }
  const parsed = storedColorsSchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  return parsed.data
    .slice(0, MAX_GARMENT_COLORS)
    .map((color) => ({ name: color.name, hex: color.hex.toLowerCase() }));
}

/** A stored type, or null when the column holds a word the app cannot draw. */
function readStoredType(value: string | null): string | null {
  return value !== null && isGarmentType(value) ? value : null;
}

function readStoredPattern(value: string | null): string | null {
  return value !== null && isGarmentPattern(value) ? value : null;
}

function readStoredFormality(
  value: string | null,
): "casual" | "smart" | "formal" | null {
  return value !== null && isGarmentFormality(value) ? value : null;
}

/** A signed URL for a garment photo, or null. Never a substitute image. */
async function signGarment(storagePath: string): Promise<string | null> {
  try {
    return await createSignedRead(BUCKETS.garments, storagePath);
  } catch {
    return null;
  }
}

/** The latest classification job per garment id. */
function classificationJobsByGarment(
  jobs: readonly JobRecord[],
): Map<string, JobRecord> {
  const found = new Map<string, JobRecord>();
  for (const job of jobs) {
    if (job.subject_type !== "classification" || job.subject_id === null) {
      continue;
    }
    // listJobsForSubjects orders oldest first, so the last write wins.
    found.set(job.subject_id, job);
  }
  return found;
}

async function toView(args: {
  readonly garment: Garment;
  readonly job: JobRecord | undefined;
}): Promise<GarmentView> {
  const type = readStoredType(args.garment.type);
  const jobStatus: ClassificationJobStatus | null =
    args.job === undefined ? null : args.job.status;

  return {
    id: args.garment.id,
    imageUrl: await signGarment(args.garment.storage_path),
    type,
    colors: readStoredColors(args.garment.colors),
    pattern: readStoredPattern(args.garment.pattern),
    formality: readStoredFormality(args.garment.formality),
    userEdited: args.garment.user_edited,
    classificationStatus: garmentClassificationStatus({
      hasType: type !== null,
      jobStatus,
    }),
  };
}

/**
 * Everything /wardrobe needs, in one object.
 *
 * An empty wardrobe is an empty array, not an error: docs/01 section J opens on
 * the empty state, which is a screen in its own right.
 */
export async function buildWardrobeView(
  session: AppSession,
): Promise<WardrobeView> {
  const plan = await planDemoRead(session);
  if (plan.source === "fixture") {
    console.log(
      JSON.stringify({
        event: "aurum.wardrobe_view",
        source: "fixture",
        reason: plan.reason,
        note: demoFixtureNote(plan.reason, "the garments are served"),
      }),
    );
    return DEMO_FIXTURE_WARDROBE;
  }

  const garments = await listGarments(plan.ownerId);
  if (garments.length === 0) {
    return { garments: [] };
  }

  const jobs = await listJobsForSubjects(
    plan.ownerId,
    garments.map((garment) => garment.id),
  );
  const jobByGarment = classificationJobsByGarment(jobs);

  const views: GarmentView[] = [];
  for (const garment of garments) {
    views.push(await toView({ garment, job: jobByGarment.get(garment.id) }));
  }
  return { garments: views };
}

/** One garment, for the routes that answer about a single card. */
export async function buildGarmentView(args: {
  readonly session: AppSession;
  readonly garment: Garment;
}): Promise<GarmentView> {
  const jobs = await listJobsForSubjects(args.session.id, [args.garment.id]);
  return toView({
    garment: args.garment,
    job: classificationJobsByGarment(jobs).get(args.garment.id),
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type CreateGarmentsOutcome =
  | { readonly ok: true; readonly slots: GarmentUploadSlot[] }
  | { readonly ok: false; readonly reason: "wardrobe_full"; readonly remaining: number };

/**
 * Claims one row and one signed upload slot per garment.
 *
 * No image bytes reach this server. The row is written first so the id exists,
 * because storage_path is not null and the path is built from that id; the
 * client then uploads straight to storage, exactly as the capture flow does
 * (docs/03-architecture.md, "Request flow for a capture" steps 2 and 3).
 *
 * A row whose upload never lands is a garment with an empty card, which the
 * classify call turns into the failed state and the person can delete. That is
 * a better failure than a signed URL with nothing to point at.
 */
export async function createGarmentSlots(args: {
  readonly session: AppSession;
  readonly count: number;
}): Promise<CreateGarmentsOutcome> {
  const ownerId = args.session.id;
  const count = Math.min(Math.max(1, Math.trunc(args.count)), MAX_GARMENTS_PER_REQUEST);

  const existing = await countGarments(ownerId);
  const remaining = Math.max(0, MAX_GARMENTS_PER_WARDROBE - existing);
  if (remaining < count) {
    return { ok: false, reason: "wardrobe_full", remaining };
  }

  const slots: GarmentUploadSlot[] = [];
  for (let index = 0; index < count; index += 1) {
    const garmentId = crypto.randomUUID();
    const storagePath = garmentPath(ownerId, garmentId, GARMENT_EXTENSION);

    const row: Insert<"garments"> = {
      id: garmentId,
      user_id: ownerId,
      storage_path: storagePath,
    };
    const garment = await insertGarment(row);

    const upload = await createSignedUpload(BUCKETS.garments, storagePath);
    slots.push({
      garmentId: garment.id,
      uploadUrl: upload.uploadUrl,
      uploadToken: upload.token,
      storagePath: upload.storagePath,
      expiresInSeconds: upload.expiresInSeconds,
    });
  }

  console.log(
    JSON.stringify({
      event: "aurum.garment_slots_created",
      ownerType: args.session.ownerType,
      ownerId,
      count: slots.length,
    }),
  );

  return { ok: true, slots };
}

// ---------------------------------------------------------------------------
// Correct
// ---------------------------------------------------------------------------

export type PatchGarmentOutcome =
  | { readonly ok: true; readonly view: GarmentView }
  | { readonly ok: false; readonly reason: "not_found" };

/**
 * "Tap a chip to correct it." (docs/01-user-flow.md section J item 2).
 *
 * Only the chips the body carries move, and every value has already been
 * checked against the vocabulary by the schema at the route boundary. The write
 * always sets user_edited, which is what stops a later classifier answer from
 * quietly replacing the person's own words (migration 0003).
 */
export async function patchGarment(args: {
  readonly session: AppSession;
  readonly garmentId: string;
  readonly patch: GarmentPatchRequest;
}): Promise<PatchGarmentOutcome> {
  const ownerId = args.session.id;
  const existing = await getGarment(ownerId, args.garmentId);
  if (existing === null) {
    return { ok: false, reason: "not_found" };
  }

  const patch: {
    type?: string;
    pattern?: string;
    formality?: "casual" | "smart" | "formal";
    colors?: Json;
    user_edited: boolean;
  } = { user_edited: true };

  if (args.patch.type !== undefined) {
    patch.type = args.patch.type;
  }
  if (args.patch.pattern !== undefined) {
    patch.pattern = args.patch.pattern;
  }
  if (args.patch.formality !== undefined) {
    patch.formality = args.patch.formality;
  }
  if (args.patch.colors !== undefined) {
    patch.colors = args.patch.colors.map((color) => ({
      name: color.name,
      hex: color.hex.toLowerCase(),
    })) as unknown as Json;
  }

  const updated = (await updateGarment(ownerId, args.garmentId, patch)) ?? existing;

  console.log(
    JSON.stringify({
      event: "aurum.garment_corrected",
      ownerType: args.session.ownerType,
      ownerId,
      garmentId: args.garmentId,
      // Which chips moved, never what they were set to.
      fields: Object.keys(args.patch).sort(),
    }),
  );

  return { ok: true, view: await buildGarmentView({ session: args.session, garment: updated }) };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export type RemoveGarmentOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" };

/**
 * Removes a garment and its photo.
 *
 * docs/06-safety-privacy.md, "Retention": "Garment photos are kept while the
 * garment exists; deleting a garment deletes its object." The object goes
 * first, so a failure between the two leaves a row pointing at nothing, which
 * the next delete finishes, rather than a photo nothing points at.
 */
export async function removeGarment(args: {
  readonly session: AppSession;
  readonly garmentId: string;
}): Promise<RemoveGarmentOutcome> {
  const ownerId = args.session.id;
  const existing = await getGarment(ownerId, args.garmentId);
  if (existing === null) {
    return { ok: false, reason: "not_found" };
  }

  await removeObjects(BUCKETS.garments, [existing.storage_path]);
  await deleteGarmentRow(ownerId, args.garmentId);

  console.log(
    JSON.stringify({
      event: "aurum.garment_deleted",
      ownerType: args.session.ownerType,
      ownerId,
      garmentId: args.garmentId,
    }),
  );

  return { ok: true };
}
