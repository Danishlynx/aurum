/**
 * The shape /profile reads, and the request bodies it posts.
 *
 * One object per screen, built on the server, consumed by a server component or
 * fetched by the client. Nothing here does I/O, imports a provider, or touches
 * the database. It is the Layer 5 twin of src/lib/shared/looks-view.ts.
 *
 * Spec: docs/01-user-flow.md section L (the summary rows, the saved items, the
 * data controls), docs/06-safety-privacy.md ("Person's controls": what is
 * stored, the download, the typed delete, and the rule that a judge session can
 * neither delete nor download), docs/07-payments-and-judge-mode.md (the demo
 * profile is read only).
 *
 * Rules the types themselves carry:
 * - A row value is a string or null. Null means nothing has ever been read, and
 *   the screen says so in copy rather than showing a blank. There is no third
 *   state and no placeholder value, so a row can never show a reading nobody
 *   took (docs/06-safety-privacy.md, "Grounding and honesty" applied to the
 *   person's own data).
 * - A saved item is one of exactly three kinds, and it carries the words it is
 *   drawn with, so no screen has to look a name up by id.
 * - The download document is a closed shape. Every object in it is strict, so a
 *   field nobody declared here cannot travel in it: that is what keeps a storage
 *   path, a signed URL, and a raw provider payload out of the file a person
 *   downloads.
 */

import { z } from "zod";

import { copy } from "./copy";

// ---------------------------------------------------------------------------
// GET /api/profile
// ---------------------------------------------------------------------------

/**
 * One row of the summary, docs/01-user-flow.md section L item 1: "skin type, top
 * concern, tone and undertone, season, face shape, hair type. Each row has a
 * 'Retake' or 'Adjust' affordance where it applies."
 *
 * The key is what the row is about, so the screen can order and test rows
 * without matching on a label. The label is the words from copy.ts. The action
 * is the one control that can change this value: a retake for anything read off
 * the photo, an adjust for the undertone, which the person can overrule on
 * /color, and null for the season, which is derived rather than chosen.
 */
export type ProfileSummaryRow = {
  key:
    | "skin_type"
    | "top_concern"
    | "tone_undertone"
    | "season"
    | "face_shape"
    | "hair_type";
  label: string;
  value: string | null;
  action: "retake" | "adjust" | null;
};

/**
 * One saved item, docs/01-user-flow.md section L item 2: "saved makeup look,
 * hair choice, saved looks".
 *
 * label is what the person chose ("Wedding guest", the hairstyle's own name) and
 * detail is the second line under it, or null when there is nothing more to say.
 */
export type SavedItemRow = {
  kind: "makeup" | "hair" | "look";
  label: string;
  detail: string | null;
};

/**
 * Everything /profile needs, in one object.
 *
 * keepOriginals mirrors the consent toggle (docs/06-safety-privacy.md,
 * "Retention"), so the profile screen and the welcome screen show one value.
 *
 * isJudgeSession is true for a judge cookie and true in fixture mode, because
 * both are looking at the saved demo profile: docs/01-user-flow.md, "Judge mode
 * across the flow", says "Judge sessions never see the Delete everything control
 * on the demo profile", and the server refuses the write either way.
 */
export type ProfileView = {
  rows: ProfileSummaryRow[];
  saved: SavedItemRow[];
  keepOriginals: boolean;
  isJudgeSession: boolean;
};

/** The row order docs/01-user-flow.md section L item 1 lists them in. */
export const PROFILE_ROW_KEYS: readonly ProfileSummaryRow["key"][] = [
  "skin_type",
  "top_concern",
  "tone_undertone",
  "season",
  "face_shape",
  "hair_type",
];

/** The label for each row, so the label and the key cannot drift. */
export const PROFILE_ROW_LABELS: Readonly<
  Record<ProfileSummaryRow["key"], string>
> = {
  skin_type: copy.profile.rowSkinType,
  top_concern: copy.profile.rowTopConcern,
  tone_undertone: copy.profile.rowToneAndUndertone,
  season: copy.profile.rowSeason,
  face_shape: copy.profile.rowFaceShape,
  hair_type: copy.profile.rowHairType,
};

/**
 * The affordance on each row.
 *
 * Retake for everything the photo decided, because a new photo is the only thing
 * that changes it. Adjust for the undertone, which is the one reading the person
 * is invited to overrule (docs/01-user-flow.md section G item 2). Null for the
 * season, which is derived from the tone and the undertone: it has no control of
 * its own, and offering one would suggest a person can pick a season, which is
 * not how the palette works.
 */
