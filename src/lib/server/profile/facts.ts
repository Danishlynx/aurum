import "server-only";

import {
  isConcernKey,
  rankConcernsToneFirst,
  type ConcernKey,
  type ConcernScore,
  type FitzpatrickType,
  type RankedConcern,
} from "@/lib/shared/concerns";

import type { Analysis } from "../db/types";
import { locationFor } from "./locations";
import {
  deriveSkinType,
  resolveSkinTypeZones,
  skinTypeFromZones,
  type SkinTypeReading,
} from "./skin-type";
import {
  readAttributesSummary,
  readFaceShapeSummary,
  readFitzpatrickSummary,
  readSkinSummary,
  type ReadConcern,
} from "./summaries";
import { detectUndertone, type Undertone } from "./undertone";

/**
 * Everything the profile is built from, read once out of the succeeded analyses.
 *
 * docs/03-architecture.md, request flow step 6: "the server builds the aesthetic
 * profile: deterministic fields directly from results, palette from the pure
 * mapping, and the synthesis text from one Claude call". This file is the
 * deterministic half. It runs whether or not a model is reachable, and the
 * fallback reading is built from exactly these facts.
 *
 * A failed or missing analysis is not an error here. It removes a field and the
 * report says so (docs/01-user-flow.md section F, partial state).
 */

export interface ProfileFacts {
  readonly captureId: string;
  /** Ranked tone first. Empty when the skin analysis did not succeed. */
  readonly ranked: readonly RankedConcern[];
  /** Provider named region per concern key, "cheek" and so on, or null. */
  readonly regionByKey: ReadonlyMap<ConcernKey, string | null>;
  /** Moisture and radiance: scores that read as qualities, not as concerns. */
  readonly qualities: readonly ReadConcern[];
  readonly skinType: SkinTypeReading | null;
  readonly zones: { readonly tZone: string | null; readonly cheeks: string | null };
  readonly skinAge: number | null;
  readonly overallScore: number | null;
  readonly fitzpatrick: FitzpatrickType | null;
  readonly skinToneHex: string | null;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
  readonly undertone: Undertone | null;
  readonly faceShape: string | null;
  /**
   * False when the attributes analysis gave no tone, which is the partial state
   * in docs/01-user-flow.md section F: "Tone reading is unavailable for this
   * photo. Color identity will ask you to confirm your undertone."
   */
  readonly toneReadingAvailable: boolean;
  /** Mask storage paths by concern key, from the skin analysis. */
  readonly maskPathByKey: ReadonlyMap<ConcernKey, string>;
  /** Provider concern names we could not map. Logged, never shown. */
  readonly unmappedNames: readonly string[];
  /** The analysis kinds that succeeded, for the rebuild decision. */
  readonly succeededKinds: ReadonlySet<string>;
}

/** The core set from docs/03-architecture.md step 6. */
export function hasCoreAnalyses(succeeded: ReadonlySet<string>): boolean {
  return (
    succeeded.has("skin") &&
    (succeeded.has("fitzpatrick") || succeeded.has("attributes"))
  );
}

/**
 * masks/<owner_id>/<capture_id>/<concern_key>.<ext> is the path shape
 * src/lib/server/db/storage.ts writes, so the concern key is the file name.
 */
export function concernKeyFromMaskPath(path: string): string | null {
  const file = path.split("/").pop();
  if (file === undefined) {
    return null;
  }
  const dot = file.lastIndexOf(".");
  const stem = dot === -1 ? file : file.slice(0, dot);
  return stem.length === 0 ? null : stem;
}

function readMaskPaths(
  analysis: Analysis,
  keys: ReadonlySet<string>,
): Map<ConcernKey, string> {
  const found = new Map<ConcernKey, string>();
  const raw = analysis.mask_paths;
  if (!Array.isArray(raw)) {
    return found;
  }
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const key = concernKeyFromMaskPath(entry);
    if (key !== null && keys.has(key)) {
      found.set(key as ConcernKey, entry);
    }
  }
  return found;
}

