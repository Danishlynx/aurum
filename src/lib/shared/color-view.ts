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

import type { ConcernKey } from "./concerns";
import { copy } from "./copy";
import {
  hairColorRenderRequestSchema,
  hairstyleRenderRequestSchema,
} from "./hair-view";
import { clothRenderRequestSchema } from "./looks-view";
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
  /**
   * Three swatches, ordered lightest first. Four when a saved shade was not one
   * of the three the palette derives: it is added rather than dropped, because
   * the person chose it (docs/01-user-flow.md section H item 4).
   */
  shades: ShadeOption[];
  /** The middle one, which is the shade the palette recommends. */
  recommendedIndex: number;
  /**
   * The saved shade's position, when this profile has a saved look. The row
   * opens on it instead of the recommendation, which is what makes "Save this
   * look" mean something on the next visit: the same shades, and therefore the
   * same render, rather than a fresh one that costs a credit.
   *
   * Absent when nothing has been saved for this category.
   */
  savedIndex?: number;
};

export type MakeupView = {
  /** Signed URL for the selfie, null once retention has deleted the original. */
  captureImageUrl: string | null;
  /**
   * The stored try on for the shades the rows open on, when one exists in our
   * own bucket, as a short lived signed URL.
   *
   * It is here so a look that was already rendered is on the screen at the first
   * paint, without a request that could refuse: the render already exists, it
   * belongs to this owner, and asking POST /api/renders for it again would need
   * consent and a cap check to answer with the same picture. Null means nothing
   * has been rendered for these shades, and the screen then asks for one. It is
   * never a substitute image (docs/01-user-flow.md section H, "Try on failed").
   */
  renderUrl: string | null;
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

/**
 * An index that is absent, out of range, or not a number reads as null.
 *
 * The ceiling is 3 rather than 2 because a row holds four swatches when a saved
 * shade was not one of the three the palette derives (MakeupCategoryView above).
 */
const shadeIndexSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(3)
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

// ---------------------------------------------------------------------------
// POST /api/profile/makeup
// ---------------------------------------------------------------------------

/**
 * "Save this look", docs/01-user-flow.md section H item 4: the selected shades
 * are saved to the profile (migration 0013).
 *
 * The body is makeupRenderParamsSchema, the same shape a render is created
 * under, because it is the same look. Saving it in that shape is what lets the
 * next visit open on those shades and find the try on they were rendered with
 * rather than asking for another one.
 */
export type MakeupSaveRequest = MakeupRenderParams;

/** The save answer. Nothing to read back: the screen re reads the view. */
export type MakeupSaveResponse = { ok: true };

// ---------------------------------------------------------------------------
// Layer 6: the skin simulation and the accessory try on
// ---------------------------------------------------------------------------

/**
 * The concerns Perfect Corp's skin simulation can project, in our own keys.
 *
 * docs/04-integrations.md records the ten the reference page lists: "radiance,
 * acne, oiliness, eye bags, dark circles, spots, pores, texture, wrinkles,
 * redness". Their "spots" is our dark_spots; the rest map by name.
 *
 * Two of our tone concerns, pigmentation and uneven tone, are not on that list.
 * The report ranks those first on deeper skin (src/lib/shared/concerns.ts), so a
 * projection on a tone first report can only show the concerns underneath them.
 * That is a limit of the endpoint, and the row says what it projected rather
 * than implying it projected everything the reading named.
 */
export const SIMULATABLE_CONCERN_KEYS = [
  "dark_spots",
  "texture",
  "pores",
  "oiliness",
  "acne",
  "redness",
  "radiance",
  "wrinkles",
  "dark_circles",
  "eye_bags",
] as const satisfies readonly ConcernKey[];

export type SimulatableConcernKey = (typeof SIMULATABLE_CONCERN_KEYS)[number];

const SIMULATABLE_CONCERN_SET: ReadonlySet<string> = new Set<string>(
  SIMULATABLE_CONCERN_KEYS,
);

export function isSimulatableConcern(
  value: string,
): value is SimulatableConcernKey {
  return SIMULATABLE_CONCERN_SET.has(value);
}

/**
 * How many concerns one projection asks for.
 *
 * docs/04-integrations.md, credit table: skin simulation costs "4 for 1 to 4
 * concerns, 6 for 5 to 10 concerns". Four is the whole of the cheaper tier, and
 * it is also as many concerns as the report leads with, so the projection covers
 * the top of the reading without moving to the dearer tier.
 */
export const MAX_SIMULATED_CONCERNS = 4;

/**
 * One skin simulation: the person's own capture, with the concerns the report
 * ranked highest projected.
 *
 * The concerns travel in the request because the report already ranked them and
 * the person is looking at that ranking; they are checked here against the ten
 * the endpoint can simulate, so nothing outside that set is ever sent.
 */
export const skinSimulationRenderParamsSchema = z.object({
  concerns: z
    .array(z.enum(SIMULATABLE_CONCERN_KEYS))
    .min(1)
    .max(MAX_SIMULATED_CONCERNS),
});

export type SkinSimulationRenderParams = z.infer<
  typeof skinSimulationRenderParamsSchema
>;

export const skinSimulationRenderRequestSchema = z.object({
  kind: z.literal("skin_simulation"),
  params: skinSimulationRenderParamsSchema,
});

/**
 * The accessory try on categories this build offers.
 *
 * docs/09-build-order-and-demo.md, Layer 6: "One accessory try on in the top
 * look (earrings or a bag)". The watch is here as well because it is the one
 * accessory endpoint that is confirmed in
 * src/lib/server/providers/perfectcorp/endpoints.ts, so it is the one that can
 * run first. The provider has nine accessory endpoints in all; adding another
 * one here and in src/lib/server/renders/accessory.ts is the whole change.
 *
 * Which of these a session can actually render is decided on the server from the
 * verification state of the endpoint behind it, never here.
 */
export const ACCESSORY_CATEGORIES = ["earrings", "bag", "watch"] as const;

export type AccessoryCategory = (typeof ACCESSORY_CATEGORIES)[number];

/** The category named on the chip that starts the try on. */
export const ACCESSORY_CATEGORY_LABELS: Readonly<
  Record<AccessoryCategory, string>
> = {
  earrings: copy.looks.accessoryEarrings,
  bag: copy.looks.accessoryBag,
  watch: copy.looks.accessoryWatch,
};

export function accessoryCategoryLabel(category: AccessoryCategory): string {
  return ACCESSORY_CATEGORY_LABELS[category];
}

/**
 * One accessory try on: one accessory the person owns, worn on their own
 * capture, in one category.
 *
 * The category is in the request because the wardrobe records accessories under
 * a single "accessory" type (src/lib/shared/wardrobe-view.ts): a photo of a bag
 * and a photo of a pair of earrings are the same garment type, so nothing on the
 * server can tell which endpoint the photo belongs to. The person says which,
 * and the server checks the garment is theirs and is an accessory before
 * anything is uploaded.
 */
export const accessoryRenderParamsSchema = z.object({
  garmentId: z.uuid(),
  category: z.enum(ACCESSORY_CATEGORIES),
});

export type AccessoryRenderParams = z.infer<typeof accessoryRenderParamsSchema>;

export const accessoryRenderRequestSchema = z.object({
  kind: z.literal("accessory"),
  params: accessoryRenderParamsSchema,
});

/**
 * Every kind of try on POST /api/renders accepts, discriminated by kind.
 *
 * The two hair kinds are declared in src/lib/shared/hair-view.ts and the cloth
 * kind in src/lib/shared/looks-view.ts, each beside the screen that posts it,
 * and they are joined here because the route takes one body and the render
 * layer takes one input. The two Layer 6 kinds are declared above rather than
 * beside /report and /looks: neither is a screen contract of its own, both are
 * additions to this one route, and keeping them here keeps the union and its
 * members in one file.
 */
export const renderRequestSchema = z.discriminatedUnion("kind", [
  makeupRenderRequestSchema,
  hairstyleRenderRequestSchema,
  hairColorRenderRequestSchema,
  clothRenderRequestSchema,
  skinSimulationRenderRequestSchema,
  accessoryRenderRequestSchema,
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
