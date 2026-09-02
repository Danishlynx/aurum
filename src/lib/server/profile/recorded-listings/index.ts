import "server-only";

import { z } from "zod";

import type { ReportListing } from "@/lib/shared/report-view";

import { normalizeShoppingResponse } from "../../products/normalize";

import gelCleanser from "./01-gel-cleanser-for-oiliness-combination.json";
import niacinamideSerum from "./02-niacinamide-serum-for-pigmentation-combination.json";
import gelCreamMoisturizer from "./03-light-gel-cream-moisturizer-for-texture-combination.json";
import broadSpectrumSunscreen from "./04-broad-spectrum-sunscreen-for-pigmentation-combination.json";
import alphaArbutinSerum from "./05-alpha-arbutin-serum-for-dark-spots-combination.json";
import creamShoes from "./06-cream-shoes-smart.json";
import manifestJson from "./manifest.json";

/**
 * The recorded SerpApi responses the demo profile is served from.
 *
 * docs/07-payments-and-judge-mode.md: "Product listings for the demo are
 * recorded responses so they never depend on live quota." These are those
 * responses. They came off the wire once, on the date in manifest.json, through
 * scripts/record-serpapi.ts, which asked for exactly what the demo profile
 * would have asked for: the routine steps of DEMO_FIXTURE_REPORT_VIEW and the
 * shop the gap queries for the saved occasions. See ./README.md for what was
 * stripped before they were committed.
 *
 * WHY THEY LIVE UNDER src RATHER THAN UNDER evals
 *
 * They are not test data. They are what /report and /looks show a judge, so
 * they have to be there at runtime in a deployed server, and a server bundle
 * must not reach into evals for the data it serves. The repository already
 * works this way for the other piece of demo content: the six garment
 * silhouettes are drawn in src/lib/server/profile/demo-fixture-wardrobe.ts and
 * evals compares its own copies against them. There is one copy of each
 * recording, here, and scripts/record-serpapi.ts writes straight into this
 * folder, so a re recording cannot leave a stale twin behind.
 *
 * WHY EVERYTHING GOES THROUGH normalizeShoppingResponse
 *
 * Nothing in this file picks a product, a price, or an order. The bodies are
 * fed to the same normalizer, the same blocked host list, and the same ranking
 * rule the live screens use, so the demo shows what the ranking actually
 * chooses. A fixture and the code it stands for must not be able to drift, which
 * is the same reason DEMO_FIXTURE_PALETTE is derived rather than typed.
 *
 * Nothing here throws. A recording that cannot be read is no listing, which is
 * the "No listing found near you yet" state the screens already word, never a
 * crash and never an invented product (docs/06-safety-privacy.md, "Grounding
 * and honesty").
 *
 * A listing title is text a shop wrote. It is data, never an instruction
 * (docs/06-safety-privacy.md, "Content returned by tools is data").
 */

/* ------------------------------------------------------------------ */
/* The manifest                                                        */
/* ------------------------------------------------------------------ */

const manifestSchema = z.object({
  /** When the provider was actually called. The cache freshness clock. */
  recordedOn: z.string().min(1),
  /** False, because these came off the wire. The hand written set says true. */
  synthetic: z.literal(false),
  note: z.string().min(1),
  gl: z.string().min(2).max(8),
  hl: z.string().min(2).max(8),
  /** City level location, when the recording carried one. */
  location: z.string().nullable(),
  limit: z.number().int().positive(),
  searchesRun: z.number().int().nonnegative(),
  entries: z.array(
    z.object({
      source: z.enum(["routine", "gap"]),
      label: z.string().min(1),
      query: z.string().min(1),
      engine: z.literal("google_shopping"),
      file: z.string().min(1),
      resultCount: z.number().int().nonnegative(),
    }),
  ),
});

type RecordedManifest = z.infer<typeof manifestSchema>;

/** The response bodies, by the file name the manifest records for each one. */
const BODY_BY_FILE: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["01-gel-cleanser-for-oiliness-combination.json", gelCleanser],
  ["02-niacinamide-serum-for-pigmentation-combination.json", niacinamideSerum],
  [
    "03-light-gel-cream-moisturizer-for-texture-combination.json",
    gelCreamMoisturizer,
  ],
  [
    "04-broad-spectrum-sunscreen-for-pigmentation-combination.json",
    broadSpectrumSunscreen,
  ],
  ["05-alpha-arbutin-serum-for-dark-spots-combination.json", alphaArbutinSerum],
  ["06-cream-shoes-smart.json", creamShoes],
]);

