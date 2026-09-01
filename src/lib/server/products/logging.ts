import "server-only";

/**
 * One structured line per grounding decision.
 *
 * docs/03-architecture.md, "Observability": provider calls made, credits spent,
 * outcome, and nothing else. What is never in a line here: the query text (it
 * describes a person's skin), a listing URL, a store name, or an owner's
 * identity beyond the id we minted.
 *
 * The count fields exist so a run can be read back later: how many steps asked
 * for a product, how many were answered from cache, how many cost a search, and
 * how many ended with no listing.
 */

/** Why a step ended without a product, or why a search did not happen. */
export type GroundingReason =
  /** SERPAPI_API_KEY is not set on the server. Nothing live can be fetched. */
  | "serpapi_not_configured"
  /** PROVIDER_CALLS_ENABLED is false. Cache only, by choice. */
  | "provider_calls_disabled"
  /** The person's daily SerpApi cap is used up. */
  | "daily_cap"
  /** A judge session's credit cap is used up, or the session has expired. */
  | "session_cap"
  /** The ledger itself could not be reached, so no call was made. */
  | "ledger_unavailable"
  /** The cache could not be read or written. The run continues without it. */
  | "cache_unavailable"
  /** The query was empty or unusable after cleaning. */
  | "invalid_query"
  /** The caller's options did not validate. */
  | "invalid_options"
  /** The provider answered, but with nothing we can show. */
  | "no_listing"
  /** The provider call failed. */
  | "provider_error";

export interface GroundingLogFields {
  readonly reason: GroundingReason;
  readonly engine: string | null;
  /** How many routine steps this reason applies to. */
  readonly steps: number;
  /** Searches actually sent to SerpApi during this run. */
  readonly searches: number;
  /** Our own provider error code, never a provider payload. */
  readonly errorCode: string | null;
}

export function logGrounding(fields: GroundingLogFields): void {
  console.warn(JSON.stringify({ event: "aurum.grounding", ...fields }));
}

export interface GroundingRunFields {
  readonly steps: number;
  readonly fromCache: number;
  readonly fromSearch: number;
  readonly withoutListing: number;
  readonly searches: number;
  readonly localLookup: boolean;
}

export function logGroundingRun(fields: GroundingRunFields): void {
  console.log(JSON.stringify({ event: "aurum.grounding_run", ...fields }));
}
