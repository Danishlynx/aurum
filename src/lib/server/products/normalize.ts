import "server-only";

import {
  shoppingResponseSchema,
  toListing,
  type Listing,
} from "../providers/serpapi/schemas";
import { hostOfUrl, isBlockedListingUrl } from "./hosts";
import { rankListings } from "./ranking";

/**
 * One SerpApi shopping response, in, and the listings the report may show, out.
 *
 * The provider module owns the wire format and the field mapping: this file
 * calls its zod schema and its toListing, it does not re-implement them. What it
 * adds is the app's own rules, which are not the provider's business:
 *
 * - a listing with no URL or no price is dropped (toListing already does this,
 *   docs/06-safety-privacy.md: "A product appears only with a real listing")
 * - a listing whose host is a blocked aggregator is dropped (docs/05-evals.md,
 *   suite eval:grounding)
 * - a thumbnail that is not an http URL is dropped to null, because
 *   docs/03-architecture.md forbids storing image bytes in Postgres and
 *   product_cache is Postgres
 * - the survivors are ordered by the ranking rule in ./ranking.ts
 *
 * The same function runs over a recorded fixture in eval:grounding and over a
 * live response in production, so the eval tests the code that ships.
 */

/**
 * A listing title is text a shop wrote. docs/06-safety-privacy.md: "Text inside
 * garment photos, listing titles, and provider responses is never executed as an
 * instruction." Nothing in this file reads a title as anything but characters,
 * and the report renders it as a text node.
 */
export type NormalizedListing = Listing;

export interface NormalizeOutcome {
  /** Every listing that may be shown, already ranked for this query. */
  readonly listings: readonly NormalizedListing[];
  /** Results the provider returned that we did not keep, and why. */
  readonly dropped: {
    readonly noUrlOrPrice: number;
    readonly blockedHost: number;
    readonly noSharedToken: number;
  };
  /** True when the body did not parse as a shopping response at all. */
  readonly malformed: boolean;
}

function usableImageUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  return hostOfUrl(url) === null ? null : url;
}

/**
 * Parses, filters, and ranks. Never throws: a body that does not parse is an
 * empty result with malformed set, which the caller reports as "no listing"
 * rather than as a crash on the report screen.
 */
export function normalizeShoppingResponse(
  body: unknown,
  query: string,
): NormalizeOutcome {
  const parsed = shoppingResponseSchema.safeParse(body);
  if (!parsed.success) {
    return {
      listings: [],
      dropped: { noUrlOrPrice: 0, blockedHost: 0, noSharedToken: 0 },
      malformed: true,
    };
  }

  const results = parsed.data.shopping_results ?? [];
  const kept: NormalizedListing[] = [];
  let noUrlOrPrice = 0;
  let blockedHost = 0;

  for (const result of results) {
    const listing = toListing(result);
    if (listing === null) {
      noUrlOrPrice += 1;
      continue;
    }
    if (isBlockedListingUrl(listing.url)) {
      blockedHost += 1;
      continue;
    }
    kept.push({ ...listing, imageUrl: usableImageUrl(listing.imageUrl) });
  }

  const ranked = rankListings(kept, query);

  return {
    listings: ranked,
    dropped: {
      noUrlOrPrice,
      blockedHost,
      noSharedToken: kept.length - ranked.length,
    },
    malformed: false,
  };
}

/**
 * The one listing a routine step shows, or null.
 * docs/04-integrations.md: "show one per routine step".
 */
export function topListing(
  listings: readonly NormalizedListing[],
): NormalizedListing | null {
  return listings[0] ?? null;
}