/** Reads the facts out of the analyses for one capture. */
export function readProfileFacts(args: {
  readonly captureId: string;
  readonly analyses: readonly Analysis[];
}): ProfileFacts {
  const succeeded = new Set<string>();
  const byKind = new Map<string, Analysis>();
  for (const analysis of args.analyses) {
    if (analysis.capture_id !== args.captureId) {
      continue;
    }
    byKind.set(analysis.kind, analysis);
    if (analysis.status === "succeeded") {
      succeeded.add(analysis.kind);
    }
  }

  const skinAnalysis = succeeded.has("skin") ? byKind.get("skin") : undefined;
  const skin =
    skinAnalysis === undefined ? null : readSkinSummary(skinAnalysis.summary);

  const attributesAnalysis = succeeded.has("attributes")
    ? byKind.get("attributes")
    : undefined;
  const attributes =
    attributesAnalysis === undefined
      ? null
      : readAttributesSummary(attributesAnalysis.summary);

  const fitzpatrickAnalysis = succeeded.has("fitzpatrick")
    ? byKind.get("fitzpatrick")
    : undefined;
  const fitzpatrick =
    fitzpatrickAnalysis === undefined
      ? null
      : readFitzpatrickSummary(fitzpatrickAnalysis.summary);

  const faceShapeAnalysis = succeeded.has("face_shape")
    ? byKind.get("face_shape")
    : undefined;
  const faceShape =
    faceShapeAnalysis === undefined
      ? null
      : readFaceShapeSummary(faceShapeAnalysis.summary);

  const scores: ConcernScore[] = (skin?.concerns ?? []).map((concern) => ({
    key: concern.key,
    score: concern.score,
  }));
  const ranked = rankConcernsToneFirst(scores, fitzpatrick);

  const regionByKey = new Map<ConcernKey, string | null>();
  for (const concern of skin?.concerns ?? []) {
    // First region wins, which keeps the map stable when the provider reports
    // the same concern for two regions.
    if (!regionByKey.has(concern.key)) {
      regionByKey.set(concern.key, concern.region);
    }
  }

  const skinType =
    skin === null
      ? null
      : deriveSkinType({ concerns: skin.concerns, qualities: skin.qualities });

  const maskPathByKey =
    skinAnalysis === undefined
      ? new Map<ConcernKey, string>()
      : readMaskPaths(
          skinAnalysis,
          new Set(ranked.map((concern) => concern.key as string)),
        );

  const skinToneHex = attributes?.skinToneHex ?? null;

  return {
    captureId: args.captureId,
    ranked,
    regionByKey,
    qualities: skin?.qualities ?? [],
    skinType,
    zones: resolveSkinTypeZones({
      fromProvider: skin?.zonesFromProvider ?? null,
      derived: skinType,
    }),
    skinAge: skin?.skinAge ?? null,
    overallScore: skin?.overallScore ?? null,
    fitzpatrick,
    skinToneHex,
    eyeColorHex: attributes?.eyeColorHex ?? null,
    hairColorHex: attributes?.hairColorHex ?? null,
    undertone: detectUndertone(skinToneHex),
    faceShape,
    toneReadingAvailable: skinToneHex !== null,
    maskPathByKey,
    unmappedNames: skin?.unmappedNames ?? [],
    succeededKinds: succeeded,
  };
}

/**
 * The same facts, read back out of a stored aesthetic_profiles row instead of
 * out of the analyses.
 *
 * The report uses this one. It means the routine and the going well line depend
 * only on the row, so they are identical on every visit, they survive the
 * analyses being purged, and they cost one query instead of two.
 *
 * Two things are missing compared to the analyses: the provider's regions (so
 * locations fall back to where a concern usually sits) and moisture and radiance
 * (which the row does not store). Neither changes a stored reading, because a
 * stored reading is not rebuilt.
 */
export function factsFromStoredProfile(args: {
  readonly captureId: string;
  readonly concerns: readonly {
    readonly key: string;
    readonly score: number;
    readonly rank: number;
    readonly mask_path: string | null;
  }[];
  readonly zones: { readonly tZone: string | null; readonly cheeks: string | null };
  readonly skinAge: number | null;
  readonly fitzpatrick: FitzpatrickType | null;
  readonly skinToneHex: string | null;
  readonly eyeColorHex: string | null;
  readonly hairColorHex: string | null;
  readonly undertone: Undertone | null;
  readonly faceShape: string | null;
}): ProfileFacts {
  const ranked: RankedConcern[] = [];
  const maskPathByKey = new Map<ConcernKey, string>();

  for (const concern of args.concerns) {
    if (!isConcernKey(concern.key)) {
      continue;
    }
    ranked.push({
      key: concern.key,
      score: concern.score,
      rank: ranked.length + 1,
      promotedByToneFirst: false,
    });
    if (concern.mask_path !== null) {
      maskPathByKey.set(concern.key, concern.mask_path);
    }
  }

  return {
    captureId: args.captureId,
    ranked,
    regionByKey: new Map<ConcernKey, string | null>(),
    qualities: [],
    skinType: skinTypeFromZones(args.zones.tZone, args.zones.cheeks),
    zones: args.zones,
    skinAge: args.skinAge,
    overallScore: null,
    fitzpatrick: args.fitzpatrick,
    skinToneHex: args.skinToneHex,
    eyeColorHex: args.eyeColorHex,
    hairColorHex: args.hairColorHex,
    undertone: args.undertone,
    faceShape: args.faceShape,
    toneReadingAvailable: args.skinToneHex !== null,
    maskPathByKey,
    unmappedNames: [],
    succeededKinds: new Set<string>(),
  };
}

/** Where a ranked concern sits on the face, in plain words. */
export function locationOf(facts: ProfileFacts, key: ConcernKey): string {
  return locationFor(key, facts.regionByKey.get(key) ?? null);
}

/** The top ranked concern key, or null when the skin analysis did not land. */
export function topConcernKey(facts: ProfileFacts): ConcernKey | null {
  return facts.ranked[0]?.key ?? null;
}