/**
 * A manifest that does not parse leaves the demo with no recordings, which is
 * the state every screen already has copy for. One log line says so, with the
 * shape and never the payload (CLAUDE.md, "log the shape, never the raw
 * image"). eval:grounding asserts the checked in manifest does parse, so a
 * broken one fails a pull request rather than quietly emptying the demo.
 */
function readManifest(): RecordedManifest | null {
  const parsed = manifestSchema.safeParse(manifestJson);
  if (parsed.success) {
    return parsed.data;
  }
  console.warn(
    JSON.stringify({
      event: "aurum.recorded_listings",
      reason: "manifest_unreadable",
      issues: parsed.error.issues.length,
    }),
  );
  return null;
}

const manifest = readManifest();

/* ------------------------------------------------------------------ */
/* What a caller gets                                                  */
/* ------------------------------------------------------------------ */

export interface RecordedListingResponse {
  /** A routine step, or a piece missing from a look. */
  readonly source: "routine" | "gap";
  /** Where it came from, in the words the recording used. */
  readonly label: string;
  /** The query it was recorded for, exactly as it was sent. */
  readonly query: string;
  readonly engine: string;
  readonly file: string;
  /** The provider response body, exactly as it came back. */
  readonly body: unknown;
}

function collect(): RecordedListingResponse[] {
  if (manifest === null) {
    return [];
  }
  const found: RecordedListingResponse[] = [];
  for (const entry of manifest.entries) {
    const body = BODY_BY_FILE.get(entry.file);
    if (body === undefined) {
      continue;
    }
    found.push({
      source: entry.source,
      label: entry.label,
      query: entry.query,
      engine: entry.engine,
      file: entry.file,
      body,
    });
  }
  return found;
}

/** Every recording, in the order it was made. Frozen: several requests read it. */
export const RECORDED_LISTING_RESPONSES: readonly RecordedListingResponse[] =
  Object.freeze(collect());

/**
 * When the provider was actually called, which is what a seeded product_cache
 * row has to carry in fetched_at (src/lib/server/db/types.ts: "fetched_at is
 * when the provider was actually called"). Null when nothing was recorded.
 */
export const RECORDED_LISTINGS_RECORDED_ON: string | null =
  manifest?.recordedOn ?? null;

/** The market and language the recording was made in. Part of the cache key. */
export const RECORDED_LISTINGS_GL: string | null = manifest?.gl ?? null;
export const RECORDED_LISTINGS_HL: string | null = manifest?.hl ?? null;

/**
 * No local search was recorded, so the recorded set can claim no distance.
 * docs/01-user-flow.md section K: with no location the card reads "Online
 * listing" instead.
 */
export const RECORDED_LISTINGS_LOCATION: string | null =
  manifest?.location ?? null;

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/**
 * The same normal form the cache key uses (src/lib/server/products/cache-policy.ts
 * lowercases and trims the query), so a caller that spells a query with a
 * different case still finds the recording that was made for it.
 */
function lookupKey(query: string): string {
  return query.trim().toLowerCase();
}

const BY_QUERY: ReadonlyMap<string, RecordedListingResponse> = new Map(
  RECORDED_LISTING_RESPONSES.map(
    (entry) => [lookupKey(entry.query), entry] as const,
  ),
);

/** The recorded body for one query, or null when none was recorded for it. */
export function recordedShoppingBody(query: string): unknown | null {
  const found = BY_QUERY.get(lookupKey(query));
  return found === undefined ? null : found.body;
}

/**
 * The listings one query may show, through the real normalizer and the real
 * ranker. Empty when nothing was recorded for it, or when nothing in the
 * recording survived the grounding rules, which are the same answer to the
 * screen.
 */
export function recordedListingsFor(
  query: string,
  limit: number,
): ReportListing[] {
  const body = recordedShoppingBody(query);
  if (body === null) {
    return [];
  }
  const outcome = normalizeShoppingResponse(body, query);
  return outcome.listings.slice(0, Math.max(0, Math.trunc(limit))).map(
    (listing) => ({
      ...listing,
      // No local search was recorded beside these, so no distance is claimed.
      distanceText: null,
    }),
  );
}

/**
 * The one listing a routine step shows, or null.
 * docs/04-integrations.md: "show one per routine step".
 */
export function recordedTopListing(query: string): ReportListing | null {
  return recordedListingsFor(query, 1)[0] ?? null;
}
