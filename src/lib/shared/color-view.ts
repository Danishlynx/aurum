/**
 * The shapes /color and /makeup read, and the request bodies they post.
 *
 * One object per screen, built on the server, consumed by a server component or
 * fetched by the client. Nothing here does I/O, imports a provider, or touches
 * the database. It is the Layer 2 twin of src/lib/shared/report-view.ts.
 *
 * Spec: docs/01-user-flow.md sections G and H (layout and states),
 * docs/03-architecture.md ("Caching": render params, palette derivation),
 * docs/04-integrations.md (makeup try on, the "<shade family> <category>" query
 * grammar), docs/07-payments-and-judge-mode.md (6 renders per judge session).
 *
 * Rules the types themselves carry:
 * - A palette is a Palette or it is null. Null is the honest state for a photo
 *   whose tone could not be read, which is the /color state in docs/01 section G
 *   ("Confirm your undertone"), never a made up season.
 * - A render URL is a string or null. There is no substitute image: with no
 *   provider key the hero shows the unedited selfie and
 *   copy.makeup.previewUnavailable, per docs/01 section H, "Try on failed".
 * - A product is a ReportListing or it is null, the same grounding rule the
 *   report follows (docs/06-safety-privacy.md, "Grounding and honesty").
 */

import { z } from "zod";

import {
  hairColorRenderRequestSchema,
  hairstyleRenderRequestSchema,
} from "./hair-view";
import type { Palette, Season, Undertone } from "./palette";
import type { ReportListing } from "./report-view";

// ---------------------------------------------------------------------------
// GET /api/profile/color
// ---------------------------------------------------------------------------

/** aesthetic_profiles.undertone_source, docs/03-architecture.md data model. */
export type UndertoneSource = "detected" | "confirmed_by_user";

export type ColorView = {
  /** The detected skin tone. Null when the attributes analysis gave no tone. */
  skinToneHex: string | null;
  undertone: Undertone | null;
  undertoneSource: UndertoneSource | null;
  /**
   * Derived from the stored profile fields by src/lib/shared/palette.ts on every
   * read. Null when there is no tone or no undertone to derive it from.
   */
  palette: Palette | null;
};

// ---------------------------------------------------------------------------
// POST /api/profile/undertone
// ---------------------------------------------------------------------------

export const UNDERTONES = ["warm", "cool", "neutral"] as const;

/**
 * The undertone adjuster on /color (docs/01 section G item 2). The person picks
 * one of three, the server stores it with undertone_source "confirmed_by_user",
 * re derives the season and the palette, and regenerates the reading
 * (docs/03-architecture.md, "Caching": synthesis is regenerated when the person
 * adjusts undertone).
 */
export const undertoneRequestSchema = z.object({
  undertone: z.enum(UNDERTONES),
});

export type UndertoneRequest = z.infer<typeof undertoneRequestSchema>;

export type UndertoneUpdateResponse = {
  /**
   * The season after the change. Null when the photo gave no skin tone: an
   * undertone alone cannot produce a palette, so the screen stays in the
   * "Confirm your undertone" state rather than being handed an invented season.
   */
  season: Season | null;
  /** True when a palette was derived and stored for the new undertone. */
  paletteChanged: boolean;
};

// ---------------------------------------------------------------------------
// GET /api/profile/makeup
// ---------------------------------------------------------------------------

/**
 * The four rows on /makeup, docs/01 section H item 2: "Lip", "Blush",
 * "Foundation", "Eye". These are the four makeup try on categories this build
 * uses out of the thirteen the API offers (docs/04-integrations.md).
 */
export const MAKEUP_CATEGORIES = ["lip", "blush", "foundation", "eye"] as const;

export type MakeupCategory = (typeof MAKEUP_CATEGORIES)[number];

/**
 * One swatch in a shade row.
 *
 * productQuery follows the makeup grammar in docs/04-integrations.md,
 * "<shade family> <category>", for example "rust lipstick". It is on the option
 * rather than computed by the screen so the same shade always produces the same
 * query, which is what lets the product cache work.
 */
export type ShadeOption = {
  name: string;
  hex: string;
  productQuery: string;
};

export type MakeupCategoryView = {
  category: MakeupCategory;
  /** The row label from copy.ts, for example "Lip". */
  label: string;
  /** Three swatches, ordered lightest first. */
  shades: ShadeOption[];
  /** The middle one, which is the shade the row opens on. */
  recommendedIndex: number;
};

