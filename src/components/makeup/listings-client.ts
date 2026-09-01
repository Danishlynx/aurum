/**
 * The browser side of GET /api/profile/makeup, used to fetch the listing for a
 * shade the person just chose.
 *
 * The screen is first painted on the server with the listings for the shades the
 * rows open on. Choosing a different shade means a different product, so the
 * screen asks the same route again with the new selection rather than reusing
 * the listing it already has (docs/06-safety-privacy.md, "Grounding and
 * honesty": a product is only shown when a real listing was fetched for what is
 * on the screen).
 *
 * The route decides the query, the cache, and the caps. This module only asks,
 * parses, and hands back listings.
 */

import { z } from "zod";

import {
  MAKEUP_GROUND_PARAM,
  type MakeupCategoryView,
} from "@/lib/shared/color-view";
import type { ReportListing } from "@/lib/shared/report-view";
import { httpUrlSchema } from "@/lib/shared/schemas";

/**
 * ReportListing from src/lib/shared/report-view.ts, as a schema. The url is
 * checked as an http URL because the card puts it in an anchor, and everything
 * on a listing arrives from SerpApi, which is untrusted input.
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

/** Only the field this call is for. The rest of the view is already on screen. */
const makeupListingsSchema = z.object({
  product: z.array(listingSchema.nullable()).nullable(),
});

export type MakeupListingsResult =
  | { readonly ok: true; readonly products: (ReportListing | null)[] | null }
  | { readonly ok: false };

/**
 * The listings for one selection, one per row, in the order of the rows.
 *
 * The selection travels as one query parameter per category holding the index
 * of the chosen shade, which is the form documented beside
 * makeupViewQuerySchema in src/lib/shared/color-view.ts.
 */
export async function fetchMakeupListings(
  categories: readonly MakeupCategoryView[],
  selection: readonly number[],
): Promise<MakeupListingsResult> {
  const query = new URLSearchParams({ [MAKEUP_GROUND_PARAM]: "1" });
  categories.forEach((category, index) => {
    const chosen = selection[index];
    if (Number.isInteger(chosen)) {
      query.set(category.category, String(chosen));
    }
  });

  let response: Response;
  try {
    response = await fetch(`/api/profile/makeup?${query.toString()}`, {
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false };
  }

  const parsed = makeupListingsSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false };
  }
  return { ok: true, products: parsed.data.product };
}
