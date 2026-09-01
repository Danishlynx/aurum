import "server-only";

import { ProviderError } from "../errors";
import { assertNoSearchError, readSerpApiConfig, serpApiSearch } from "./client";
import { SERPAPI_ENGINES } from "./endpoints";
import {
  placesResponseSchema,
  shoppingResponseSchema,
  toListing,
  toNearbyPlace,
  type Listing,
  type NearbyPlace,
} from "./schemas";

export { SERPAPI_ENGINES, SERPAPI_QUOTA_NOTE } from "./endpoints";
export type { SerpApiEngineKey } from "./endpoints";
export { isSerpApiConfigured } from "./client";
export { readCurrency } from "./schemas";
export type { Listing, NearbyPlace } from "./schemas";

const PROVIDER = "serpapi" as const;

/* ------------------------------------------------------------------ */
/* Query construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Queries are built from structured parts that the app produced, never from
 * free text a person typed. Spec: docs/04-integrations.md (query construction).
 */
export type ProductQuery =
  | {
      readonly kind: "skincare";
      /** The ingredient or product type, for example "niacinamide serum". */
      readonly ingredientOrType: string;
      /** The concern this step is for, for example "uneven tone". */
      readonly concern: string;
      /** The skin type label, for example "combination". */
      readonly skinType: string;
    }
  | {
      readonly kind: "makeup";
      /** The shade family, for example "warm rose". */
      readonly shadeFamily: string;
      /** The makeup category, for example "lipstick". */
      readonly category: string;
    }
  | {
      readonly kind: "garment";
      /** The colour name from the palette, for example "deep teal". */
      readonly colorName: string;
      /** The garment type, for example "knit polo". */
      readonly garmentType: string;
      /** The formality band, for example "smart". */
      readonly formality: string;
    };

/**
 * Local categories the app asks for. Free text is not accepted.
 *
 * docs/04-integrations.md names "pharmacy", "beauty store", and "menswear".
 * "clothing store" is added for Layer 4: a gap in a look is shopped near the
 * person, and nothing on the profile says which department they buy in.
 * Choosing menswear or womenswear for them would be a guess about the person,
 * so the neutral category is the honest query.
 */
export const LOCAL_CATEGORIES = [
  "pharmacy",
  "beauty store",
  "menswear",
  "womenswear",
  "clothing store",
] as const;
export type LocalCategory = (typeof LOCAL_CATEGORIES)[number];

const MAX_PART_LENGTH = 48;

/**
 * Keeps a query part to letters, digits, spaces, and a few safe marks, so a
 * value that came back from a model or a provider cannot reshape the query.
 */
function cleanPart(value: string, field: string): string {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} '.+&/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PART_LENGTH)
    .trim();
  if (cleaned.length === 0) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_input",
      message: `The query part "${field}" was empty after cleaning.`,
    });
  }
  return cleaned;
}

export function buildProductQuery(query: ProductQuery): string {
  switch (query.kind) {
    case "skincare":
      return [
        cleanPart(query.ingredientOrType, "ingredientOrType"),
        "for",
        cleanPart(query.concern, "concern"),
        cleanPart(query.skinType, "skinType"),
      ].join(" ");
    case "makeup":
      return [
        cleanPart(query.shadeFamily, "shadeFamily"),
        cleanPart(query.category, "category"),
      ].join(" ");
    case "garment":
      return [
        cleanPart(query.colorName, "colorName"),
        cleanPart(query.garmentType, "garmentType"),
        cleanPart(query.formality, "formality"),
      ].join(" ");
  }
}

export function buildLocalQuery(category: LocalCategory): string {
  return category;
}

/**
 * The cache key covers engine, query, location, gl, and hl, per
 * docs/03-architecture.md. The hash itself is computed by the caching layer.
 */
export interface SearchCacheKeyParts {
  readonly engine: string;
  readonly query: string;
  readonly location: string | null;
  readonly gl: string;
  readonly hl: string;
}

/* ------------------------------------------------------------------ */
/* Shopping                                                            */
/* ------------------------------------------------------------------ */

export interface ShoppingSearchInput {
  readonly query: ProductQuery;
  /** City level location from the profile, when location was allowed. */
  readonly location?: string;
  readonly gl?: string;
  readonly hl?: string;
  /** How many listings to ask for. */
  readonly limit?: number;
}

