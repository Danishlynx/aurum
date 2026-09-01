import "server-only";

import {
  assertNoSearchError,
  serpApiSearch,
} from "../providers/serpapi/client";
import { SERPAPI_ENGINES } from "../providers/serpapi/endpoints";
import { shoppingResponseSchema } from "../providers/serpapi/schemas";

/**
 * The one call this layer makes to the shopping engine.
 *
 * Why it is not src/lib/server/providers/serpapi/index.ts searchShopping: that
 * function takes the structured ProductQuery union and builds the query text
 * itself, which is right for a query the app assembles from parts. Layer 1's
 * query arrives as a single string from the synthesis call
 * (docs/04-integrations.md, synthesis output schema: product_query), already
 * cleaned by sanitizeProductQuery in ./ranking.ts. This adapter passes that
 * prepared string through the provider's own client, schema, and error
 * handling, so the wire format still lives in the provider module. When the
 * provider module grows a raw query entry point, delete this file and call it.
 *
 * UNVERIFIED, and the reason the shopping search does not send `location`:
 * SerpApi's google_shopping `location` parameter takes a canonical location
 * name from its own locations database, and an unrecognized value is rejected
 * outright. We cannot check what our city strings resolve to without a key, and
 * a rejected search means a report with no products at all. Until someone
 * confirms the accepted form against a live key (docs/04-integrations.md,
 * "Verify first"), the market comes from gl and hl, and local availability comes
 * from the google_maps lookup, which takes coordinates and cannot be rejected
 * for a spelling. The location still forms part of the cache key, so turning
 * this on later does not serve entries fetched without it.
 */

/**
 * How many results to ask for. One is shown per routine step and three for shop
 * the gap, but ranking needs a pool: relevance filtering discards a good share
 * of a shopping page, and the price sort is only meaningful across several.
 */
export const SHOPPING_RESULT_POOL = 20;

export const SHOPPING_ENGINE = SERPAPI_ENGINES.shopping.engine;
export const MAPS_ENGINE = SERPAPI_ENGINES.maps.engine;

/**
 * One shopping search. Returns the parsed provider body, which
 * normalizeShoppingResponse turns into listings.
 *
 * Throws a ProviderError when the call or the parse fails. The orchestrator
 * catches it and answers with "no listing", because a failed search must never
 * reach the person as an error on the report screen.
 */
export async function fetchShoppingBody(args: {
  readonly query: string;
  readonly gl: string;
  readonly hl: string;
}): Promise<unknown> {
  const response = await serpApiSearch({
    engineKey: "shopping",
    schema: shoppingResponseSchema,
    params: {
      q: args.query,
      gl: args.gl,
      hl: args.hl,
      num: SHOPPING_RESULT_POOL,
    },
  });

  // A search that found nothing is not a failure: it is the "No listing found
  // near you yet" state. assertNoSearchError already treats it that way.
  assertNoSearchError(response.error, "The shopping search");
  return response;
}
