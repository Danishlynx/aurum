import "server-only";

/**
 * Which market a search is run in, resolved from the request itself.
 *
 * docs/04-integrations.md, "Local availability": "Location comes from the
 * profile's approximate location (city level) with gl and hl set from the
 * person's locale. Default gl is the human's country; make it a config value."
 *
 * The config value is SERPAPI_DEFAULT_GL and SERPAPI_DEFAULT_HL, and until now
 * it was the only answer. That made every listing Indian, which is right for the
 * founder and wrong for a judge in Portland: a report full of Nykaa links is not
 * a report they can act on, and "every recommended product shown as a real, live
 * priced, purchasable item, near them where possible" (CLAUDE.md) means near
 * them, not near us.
 *
 * So the request answers first and the environment answers last:
 *
 *   gl  x-vercel-ip-country, the two letter country Vercel puts on every request
 *       at the edge. Same alphabet as Google's gl, so it is used as it stands,
 *       lowercased.
 *   hl  the first primary subtag of Accept-Language, which every browser sends
 *       ("en-GB,en;q=0.9" reads as "en").
 *
 * Nothing here reads or stores an IP address. The country header is a country,
 * derived by the edge before the request reaches us, and the only thing ever
 * logged from this module's output is that two letter code. The person's own
 * approximate location is a separate, consented thing and still comes from the
 * profile row (docs/06-safety-privacy.md).
 *
 * The header is trusted because Vercel sets it on the platform side and
 * overwrites whatever a client sent. It only ever selects a shopping market, so
 * the worst a forged one could do is show somebody the wrong country's shops.
 *
 * Pure apart from reading process.env: the headers arrive as an argument, so
 * every branch is testable without a request.
 */

/** The country header Vercel sets at the edge, on every request. */
export const COUNTRY_HEADER = "x-vercel-ip-country";

/** The language header the browser sends. */
export const LANGUAGE_HEADER = "accept-language";

/**
 * The last resort, used when neither the request nor the environment says
 * anything. India, because that is where the app was built and where the
 * recorded demo listings come from.
 */
export const FALLBACK_GL = "in";
export const FALLBACK_HL = "en";

export interface GroundingLocale {
  /** Two letter country, lowercase. SerpApi's gl. */
  readonly gl: string;
  /** Two letter language, lowercase. SerpApi's hl. */
  readonly hl: string;
  /** Where it came from, for the one log line a grounding run writes. */
  readonly source: "header" | "env";
}

/**
 * The little of Headers this module needs. Both the Headers a route handler
 * reads off a NextRequest and the one headers() returns in a server component
 * satisfy it, and so does a plain object in a test.
 */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

const TWO_LETTERS = /^[a-z]{2}$/u;

/** A two letter code, lowercased, or null for anything else. */
function twoLetterCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return TWO_LETTERS.test(trimmed) ? trimmed : null;
}

/**
 * The configured defaults.
 *
 * Deliberately lenient about the shape: an operator who sets hl to a regional
 * tag SerpApi accepts should keep it. Only an empty or absent value falls
 * through to the built in one.
 */
export function envGroundingLocale(): { readonly gl: string; readonly hl: string } {
  const gl = process.env.SERPAPI_DEFAULT_GL;
  const hl = process.env.SERPAPI_DEFAULT_HL;
  return {
    gl: typeof gl === "string" && gl.trim().length > 0 ? gl.trim().toLowerCase() : FALLBACK_GL,
    hl: typeof hl === "string" && hl.trim().length > 0 ? hl.trim().toLowerCase() : FALLBACK_HL,
  };
}

/**
 * The language of an Accept-Language header: the first tag's primary subtag.
 *
 * "en-US,en;q=0.9,fr;q=0.8" reads as "en". A wildcard, an empty header, and
 * anything that is not two letters after the region is stripped all read as
 * null, which the caller turns into the default language rather than into a
 * search SerpApi would reject.
 */
export function primaryLanguageOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const firstTag = value.split(",")[0] ?? "";
  const withoutWeight = firstTag.split(";")[0] ?? "";
  const primary = withoutWeight.trim().split("-")[0] ?? "";
  return twoLetterCode(primary);
}

/**
 * The market this request is grounded in.
 *
 * The country header decides. With it, the request is answered in the judge's
 * own country and the language their browser asked for. Without it (local dev, a
 * test, a script, any non request context) the configured defaults answer, which
 * is exactly the behaviour that shipped before this existed.
 *
 * The language is only read when the country was read: a British browser
 * pointing at a machine with no country header should not turn an Indian default
 * market into an English language search of it, because the pair is one market.
 */
export function resolveGroundingLocale(
  headers?: HeaderReader | null,
): GroundingLocale {
  const env = envGroundingLocale();
  if (headers === null || headers === undefined) {
    return { gl: env.gl, hl: env.hl, source: "env" };
  }

  let country: string | null = null;
  try {
    country = twoLetterCode(headers.get(COUNTRY_HEADER));
  } catch {
    // A header bag that throws is a header bag we do not have.
    country = null;
  }
  if (country === null) {
    return { gl: env.gl, hl: env.hl, source: "env" };
  }

  let language: string | null = null;
  try {
    language = primaryLanguageOf(headers.get(LANGUAGE_HEADER));
  } catch {
    language = null;
  }

  return { gl: country, hl: language ?? FALLBACK_HL, source: "header" };
}
