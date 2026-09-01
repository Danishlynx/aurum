/**
 * The shape /hair reads, and the request bodies it posts.
 *
 * One object per screen, built on the server, consumed by a server component or
 * fetched by the client. Nothing here does I/O, imports a provider, or touches
 * the database. It is the Layer 3 twin of src/lib/shared/color-view.ts.
 *
 * Spec: docs/01-user-flow.md section I (layout and states),
 * docs/03-architecture.md ("Caching": render params are keyed by (user_id, kind,
 * params_hash); "Concurrency": renders are sequential per person),
 * docs/04-integrations.md (hairstyle try on at 2 units, hair color try on at 1),
 * docs/07-payments-and-judge-mode.md (6 renders per judge session).
 *
 * Rules the types themselves carry:
 * - A render URL is a string or null. There is no substitute image: with no
 *   provider key, an unverified endpoint, or a failed task, the screen shows the
 *   unedited selfie and the documented "Preview unavailable for this shade."
 *   line (docs/01 section I, "same pending and failed patterns as Makeup").
 * - Every style and every color carries its own one line reason, so no screen
 *   has to look a reason up by key and no screen can invent one.
 * - faceShapeLine is always a sentence. When the face shape was not read it says
 *   so, rather than naming a shape nobody measured.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// GET /api/profile/hair
// ---------------------------------------------------------------------------

/**
 * Where the try on for one style or one color stands.
 *
 * "none" means nothing has been rendered for it yet, which is the state every
 * option starts in: docs/01 section I renders a style only when the person asks
 * for it, and a render is never faked. A render the jobs layer reports as
 * running is "pending" here, because the screen shows one pending state.
 */
export type HairRenderStatus = "none" | "pending" | "succeeded" | "failed";

/** One style in the row, docs/01-user-flow.md section I item 2. */
export type HairStyleOption = {
  /** Stable catalog id, for example "textured-crop". Saved and hashed. */
  id: string;
  /** Plain name, for example "Soft layers past the collarbone". */
  name: string;
  /** One line of why it suits the face shape and, when known, the hair type. */
  why: string;
  renderUrl: string | null;
  renderStatus: "none" | "pending" | "succeeded" | "failed";
};

/** One hair color in the row, docs/01-user-flow.md section I item 3. */
export type HairColorOption = {
  name: string;
  /** The swatch color, lowercase six digit hex. Data, not a design token. */
  hex: string;
  /** One line of why, referencing the person's own coloring. */
  why: string;
  renderUrl: string | null;
  renderStatus: "none" | "pending" | "succeeded" | "failed";
};

export type HairView = {
  /** Signed URL for the selfie, null once retention has deleted the original. */
  captureImageUrl: string | null;
  /**
   * The face shape the rules matched, in the words faceShapeLine uses ("oval"),
   * or null when the photo gave no shape we have rules for.
   */
  faceShape: string | null;
  /** Always a sentence. docs/01 section I item 1. */
  faceShapeLine: string;
  styles: HairStyleOption[];
  colors: HairColorOption[];
  savedStyleId: string | null;
  savedColorName: string | null;
};

// ---------------------------------------------------------------------------
// POST /api/renders, the two hair kinds
// ---------------------------------------------------------------------------

/**
 * A catalog style id: lower case letters and single hyphens, as
 * src/lib/shared/hair-rules.ts writes them. The server checks the id against the
 * catalog as well; this is only the shape check at the boundary.
 */
export const hairStyleIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z]+(?:-[a-z]+)*$/u, "Expected a style id like textured-crop.");

/**
 * The same six digit hex the palette writes. Declared here rather than imported
 * from color-view.ts so this file has no import back into the makeup contract,
 * which is what keeps the two shared modules free of a cycle.
 */
export const hairColorHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "Expected a color like #6b3f24.");

/** One hairstyle try on. The style is a catalog id, never free text. */
export const hairstyleRenderParamsSchema = z.object({
  styleId: hairStyleIdSchema,
});

export type HairstyleRenderParams = z.infer<typeof hairstyleRenderParamsSchema>;

/**
 * One hair color try on. docs/01 section I item 3 renders the color "on the
 * selected style", so the style travels with the color: the same color on a
 * different style is a different picture and therefore a different render.
 *
 * colorName is carried for the pending line ("Applying warm chestnut") and is
 * not part of the render hash, for the same reason a shade name is not: renaming
 * a swatch must not cost a credit.
 */
export const hairColorRenderParamsSchema = z.object({
  styleId: hairStyleIdSchema,
  colorHex: hairColorHexSchema,
  colorName: z.string().min(1).max(48),
});

export type HairColorRenderParams = z.infer<typeof hairColorRenderParamsSchema>;

export const hairstyleRenderRequestSchema = z.object({
  kind: z.literal("hairstyle"),
  params: hairstyleRenderParamsSchema,
});

export const hairColorRenderRequestSchema = z.object({
  kind: z.literal("hair_color"),
  params: hairColorRenderParamsSchema,
});

// ---------------------------------------------------------------------------
// POST /api/profile/hair/save
// ---------------------------------------------------------------------------

/**
 * "Save this", docs/01-user-flow.md section I item 4: the chosen style and color
 * are saved to the profile.
 *
 * colorName is nullable because a person can save a style before trying a color
 * on it. Null is stored as null, which is the honest record of "a style, no
 * color", never a color nobody picked.
 */
export const hairSaveRequestSchema = z.object({
  styleId: hairStyleIdSchema,
  colorName: z.string().min(1).max(48).nullable(),
});

export type HairSaveRequest = z.infer<typeof hairSaveRequestSchema>;

/** The save answer. There is nothing to read back: the screen re reads the view. */
export type HairSaveResponse = { ok: true };
