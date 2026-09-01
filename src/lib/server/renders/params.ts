import "server-only";

import { createHash } from "node:crypto";

import type { MakeupRenderParams } from "@/lib/shared/color-view";

import type { RenderKind } from "../db/types";

/**
 * What a render is keyed by.
 *
 * docs/03-architecture.md, "Caching": "Render params: (user_id, kind,
 * params_hash) is unique. Re selecting a shade or style returns the stored
 * render." Migration 0003 adds the column and says where the hash comes from:
 * "App computed hash of the canonical JSON of params. Lowercase hex SHA 256 is
 * the expected form", and "Hashing in the app, not in SQL, keeps the canonical
 * form (key order, number formatting) in one tested place".
 *
 * This is that place. Everything here is pure and deterministic.
 *
 * The capture id is part of the parameters even though the screen never sends
 * it. A render is a picture of a person's face with shades on it, so the same
 * shades on a different selfie are a different render, and leaving the capture
 * out would let a new photo serve the old face from cache.
 */

/** The exact parameters a makeup render is stored and hashed under. */
export interface StoredMakeupParams {
  /** The capture the try on was rendered on. */
  readonly captureId: string;
  readonly categories: ReadonlyArray<{
    readonly category: string;
    readonly shadeHex: string;
    readonly shadeName: string;
  }>;
}

/**
 * JSON with the object keys in sorted order, so two objects that differ only in
 * key order hash the same. Arrays keep their order, because order is meaning.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * The canonical form of one makeup render's parameters.
 *
 * Categories are sorted and hexes lower cased so the same look asked for in a
 * different order is the same render. The shade name is kept on the stored row,
 * because the pending line reads "Applying rust lip", but it is not part of the
 * hash: renaming a swatch must not cost a credit.
 */
export function canonicalMakeupParams(args: {
  readonly captureId: string;
  readonly params: MakeupRenderParams;
}): StoredMakeupParams {
  const categories = [...args.params.categories]
    .map((entry) => ({
      category: entry.category,
      shadeHex: entry.shadeHex.trim().toLowerCase(),
      shadeName: entry.shadeName.trim(),
    }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { captureId: args.captureId, categories };
}

/**
 * The stored hash. The version prefix means a change to what a hash covers
 * invalidates old rows instead of silently serving a render made under
 * different rules.
 */
export function paramsHash(kind: RenderKind, params: StoredMakeupParams): string {
  const hashable = {
    captureId: params.captureId,
    categories: params.categories.map((entry) => ({
      category: entry.category,
      shadeHex: entry.shadeHex,
    })),
  };
  return createHash("sha256")
    .update(`v1 ${kind} ${canonicalJson(hashable)}`, "utf8")
    .digest("hex");
}