export type MakeupView = {
  /** Signed URL for the selfie, null once retention has deleted the original. */
  captureImageUrl: string | null;
  /**
   * Only the categories that could be built honestly. Lip, blush, and eye need a
   * palette; foundation needs a detected skin tone. A category with neither is
   * absent rather than filled with a guess.
   */
  categories: MakeupCategoryView[];
  /**
   * One entry per category, in the same order and of the same length, for the
   * selected shade of that category. Null (the whole field) when grounding was
   * not asked for; a null entry means no listing came back, which the screen
   * shows as "No listing found near you yet".
   */
  product: (ReportListing | null)[] | null;
};

/**
 * How the screen asks for listings.
 *
 * GET /api/profile/makeup             shades only, no SerpApi search
 * GET /api/profile/makeup?ground=1    also grounds the selected shade of each row
 *
 * The selection per row is a query parameter named after the category, holding
 * the index of the selected shade, for example
 * GET /api/profile/makeup?ground=1&lip=2&eye=0. An absent or unparseable index
 * falls back to that row's recommendedIndex, so the plain ?ground=1 form grounds
 * the recommended look.
 */
export const MAKEUP_GROUND_PARAM = "ground";

/** An index that is absent, out of range, or not a number reads as null. */
const shadeIndexSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(2)
  .nullish()
  .catch(null);

export const makeupViewQuerySchema = z.object({
  ground: z
    .string()
    .nullish()
    .transform((value) => value === "1" || value === "true"),
  lip: shadeIndexSchema,
  blush: shadeIndexSchema,
  foundation: shadeIndexSchema,
  eye: shadeIndexSchema,
});

export type MakeupViewQuery = z.infer<typeof makeupViewQuerySchema>;

// ---------------------------------------------------------------------------
// POST /api/renders and GET /api/renders/[id]
// ---------------------------------------------------------------------------

/** jobs.status and renders.status, docs/03-architecture.md data model. */
export type RenderStatus = "pending" | "running" | "succeeded" | "failed";

/** A six digit hex colour with the leading hash, as the palette writes them. */
export const shadeHexSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "Expected a colour like #6b4a2f.");

export const makeupRenderCategorySchema = z.object({
  category: z.enum(MAKEUP_CATEGORIES),
  shadeHex: shadeHexSchema,
  /** Shown in the pending line, for example "Applying rust lip". */
  shadeName: z.string().min(1).max(48),
});

export type MakeupRenderCategoryInput = z.infer<
  typeof makeupRenderCategorySchema
>;

/**
 * The recommended full look is one render with several categories in it, and a
 * single shade change is one render with one category in it (docs/01 section H
 * items 1 and 2). Both are the same call.
 */
export const makeupRenderParamsSchema = z.object({
  categories: z.array(makeupRenderCategorySchema).min(1).max(4),
});

export type MakeupRenderParams = z.infer<typeof makeupRenderParamsSchema>;

export const makeupRenderRequestSchema = z.object({
  kind: z.literal("makeup"),
  params: makeupRenderParamsSchema,
});

/**
 * Every kind of try on POST /api/renders accepts, discriminated by kind.
 *
 * The two hair kinds are declared in src/lib/shared/hair-view.ts, beside the
 * screen that posts them, and joined here because the route takes one body and
 * the render layer takes one input. Layer 4 adds cloth to the same union.
 */
export const renderRequestSchema = z.discriminatedUnion("kind", [
  makeupRenderRequestSchema,
  hairstyleRenderRequestSchema,
  hairColorRenderRequestSchema,
]);

export type RenderRequest = z.infer<typeof renderRequestSchema>;

/**
 * 202 when a provider task started, 200 when the params hash already had a
 * render stored (docs/03-architecture.md, "Caching": re selecting a shade
 * returns the stored render instead of spending a credit).
 */
export type RenderCreatedResponse = {
  renderId: string;
  /** Null on a cache hit, because no job was needed. */
  jobId: string | null;
  status: RenderStatus;
  /** Present only on a cache hit. A short lived signed URL. */
  renderUrl?: string;
};

export type RenderView = {
  renderId: string;
  status: RenderStatus;
  /** Short lived signed URL, or null while the render is not finished. */
  renderUrl: string | null;
  /** A sentence from copy.ts or the server messages, never provider text. */
  error: string | null;
};
