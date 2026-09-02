import "server-only";

import { z } from "zod";

import {
  faceShapeLine,
  hairColorsFor,
  hairStylesFor,
  isHairColorName,
  isHairStyleId,
  normalizeFaceShape,
  readHairTexture,
  type HairTypeReading,
} from "@/lib/shared/hair-rules";
import type {
  HairColorOption,
  HairRenderStatus,
  HairStyleOption,
  HairView,
} from "@/lib/shared/hair-view";

import { getCapture } from "../db";
import { BUCKETS, createSignedRead } from "../db/storage";
import type { Insert, JobStatus, Render } from "../db/types";
import {
  demoFixtureNote,
  demoProfileIsReadOnly,
  planDemoRead,
} from "../judge/demo";
import { findRendersByHashes } from "../renders/db";
import {
  canonicalHairColorParams,
  canonicalHairstyleParams,
  paramsHash,
} from "../renders/params";
import type { AppSession } from "../session";
import { paletteForProfile } from "./color";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "./db";
import { DEMO_FIXTURE_HAIR_VIEW } from "./demo-fixture";

/**
 * Everything /hair needs, in one object, and the save behind "Save this".
 *
 * docs/01-user-flow.md section I is the layout this fills: the face shape line,
 * the row of styles, the row of colors inside the palette, and the save.
 *
 * Three things this deliberately does not do:
 *
 * 1. It never starts a render. It reports the renders that already exist for the
 *    styles and colors it is offering, so a style the person has already seen
 *    comes back with its picture instead of a second credit
 *    (docs/03-architecture.md, "Caching"). Starting one is POST /api/renders.
 * 2. It never invents a picture. renderUrl is null unless a real render
 *    succeeded and is in our own bucket, which is what leaves the screen with
 *    its documented "Preview unavailable for this shade." state.
 * 3. It decides nothing about hair. The rules are pure and unit tested in
 *    src/lib/shared/hair-rules.ts; this file reads the profile row, asks them,
 *    and attaches renders.
 */

/* ------------------------------------------------------------------ */
/* Reading the row                                                      */
/* ------------------------------------------------------------------ */

/**
 * aesthetic_profiles.hair_type, as the analysis job writes it: the hair type
 * detection result is stored as { mapping, term } (src/lib/server/jobs/analysis.ts).
 *
 * Both fields are unknown rather than string, because the column is jsonb and
 * the provider's vocabulary is unverified. Anything that is not a string is
 * simply not a texture we can read.
 *
 * In this build the column is always null: hair type detection needs three
 * photos of the same size and is skipped in the one selfie fan out
 * (docs/04-integrations.md), so the styles read the face shape alone.
 */
const storedHairTypeSchema = z.object({
  mapping: z.unknown().optional(),
  term: z.unknown().optional(),
});

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The hair type reading on a stored row, or null when there is none. */
export function readStoredHairType(value: unknown): HairTypeReading | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = storedHairTypeSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const term = asText(parsed.data.term);
  const mapping = asText(parsed.data.mapping);
  if (term === null && mapping === null) {
    return null;
  }
  return {
    texture: readHairTexture(term) ?? readHairTexture(mapping),
    curl: mapping,
  };
}

/**
 * The saved style, or null.
 *
 * A stored id that is no longer in the catalog reads as no saved style rather
 * than as a style with no name: the catalog is what the screen renders from, and
 * an id it cannot draw is not a choice it can show.
 */
export function readSavedStyleId(profile: AestheticProfile): string | null {
  const saved = profile.saved_hair_style_id;
  return saved !== null && isHairStyleId(saved) ? saved : null;
}

/** The saved color name, or null. Same rule as the style. */
export function readSavedColorName(profile: AestheticProfile): string | null {
  const saved = profile.saved_hair_color_name;
  return saved !== null && isHairColorName(saved) ? saved : null;
}

/* ------------------------------------------------------------------ */
/* Renders that already exist                                           */
/* ------------------------------------------------------------------ */

