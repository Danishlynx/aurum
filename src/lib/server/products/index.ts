import "server-only";

import type { ReportListing } from "@/lib/shared/report-view";

import { providerCallsEnabled } from "../env";
import {
  isSerpApiConfigured,
  searchMaps,
  type LocalCategory,
  type NearbyPlace,
} from "../providers/serpapi";
import { readProductCache, writeProductCache } from "./cache";
import {
  locationKey,
  roundCoordinate,
  type ApproxLocation,
  type CacheKeyParts,
} from "./cache-policy";
import { distanceTextForStore } from "./distance";
import { isBlockedListingUrl } from "./hosts";
import { openSearchBudget, type SearchBudget } from "./ledger";
import {
  logGrounding,
  logGroundingRun,
  type GroundingReason,
} from "./logging";
import {
  normalizeShoppingResponse,
  topListing,
  type NormalizedListing,
} from "./normalize";
import { rankListings, sanitizeProductQuery } from "./ranking";
import {
  cachedListingsSchema,
  cachedPlacesSchema,
  groundingOptionsSchema,
  routineStepInputSchema,
} from "./schemas";
import { fetchShoppingBody, MAPS_ENGINE, SHOPPING_ENGINE } from "./search";

/**
 * Product grounding: a routine step in, a real listing or nothing out.
 *
 * docs/06-safety-privacy.md, "Grounding and honesty": "A product appears only
 * with a real listing (URL and price) from SerpApi. No listing, no product."
 * Every path through this file ends in either a listing that came back from the
 * provider or null. There is no third answer, and null is not a failure: it is
 * the "No listing found near you yet" row on the report.
 *
 * The order of work, per docs/03-architecture.md, "Caching" and "Credits and
 * caps":
 *
 * 1. clean and de duplicate the queries, so two steps asking for the same thing
 *    cost one search
 * 2. read product_cache, keyed on engine, query, rounded location, gl, and hl
 * 3. for the misses, reserve a search in the ledger, call SerpApi, normalize,
 *    rank, and write the cache
 * 4. once per run, if the person allowed location, look up nearby stores and
 *    attach a distance to the listings whose store is actually one of them
 *
 * Nothing here throws. A missing key, a disabled kill switch, a used up cap, an
 * unreachable database, and a provider error all produce nulls and one log line
 * carrying the typed reason. The report renders either way.
 */

export {
  BLOCKED_HOSTS_REVIEWED_ON,
  BLOCKED_LISTING_HOSTS,
  hostOfUrl,
  isBlockedListingUrl,
} from "./hosts";
export {
  queryKeyTokens,
  rankListings,
  relevanceScore,
  RELEVANCE_BAND,
  sanitizeProductQuery,
  titleTokens,
} from "./ranking";
export {
  isCacheFresh,
  locationKey,
  productCacheKey,
  roundCoordinate,
  cacheTtlMs,
  CACHEABLE_ENGINES,
  LOCATION_DECIMALS,
} from "./cache-policy";
export type { ApproxLocation, CacheKeyParts } from "./cache-policy";
export {
  normalizeShoppingResponse,
  topListing,
} from "./normalize";
export type { NormalizedListing, NormalizeOutcome } from "./normalize";
export {
  distanceTextForStore,
  formatDistanceKm,
  haversineKm,
  matchStoreToPlace,
} from "./distance";
export { fetchShoppingBody, MAPS_ENGINE, SHOPPING_ENGINE } from "./search";
export type { GroundingReason } from "./logging";

/**
 * The store category a skincare routine is bought in.
 *
 * docs/04-integrations.md names "pharmacy", "beauty store", and "menswear" as
 * the categories we ask google_maps or google_local for. Layer 1 grounds a
 * skincare routine, and a pharmacy is where a cleanser, a sunscreen, and a
 * serum are all reliably stocked. Layer 4 will pass its own category when it
 * grounds garments.
 */
export const ROUTINE_STORE_CATEGORY: LocalCategory = "pharmacy";

/** What the profile layer hands us. Only the query is grounding's business. */
export interface RoutineStepQuery {
  readonly productQuery: string;
}

export interface GroundingRequestOptions {
  /** City level, rounded to 2 decimals. Null when location was not allowed. */
  readonly location: ApproxLocation | null;
  readonly gl: string;
  readonly hl: string;
  readonly ownerType: "user" | "judge_session";
  readonly ownerId: string;
}

/** Collects reasons so each one is logged once per run, with a count. */
class ReasonLog {
  private readonly counts = new Map<GroundingReason, number>();
  private readonly codes = new Map<GroundingReason, string>();

