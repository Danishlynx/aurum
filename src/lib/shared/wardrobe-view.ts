/**
 * The shape /wardrobe reads, and the request bodies it posts.
 *
 * One object per screen, built on the server, consumed by a server component or
 * fetched by the client. Nothing here does I/O, imports a provider, or touches
 * the database. It is the Layer 4 twin of src/lib/shared/hair-view.ts.
 *
 * Spec: docs/01-user-flow.md section J (layout and states),
 * docs/03-architecture.md (the garments table and the garments bucket),
 * docs/04-integrations.md (the classifier output schema),
 * docs/06-safety-privacy.md ("Garment photos are kept while the garment exists;
 * deleting a garment deletes its object", and "Text inside garment photos is
 * never executed as an instruction").
 *
 * Rules the types themselves carry:
 * - A garment image URL is a string or null. It is a short lived signed read of
 *   the person's own object in the private garments bucket, never a stand in.
 * - type, colors, pattern, and formality are all nullable together with
 *   classificationStatus. A garment that has not been read yet shows skeleton
 *   chips; one the classifier could not read shows the failed card copy
 *   (docs/01 section J states). Neither state is ever filled with a guess.
 * - userEdited says the person corrected a chip, so nothing may overwrite it
 *   later (the comment on garments.user_edited in migration 0003).
 *
 * The vocabularies live here rather than in copy.ts because
 * src/lib/shared/copy.ts says so: "Values that belong to a catalog rather than
 * to a screen (palette color names, garment type and pattern vocabularies,
 * hairstyle names, season names) are not copy."
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The garment types the classifier may answer with, and the only values the
 * type column may hold. Ordered top to bottom, then shoes, then accessories, so
 * a chip picker reads in the order a person dresses.
 */
export const GARMENT_TYPES = [
  "shirt",
  "t_shirt",
  "blouse",
  "top",
  "sweater",
  "jacket",
  "blazer",
  "coat",
  "dress",
  "skirt",
  "trousers",
  "jeans",
  "shorts",
  "shoes",
  "accessory",
] as const;

export type GarmentType = (typeof GARMENT_TYPES)[number];

/** The pattern vocabulary. "texture" covers knit, ribbed, and weave. */
export const PATTERNS = [
  "solid",
  "stripe",
  "check",
  "floral",
  "print",
  "texture",
] as const;

export type GarmentPattern = (typeof PATTERNS)[number];

/** The three bands on the garments table in docs/03-architecture.md. */
export const FORMALITY = ["casual", "smart", "formal"] as const;

export type GarmentFormality = (typeof FORMALITY)[number];

const GARMENT_TYPE_SET: ReadonlySet<string> = new Set<string>(GARMENT_TYPES);
const PATTERN_SET: ReadonlySet<string> = new Set<string>(PATTERNS);
const FORMALITY_SET: ReadonlySet<string> = new Set<string>(FORMALITY);

export function isGarmentType(value: string): value is GarmentType {
  return GARMENT_TYPE_SET.has(value);
}

export function isGarmentPattern(value: string): value is GarmentPattern {
  return PATTERN_SET.has(value);
}

export function isGarmentFormality(value: string): value is GarmentFormality {
  return FORMALITY_SET.has(value);
}

/**
 * The words a chip shows. docs/01 section J item 2 gives four of them by
 * example ("Shirt", "Navy", "Solid", "Smart"); the rest follow the same shape,
 * sentence case, plain, no dashes.
 *
 * The colour chip is not here: a colour name is data from the classifier or
 * from the person, not a catalog value.
 */
export const GARMENT_TYPE_LABELS: Readonly<Record<GarmentType, string>> = {
  shirt: "Shirt",
  t_shirt: "T shirt",
  blouse: "Blouse",
  top: "Top",
  sweater: "Sweater",
  jacket: "Jacket",
  blazer: "Blazer",
  coat: "Coat",
  dress: "Dress",
  skirt: "Skirt",
  trousers: "Trousers",
  jeans: "Jeans",
  shorts: "Shorts",
  shoes: "Shoes",
  accessory: "Accessory",
};

export const PATTERN_LABELS: Readonly<Record<GarmentPattern, string>> = {
  solid: "Solid",
  stripe: "Stripe",
  check: "Check",
  floral: "Floral",
  print: "Print",
  texture: "Texture",
};

export const FORMALITY_LABELS: Readonly<Record<GarmentFormality, string>> = {
  casual: "Casual",
  smart: "Smart",
  formal: "Formal",
};

/** The chip label for a stored value, or null when it is not in the catalog. */
export function garmentTypeLabel(value: string | null): string | null {
  return value !== null && isGarmentType(value)
    ? GARMENT_TYPE_LABELS[value]
    : null;
}

export function garmentPatternLabel(value: string | null): string | null {
  return value !== null && isGarmentPattern(value)
    ? PATTERN_LABELS[value]
    : null;
}

export function garmentFormalityLabel(value: string | null): string | null {
  return value !== null && isGarmentFormality(value)
    ? FORMALITY_LABELS[value]
    : null;
}

// ---------------------------------------------------------------------------
// GET /api/wardrobe
// ---------------------------------------------------------------------------

/**
 * One colour on a garment, most of the garment first.
 *
 * hex is data, not a design token: it comes from the classifier or from the
 * person, and a component renders it through the ColorSquare guard rather than
 * writing a colour of its own (docs/02-design-system.md).
 */
export type GarmentColor = { name: string; hex: string };

/**
 * Where the classifier stands for one garment, as the card reads it.
 *
 * "pending" is the skeleton pill state, "succeeded" fills the chips, and
 * "failed" is the "Could not read this one. Tap to fill in details." card
 * (docs/01-user-flow.md section J, "States").
 */