/**
 * A render row as the screen reads it. A running render is "pending", because
 * docs/01 section I has one pending state and the person does not need to know
 * whether the provider has picked the task up yet.
 */
function statusOf(status: JobStatus): HairRenderStatus {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  return "pending";
}

/** A signed URL for a finished render, or null. Never a substitute image. */
async function signRender(render: Render): Promise<string | null> {
  if (render.status !== "succeeded" || render.storage_path === null) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.renders, render.storage_path);
  } catch {
    return null;
  }
}

/**
 * A signed URL for the selfie, or null. Copied in shape from
 * src/lib/server/profile/makeup.ts: a selfie that cannot be signed is a missing
 * hero, never a missing screen.
 */
async function signCapture(
  ownerId: string,
  captureId: string | null,
): Promise<string | null> {
  if (captureId === null) {
    return null;
  }
  try {
    const capture = await getCapture(ownerId, captureId);
    const path = capture?.storage_path ?? null;
    if (path === null) {
      return null;
    }
    return await createSignedRead(BUCKETS.captures, path);
  } catch {
    return null;
  }
}

/** Hash to render, for the rows that exist. */
async function rendersByHash(args: {
  readonly ownerId: string;
  readonly kind: "hairstyle" | "hair_color";
  readonly hashes: readonly string[];
}): Promise<Map<string, Render>> {
  const found = new Map<string, Render>();
  if (args.hashes.length === 0) {
    return found;
  }
  try {
    for (const render of await findRendersByHashes({
      ownerId: args.ownerId,
      kind: args.kind,
      paramsHashes: args.hashes,
    })) {
      found.set(render.params_hash, render);
    }
  } catch {
    // A screen that cannot read its render history still shows every style and
    // every color. It just shows them as not yet rendered, which is what the
    // person would see on their first visit anyway.
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* The view                                                             */
/* ------------------------------------------------------------------ */

/**
 * The hair view for the signed in person or the judge session.
 *
 * Returns null when there is no profile yet, which is the "nothing to show"
 * case: the caller sends the person to capture rather than rendering an empty
 * screen. A profile with no face shape and no palette still returns a view, with
 * the honest line and the styles that suit most faces.
 */
export async function buildHairView(
  session: AppSession,
): Promise<HairView | null> {
  const plan = await planDemoRead(session);
  if (plan.source === "fixture") {
    console.log(
      JSON.stringify({
        event: "aurum.hair_view",
        source: "fixture",
        reason: plan.reason,
        note: demoFixtureNote(plan.reason, "the styles and colors are served"),
      }),
    );
    return DEMO_FIXTURE_HAIR_VIEW;
  }

  const profile = await getAestheticProfile(plan.ownerId);
  if (profile === null) {
    return null;
  }

  const faceShape = normalizeFaceShape(profile.face_shape);
  const styles = hairStylesFor({
    faceShape,
    hairType: readStoredHairType(profile.hair_type),
  });
  const colors = hairColorsFor({
    palette: paletteForProfile(profile),
    skinToneHex: profile.skin_tone_hex,
  });

  const savedStyleId = readSavedStyleId(profile);
  const savedColorName = readSavedColorName(profile);

  /*
   * Which style the color row is rendered on, docs/01 section I item 3: "a row
   * of 3 to 4 hair colors inside the palette, rendered on the selected style".
   * The saved style is the selected one; before anything is saved it is the
   * first candidate, which is the one the row opens on. A color rendered on a
   * different style has a different hash and simply shows as not rendered here,
   * which is true: it is a picture of another style.
   */
  const captureId = profile.capture_id;
  const selectedStyleId = savedStyleId ?? styles[0]?.id ?? null;

  const styleHashes =
    captureId === null
      ? []
      : styles.map((style) =>
          paramsHash(
            "hairstyle",
            canonicalHairstyleParams({
              captureId,
              params: { styleId: style.id },
            }),
          ),
        );
  const colorHashes =
    captureId === null || selectedStyleId === null
      ? []
      : colors.map((color) =>
          paramsHash(
            "hair_color",
            canonicalHairColorParams({
              captureId,
              params: {
                styleId: selectedStyleId,
                colorHex: color.hex,
                colorName: color.name,
              },
            }),
          ),
        );

  const [styleRenders, colorRenders, captureImageUrl] = await Promise.all([
    rendersByHash({
      ownerId: plan.ownerId,
      kind: "hairstyle",
      hashes: styleHashes,
    }),
    rendersByHash({
      ownerId: plan.ownerId,
      kind: "hair_color",
      hashes: colorHashes,
    }),
    signCapture(plan.ownerId, captureId),
  ]);

  const styleOptions: HairStyleOption[] = [];
  for (let index = 0; index < styles.length; index += 1) {
    const style = styles[index];
    const render = styleRenders.get(styleHashes[index] ?? "");
    styleOptions.push({
      id: style.id,
      name: style.name,
      why: style.why,
      renderUrl: render === undefined ? null : await signRender(render),
      renderStatus: render === undefined ? "none" : statusOf(render.status),
    });
  }

  const colorOptions: HairColorOption[] = [];
  for (let index = 0; index < colors.length; index += 1) {
    const color = colors[index];
    const render = colorRenders.get(colorHashes[index] ?? "");
    colorOptions.push({
      name: color.name,
      hex: color.hex,
      why: color.why,
      renderUrl: render === undefined ? null : await signRender(render),
      renderStatus: render === undefined ? "none" : statusOf(render.status),
    });
  }

  return {
    captureImageUrl,
    faceShape,
    faceShapeLine: faceShapeLine(faceShape),
    styles: styleOptions,
    colors: colorOptions,
    savedStyleId,
    savedColorName,
  };
}

/* ------------------------------------------------------------------ */
/* Save                                                                 */
/* ------------------------------------------------------------------ */

export type SaveHairChoiceOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "no_profile" | "fixture_read_only" | "unknown_choice";
    };

/**
 * "Save this", docs/01-user-flow.md section I item 4.
 *
 * docs/03-architecture.md has no column for a saved hair choice: the data model
 * lists face_shape and hair_type on aesthetic_profiles, and /profile is asked to
 * show "saved makeup look, hair choice, saved looks" (docs/01 section L item 2)
 * without saying where any of them live. Migration 0009 adds the two smallest
 * columns that carry it, saved_hair_style_id and saved_hair_color_name, on the
 * profile row every feature already reads. Recorded as a doc gap.
 *
 * Both values are checked against the catalog before they are written, so the
 * column can only ever hold a style the app can draw and a color it can name.
 */
export async function saveHairChoice(args: {
  readonly session: AppSession;
  readonly styleId: string;
  readonly colorName: string | null;
}): Promise<SaveHairChoiceOutcome> {
  if (demoProfileIsReadOnly(args.session)) {
    // The fixture is checked in and there is no database behind it, and a judge
    // session at zero analyses is reading the saved demo profile, which is read
    // only. Saying so is the honest answer; writing to nothing, or to a row no
    // screen will read back, and reporting success is not.
    return { ok: false, reason: "fixture_read_only" };
  }

  if (!isHairStyleId(args.styleId)) {
    return { ok: false, reason: "unknown_choice" };
  }
  if (args.colorName !== null && !isHairColorName(args.colorName)) {
    return { ok: false, reason: "unknown_choice" };
  }

  const existing = await getAestheticProfile(args.session.id);
  if (existing === null) {
    return { ok: false, reason: "no_profile" };
  }

  // Only the two columns move. version is not bumped on purpose: it counts
  // rebuilds of the reading and the palette (see build.ts), and choosing a
  // hairstyle changes neither.
  const row: Insert<"aesthetic_profiles"> = {
    user_id: args.session.id,
    saved_hair_style_id: args.styleId,
    saved_hair_color_name: args.colorName,
  };
  await upsertAestheticProfile(row);

  console.log(
    JSON.stringify({
      event: "aurum.hair_choice_saved",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      styleId: args.styleId,
      colorSaved: args.colorName !== null,
    }),
  );

  return { ok: true };
}
