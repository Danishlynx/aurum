import "server-only";

import type { ConcernKey } from "@/lib/shared/concerns";
import { derivePalette, type Palette } from "@/lib/shared/palette";

import { getProfile, listAnalyses } from "../db";
import type { Analysis, Insert, Json } from "../db/types";
import type { AppSession } from "../session";
import {
  getAestheticProfile,
  readStoredConcerns,
  upsertAestheticProfile,
  type AestheticProfile,
  type StoredConcern,
} from "./db";
import {
  hasCoreAnalyses,
  readProfileFacts,
  type ProfileFacts,
} from "./facts";
import { readUndertone } from "./report-view";
import { runProfileSynthesis, type SynthesisOutcome } from "./synthesis";
import type { Undertone } from "./undertone";

/**
 * Building the aesthetic profile.
 *
 * docs/03-architecture.md, request flow step 6: "When the core set is complete
 * (skin plus at least one of Fitzpatrick or attributes), the server builds the
 * aesthetic profile: deterministic fields directly from results, palette from
 * the pure mapping, and the synthesis text from one Claude call with structured
 * output. The profile row is written and the client routes to the report."
 *
 * The season and the palette are derived here too, by the pure mapping in
 * src/lib/shared/palette.ts, and written to the row. Screens do not read the
 * stored palette back: docs/03-architecture.md, "Caching", says the palette is
 * "derived by a pure function from profile fields; not cached, it is
 * microseconds", so src/lib/server/profile/color.ts derives it fresh on every
 * read. The columns are written because they are in the data model and because
 * /profile and the stylist layer read the season.
 *
 * Retention is not this file's job. src/lib/server/jobs/index.ts already deletes
 * the original object in finishCapture once every job for the capture is
 * terminal and keep_originals is false (docs/03-architecture.md step 7). This
 * file must not delete anything, or the same object would be removed twice and
 * a failure in one path would be hidden by the other.
 *
 * WHAT IS NOT STORED, and it is deliberate: the routine and the going well
 * sentence. aesthetic_profiles has columns for the reading and for
 * reading_model and for nothing else the synthesis produces, and
 * docs/03-architecture.md has no routine table. Both are therefore rebuilt
 * deterministically whenever the report is built, from the stored concerns and
 * the stored skin type, which also keeps the product queries stable so the
 * product cache can work. Open item for the human: if the model's own routine
 * should reach the report, that needs a column (or a routine table) in
 * docs/03-architecture.md and a migration, which is a decision about what data
 * is stored and so is not ours to make.
 */

export type BuildOutcome =
  | "built"
  | "core_incomplete"
  | "up_to_date"
  | "no_concerns";

export interface BuildResult {
  readonly outcome: BuildOutcome;
  readonly profile: AestheticProfile | null;
  readonly synthesis: SynthesisOutcome | null;
  readonly regeneratedReading: boolean;
}

function toStoredConcerns(facts: ProfileFacts): StoredConcern[] {
  return facts.ranked.map((concern) => ({
    key: concern.key,
    score: concern.score,
    rank: concern.rank,
    mask_path: facts.maskPathByKey.get(concern.key) ?? null,
  }));
}

/**
 * The palette for one set of facts, or null when there is nothing to derive one
 * from. No tone and no undertone means no season: docs/01-user-flow.md section G
 * has the screen ask the person to confirm their undertone instead.
 */
function paletteFor(
  facts: ProfileFacts,
  undertone: Undertone | null,
): Palette | null {
  if (facts.skinToneHex === null || undertone === null) {
    return null;
  }
  return derivePalette({
    skinToneHex: facts.skinToneHex,
    undertone,
    eyeColorHex: facts.eyeColorHex,
    hairColorHex: facts.hairColorHex,
    fitzpatrick: facts.fitzpatrick,
  });
}

function signatureOf(concerns: readonly StoredConcern[]): string {
  return concerns.map((concern) => `${concern.key}:${String(concern.score)}`).join("|");
}

function keysOf(concerns: readonly StoredConcern[]): string {
  return concerns.map((concern) => concern.key).join("|");
}

interface BuildDecision {
  readonly build: boolean;
  readonly regenerateReading: boolean;
}

/**
 * Whether to write, and whether the reading has to be written again.
 *
 * docs/03-architecture.md, "Caching": "Synthesis: stored on the profile;
 * regenerated only when the underlying analyses change or the person adjusts
 * undertone." A new face shape or a newly detected tone changes the row but not
 * the reading. A changed concern order or a changed Fitzpatrick type changes the
 * reading, because the ranking is what the reading leads with.
 */
export function decideBuild(args: {
  readonly existing: AestheticProfile | null;
  readonly facts: ProfileFacts;
}): BuildDecision {
  const facts = args.facts;
  const existing = args.existing;
  const next = toStoredConcerns(facts);

  if (existing === null || existing.capture_id !== facts.captureId) {
    return { build: true, regenerateReading: true };
  }

  const stored = readStoredConcerns(existing);
  const orderChanged = keysOf(stored) !== keysOf(next);
  const scoresChanged = signatureOf(stored) !== signatureOf(next);
  const fitzpatrickChanged = (existing.fitzpatrick ?? null) !== facts.fitzpatrick;
  const toneArrived = existing.skin_tone_hex === null && facts.skinToneHex !== null;
  const faceShapeArrived = existing.face_shape === null && facts.faceShape !== null;
  const readingMissing = existing.reading === null || existing.reading.length === 0;

  const regenerateReading = readingMissing || orderChanged || fitzpatrickChanged;
  const build =
    regenerateReading || scoresChanged || toneArrived || faceShapeArrived;

  return { build, regenerateReading };
}

