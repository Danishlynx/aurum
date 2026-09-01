import "server-only";

import { z } from "zod";

import {
  isConcernKey,
  parseProviderConcernName,
  type ConcernKey,
  type FitzpatrickType,
} from "@/lib/shared/concerns";

/**
 * Reading the normalized summaries the jobs layer stored on analyses.summary.
 *
 * src/lib/server/jobs/analysis.ts writes those objects. This file is the only
 * place that reads them back, and it reads them through zod, because a summary
 * written by an older build is an external input like any other
 * (CLAUDE.md: "Validate every external input with zod").
 *
 * Nothing here calls a provider. Everything here is a pure function over jsonb.
 */

/* ------------------------------------------------------------------ */
/* Schemas, one per analysis kind                                      */
/* ------------------------------------------------------------------ */

/**
 * One concern as normalize() stores it: the provider's own name, our internal
 * key (null when the name is not in the UNVERIFIED map in concerns.ts), and the
 * two scores the provider returned.
 */
export const skinConcernSummarySchema = z.object({
  providerType: z.string(),
  key: z.string().nullable(),
  uiScore: z.number(),
  rawScore: z.number(),
});

export const skinSummarySchema = z.object({
  concerns: z.array(skinConcernSummarySchema),
  skinAge: z.number().nullable().optional(),
  overallScore: z.number().nullable().optional(),
  /**
   * Not written by today's normalizer. Read anyway, so that the day the skin
   * type by zone output is mapped in the provider module, this layer picks it up
   * without a change here. Until then the zones are derived, see skin-type.ts.
   */
  skinTypeZones: z
    .object({
      tZone: z.string().nullable().optional(),
      cheeks: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const attributesSummarySchema = z.object({
  skinColor: z.string().nullable().optional(),
  eyeColor: z.string().nullable().optional(),
  eyeColorName: z.string().nullable().optional(),
  lipColor: z.string().nullable().optional(),
  eyebrowColor: z.string().nullable().optional(),
  hairColor: z.string().nullable().optional(),
  hairColorName: z.string().nullable().optional(),
});

export const fitzpatrickSummarySchema = z.object({
  fitzpatrick: z.number().nullable().optional(),
});

export const faceShapeSummarySchema = z.object({
  faceShape: z.string().nullable().optional(),
});

export const hairTypeSummarySchema = z.object({
  mapping: z.unknown().optional(),
  term: z.unknown().optional(),
});

export type SkinSummary = z.infer<typeof skinSummarySchema>;
export type AttributesSummary = z.infer<typeof attributesSummarySchema>;

/* ------------------------------------------------------------------ */
/* Values read out of the summaries                                    */
/* ------------------------------------------------------------------ */

/**
 * The provider concern name that carries the skin type classification rather
 * than a concern (SD_SKIN_CONCERN_KEYS in the Perfect Corp schemas).
 *
 * It is dropped from the concern list on purpose. The UNVERIFIED map in
 * src/lib/shared/concerns.ts currently sends "skin_type" to "uneven_tone", so
 * without this guard the skin type output would appear on the report as a tone
 * concern with a score that means something else entirely. Recorded as an open
 * item: the map is fixed when the live concern names are verified.
 */
export const SKIN_TYPE_PROVIDER_NAME = "skin_type";

/**
 * Concerns whose score reads as a quality rather than as a problem: a high
 * moisture or radiance score is a good result, not a concern to rank.
 *
 * They are kept out of the ranked concern list (ranking is "higher score means
 * more present", which is only true for the rest) and used instead for the skin
 * type zones and for the sentence about what is going well.
 *
 * UNVERIFIED: the direction of the provider's scale is not confirmed for any
 * concern. Recorded as an open item; eval:consistency is where it gets settled.
 */
export const QUALITY_CONCERN_KEYS: readonly ConcernKey[] = ["moisture", "radiance"];

export function isQualityConcern(key: ConcernKey): boolean {
  return QUALITY_CONCERN_KEYS.includes(key);
}

export interface ReadConcern {
  readonly key: ConcernKey;
  /** 1 to 100 as the provider reported it. */
  readonly score: number;
  /**
   * The region the provider named, for example "cheek" from "age_spot_cheek",
   * or null when the name carried none.
   */
  readonly region: string | null;
}

export interface ReadSkin {
  /** Concerns that rank: everything except the quality concerns. */
  readonly concerns: readonly ReadConcern[];
  /** Moisture and radiance, kept aside. */
  readonly qualities: readonly ReadConcern[];
  readonly skinAge: number | null;
  readonly overallScore: number | null;
  readonly zonesFromProvider: {
    readonly tZone: string | null;
    readonly cheeks: string | null;
  } | null;
  /** Provider names we could not map, for the log line and for the eval. */
  readonly unmappedNames: readonly string[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Reads the skin summary. Duplicate keys keep the highest score, which is the
 * same rule rankConcernsToneFirst applies, so the two cannot disagree.
 */
export function readSkinSummary(summary: unknown): ReadSkin | null {
  const parsed = skinSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return null;
  }

  const concerns: ReadConcern[] = [];
  const qualities: ReadConcern[] = [];
  const unmappedNames: string[] = [];

  for (const entry of parsed.data.concerns) {
    const parsedName = parseProviderConcernName(entry.providerType);
    if (parsedName.normalized === SKIN_TYPE_PROVIDER_NAME) {
      continue;
    }

    const key =
      entry.key !== null && isConcernKey(entry.key) ? entry.key : parsedName.key;
    if (key === null) {
      unmappedNames.push(parsedName.normalized);
      continue;
    }

    const read: ReadConcern = {
      key,
      score: clampScore(entry.uiScore),
      region: parsedName.region,
    };
    if (isQualityConcern(key)) {
      qualities.push(read);
    } else {
      concerns.push(read);
    }
  }

  const zones = parsed.data.skinTypeZones ?? null;

  return {
    concerns,
    qualities,
    skinAge:
      typeof parsed.data.skinAge === "number" && Number.isFinite(parsed.data.skinAge)
        ? Math.round(parsed.data.skinAge)
        : null,
    overallScore:
      typeof parsed.data.overallScore === "number" &&
      Number.isFinite(parsed.data.overallScore)
        ? Math.round(parsed.data.overallScore)
        : null,
    zonesFromProvider:
      zones === null
        ? null
        : { tZone: zones.tZone ?? null, cheeks: zones.cheeks ?? null },
    unmappedNames,
  };
}

/**
 * Six hex digits with a leading hash, lowercased, or null.
 *
 * aesthetic_profiles has a check constraint of exactly this shape on every
 * colour column, so a value that does not match here would be a failed insert
 * later. A provider value we cannot read is dropped, never guessed.
 */
export function toHexColor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^#/u, "");
  if (!/^[0-9a-fA-F]{6}$/u.test(trimmed)) {
    return null;
  }
  return `#${trimmed.toLowerCase()}`;
}

export interface ReadAttributes {
  readonly skinToneHex: string | null;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
}

export function readAttributesSummary(summary: unknown): ReadAttributes | null {
  const parsed = attributesSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return null;
  }
  return {
    skinToneHex: toHexColor(parsed.data.skinColor),
    eyeColorHex: toHexColor(parsed.data.eyeColor),
    hairColorHex: toHexColor(parsed.data.hairColor),
  };
}

export function readFitzpatrickSummary(summary: unknown): FitzpatrickType | null {
  const parsed = fitzpatrickSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.data.fitzpatrick;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  if (value < 1 || value > 6) {
    return null;
  }
  return value as FitzpatrickType;
}

export function readFaceShapeSummary(summary: unknown): string | null {
  const parsed = faceShapeSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.data.faceShape;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") {
    return null;
  }
  return trimmed;
}
