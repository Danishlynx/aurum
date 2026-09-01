import "server-only";

/**
 * Hosts a listing may not come from.
 *
 * docs/05-evals.md, suite eval:grounding: "the URL host is not in the blocked
 * list (aggregators that redirect to nothing)". The problem these hosts share is
 * that their product URL is a comparison page or a redirector, so tapping
 * "View listing" lands the person on a search box or a dead page rather than on
 * the thing they were shown a price for. That breaks the promise in
 * docs/06-safety-privacy.md that every recommendation is a real, purchasable
 * listing.
 *
 * This list is deliberately small and starts from the aggregator families that
 * appear in Google Shopping results for the two markets this build targets
 * (India and the United States). It grows the way docs/05-evals.md says every
 * list grows: when a real failure is found, the failing URL becomes a fixture,
 * the host is added here, and the date is recorded below.
 *
 * Not on the list, on purpose:
 *
 * - google.com. SerpApi's google_shopping results carry product_link on
 *   google.com for most rows, and that page is a real product page with real
 *   merchants and a real price, not a dead redirect. Blocking it would drop
 *   nearly every listing and leave the report with no products at all, which is
 *   a worse answer than a Google product page.
 * - Marketplaces (amazon, flipkart, nykaa, walmart, target). They sell the item.
 *   A marketplace is not an aggregator.
 */

/** When this list was last reviewed. Update it when a host is added. */
export const BLOCKED_HOSTS_REVIEWED_ON = "2026-09-01";

/**
 * Matched on the registrable host and on any subdomain of it, so
 * "www.shopping.com" and "m.shopping.com" are both blocked by "shopping.com".
 */
export const BLOCKED_LISTING_HOSTS: readonly string[] = [
  // Price comparison, United States.
  "shopping.com",
  "pricegrabber.com",
  "nextag.com",
  "shopzilla.com",
  "bizrate.com",
  // Price comparison, Europe and the United Kingdom.
  "pricerunner.com",
  "idealo.com",
  // Price comparison, India.
  "mysmartprice.com",
  "smartprix.com",
  "compareraja.in",
  "pricee.com",
];

const BLOCKED_HOST_SET: ReadonlySet<string> = new Set(BLOCKED_LISTING_HOSTS);

/**
 * The lowercase host of an http or https URL, or null when the string is not
 * one. Anything that is not http or https is treated as blocked by the caller:
 * a listing URL goes into an anchor, so javascript: and data: never pass here.
 */
export function hostOfUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  return host.length === 0 ? null : host;
}

/** True when the URL is unusable or its host is a blocked aggregator. */
export function isBlockedListingUrl(url: string): boolean {
  const host = hostOfUrl(url);
  if (host === null) {
    return true;
  }
  if (BLOCKED_HOST_SET.has(host)) {
    return true;
  }
  for (const blocked of BLOCKED_LISTING_HOSTS) {
    if (host.endsWith(`.${blocked}`)) {
      return true;
    }
  }
  return false;
}