export const PROFILE_ROW_ACTIONS: Readonly<
  Record<ProfileSummaryRow["key"], ProfileSummaryRow["action"]>
> = {
  skin_type: "retake",
  top_concern: "retake",
  tone_undertone: "adjust",
  season: null,
  face_shape: "retake",
  hair_type: "retake",
};

// ---------------------------------------------------------------------------
// PATCH /api/profile
// ---------------------------------------------------------------------------

/**
 * "Keep original photos", docs/01-user-flow.md section L item 3, mirroring the
 * consent toggle on /welcome (docs/06-safety-privacy.md, "Retention").
 *
 * One field, because one field is what the control is. Turning it off does not
 * delete anything on its own: retention runs when an analysis finishes, and
 * "Delete everything" is the control that removes what is already stored.
 */
export const profileUpdateRequestSchema = z.object({
  keepOriginals: z.boolean(),
});

export type ProfileUpdateRequest = z.infer<typeof profileUpdateRequestSchema>;

/** Nothing to read back: the screen re reads GET /api/profile. */
export type ProfileUpdateResponse = { ok: true };

// ---------------------------------------------------------------------------
// POST /api/profile/delete
// ---------------------------------------------------------------------------

/**
 * The typed confirmation, docs/01-user-flow.md section L item 3 and "Global
 * states and rules": "Every destructive action has a typed confirmation."
 *
 * A literal rather than a string comparison in a handler: the only body this
 * schema accepts is the exact word, so a client that posts anything else is
 * refused at the boundary rather than inside the delete.
 */
export const profileDeleteRequestSchema = z.object({
  confirmation: z.literal(copy.profile.deleteConfirmWord),
});

export type ProfileDeleteRequest = z.infer<typeof profileDeleteRequestSchema>;

/**
 * The delete answer. There is nothing to read back and nothing to navigate to
 * with the old session: the server signs the person out, and the screen shows
 * copy.toasts.deleted and returns to the landing page.
 */
export type ProfileDeleteResponse = { ok: true };

// ---------------------------------------------------------------------------
// GET /api/profile/download
// ---------------------------------------------------------------------------

/**
 * "Download my data", docs/06-safety-privacy.md, "Person's controls": "returns
 * JSON of profile, analyses summaries, garments metadata, and looks."
 *
 * What is deliberately not in it, and why each one is left out:
 *
 * 1. No image bytes. A photo is not a field in a JSON document, and inlining one
 *    would turn a data export into a copy of a person's face travelling through
 *    a browser cache.
 * 2. No storage paths. A path is an internal address in a private bucket. It
 *    tells the person nothing they can use and tells anyone who sees the file
 *    where their objects live.
 * 3. No signed URLs. A signed URL is a bearer credential for one object
 *    (docs/06-safety-privacy.md, "Access"). A downloaded file outlives the
 *    window, so putting one in it hands out a credential the person cannot
 *    revoke.
 * 4. No raw provider payloads. analyses.raw is Perfect Corp's own response, kept
 *    for debugging. What the person is owed is the reading it produced, which is
 *    the summary, and shipping the raw body would export a provider's schema
 *    rather than the person's data.
 *
 * Every object below is strict, so this list is enforced by the schema rather
 * than by review: a field nobody declared here fails the parse the route does
 * before it answers.
 */
export const PROFILE_DOWNLOAD_FORMAT = "aurum.profile.v1";

const downloadColorSchema = z.strictObject({
  name: z.string(),
  hex: z.string(),
});

const downloadConcernSchema = z.strictObject({
  key: z.string(),
  /** 1 to 100 as the provider reported it. */
  score: z.number(),
  rank: z.number(),
});

