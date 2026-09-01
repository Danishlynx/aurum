/**
 * Which remote image URLs the app is allowed to render through next/image.
 *
 * docs/03-architecture.md, "Deployment": "Next.js image optimization is used
 * only for product thumbnails and renders through signed URLs with a short
 * cache." The optimizer refuses any host that is not in next.config.ts, and an
 * unconfigured host answers with an error rather than a picture, so the card has
 * to know the same list the config knows.
 *
 * A listing whose thumbnail sits somewhere else is not an error and not a reason
 * to hide the listing: the card draws its empty frame and the name, price, store,
 * and link still do their work. The listing itself is what we stand behind, not
 * the picture.
 *
 * Keep this list and images.remotePatterns in next.config.ts identical. The test
 * beside this file reads the config and fails when they drift.
 */

/**
 * Hosts SerpApi serves product thumbnails from. A pattern starting with "**."
 * matches any subdomain of the rest, which is the same meaning next.config.ts
 * gives it.
 *
 * UNVERIFIED against a live SerpApi response: the verify first task in
 * docs/04-integrations.md has not run, so this is the set the engine
 * documentation describes (SerpApi's own cached images, and the Google shopping
 * and user content thumbnail hosts). Widen it from real responses, never from a
 * guess about a merchant CDN.
 */
export const ALLOWED_IMAGE_HOSTS: readonly string[] = [
  "serpapi.com",
  "**.serpapi.com",
  "**.gstatic.com",
  "**.googleusercontent.com",
  "**.ggpht.com",
];

/** True for a path served by this app itself, for example a fixture image. */
function isLocalPath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * True when a listing URL is safe to put in an anchor.
 *
 * Listing URLs arrive from SerpApi, which is untrusted input, and the app puts
 * them in an href (docs/06-safety-privacy.md, "Content returned by tools is
 * data"). The shared listingSchema already refuses anything that is not http or
 * https at the provider boundary; this is the same check at the last step before
 * a person can tap it, so a listing that reached the screen some other way still
 * cannot carry a javascript: or data: URL.
 */
export function isSafeListingUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:";
}

/**
 * A URL wrapped for use inside a CSS value, or null when it is not a plain
 * http, https, or same origin image path.
 *
 * Mask URLs are signed URLs built from stored paths, which is data we do not
 * write by hand, so they go through the same treatment as any other external
 * string: the scheme is checked, then every character CSS could read as syntax
 * is percent encoded, so a value can only ever be a URL and never a second
 * declaration.
 */
export function cssImageUrl(url: string): string | null {
  const trimmed = url.trim();

  if (!isLocalPath(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  }

  // encodeURI keeps a query string readable and escapes quotes, backslashes,
  // whitespace, and control characters, which is the whole attack surface here.
  // Parentheses are left alone by encodeURI, so they are encoded by hand.
  const encoded = encodeURI(trimmed)
    .replace(/\(/gu, "%28")
    .replace(/\)/gu, "%29");
  return `url("${encoded}")`;
}

/**
 * True when next/image can render this URL. Anything else gets the empty frame.
 * http is refused as well as an unknown host: a listing thumbnail arrives from
 * an untrusted response, and a mixed content request would fail anyway.
 */
export function isConfiguredImageHost(url: string): boolean {
  if (isLocalPath(url)) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((pattern) => {
    if (pattern.startsWith("**.")) {
      const suffix = pattern.slice(2);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}