export interface BuildProfileInput {
  readonly session: AppSession;
  readonly captureId: string;
  /** Passed in when the caller already listed them, to save a query. */
  readonly analyses?: readonly Analysis[];
}

/**
 * Builds the profile when the core set is in and something has changed.
 * Safe to call on every job poll: it reads, decides, and usually does nothing.
 */
export async function maybeBuildProfile(
  input: BuildProfileInput,
): Promise<BuildResult> {
  const ownerId = input.session.id;
  const analyses =
    input.analyses ?? (await listAnalyses(ownerId, input.captureId));

  const facts = readProfileFacts({
    captureId: input.captureId,
    analyses,
  });

  if (!hasCoreAnalyses(facts.succeededKinds)) {
    return {
      outcome: "core_incomplete",
      profile: null,
      synthesis: null,
      regeneratedReading: false,
    };
  }
  if (facts.ranked.length === 0) {
    return {
      outcome: "no_concerns",
      profile: null,
      synthesis: null,
      regeneratedReading: false,
    };
  }

  const existing = await getAestheticProfile(ownerId);
  const decision = decideBuild({ existing, facts });
  if (!decision.build) {
    return {
      outcome: "up_to_date",
      profile: existing,
      synthesis: null,
      regeneratedReading: false,
    };
  }

  let reading: string | null = existing?.reading ?? null;
  let readingModel: string | null = existing?.reading_model ?? null;
  let synthesisOutcome: SynthesisOutcome | null = null;

  if (decision.regenerateReading) {
    const firstName = await readFirstName(input.session);
    const result = await runProfileSynthesis(facts, { firstName });
    synthesisOutcome = result.outcome;
    if (result.narrative !== null) {
      reading = result.narrative.reading;
      readingModel = result.narrative.readingModel;
    }
  }

  // An undertone the person confirmed on /color outranks the one we detected
  // (docs/01-user-flow.md section G item 2). A late arriving analysis must not
  // quietly undo their answer, and the palette below is derived from whichever
  // of the two wins.
  const confirmed =
    existing?.undertone_source === "confirmed_by_user"
      ? readUndertone(existing.undertone)
      : null;
  const undertone: Undertone | null = confirmed ?? facts.undertone;
  const palette = paletteFor(facts, undertone);

  const row: Insert<"aesthetic_profiles"> = {
    user_id: ownerId,
    capture_id: facts.captureId,
    skin_type_zones: {
      t_zone: facts.zones.tZone,
      cheeks: facts.zones.cheeks,
    } as Json,
    concerns: toStoredConcerns(facts) as unknown as Json,
    skin_age: facts.skinAge,
    fitzpatrick: facts.fitzpatrick,
    skin_tone_hex: facts.skinToneHex,
    undertone,
    undertone_source:
      confirmed !== null
        ? "confirmed_by_user"
        : facts.undertone === null
          ? null
          : "detected",
    eye_color_hex: facts.eyeColorHex,
    hair_color_hex: facts.hairColorHex,
    face_shape: facts.faceShape,
    season: palette?.season ?? null,
    palette: palette === null ? null : (palette as unknown as Json),
    version: (existing?.version ?? 0) + 1,
  };
  if (decision.regenerateReading || existing === null) {
    row.reading = reading;
    row.reading_model = readingModel;
  }

  const profile = await upsertAestheticProfile(row);

  console.log(
    JSON.stringify({
      event: "aurum.profile_built",
      ownerType: input.session.ownerType,
      ownerId,
      captureId: facts.captureId,
      version: profile.version,
      concerns: facts.ranked.length,
      unmappedProviderNames: facts.unmappedNames.length,
      toneReadingAvailable: facts.toneReadingAvailable,
      regeneratedReading: decision.regenerateReading,
      synthesis: synthesisOutcome,
    }),
  );

  return {
    outcome: "built",
    profile,
    synthesis: synthesisOutcome,
    regeneratedReading: decision.regenerateReading,
  };
}

/**
 * The person's first name, when they gave one. A judge session has no profiles
 * row and no name, which is why this returns null rather than looking one up.
 *
 * Exported because the undertone adjuster regenerates the same reading and has
 * to pass the same name (src/lib/server/profile/color.ts).
 */
export async function readFirstName(session: AppSession): Promise<string | null> {
  if (session.kind !== "user") {
    return null;
  }
  const profile = await getProfile(session.id);
  const displayName = profile?.display_name ?? null;
  if (displayName === null) {
    return null;
  }
  const first = displayName.trim().split(/\s+/u)[0] ?? "";
  return first.length === 0 ? null : first;
}

/** The concern keys stored on a profile row, in rank order. */
export function storedConcernKeys(profile: AestheticProfile | null): ConcernKey[] {
  return readStoredConcerns(profile).map((concern) => concern.key) as ConcernKey[];
}