const downloadAestheticSchema = z.strictObject({
  skinTypeZones: z.strictObject({
    tZone: z.string().nullable(),
    cheeks: z.string().nullable(),
  }),
  concerns: z.array(downloadConcernSchema),
  skinAge: z.number().nullable(),
  fitzpatrick: z.number().nullable(),
  skinToneHex: z.string().nullable(),
  undertone: z.string().nullable(),
  undertoneSource: z.string().nullable(),
  eyeColorHex: z.string().nullable(),
  hairColorHex: z.string().nullable(),
  faceShape: z.string().nullable(),
  hairType: z.string().nullable(),
  savedHairStyleId: z.string().nullable(),
  savedHairColorName: z.string().nullable(),
  season: z.string().nullable(),
  reading: z.string().nullable(),
  /** Which model wrote the reading, or null when the fallback did. */
  readingModel: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const downloadProfileSchema = z.strictObject({
  consentAt: z.string().nullable(),
  consentVersion: z.string().nullable(),
  isAdultConfirmed: z.boolean(),
  keepOriginals: z.boolean(),
  locationConsent: z.boolean(),
  /** City level only, and only when the person allowed location. */
  approxLocationCity: z.string().nullable(),
  aesthetic: downloadAestheticSchema.nullable(),
});

/**
 * One analysis, as a summary rather than as a row: what was read, whether it
 * finished, and the normalized result the profile was built from.
 */
const downloadAnalysisSchema = z.strictObject({
  kind: z.string(),
  status: z.string(),
  createdAt: z.string(),
  creditsUsed: z.number(),
  /** The normalized summary. Never analyses.raw. */
  summary: z.unknown(),
});

const downloadGarmentSchema = z.strictObject({
  id: z.string(),
  type: z.string().nullable(),
  colors: z.array(downloadColorSchema),
  pattern: z.string().nullable(),
  formality: z.string().nullable(),
  /** True once the person corrected a chip, so the record says whose word it is. */
  userEdited: z.boolean(),
  createdAt: z.string(),
});

/**
 * One piece of a saved look: a garment the person owns, or the listing that
 * stood in for one. A listing keeps its title, price, store, and URL, because
 * those came back from a real search and are the person's record of what they
 * were shown.
 */
const downloadLookItemSchema = z.union([
  z.strictObject({
    source: z.literal("garment"),
    garmentId: z.string(),
    type: z.string().nullable(),
  }),
  z.strictObject({
    source: z.literal("listing"),
    type: z.string().nullable(),
    title: z.string().nullable(),
    priceText: z.string().nullable(),
    store: z.string().nullable(),
    url: z.string().nullable(),
  }),
]);

const downloadLookSchema = z.strictObject({
  id: z.string(),
  occasion: z.string().nullable(),
  isSaved: z.boolean(),
  rationale: z.string().nullable(),
  createdAt: z.string(),
  items: z.array(downloadLookItemSchema),
});

export const profileDownloadSchema = z.strictObject({
  format: z.literal(PROFILE_DOWNLOAD_FORMAT),
  exportedAt: z.string(),
  /** One plain sentence saying what the file holds and what it does not. */
  note: z.string(),
  profile: downloadProfileSchema,
  analyses: z.array(downloadAnalysisSchema),
  garments: z.array(downloadGarmentSchema),
  looks: z.array(downloadLookSchema),
});

export type ProfileDownload = z.infer<typeof profileDownloadSchema>;

/** The file name the browser is offered. Plain, dated, and not a person's name. */
export function profileDownloadFileName(exportedAt: string): string {
  const day = exportedAt.slice(0, 10);
  return `aurum-my-data-${day}.json`;
}

// ---------------------------------------------------------------------------
// The exclusion guard
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear anywhere in the download, at any depth.
 *
 * The strict schema already drops anything undeclared, so this is the second
 * lock rather than the first: it is what a unit test can assert directly, and it
 * catches the case the schema cannot, which is a declared field whose value
 * carries an address (a path pasted into a title, a signed URL in a stored
 * rationale). Both run on every download.
 */
export const EXCLUDED_DOWNLOAD_KEYS: readonly string[] = [
  "storage_path",
  "storagePath",
  "mask_path",
  "maskPath",
  "mask_paths",
  "maskPaths",
  "render_path",
  "renderPath",
  "raw",
  "signedUrl",
  "imageUrl",
  "captureImageUrl",
  "renderUrl",
  "maskUrl",
];

/**
 * Substrings that mean a value is an address into our own storage rather than a
 * fact about the person. A public listing URL is fine and is meant to be there;
 * a Supabase storage object URL and a signing token are not.
 */
export const EXCLUDED_DOWNLOAD_VALUE_MARKERS: readonly string[] = [
  "/storage/v1/object/",
  "token=",
];

/**
 * Walks a document and returns the first path that must not be in it, or null.
 *
 * Total: it recurses over plain JSON only, and a value it does not understand is
 * simply not a violation.
 */
export function findExcludedDownloadField(
  value: unknown,
  path = "$",
): string | null {
  if (typeof value === "string") {
    for (const marker of EXCLUDED_DOWNLOAD_VALUE_MARKERS) {
      if (value.includes(marker)) {
        return `${path} carries "${marker}"`;
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findExcludedDownloadField(entry, `${path}[${index}]`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (EXCLUDED_DOWNLOAD_KEYS.includes(key)) {
        return `${path}.${key}`;
      }
      const found = findExcludedDownloadField(entry, `${path}.${key}`);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  return null;
}