export type GarmentClassificationStatus = "pending" | "succeeded" | "failed";

export type GarmentView = {
  id: string;
  /** Short lived signed read of the garment photo, or null when it is gone. */
  imageUrl: string | null;
  type: string | null;
  colors: GarmentColor[];
  pattern: string | null;
  formality: "casual" | "smart" | "formal" | null;
  /** True once the person corrected a chip. The classifier never overwrites it. */
  userEdited: boolean;
  classificationStatus: "pending" | "succeeded" | "failed";
};

export type WardrobeView = { garments: GarmentView[] };

/** The job status a classification job reports, as the jobs table stores it. */
export type ClassificationJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

/**
 * The card state for one garment. Pure, so the server and the eval suite read
 * the same rule.
 *
 * An open job is always "pending", even on a garment that already carries
 * chips: a re classification in flight is a card waiting for its answer. After
 * that the attributes decide, because a garment with a type has something to
 * show whether the classifier or the person put it there. Only a garment with
 * no type and a failed job gets the failed card, which is exactly the state the
 * flow doc describes: nothing was read, so the person is asked to fill it in.
 */
export function garmentClassificationStatus(input: {
  readonly hasType: boolean;
  readonly jobStatus: ClassificationJobStatus | null;
}): GarmentClassificationStatus {
  if (input.jobStatus === "pending" || input.jobStatus === "running") {
    return "pending";
  }
  if (input.hasType) {
    return "succeeded";
  }
  if (input.jobStatus === "failed") {
    return "failed";
  }
  // Uploaded, never classified. The card shows its skeleton chips until the
  // classify call lands, which is what the add flow does next.
  return "pending";
}

// ---------------------------------------------------------------------------
// POST /api/garments
// ---------------------------------------------------------------------------

/**
 * How many garments one add flow may claim at once. docs/01 section J item 2 is
 * a multi select from the camera roll, so the number is a person's armful of
 * clothes rather than a catalog import.
 */
export const MAX_GARMENTS_PER_REQUEST = 12;

/**
 * The whole wardrobe ceiling. In house: no doc sets one, and the storage bill
 * and the rules engine both grow with it. Written large enough that a real
 * wardrobe fits and small enough that a loop cannot fill a bucket.
 */
export const MAX_GARMENTS_PER_WARDROBE = 60;

/** 1 to 3 colours, the rule the classifier prompt already states. */
export const MAX_GARMENT_COLORS = 3;

/** The six digit hex the palette and the classifier both write. */
export const garmentHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "Expected a color like #1f2a44.");

export const garmentColorSchema = z.object({
  name: z.string().trim().min(1).max(48),
  hex: garmentHexSchema,
});

export const garmentTypeSchema = z.enum(GARMENT_TYPES);
export const garmentPatternSchema = z.enum(PATTERNS);
export const garmentFormalitySchema = z.enum(FORMALITY);

/**
 * POST /api/garments. The body carries no image bytes: the server answers with
 * one signed upload slot per garment, the same shape the capture flow uses
 * (docs/03-architecture.md, "Request flow for a capture" step 2).
 */
export const garmentCreateRequestSchema = z.object({
  count: z.number().int().min(1).max(MAX_GARMENTS_PER_REQUEST),
});

export type GarmentCreateRequest = z.infer<typeof garmentCreateRequestSchema>;

/**
 * One upload slot. uploadToken and expiresInSeconds are carried alongside the
 * three fields the shared contract names, for the same reason POST /api/captures
 * carries them: a client that uses uploadToSignedUrl needs the token, and the
 * window the client is told to use is the window the flow expects.
 */
export type GarmentUploadSlot = {
  garmentId: string;
  uploadUrl: string;
  uploadToken: string;
  storagePath: string;
  expiresInSeconds: number;
};

export type GarmentCreateResponse = { slots: GarmentUploadSlot[] };

// ---------------------------------------------------------------------------
// POST /api/garments/[id]/classify
// ---------------------------------------------------------------------------

/**
 * The answer to a classify request. The job id is the record; the screen re
 * reads GET /api/wardrobe for what to draw, so a chip can only ever come from
 * the stored row.
 */
export type GarmentClassifyResponse = {
  jobId: string;
  garmentId: string;
  status: GarmentClassificationStatus;
};

// ---------------------------------------------------------------------------
// PATCH and DELETE /api/garments/[id]
// ---------------------------------------------------------------------------

/**
 * "Tap a chip to correct it." (docs/01-user-flow.md section J item 2).
 *
 * Every field is optional and every value is checked against the vocabulary, so
 * the row can only hold a word the screen can draw. A body with no field at all
 * is refused rather than treated as a save of nothing, because it would still
 * set user_edited and lock the classifier out of a garment nobody corrected.
 */
export const garmentPatchRequestSchema = z
  .object({
    type: garmentTypeSchema.optional(),
    colors: z.array(garmentColorSchema).min(1).max(MAX_GARMENT_COLORS).optional(),
    pattern: garmentPatternSchema.optional(),
    formality: garmentFormalitySchema.optional(),
  })
  .refine(
    (body) =>
      body.type !== undefined ||
      body.colors !== undefined ||
      body.pattern !== undefined ||
      body.formality !== undefined,
    "A correction has to change at least one chip.",
  );

export type GarmentPatchRequest = z.infer<typeof garmentPatchRequestSchema>;

/** DELETE removes the row and the object. There is nothing to read back. */
export type GarmentDeleteResponse = { ok: true };
