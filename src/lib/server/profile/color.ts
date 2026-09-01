import "server-only";

import type { ColorView, UndertoneSource } from "@/lib/shared/color-view";
import {
  derivePalette,
  type Palette,
  type Season,
  type Undertone,
} from "@/lib/shared/palette";

import type { Insert, Json } from "../db/types";
import type { AppSession } from "../session";
import { readFirstName } from "./build";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "./db";
import { DEMO_FIXTURE_COLOR_VIEW } from "./demo-fixture";
import {
  isDemoFixtureMode,
  readUndertone,
  toFacts,
  DEMO_FIXTURE_ENV,
} from "./report-view";
import { runProfileSynthesis } from "./synthesis";

/**
 * Colour identity: the palette the rest of the app reads from.
 *
 * docs/01-user-flow.md section G is the screen this fills: the detected tone,
 * the undertone with its adjuster, the season line, the wear and avoid grids.
 *
 * Where the palette comes from, and why it is derived rather than read back:
 * docs/03-architecture.md, "Caching", says "Palette: derived by a pure function
 * from profile fields; not cached, it is microseconds". So every read derives it
 * from the stored tone, undertone, eye colour, hair colour, and Fitzpatrick type
 * through src/lib/shared/palette.ts. The season and palette columns are still
 * written (they are in the data model, and /profile and the stylist layer read
 * the season), but no screen depends on a stored palette staying in step with
 * the function that produced it.
 *
 * The undertone the person confirms outranks the one we detected. That is the
 * whole point of the adjuster: "Lighting can fool a camera. You know your skin.
 * Pick what is true." It is recorded in undertone_source so the two are never
 * confused, and a later rebuild of the profile never overwrites a confirmed
 * value with a detected one (see build.ts).
 */

const UNDERTONE_SOURCES: readonly UndertoneSource[] = [
  "detected",
  "confirmed_by_user",
];

export function parseUndertoneSource(
  value: string | null,
): UndertoneSource | null {
  if (value === null) {
    return null;
  }
  return UNDERTONE_SOURCES.find((entry) => entry === value) ?? null;
}

/** The fields a palette is derived from, as they sit on the profile row. */
export type PaletteSourceFields = Pick<
  AestheticProfile,
  "skin_tone_hex" | "undertone" | "eye_color_hex" | "hair_color_hex" | "fitzpatrick"
>;

/**
 * The palette for a stored profile row, or null when there is nothing to derive
 * one from. A photo whose tone could not be read has no palette, which is the
 * "Confirm your undertone" state in docs/01 section G, not a default season.
 */
export function paletteForProfile(
  profile: PaletteSourceFields,
): Palette | null {
  const skinToneHex = profile.skin_tone_hex;
  const undertone = readUndertone(profile.undertone);
  if (skinToneHex === null || undertone === null) {
    return null;
  }
  return derivePalette({
    skinToneHex,
    undertone,
    eyeColorHex: profile.eye_color_hex,
    hairColorHex: profile.hair_color_hex,
    fitzpatrick: profile.fitzpatrick,
  });
}

/**
 * The palette as it is stored.
 *
 * docs/03-architecture.md gives the column as "({wear: [...], avoid: [...]})".
 * The whole Palette goes in, which is a superset: the season, its display name,
 * and its one sentence explanation travel with the lists, so a later reader has
 * the sentence without having to derive the palette again.
 */
export function paletteToJson(palette: Palette | null): Json | null {
  return palette === null ? null : (palette as unknown as Json);
}

/** What /color renders. */
export async function buildColorView(
  session: AppSession,
): Promise<ColorView | null> {
  if (isDemoFixtureMode()) {
    console.log(
      JSON.stringify({
        event: "aurum.color_view",
        source: "fixture",
        note: `${DEMO_FIXTURE_ENV} is true: the palette is served from the checked in fixture and no database or provider is touched.`,
      }),
    );
    return DEMO_FIXTURE_COLOR_VIEW;
  }

  const profile = await getAestheticProfile(session.id);
  if (profile === null) {
    return null;
  }

  return {
    skinToneHex: profile.skin_tone_hex,
    undertone: readUndertone(profile.undertone),
    undertoneSource: parseUndertoneSource(profile.undertone_source),
    palette: paletteForProfile(profile),
  };
}

export type UndertoneUpdateOutcome =
  | {
      readonly ok: true;
      readonly season: Season | null;
      readonly paletteChanged: boolean;
      readonly palette: Palette | null;
      /** Whether the reading was written again, for the log line. */
      readonly readingRegenerated: boolean;
    }
  | { readonly ok: false; readonly reason: "no_profile" | "fixture_read_only" };

/**
 * The undertone adjuster, docs/01-user-flow.md section G item 2: "Choosing one
 * updates the profile and re derives the palette."
 *
 * The reading is written again as well, because docs/03-architecture.md,
 * "Caching", says the synthesis is "regenerated only when the underlying
 * analyses change or the person adjusts undertone", and the reading names the
 * tone. With no Anthropic key the same pipeline returns the deterministic
 * fallback, so this path works in a build with no provider keys at all.
 *
 * When the photo gave no skin tone there is nothing to derive a palette from.
 * The confirmed undertone is still stored, because it is the person's answer and
 * the next capture will use it, and the outcome says plainly that no palette
 * changed rather than reporting a season nobody derived.
 */
export async function confirmUndertone(args: {
  readonly session: AppSession;
  readonly undertone: Undertone;
}): Promise<UndertoneUpdateOutcome> {
  if (isDemoFixtureMode()) {
    // The fixture is checked in and there is no database behind it. Saying so is
    // the honest answer; writing to nothing and reporting success is not.
    return { ok: false, reason: "fixture_read_only" };
  }

  const existing = await getAestheticProfile(args.session.id);
  if (existing === null) {
    return { ok: false, reason: "no_profile" };
  }

  const palette = paletteForProfile({
    skin_tone_hex: existing.skin_tone_hex,
    undertone: args.undertone,
    eye_color_hex: existing.eye_color_hex,
    hair_color_hex: existing.hair_color_hex,
    fitzpatrick: existing.fitzpatrick,
  });

  const row: Insert<"aesthetic_profiles"> = {
    user_id: args.session.id,
    undertone: args.undertone,
    undertone_source: "confirmed_by_user",
    season: palette?.season ?? null,
    palette: paletteToJson(palette),
    version: existing.version + 1,
  };

  const facts = toFacts({ ...existing, undertone: args.undertone });
  let readingRegenerated = false;
  if (facts.ranked.length > 0) {
    const firstName = await readFirstName(args.session);
    const result = await runProfileSynthesis(facts, { firstName });
    if (result.narrative !== null) {
      row.reading = result.narrative.reading;
      row.reading_model = result.narrative.readingModel;
      readingRegenerated = true;
    }
  }

  await upsertAestheticProfile(row);

  console.log(
    JSON.stringify({
      event: "aurum.undertone_confirmed",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      season: palette?.season ?? null,
      paletteDerived: palette !== null,
      readingRegenerated,
    }),
  );

  return {
    ok: true,
    season: palette?.season ?? null,
    paletteChanged: palette !== null,
    palette,
    readingRegenerated,
  };
}
