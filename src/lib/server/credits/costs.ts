import "server-only";

import {
  unitsForCall,
  type PerfectCorpEndpointKey,
} from "../providers/perfectcorp";
import type { AnalysisKind, CreditProvider } from "../db/types";

/**
 * What one provider call reserves, read from the provider's own endpoint table
 * so there is one credit table, not two.
 *
 * docs/04-integrations.md keeps the authoritative numbers; endpoints.ts returns
 * null for every row still marked TBD (cloth try on today, and the accessory
 * APIs other than the watch).
 *
 * Skin analysis left that list on 2026-09-02: one live task measured it at 16
 * units, balance 40 to 24. It is a measurement of one call with all 16 SD
 * concern keys, not a published price, which endpoints.ts says on the row.
 */

/**
 * TODO: replace with the real figure once the human reads the per call cost for
 * cloth try on from the Perfect Corp API console, and updates the credit table
 * in docs/04-integrations.md and unitCost in
 * src/lib/server/providers/perfectcorp/endpoints.ts.
 *
 * Until then an unknown cost reserves one unit. One unit is deliberately low:
 * it keeps the flow working for a judge instead of blocking on a missing number,
 * and reconciliation writes the real figure to the ledger the moment
 * endpoints.ts learns it.
 */
export const UNKNOWN_COST_FALLBACK_UNITS = 1;

/** True when the real cost of this endpoint is still unknown. */
export function hasUnknownCost(
  key: PerfectCorpEndpointKey,
  itemCount = 1,
): boolean {
  return unitsForCall(key, itemCount) === null;
}

export function perfectCorpUnits(
  key: PerfectCorpEndpointKey,
  itemCount = 1,
): number {
  return unitsForCall(key, itemCount) ?? UNKNOWN_COST_FALLBACK_UNITS;
}

/** SerpApi bills per search, so one search is one unit. */
export const SERPAPI_UNITS_PER_SEARCH = 1;

/**
 * Claude calls are billed in tokens, not units. The ledger counts calls so the
 * cost per session can be read back later; it is not a spend limit.
 */
export const ANTHROPIC_UNITS_PER_CALL = 1;

/** The endpoint each analysis kind is served by, per endpoints.ts. */
export const ENDPOINT_FOR_ANALYSIS: Readonly<
  Record<AnalysisKind, PerfectCorpEndpointKey>
> = {
  skin: "skinAnalysis",
  fitzpatrick: "fitzpatrick",
  attributes: "facialColorTones",
  face_shape: "faceAttributes",
  hair_type: "hairType",
};

export function unitsForProvider(
  provider: CreditProvider,
  key: PerfectCorpEndpointKey | null,
  itemCount = 1,
): number {
  if (provider === "perfectcorp") {
    return key === null
      ? UNKNOWN_COST_FALLBACK_UNITS
      : perfectCorpUnits(key, itemCount);
  }
  if (provider === "serpapi") {
    return SERPAPI_UNITS_PER_SEARCH;
  }
  return ANTHROPIC_UNITS_PER_CALL;
}
