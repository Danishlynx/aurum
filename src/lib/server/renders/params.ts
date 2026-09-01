import "server-only";

import { createHash } from "node:crypto";

import type { MakeupRenderParams } from "@/lib/shared/color-view";
import type {
  HairColorRenderParams,
  HairstyleRenderParams,
} from "@/lib/shared/hair-view";

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

/** One hairstyle try on: a catalog style id on one capture. */
export interface StoredHairstyleParams {
  readonly captureId: string;
  readonly styleId: string;
}

/**
 * One hair colour try on. The style travels with the colour because
 * docs/01-user-flow.md section I item 3 renders the colour "on the selected
 * style": the same colour on a different style is a different picture.
 */
export interface StoredHairColorParams {
  readonly captureId: string;
  readonly styleId: string;
  readonly colorHex: string;
  /** For the pending line. Not hashed, the same as a makeup shade name. */
  readonly colorName: string;
}

/**
 * One cloth try on: one garment the person owns, on one capture.
 *
 * The garment category travels with the id and is part of the hash because it
 * is part of the request: docs/04-integrations.md records that cloth try on
 * "takes one garment_category per call", so the same garment sent as an upper
 * body piece and as a full body piece are two different pictures. Correcting a
 * garment's type chip can move it between categories, and a new picture is what
 * the person should get when that happens.
 */
export interface StoredClothParams {
  readonly captureId: string;
  readonly garmentId: string;
  readonly garmentCategory: string;
}

/**
 * One skin simulation: the concerns projected, on one capture.
 *
 * The concerns are sorted and de duplicated in the canonical form, so the same
 * projection asked for in a different order is the same picture and the second
 * ask is answered from the cache rather than from four more units
 * (docs/04-integrations.md, credit table).
 */
export interface StoredSkinSimulationParams {
  readonly captureId: string;
  readonly concerns: readonly string[];
}

/**
 * One accessory try on: one accessory the person owns, worn on one capture, in
 * one category.
 *
 * The category is part of the hash because it is part of the request and part of
 * the picture: the same photo sent as a bag and as a pair of earrings goes to
 * two different endpoints and comes back as two different images.
 */
export interface StoredAccessoryParams {
  readonly captureId: string;
  readonly garmentId: string;
  readonly category: string;
}

export type StoredRenderParams =
  | StoredMakeupParams
  | StoredHairstyleParams
  | StoredHairColorParams
  | StoredClothParams
  | StoredSkinSimulationParams
  | StoredAccessoryParams;

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
 * The canonical form of one hairstyle render's parameters.
 *
 * There is nothing to sort: a hairstyle render is one style on one capture. The
 * id is trimmed and lower cased so the same style asked for in a different case
 * is the same render rather than a second credit.
 */
export function canonicalHairstyleParams(args: {
  readonly captureId: string;
  readonly params: HairstyleRenderParams;
}): StoredHairstyleParams {
  return {
    captureId: args.captureId,
    styleId: args.params.styleId.trim().toLowerCase(),
  };
}

/**
 * The canonical form of one hair colour render's parameters. Same rules as the
 * makeup shades: the hex is lower cased, and the name is stored but not hashed.
 */
export function canonicalHairColorParams(args: {
  readonly captureId: string;
  readonly params: HairColorRenderParams;
}): StoredHairColorParams {
  return {
    captureId: args.captureId,
    styleId: args.params.styleId.trim().toLowerCase(),
    colorHex: args.params.colorHex.trim().toLowerCase(),
    colorName: args.params.colorName.trim(),
  };
}

/**
 * The canonical form of one cloth render's parameters.
 *
 * Nothing is sorted and nothing is dropped: a cloth render is one garment on
 * one capture in one category. The ids are trimmed and the category is lower
 * cased so the same request written in a different case is the same render
 * rather than a second credit.
 */
export function canonicalClothParams(args: {
  readonly captureId: string;
  readonly garmentId: string;
  readonly garmentCategory: string;
}): StoredClothParams {
  return {
    captureId: args.captureId,
    garmentId: args.garmentId.trim(),
    garmentCategory: args.garmentCategory.trim().toLowerCase(),
  };
}

/**
 * The canonical form of one skin simulation's parameters.
 *
 * The concerns are lower cased, de duplicated, and sorted: which order the
 * report happened to rank them in does not change the picture, and asking for
 * the same set twice must not cost a second four units.
 */
export function canonicalSimulationParams(args: {
  readonly captureId: string;
  readonly concerns: readonly string[];
}): StoredSkinSimulationParams {
  const concerns = [
    ...new Set(args.concerns.map((concern) => concern.trim().toLowerCase())),
  ].sort();
  return { captureId: args.captureId, concerns };
}

/**
 * The canonical form of one accessory try on's parameters. The same rules as the
 * cloth params: ids trimmed, the category lower cased, nothing dropped.
 */
export function canonicalAccessoryParams(args: {
  readonly captureId: string;
  readonly garmentId: string;
  readonly category: string;
}): StoredAccessoryParams {
  return {
    captureId: args.captureId,
    garmentId: args.garmentId.trim(),
    category: args.category.trim().toLowerCase(),
  };
}

/**
 * What a hash covers, per kind of parameters.
 *
 * The branch is on the shape of the parameters rather than on the kind, so a
 * caller that hashes one shape under another kind (which is what a change of
 * kind is meant to do: produce a different hash for the same picture) still gets
 * a stable digest instead of an exception.
 *
 * The names, which the pending line reads, are left out of every branch:
 * renaming a swatch or a style must not cost a credit.
 */
function hashableOf(params: StoredRenderParams): Record<string, unknown> {
  if ("categories" in params) {
    return {
      captureId: params.captureId,
      categories: params.categories.map((entry) => ({
        category: entry.category,
        shadeHex: entry.shadeHex,
      })),
    };
  }
  if ("concerns" in params) {
    return { captureId: params.captureId, concerns: [...params.concerns] };
  }
  if ("category" in params) {
    // The accessory shape. It is checked before the cloth shape below because
    // both carry a garment id, and only this one carries a category.
    return {
      captureId: params.captureId,
      garmentId: params.garmentId,
      category: params.category,
    };
  }
  if ("colorHex" in params) {
    return {
      captureId: params.captureId,
      styleId: params.styleId,
      colorHex: params.colorHex,
    };
  }
  if ("garmentId" in params) {
    return {
      captureId: params.captureId,
      garmentId: params.garmentId,
      garmentCategory: params.garmentCategory,
    };
  }
  return { captureId: params.captureId, styleId: params.styleId };
}

/**
 * The stored hash. The version prefix means a change to what a hash covers
 * invalidates old rows instead of silently serving a render made under
 * different rules.
 */
export function paramsHash(kind: RenderKind, params: StoredRenderParams): string {
  return createHash("sha256")
    .update(`v1 ${kind} ${canonicalJson(hashableOf(params))}`, "utf8")
    .digest("hex");
}