  note(reason: GroundingReason, steps: number, errorCode?: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + steps);
    if (errorCode !== undefined && !this.codes.has(reason)) {
      this.codes.set(reason, errorCode);
    }
  }

  /**
   * One line per distinct reason. engine is null because a run can span the
   * shopping engine and the maps engine, and a line that named one of them
   * would be wrong for the other.
   */
  flush(searches: number): void {
    for (const [reason, steps] of this.counts) {
      logGrounding({
        reason,
        engine: null,
        steps,
        searches,
        errorCode: this.codes.get(reason) ?? null,
      });
    }
  }
}

function shoppingParts(
  query: string,
  options: GroundingRequestOptions,
): CacheKeyParts {
  return {
    engine: SHOPPING_ENGINE,
    query,
    location: locationKey(options.location),
    gl: options.gl,
    hl: options.hl,
  };
}

function placesParts(options: GroundingRequestOptions): CacheKeyParts {
  return {
    engine: MAPS_ENGINE,
    query: ROUTINE_STORE_CATEGORY,
    location: locationKey(options.location),
    gl: options.gl,
    hl: options.hl,
  };
}

/**
 * Defence in depth on a cache read. An entry written before a host joined the
 * blocked list would otherwise keep serving that host until it expired.
 */
function withoutBlockedHosts(
  listings: readonly NormalizedListing[],
): NormalizedListing[] {
  return listings.filter((listing) => !isBlockedListingUrl(listing.url));
}

/**
 * Grounds a set of routine steps.
 *
 * Returns one entry per input step, in the same order. Null means no listing:
 * the row shows the ingredient or product type and the "No listing found near
 * you yet" copy, never an invented product.
 */
export async function groundRoutineSteps(
  steps: readonly RoutineStepQuery[],
  opts: GroundingRequestOptions,
): Promise<(ReportListing | null)[]> {
  const results: (ReportListing | null)[] = steps.map(() => null);
  if (steps.length === 0) {
    return results;
  }

  const reasons = new ReasonLog();

  const parsedOptions = groundingOptionsSchema.safeParse(opts);
  if (!parsedOptions.success) {
    reasons.note("invalid_options", steps.length);
    reasons.flush(0);
    return results;
  }
  const options: GroundingRequestOptions = parsedOptions.data;

  // 1. Clean every query. A step whose query does not survive cleaning gets no
  // search, because a query we cannot trust is not a query we should send.
  const queries: (string | null)[] = steps.map((step) => {
    const parsedStep = routineStepInputSchema.safeParse(step);
    if (!parsedStep.success) {
      return null;
    }
    return sanitizeProductQuery(parsedStep.data.productQuery);
  });
  const invalidQueries = queries.filter((query) => query === null).length;
  if (invalidQueries > 0) {
    reasons.note("invalid_query", invalidQueries);
  }

  const distinct: string[] = [];
  for (const query of queries) {
    if (query !== null && !distinct.includes(query)) {
      distinct.push(query);
    }
  }
  if (distinct.length === 0) {
    reasons.flush(0);
    return results;
  }

  const nowMs = Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const listingsByQuery = new Map<string, NormalizedListing[]>();

  // 2. Cache first, always. The kill switch and an exhausted cap both still
  // serve whatever is fresh in here (docs/03-architecture.md, kill switch).
  const misses: string[] = [];
  for (const query of distinct) {
    const cached = await readProductCache({
      parts: shoppingParts(query, options),
      schema: cachedListingsSchema,
      nowMs,
    });
    if (cached === null) {
      misses.push(query);
      continue;
    }
    listingsByQuery.set(
      query,
      rankListings(withoutBlockedHosts(cached.results), query),
    );
  }

  // 3. Live searches for the misses.
  let shoppingSearches = 0;
  let budgetPromise: Promise<SearchBudget> | null = null;
  const budgetOnce = (): Promise<SearchBudget> => {
    budgetPromise ??= openSearchBudget({
      ownerType: options.ownerType,
      ownerId: options.ownerId,
    });
    return budgetPromise;
  };

  const stepsPerQuery = (query: string): number =>
    queries.filter((candidate) => candidate === query).length;
  const stepsFor = (queryList: readonly string[]): number =>
    queryList.reduce((total, query) => total + stepsPerQuery(query), 0);

  const serpApiConfigured = isSerpApiConfigured();
  const callsEnabled = providerCallsEnabled();
  const live = serpApiConfigured && callsEnabled;

  if (misses.length > 0 && !serpApiConfigured) {
    reasons.note("serpapi_not_configured", stepsFor(misses));
  } else if (misses.length > 0 && !callsEnabled) {
    reasons.note("provider_calls_disabled", stepsFor(misses));
  }

  if (misses.length > 0 && live) {
    const budget = await budgetOnce();
    if (!budget.ok) {
      reasons.note(budget.reason, stepsFor(misses));
    } else {
      for (let index = 0; index < misses.length; index += 1) {
        const query = misses[index];
        const reserved = await budget.reserve();
        if (!reserved.ok) {
          // The cap is reached. Everything still unsearched shares the reason.
          reasons.note(reserved.reason, stepsFor(misses.slice(index)));
          break;
        }
        try {
          const body = await fetchShoppingBody({
            query,
            gl: options.gl,
            hl: options.hl,
          });
          shoppingSearches += 1;
          const outcome = normalizeShoppingResponse(body, query);
          listingsByQuery.set(query, [...outcome.listings]);
          // An empty result is cached too. A query that found nothing found
          // nothing, and paying for that answer again on the next report would
          // spend the daily cap on a known no.
          await writeProductCache({
            parts: shoppingParts(query, options),
            results: outcome.listings,
            fetchedAt,
          });
        } catch (thrown) {
          await budget.refund(reserved.reservation);
          reasons.note(
            "provider_error",
            stepsPerQuery(query),
            errorCodeOf(thrown),
          );
        }
      }
    }
  }

  // 4. One listing per step, then local availability once for the whole run.
  const tops: (NormalizedListing | null)[] = queries.map((query) =>
    query === null ? null : topListing(listingsByQuery.get(query) ?? []),
  );
  const withListing = tops.filter(
    (listing): listing is NormalizedListing => listing !== null,
  );

  let places: readonly NearbyPlace[] = [];
  let localLookup = false;
  if (options.location !== null && withListing.length > 0) {
    const outcome = await nearbyStores({
      options,
      nowMs,
      fetchedAt,
      live,
      budgetOnce,
      reasons,
    });
    places = outcome.places;
    localLookup = outcome.searched;
  }

  let withoutListing = 0;
  for (let index = 0; index < steps.length; index += 1) {
    const listing = tops[index];
    if (listing === null) {
      if (queries[index] !== null) {
        withoutListing += 1;
      }
      continue;
    }
    results[index] = {
      ...listing,
      distanceText: distanceTextForStore({
        store: listing.store,
        places,
        location: options.location,
      }),
    };
  }
  if (withoutListing > 0) {
    reasons.note("no_listing", withoutListing);
  }

  const searches = shoppingSearches + (localLookup ? 1 : 0);
  reasons.flush(searches);
  logGroundingRun({
    steps: steps.length,
    fromCache: distinct.length - misses.length,
    fromSearch: shoppingSearches,
    withoutListing,
    searches,
    localLookup,
  });

  return results;
}

