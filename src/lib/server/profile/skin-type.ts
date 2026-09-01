import "server-only";

import type { ConcernKey } from "@/lib/shared/concerns";

import type { ReadConcern } from "./summaries";

/**
 * Skin type by zone.
 *
 * PROVISIONAL, and deliberately so. Perfect Corp's skin analysis lists a skin
 * type output, but its name, its scale, and whether it is reported per zone are
 * not verified yet (docs/04-integrations.md, "Verify first"), and the provider
 * module does not map it. Until it does, the two zones the report shows are
 * derived from two scores that are mapped: oiliness and moisture.
 *
 * The rule below is ours, not the provider's, and it is written down rather than
 * hidden in a conditional so it can be argued with:
 *
 *   oily through the T zone and dry on the cheeks   -> combination
 *   oily and not dry                                -> oily
 *   neither oily nor holding water                  -> dry
 *   anything else                                   -> balanced
 *
 * Oil is read as a T zone signal and water as a cheek signal because that is
 * where each shows first on a face. When only one of the two scores exists, the
 * type is read from that one. When neither exists, the type is null and the
 * report says nothing about it rather than guessing.
 *
 * Replace this file the moment the provider's own skin type by zone output is
 * mapped, and delete the derivation rather than keeping both.
 */

/** The vocabulary, not copy: these are catalog values, like season names. */
export const SKIN_TYPE_LABELS = ["combination", "oily", "dry", "balanced"] as const;
export type SkinTypeLabel = (typeof SKIN_TYPE_LABELS)[number];

export const ZONE_LABELS = ["oily", "balanced", "dry"] as const;
export type ZoneLabel = (typeof ZONE_LABELS)[number];

/** At or above this, the oiliness score reads as an oily T zone. */
export const OILY_AT_OR_ABOVE = 55;
/** Below this, the oiliness score reads as a dry T zone. */
export const DRY_BELOW = 30;
/** Below this, the moisture score reads as dry cheeks. */
export const LOW_MOISTURE_BELOW = 45;

export interface SkinTypeReading {
  readonly label: SkinTypeLabel;
  readonly tZone: ZoneLabel;
  readonly cheeks: ZoneLabel;
}

function scoreOf(
  qualities: readonly ReadConcern[],
  concerns: readonly ReadConcern[],
  key: ConcernKey,
): number | null {
  const found =
    qualities.find((entry) => entry.key === key) ??
    concerns.find((entry) => entry.key === key);
  return found === undefined ? null : found.score;
}

/**
 * The skin type reading, or null when neither oiliness nor moisture came back.
 */
export function deriveSkinType(args: {
  readonly concerns: readonly ReadConcern[];
  readonly qualities: readonly ReadConcern[];
}): SkinTypeReading | null {
  const oiliness = scoreOf(args.qualities, args.concerns, "oiliness");
  const moisture = scoreOf(args.qualities, args.concerns, "moisture");

  if (oiliness === null && moisture === null) {
    return null;
  }

  if (oiliness === null) {
    const dry = (moisture ?? 0) < LOW_MOISTURE_BELOW;
    return dry
      ? { label: "dry", tZone: "dry", cheeks: "dry" }
      : { label: "balanced", tZone: "balanced", cheeks: "balanced" };
  }

  if (moisture === null) {
    return oiliness >= OILY_AT_OR_ABOVE
      ? { label: "oily", tZone: "oily", cheeks: "oily" }
      : { label: "balanced", tZone: "balanced", cheeks: "balanced" };
  }

  const oily = oiliness >= OILY_AT_OR_ABOVE;
  const dryCheeks = moisture < LOW_MOISTURE_BELOW;

  if (oily && dryCheeks) {
    return { label: "combination", tZone: "oily", cheeks: "dry" };
  }
  if (oily) {
    return { label: "oily", tZone: "oily", cheeks: "oily" };
  }
  if (oiliness < DRY_BELOW && dryCheeks) {
    return { label: "dry", tZone: "dry", cheeks: "dry" };
  }
  return { label: "balanced", tZone: "balanced", cheeks: "balanced" };
}

/**
 * The zones the report shows: the provider's own if they ever arrive, otherwise
 * the derived pair, otherwise nulls.
 */
export function resolveSkinTypeZones(args: {
  readonly fromProvider: {
    readonly tZone: string | null;
    readonly cheeks: string | null;
  } | null;
  readonly derived: SkinTypeReading | null;
}): { readonly tZone: string | null; readonly cheeks: string | null } {
  const provider = args.fromProvider;
  if (provider !== null && (provider.tZone !== null || provider.cheeks !== null)) {
    return { tZone: provider.tZone, cheeks: provider.cheeks };
  }
  if (args.derived === null) {
    return { tZone: null, cheeks: null };
  }
  return { tZone: args.derived.tZone, cheeks: args.derived.cheeks };
}

function asZoneLabel(value: string | null): ZoneLabel | null {
  if (value === null) {
    return null;
  }
  const found = ZONE_LABELS.find((label) => label === value.toLowerCase().trim());
  return found ?? null;
}

/**
 * The reverse of the derivation, for the report.
 *
 * aesthetic_profiles stores the two zones and nothing else about skin type, so
 * the report reads the type back out of them rather than out of the analyses.
 * That is what keeps the routine and the going well line identical on every
 * visit, including after the analyses rows have been purged.
 */
export function skinTypeFromZones(
  tZone: string | null,
  cheeks: string | null,
): SkinTypeReading | null {
  const t = asZoneLabel(tZone);
  const c = asZoneLabel(cheeks);
  if (t === null && c === null) {
    return null;
  }
  const resolvedT = t ?? c ?? "balanced";
  const resolvedC = c ?? t ?? "balanced";

  if (resolvedT === "oily" && resolvedC === "dry") {
    return { label: "combination", tZone: resolvedT, cheeks: resolvedC };
  }
  if (resolvedT === "oily") {
    return { label: "oily", tZone: resolvedT, cheeks: resolvedC };
  }
  if (resolvedT === "dry" && resolvedC === "dry") {
    return { label: "dry", tZone: resolvedT, cheeks: resolvedC };
  }
  return { label: "balanced", tZone: resolvedT, cheeks: resolvedC };
}

/**
 * The word the reading uses for the skin type, for example "combination".
 * Null when the type is unknown, so the sentence is dropped rather than fudged.
 */
export function skinTypeWord(reading: SkinTypeReading | null): string | null {
  return reading === null ? null : reading.label;
}
