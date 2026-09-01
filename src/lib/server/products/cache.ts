import "server-only";

import type { z } from "zod";

import { serviceClient } from "../db/service";
import type { Insert, Json } from "../db/types";
import {
  isCacheFresh,
  productCacheKey,
  type CacheKeyParts,
} from "./cache-policy";
import { logGrounding } from "./logging";

/**
 * Reads and writes public.product_cache (migration 0004).
 *
 * docs/03-architecture.md, "Caching": the key covers engine, query text,
 * location, and gl or hl; shopping results are cached 24 hours and local results
 * 6 hours. Freshness is decided here, on read, from fetched_at.
 *
 * Nothing in this file throws. There is no state of the world in which a
 * database hiccup should turn into a broken report: a cache that cannot be read
 * is a miss, and a cache that cannot be written is a search we will pay for
 * again. Each failed operation logs one line and the run carries on.
 */

export interface CacheRead<T> {
  readonly results: readonly T[];
  readonly fetchedAt: string;
}

async function selectRow(queryHash: string, engine: string) {
  try {
    const result = await serviceClient()
      .from("product_cache")
      .select("engine, results, fetched_at")
      .eq("query_hash", queryHash)
      .maybeSingle();
    if (result.error !== null) {
      throw new Error(result.error.message);
    }
    return result.data;
  } catch {
    logGrounding({
      reason: "cache_unavailable",
      engine,
      steps: 0,
      searches: 0,
      errorCode: "cache_read_failed",
    });
    return null;
  }
}

/**
 * A fresh entry, parsed with the caller's schema, or null for a miss.
 *
 * The stored array is parsed rather than trusted: it is JSON that an earlier
 * deploy wrote, and the shape it wrote may not be the shape this deploy reads.
 * A row that no longer parses is treated as a miss, so the next search rewrites
 * it in the current shape.
 */
export async function readProductCache<T>(args: {
  readonly parts: CacheKeyParts;
  readonly schema: z.ZodType<T[]>;
  readonly nowMs: number;
}): Promise<CacheRead<T> | null> {
  const row = await selectRow(
    productCacheKey(args.parts),
    args.parts.engine,
  );
  if (row === null) {
    return null;
  }

  if (
    !isCacheFresh({
      engine: row.engine,
      fetchedAt: row.fetched_at,
      nowMs: args.nowMs,
    })
  ) {
    return null;
  }

  const parsed = args.schema.safeParse(row.results);
  if (!parsed.success) {
    return null;
  }
  return { results: parsed.data, fetchedAt: row.fetched_at };
}

/**
 * Stores the normalized results for a query. Never the raw provider body: the
 * column comment on product_cache.results names the normalized listing shape,
 * and a raw body would carry fields we have no reason to keep.
 */
export async function writeProductCache(args: {
  readonly parts: CacheKeyParts;
  readonly results: readonly unknown[];
  readonly fetchedAt: string;
}): Promise<void> {
  const row: Insert<"product_cache"> = {
    query_hash: productCacheKey(args.parts),
    engine: args.parts.engine,
    query: {
      engine: args.parts.engine,
      query: args.parts.query,
      location: args.parts.location,
      gl: args.parts.gl,
      hl: args.parts.hl,
    },
    results: args.results as unknown as Json,
    fetched_at: args.fetchedAt,
  };

  try {
    const result = await serviceClient()
      .from("product_cache")
      .upsert(row, { onConflict: "query_hash" })
      .select("query_hash")
      .maybeSingle();
    if (result.error !== null) {
      throw new Error(result.error.message);
    }
  } catch {
    logGrounding({
      reason: "cache_unavailable",
      engine: args.parts.engine,
      steps: 0,
      searches: 0,
      errorCode: "cache_write_failed",
    });
  }
}