export interface ShoppingSearchOutput {
  readonly queryText: string;
  readonly cacheKeyParts: SearchCacheKeyParts;
  /** Only listings that came back with a URL and a price. */
  readonly listings: readonly Listing[];
  /** Results the provider returned that we dropped for having no URL or price. */
  readonly droppedCount: number;
}

/**
 * Live product grounding. A product only reaches the report if it came back
 * here with a real URL and a real price.
 */
export async function searchShopping(
  input: ShoppingSearchInput,
): Promise<ShoppingSearchOutput> {
  const config = readSerpApiConfig();
  const queryText = buildProductQuery(input.query);
  const gl = input.gl ?? config.defaultGl;
  const hl = input.hl ?? config.defaultHl;

  const response = await serpApiSearch({
    engineKey: "shopping",
    schema: shoppingResponseSchema,
    params: {
      q: queryText,
      gl,
      hl,
      location: input.location,
      num: input.limit,
    },
  });

  assertNoSearchError(response.error, "The shopping search");

  const raw = response.shopping_results ?? [];
  const listings: Listing[] = [];
  for (const result of raw) {
    const listing = toListing(result);
    if (listing !== null) {
      listings.push(listing);
    }
  }

  return {
    queryText,
    cacheKeyParts: {
      engine: SERPAPI_ENGINES.shopping.engine,
      query: queryText,
      location: input.location ?? null,
      gl,
      hl,
    },
    listings,
    droppedCount: raw.length - listings.length,
  };
}

/* ------------------------------------------------------------------ */
/* Maps and Local                                                      */
/* ------------------------------------------------------------------ */

export interface PlacesSearchInput {
  readonly category: LocalCategory;
  readonly gl?: string;
  readonly hl?: string;
}

export interface MapsSearchInput extends PlacesSearchInput {
  /** Approximate location from the profile, rounded to 2 decimals. */
  readonly latitude: number;
  readonly longitude: number;
  /** Google Maps zoom level. 14 covers a city district. */
  readonly zoom?: number;
}

export interface LocalSearchInput extends PlacesSearchInput {
  /** City level location string, for example "Bengaluru, Karnataka, India". */
  readonly location: string;
}

export interface PlacesSearchOutput {
  readonly queryText: string;
  readonly cacheKeyParts: SearchCacheKeyParts;
  readonly places: readonly NearbyPlace[];
}

/** Nearby stores by coordinates. Only runs when location was allowed. */
export async function searchMaps(input: MapsSearchInput): Promise<PlacesSearchOutput> {
  const config = readSerpApiConfig();
  const queryText = buildLocalQuery(input.category);
  const gl = input.gl ?? config.defaultGl;
  const hl = input.hl ?? config.defaultHl;
  const ll = `@${input.latitude},${input.longitude},${input.zoom ?? 14}z`;

  const response = await serpApiSearch({
    engineKey: "maps",
    schema: placesResponseSchema,
    params: { q: queryText, ll, type: "search", gl, hl },
  });

  assertNoSearchError(response.error, "The maps search");

  return {
    queryText,
    cacheKeyParts: {
      engine: SERPAPI_ENGINES.maps.engine,
      query: queryText,
      location: ll,
      gl,
      hl,
    },
    places: collectPlaces(response.local_results),
  };
}

/** Nearby stores by city name, for people who allowed location at city level only. */
export async function searchLocal(input: LocalSearchInput): Promise<PlacesSearchOutput> {
  const config = readSerpApiConfig();
  const queryText = buildLocalQuery(input.category);
  const gl = input.gl ?? config.defaultGl;
  const hl = input.hl ?? config.defaultHl;

  const response = await serpApiSearch({
    engineKey: "local",
    schema: placesResponseSchema,
    params: { q: queryText, location: input.location, gl, hl },
  });

  assertNoSearchError(response.error, "The local search");

  return {
    queryText,
    cacheKeyParts: {
      engine: SERPAPI_ENGINES.local.engine,
      query: queryText,
      location: input.location,
      gl,
      hl,
    },
    places: collectPlaces(response.local_results),
  };
}

function collectPlaces(
  results: ReadonlyArray<Parameters<typeof toNearbyPlace>[0]> | undefined,
): NearbyPlace[] {
  const places: NearbyPlace[] = [];
  for (const result of results ?? []) {
    const place = toNearbyPlace(result);
    if (place !== null) {
      places.push(place);
    }
  }
  return places;
}
