import "server-only";

import { z } from "zod";

/**
 * Zod for every SerpApi field we read. Unknown fields are dropped.
 * Spec: docs/04-integrations.md (SerpApi).
 */

const searchMetadataSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
});

/* ------------------------------------------------------------------ */
/* google_shopping                                                     */
/* ------------------------------------------------------------------ */

export const shoppingResultSchema = z.object({
  position: z.number().optional(),
  title: z.string(),
  product_link: z.string().optional(),
  link: z.string().optional(),
  source: z.string().optional(),
  price: z.string().optional(),
  extracted_price: z.number().optional(),
  thumbnail: z.string().optional(),
  serpapi_thumbnail: z.string().optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  delivery: z.string().optional(),
  product_id: z.string().optional(),
});

export const shoppingResponseSchema = z.object({
  error: z.string().optional(),
  search_metadata: searchMetadataSchema.optional(),
  shopping_results: z.array(shoppingResultSchema).optional(),
});

export type ShoppingResult = z.infer<typeof shoppingResultSchema>;

/* ------------------------------------------------------------------ */
/* google_maps and google_local                                        */
/* ------------------------------------------------------------------ */

export const gpsCoordinatesSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
});

export const placeResultSchema = z.object({
  position: z.number().optional(),
  title: z.string(),
  place_id: z.string().optional(),
  address: z.string().optional(),
  gps_coordinates: gpsCoordinatesSchema.optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
  type: z.string().optional(),
  types: z.array(z.string()).optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  thumbnail: z.string().optional(),
  provider_id: z.string().optional(),
});

export const placesResponseSchema = z.object({
  error: z.string().optional(),
  search_metadata: searchMetadataSchema.optional(),
  local_results: z.array(placeResultSchema).optional(),
});

export type PlaceResult = z.infer<typeof placeResultSchema>;

/* ------------------------------------------------------------------ */
/* Normalized shapes the rest of the app reads                         */
/* ------------------------------------------------------------------ */

/** The shape in docs/04-integrations.md. */
export interface Listing {
  readonly title: string;
  /** Exactly as returned. Never converted, never reformatted. */
  readonly priceText: string;
  readonly priceValue: number | null;
  /** Read from the price string. Null when it cannot be read. */
  readonly currency: string | null;
  readonly url: string;
  readonly imageUrl: string | null;
  readonly store: string | null;
}

export interface NearbyPlace {
  readonly title: string;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly placeId: string | null;
  readonly url: string | null;
  readonly category: string | null;
}

/**
 * Currency symbols and codes we can read off a price string. Anything we cannot
 * read stays null, and the price string is still shown exactly as returned.
 */
const CURRENCY_BY_SYMBOL: ReadonlyArray<readonly [string, string]> = [
  ["₹", "INR"],
  ["$", "USD"],
  ["£", "GBP"],
  ["€", "EUR"],
  ["¥", "JPY"],
  ["₩", "KRW"],
  ["₽", "RUB"],
  ["R$", "BRL"],
  ["A$", "AUD"],
  ["C$", "CAD"],
  ["CHF", "CHF"],
  ["AED", "AED"],
  ["SGD", "SGD"],
];

export function readCurrency(priceText: string): string | null {
  const trimmed = priceText.trim();
  for (const [token, code] of CURRENCY_BY_SYMBOL) {
    if (trimmed.includes(token)) {
      return code;
    }
  }
  const isoMatch = /\b([A-Z]{3})\b/.exec(trimmed);
  return isoMatch === null ? null : isoMatch[1];
}

/**
 * Turns one raw shopping result into a Listing, or null when it cannot be
 * shown. A product with no URL or no price is never shown, per
 * docs/06-safety-privacy.md.
 */
export function toListing(result: ShoppingResult): Listing | null {
  const url = result.product_link ?? result.link ?? null;
  const priceText = result.price ?? null;
  if (url === null || url.length === 0 || priceText === null || priceText.length === 0) {
    return null;
  }
  return {
    title: result.title,
    priceText,
    priceValue: result.extracted_price ?? null,
    currency: readCurrency(priceText),
    url,
    imageUrl: result.thumbnail ?? result.serpapi_thumbnail ?? null,
    store: result.source ?? null,
  };
}

export function toNearbyPlace(result: PlaceResult): NearbyPlace | null {
  if (result.title.length === 0) {
    return null;
  }
  return {
    title: result.title,
    address: result.address ?? null,
    latitude: result.gps_coordinates?.latitude ?? null,
    longitude: result.gps_coordinates?.longitude ?? null,
    placeId: result.place_id ?? null,
    url: result.website ?? null,
    category: result.type ?? result.types?.[0] ?? null,
  };
}