/**
 * Nearby stores for the routine's category, once per run.
 *
 * docs/04-integrations.md: google_maps takes coordinates, so the person's
 * approximate location is rounded to the two decimals the profile stores and
 * used directly. The result is cached for 6 hours like every other local search.
 */
async function nearbyStores(args: {
  readonly options: GroundingRequestOptions;
  readonly nowMs: number;
  readonly fetchedAt: string;
  readonly live: boolean;
  readonly budgetOnce: () => Promise<SearchBudget>;
  readonly reasons: ReasonLog;
}): Promise<{ readonly places: readonly NearbyPlace[]; readonly searched: boolean }> {
  const { options } = args;
  if (options.location === null) {
    return { places: [], searched: false };
  }

  const parts = placesParts(options);
  const cached = await readProductCache({
    parts,
    schema: cachedPlacesSchema,
    nowMs: args.nowMs,
  });
  if (cached !== null) {
    return { places: cached.results, searched: false };
  }
  if (!args.live) {
    return { places: [], searched: false };
  }

  const budget = await args.budgetOnce();
  if (!budget.ok) {
    args.reasons.note(budget.reason, 0);
    return { places: [], searched: false };
  }
  const reserved = await budget.reserve();
  if (!reserved.ok) {
    args.reasons.note(reserved.reason, 0);
    return { places: [], searched: false };
  }

  try {
    const outcome = await searchMaps({
      category: ROUTINE_STORE_CATEGORY,
      latitude: roundCoordinate(options.location.lat),
      longitude: roundCoordinate(options.location.lng),
      gl: options.gl,
      hl: options.hl,
    });
    await writeProductCache({
      parts,
      results: outcome.places,
      fetchedAt: args.fetchedAt,
    });
    return { places: outcome.places, searched: true };
  } catch (thrown) {
    await budget.refund(reserved.reservation);
    args.reasons.note("provider_error", 0, errorCodeOf(thrown));
    return { places: [], searched: false };
  }
}

/**
 * Our own code for a failure, never a provider payload
 * (docs/03-architecture.md, "Observability").
 */
function errorCodeOf(thrown: unknown): string {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    typeof (thrown as { code: unknown }).code === "string"
  ) {
    return (thrown as { code: string }).code;
  }
  return "unknown_error";
}
