import "server-only";

/**
 * Query text handling and the ranking rule.
 *
 * docs/04-integrations.md, SerpApi rules: "Rank listings by relevance to the
 * query and then price ascending within a tight relevance band; show one per
 * routine step, three for shop the gap."
 *
 * docs/05-evals.md, suite eval:grounding: "the top listing's title shares at
 * least one key token with the query". That is a hard rule here, not a scoring
 * nudge: a listing that shares no key token with the query is dropped, and if
 * every listing is dropped the step shows the "No listing found near you yet"
 * state rather than an unrelated product.
 *
 * Everything in this file is pure.
 */

/** Longest query we will send. Keeps a long model output out of the URL. */
const MAX_QUERY_LENGTH = 120;

/**
 * Product queries are built from the recommendation, never from free text a
 * person typed (docs/04-integrations.md, "Query construction"). The synthesis
 * call still produces the string, and a model output is untrusted input, so the
 * text is reduced to letters, digits, spaces, and a few marks before it becomes
 * a query parameter. This is the same charset the SerpApi provider module
 * applies to its structured query parts.
 *
 * Returns null when nothing usable is left, which the caller reads as "no
 * query, no search, no product".
 */
export function sanitizeProductQuery(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} '.+&/-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * Where a product query stops describing the product and starts describing the
 * person it is for. A synthesis query reads "niacinamide serum for pigmentation
 * combination", and everything from "for" onwards is the reason we chose it, not
 * something a shop puts in a product title.
 */
const TAIL_MARKERS: ReadonlySet<string> = new Set([
  "for",
  "prone",
  "suitable",
  "that",
  "to",
  "with",
]);

/** How many words a broadened query keeps when there is no marker to cut at. */
const BROAD_QUERY_WORDS = 3;

/**
 * The same query, widened to the product itself, or null when it is already as
 * wide as it goes.
 *
 * Why it exists: a strict query is the right thing to ask first, and on the
 * Indian market it is often the reason nothing comes back at all. "niacinamide
 * serum for pigmentation combination" is a sentence about a person; Amazon.in,
 * Nykaa, and Myntra list "niacinamide serum". The caller searches the strict
 * query, and only if that ends with no listing does it spend a second search on
 * this one, so the precise answer is always preferred and the broad one is the
 * difference between a real product and the empty row.
 *
 * The rule is two cuts, in order:
 *
 * 1. drop the tail from the first marker word, which is where the concern and
 *    the skin type live
 * 2. if that changed nothing, keep the first three words, which is the length a
 *    shop's own title tends to be
 *
 * Nothing here names a store, a market, or a brand: the market is gl and hl, and
 * this only shortens the words we were already going to send.
 */
export function broadenProductQuery(query: string): string | null {
  const words = query.trim().split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }

  const marker = words.findIndex((word) =>
    TAIL_MARKERS.has(word.toLowerCase()),
  );
  const head = marker > 0 ? words.slice(0, marker) : words;
  const broad = head.slice(0, BROAD_QUERY_WORDS);

  if (broad.length === 0 || broad.length === words.length) {
    return null;
  }
  return broad.join(" ");
}

/**
 * Words that carry no product meaning. Kept short on purpose: a longer list
 * starts throwing away real signal ("skin", "dry", "oil" all matter here).
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "best",
  "buy",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "your",
]);

/** Shortest token that can carry meaning. "10" and "spf" both pass. */
const MIN_TOKEN_LENGTH = 2;

/**
 * One normal form for both sides of the comparison, so "serums" in a title
 * matches "serum" in a query. Deliberately cruder than a stemmer: it only drops
 * a trailing plural s, which is the difference that actually shows up between a
 * product query and a shop's product title.
 */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
    .map(stem);
}

/** The distinct meaningful tokens of a query, in order of first appearance. */
export function queryKeyTokens(query: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of tokenize(query)) {
    if (STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** The distinct tokens of a listing title, stopwords included. */
export function titleTokens(title: string): ReadonlySet<string> {
  return new Set(tokenize(title));
}

/**
 * The share of the query's key tokens the title carries, 0 to 1. A title that
 * shares nothing scores 0 and is never shown.
 */
export function relevanceScore(
  title: string,
  keyTokens: readonly string[],
): number {
  if (keyTokens.length === 0) {
    return 0;
  }
  const tokens = titleTokens(title);
  let matched = 0;
  for (const token of keyTokens) {
    if (tokens.has(token)) {
      matched += 1;
    }
  }
  return matched / keyTokens.length;
}

/**
 * The "tight relevance band" from docs/04-integrations.md, as a fraction of the
 * key tokens. 0.15 means: on a four token query, a listing may miss one token
 * that the best listing matched only if the best listing is not itself perfect
 * by more than that. In practice it keeps the price sort inside a group of
 * listings that are about the same thing.
 */
export const RELEVANCE_BAND = 0.15;

/** The fields ranking reads. Any listing shape with these can be ranked. */
export interface Rankable {
  readonly title: string;
  /** Null when the provider gave no parsed number. Sorted last. */
  readonly priceValue: number | null;
}

interface Scored<T> {
  readonly listing: T;
  readonly score: number;
  readonly index: number;
}

function byPriceThenOrder<T extends Rankable>(a: Scored<T>, b: Scored<T>): number {
  const priceA = a.listing.priceValue;
  const priceB = b.listing.priceValue;
  if (priceA !== null && priceB !== null && priceA !== priceB) {
    return priceA - priceB;
  }
  if (priceA === null && priceB !== null) {
    return 1;
  }
  if (priceA !== null && priceB === null) {
    return -1;
  }
  return a.index - b.index;
}

/**
 * Relevance first, then price ascending inside the band.
 *
 * Listings that share no key token with the query are dropped, so an empty
 * result here is a real "no listing" answer. Listings outside the band are kept
 * after the band, ordered by relevance and then price, so a caller that wants
 * three (shop the gap) still gets a sensible list.
 */
export function rankListings<T extends Rankable>(
  listings: readonly T[],
  query: string,
): T[] {
  const keyTokens = queryKeyTokens(query);
  const scored: Scored<T>[] = [];
  listings.forEach((listing, index) => {
    const score = relevanceScore(listing.title, keyTokens);
    if (score > 0) {
      scored.push({ listing, score, index });
    }
  });

  if (scored.length === 0) {
    return [];
  }

  let best = 0;
  for (const entry of scored) {
    if (entry.score > best) {
      best = entry.score;
    }
  }
  const floor = best - RELEVANCE_BAND;

  const inBand = scored.filter((entry) => entry.score >= floor);
  const outOfBand = scored.filter((entry) => entry.score < floor);

  inBand.sort(byPriceThenOrder);
  outOfBand.sort((a, b) =>
    a.score === b.score ? byPriceThenOrder(a, b) : b.score - a.score,
  );

  return [...inBand, ...outOfBand].map((entry) => entry.listing);
}
