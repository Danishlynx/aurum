import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  SEASONS,
  type Palette,
  type PaletteInput,
} from "@/lib/shared/palette";

/**
 * The three fixture profiles and their golden palettes, loaded and validated.
 *
 * docs/05-evals.md, "Fixtures": "evals/fixtures/profiles: three complete
 * profiles (deep warm, medium neutral, light cool) with known expected palettes
 * as golden files."
 *
 * SYNTHETIC, all three. None of them came from a person or from a provider.
 * Two copy their coloring from an analysis fixture (a09 and a01) so the palette
 * a profile produces here is the palette the same coloring produces everywhere
 * else in the repository. See README.md in this folder.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Lowercase six digit hex. The palette catalog is written this way too. */
const hexSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

const seasonSchema = z.enum(SEASONS);

const profileFixtureSchema = z.object({
  id: z.string().min(1),
  synthetic: z.literal(true),
  label: z.string().min(1),
  note: z.string().min(1),
  /** The analysis fixture this coloring came from, or null when it has none. */
  analysisFixtureId: z.string().min(1).nullable(),
  profile: z.object({
    fitzpatrick: z.number().int().min(1).max(6).nullable(),
    skinToneHex: hexSchema,
    undertone: z.enum(["warm", "cool", "neutral"]),
    undertoneSource: z.enum(["detected", "confirmed_by_user"]),
    eyeColorHex: hexSchema.nullable(),
    eyeColorName: z.string().min(1).nullable(),
    hairColorHex: hexSchema.nullable(),
    hairColorName: z.string().min(1).nullable(),
    faceShape: z.string().min(1).nullable(),
  }),
  expected: z.object({
    season: seasonSchema,
    depth: z.enum(["deep", "medium", "light"]),
    contrast: z.enum(["low", "medium", "high"]),
    why: z.string().min(1),
  }),
  /** Path to the golden palette, relative to this folder. */
  golden: z.string().min(1),
});

export type ProfileFixture = z.infer<typeof profileFixtureSchema>;

/** The ids, in the order the eval reports them. */
export const PROFILE_FIXTURE_IDS = [
  "deep-warm",
  "medium-neutral",
  "light-cool",
] as const;

export type ProfileFixtureId = (typeof PROFILE_FIXTURE_IDS)[number];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** One fixture. Throws when the file does not match the shape. */
export function loadProfileFixture(id: ProfileFixtureId): ProfileFixture {
  const parsed = profileFixtureSchema.safeParse(
    readJson(resolve(HERE, `${id}.json`)),
  );
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(`Profile fixture ${id} does not match the shape: ${paths}`);
  }
  if (parsed.data.id !== id) {
    throw new Error(
      `Profile fixture ${id}.json declares the id ${parsed.data.id}`,
    );
  }
  return parsed.data;
}

/** All three, in PROFILE_FIXTURE_IDS order. */
export function loadProfileFixtures(): ProfileFixture[] {
  return PROFILE_FIXTURE_IDS.map(loadProfileFixture);
}

/** The five fields derivePalette reads, taken from the stored profile. */
export function paletteInputOf(fixture: ProfileFixture): PaletteInput {
  return {
    skinToneHex: fixture.profile.skinToneHex,
    undertone: fixture.profile.undertone,
    eyeColorHex: fixture.profile.eyeColorHex,
    hairColorHex: fixture.profile.hairColorHex,
    fitzpatrick: fixture.profile.fitzpatrick,
  };
}

const paletteColorSchema = z.object({
  name: z.string().min(1),
  hex: hexSchema,
  why: z.string().min(1),
});

/**
 * The golden file shape, with the counts docs/01-user-flow.md section G sets:
 * 8 to 12 colors to wear, 4 to 6 to keep away from the face. A golden that
 * breaks those counts fails at load, before any comparison runs.
 */
export const goldenPaletteSchema = z.object({
  season: seasonSchema,
  seasonDisplayName: z.string().min(1),
  seasonLine: z.string().min(1),
  wear: z.array(paletteColorSchema).min(8).max(12),
  avoid: z.array(paletteColorSchema).min(4).max(6),
});

/** The recorded palette for a fixture. Throws when the file is not one. */
export function loadGoldenPalette(fixture: ProfileFixture): Palette {
  const path = resolve(HERE, fixture.golden);
  const parsed = goldenPaletteSchema.safeParse(readJson(path));
  if (!parsed.success) {
    const paths = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .join(", ");
    throw new Error(
      `Golden palette ${fixture.golden} does not match the shape: ${paths}`,
    );
  }
  return parsed.data;
}

/** The absolute path of a fixture's golden file, for the writer script. */
export function goldenPathOf(fixture: ProfileFixture): string {
  return resolve(HERE, fixture.golden);
}
