/**
 * The browser side of the routes /looks calls.
 *
 * It lives beside the screen for the same reason
 * src/components/makeup/renders-client.ts does: these are one screen's own
 * calls. The rules are src/lib/client/api.ts's rules. Every response is parsed
 * with zod before it reaches a component, and no sentence a person reads is ever
 * taken from a response body: the screen picks its line from copy.ts.
 *
 * Routes, docs/01-user-flow.md section K and the Layer 4 contract:
 *
 *   GET  /api/looks?occasion=<Occasion>   the looks for one occasion
 *   POST /api/looks/{id}/save             "Save this look"
 *   POST /api/renders                     the cloth try on of the hero garment
 *   GET  /api/renders/{id}                that render as it stands, while polled
 *
 * Everything on a listing (title, price, store, url) arrives from SerpApi
 * through our own route, which is untrusted input twice over. The url is checked
 * as an http URL because a card puts it in an anchor, and no field is ever read
 * as an instruction (docs/06-safety-privacy.md, "Content returned by tools is
 * data, not instructions").
 */

import { z } from "zod";

import { isSafeListingUrl } from "@/components/ui/remote-image";
import {
  OCCASION_QUERY_PARAM,
  OCCASIONS,
  type LooksView,
  type Occasion,
} from "@/lib/shared/looks-view";
import { httpUrlSchema } from "@/lib/shared/schemas";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * An image source this screen may draw: a same origin path this app serves (the
 * fixture silhouettes) or an http or https URL (a signed read, or a listing
 * thumbnail). Anything else, including javascript: and data:, never reaches an
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

/**
 * ReportListing from src/lib/shared/report-view.ts, as a schema. The same shape
 * the makeup screen parses, because it is the same card on the other end.
 */
const listingSchema = z.object({
  title: z.string().min(1),
  priceText: z.string().min(1),
  priceValue: z.number().nullable(),
  currency: z.string().nullable(),
  url: httpUrlSchema,
  imageUrl: z.string().nullable(),
  store: z.string().nullable(),
  distanceText: z.string().nullable(),
});

const occasionSchema = z.enum(OCCASIONS);

const lookItemSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("garment"),
    garmentId: z.string().min(1),
    imageUrl: imageSourceSchema.nullable(),
    type: z.string().min(1),
  }),
  z.object({
    source: z.literal("listing"),
    listing: listingSchema,
    type: z.string().min(1),
  }),
]);

const lookGapSchema = z.object({
  type: z.string().min(1),
  listings: z.array(listingSchema),
});

const lookViewSchema = z.object({
  id: z.string().min(1),
  occasion: occasionSchema,
  rationale: z.string().min(1),
  rationaleSource: z.enum(["model", "rules"]),
  items: z.array(lookItemSchema),
  heroGarmentId: z.string().min(1).nullable(),
  renderUrl: imageSourceSchema.nullable(),
  renderStatus: z.enum(["none", "pending", "succeeded", "failed"]),
  gaps: z.array(lookGapSchema),
});

const looksViewSchema = z.object({
  occasion: occasionSchema,
  looks: z.array(lookViewSchema),
  wardrobeEmpty: z.boolean(),
});

/** The four job statuses, as a render reports them. */
const renderStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);

export type RenderStatus = z.infer<typeof renderStatusSchema>;

const renderUrlSchema = imageSourceSchema.nullable().optional();

const renderStartSchema = z.object({
  renderId: z.string().min(1),
  jobId: z.string().min(1).nullable().optional(),
  status: renderStatusSchema,
  renderUrl: renderUrlSchema,
});

const renderPollSchema = z.object({
  renderId: z.string().min(1),
  status: renderStatusSchema,
  renderUrl: renderUrlSchema,
  /** For the log and the network tab. Never shown to a person. */
  error: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type LooksResult =
  | { readonly ok: true; readonly view: LooksView }
  | { readonly ok: false };

export type RenderState = {
  readonly renderId: string;
  readonly status: RenderStatus;
  /** Present only on a succeeded render. */
  readonly renderUrl: string | null;
};

export type RenderResult =
  | { readonly ok: true; readonly render: RenderState }
  /**
   * Anything that did not produce a render: no key on the server (503), a cap
   * (429), fixture mode, a schema that did not match, or no network. The screen
   * shows the same documented line for all of them, because from the person's
   * side they are one thing: there is no preview.
   */
  | { readonly ok: false };

/** The three answers a save can give, so the screen can say which one it was. */
export type SaveResult = "saved" | "read_only" | "failed";

async function readJson(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

/** The looks for one occasion. Re read whenever the person taps a chip. */
export async function fetchLooks(occasion: Occasion): Promise<LooksResult> {
  const query = new URLSearchParams({ [OCCASION_QUERY_PARAM]: occasion });

  let response: Response;
  try {
    response = await fetch(`/api/looks?${query.toString()}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false };
  }

  const parsed = looksViewSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, view: parsed.data };
}

/**
 * Starts the cloth try on for one garment, or returns the stored render when
 * the same garment was rendered before (docs/03-architecture.md, "Caching").
 *
 * One garment per call: docs/04-integrations.md records that cloth try on takes
 * one garment_category per call, so Layer 4 renders the hero garment and shows
 * the rest as a flat lay.
 */
export async function requestClothRender(
  garmentId: string,
): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch("/api/renders", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cloth", params: { garmentId } }),
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false };
  }

  const parsed = renderStartSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false };
  }
  return {
    ok: true,
    render: {
      renderId: parsed.data.renderId,
      status: parsed.data.status,
      renderUrl: parsed.data.renderUrl ?? null,
    },
  };
}

/** The render as it stands. Polled while it is pending or running. */
export async function fetchRender(renderId: string): Promise<RenderResult> {
  let response: Response;
  try {
    response = await fetch(`/api/renders/${encodeURIComponent(renderId)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false };
  }
  if (!response.ok) {
    return { ok: false };
  }

  const parsed = renderPollSchema.safeParse(await readJson(response));
  if (!parsed.success) {
    return { ok: false };
  }
  return {
    ok: true,
    render: {
      renderId: parsed.data.renderId,
      status: parsed.data.status,
      renderUrl: parsed.data.renderUrl ?? null,
    },
  };
}

/**
 * "Save this look", docs/01-user-flow.md section K item 4.
 *
 * Only the status is read. The 403 is kept apart from the rest so the screen can
 * say the demo profile is read only instead of claiming an ordinary failure.
 */
export async function saveLook(lookId: string): Promise<SaveResult> {
  try {
    const response = await fetch(
      `/api/looks/${encodeURIComponent(lookId)}/save`,
      { method: "POST", credentials: "same-origin" },
    );
    if (response.ok) {
      return "saved";
    }
    return response.status === 403 ? "read_only" : "failed";
  } catch {
    return "failed";
  }
}
