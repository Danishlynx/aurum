import "server-only";

import { concernDisplayName, isConcernKey } from "@/lib/shared/concerns";
import { copy, fill } from "@/lib/shared/copy";
import { HAIR_STYLE_NAME, isHairStyleId } from "@/lib/shared/hair-rules";
import { isOccasion, occasionLabel } from "@/lib/shared/looks-view";
import { classifyDepth, type Palette } from "@/lib/shared/palette";
import {
  PROFILE_ROW_ACTIONS,
  PROFILE_ROW_KEYS,
  PROFILE_ROW_LABELS,
  type ProfileSummaryRow,
  type ProfileView,
  type SavedItemRow,
} from "@/lib/shared/profile-view";
import { garmentTypeLabel } from "@/lib/shared/wardrobe-view";

import type { Look } from "../db/types";
import { demoFixtureNote, planDemoRead } from "../judge/demo";
import { listAllLooks } from "../looks/db";
import { readStoredMembers } from "../looks/stored";
import { getConsent, type AppSession } from "../session";
import { paletteForProfile } from "./color";
import { getAestheticProfile, readStoredConcerns, type StoredConcern } from "./db";
import {
  DEMO_FIXTURE_CONCERNS,
  DEMO_FIXTURE_FACE_SHAPE,
  DEMO_FIXTURE_FITZPATRICK,
  DEMO_FIXTURE_PALETTE,
  DEMO_FIXTURE_SKIN_TONE_HEX,
  DEMO_FIXTURE_UNDERTONE,
} from "./demo-fixture";
import {
  DEMO_FIXTURE_LOOKS,
  DEMO_FIXTURE_SAVED_OCCASIONS,
} from "./demo-fixture-looks";
import { readSavedColorName, readSavedStyleId, readStoredHairType } from "./hair";
import { readSavedMakeup } from "./makeup";
import { readUndertone } from "./report-view";
import { skinTypeFromZones } from "./skin-type";

/**
 * Everything /profile needs, in one object.
 *
 * docs/01-user-flow.md section L is the screen this fills: six summary rows with
 * their affordances, the saved items, and the retention toggle that the data
 * controls sit under. docs/06-safety-privacy.md, "Person's controls", is the
 * promise it keeps: "/profile shows exactly what is stored, in plain rows."
 *
 * Three things it deliberately does not do:
 *
 * 1. It never invents a value. A row whose reading never arrived carries null,
 *    and the screen says so in copy.profile.valueUnavailable
 *    (src/components/profile/profile-content.ts). There is no dash, no
 *    "unknown", and no stand in figure, which is the same honesty rule the
 *    report and the looks screens follow.
 * 2. It never returns a photo. Nothing here signs a URL: the rows are text, and
 *    a profile screen does not need a face on it to say what is stored.
 * 3. It never decides anything about the person. The skin type, the palette, the
 *    concern ranking, and the hair catalog are all read from the layers that own
 *    them, so this file cannot disagree with the report, /color, or /hair.
 *
 * "Exactly what is stored" is meant literally, and the saved list now holds all
 * three of the items docs/01 section L item 2 names. The makeup row was the last
 * one to land: it waited on the column and the route (migration 0013 and
 * src/lib/server/profile/makeup.ts), and then on a label, because unlike the
 * other two a saved makeup look has no name of its own to borrow. The label is
 * copy.profile.savedMakeupLabel and the shades are the detail beside it.
 */

/* ------------------------------------------------------------------ */
/* Row values                                                          */
/* ------------------------------------------------------------------ */

/** Sentence case for a catalog word: "combination" becomes "Combination". */
function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  return `${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`;
}

/**
 * The skin type row: the type, and the two zones when they differ.
 *
 * The type is derived back out of the stored zones by the same function the
 * report uses (skin-type.ts), so the profile and the report can never name two
 * different skin types for one person.
 */
export function skinTypeRowValue(zones: {
  readonly tZone: string | null;
  readonly cheeks: string | null;
}): string | null {
  const reading = skinTypeFromZones(zones.tZone, zones.cheeks);
  if (reading === null) {
    return null;
  }
  if (reading.tZone === reading.cheeks) {
    // "Balanced, balanced T zone and balanced cheeks" says one thing three
    // times. The type word alone is the whole reading here.
    return sentenceCase(reading.label);
  }
  return fill(copy.profile.skinTypeValueTemplate, {
    label: sentenceCase(reading.label),
    tZone: reading.tZone,
    cheeks: reading.cheeks,
  });
}

/** The top concern row: the display name of the concern ranked first. */
export function topConcernRowValue(
  concerns: readonly StoredConcern[],
): string | null {
  for (const concern of concerns) {
    if (isConcernKey(concern.key)) {
      return concernDisplayName(concern.key);
    }
  }
  return null;
}

/**
 * The tone and undertone row.
 *
 * The tone half is the depth the palette layer reads off the photo, corrected by
 * Fitzpatrick, because that is the reading the app actually holds and acts on. A
 * hex is not something a person reads, and naming a tone we never measured would
 * be an invention. Null when no tone or no undertone was read: half of this row
 * is not a value, it is a half sentence.
 */
export function toneRowValue(args: {
  readonly skinToneHex: string | null;
  readonly undertone: string | null;
  readonly fitzpatrick: number | null;
}): string | null {
  if (args.skinToneHex === null || args.undertone === null) {
    return null;
  }
  return fill(copy.profile.toneValueTemplate, {
    depth: sentenceCase(classifyDepth(args.skinToneHex, args.fitzpatrick)),
    undertone: args.undertone,
  });
}

/* ------------------------------------------------------------------ */
/* The rows                                                            */
/* ------------------------------------------------------------------ */

/** The six values, keyed. Everything else about a row is fixed in the contract. */
export interface ProfileRowValues {
  readonly skin_type: string | null;
  readonly top_concern: string | null;
  readonly tone_undertone: string | null;
  readonly season: string | null;
  readonly face_shape: string | null;
  readonly hair_type: string | null;
}

/**
 * The rows, in the order docs/01-user-flow.md section L item 1 lists them, with
 * the label and the affordance taken from the shared contract so this file
 * cannot put a "Retake" on a row the screen calls something else.
 */
export function toProfileRows(values: ProfileRowValues): ProfileSummaryRow[] {
  return PROFILE_ROW_KEYS.map((key) => ({
    key,
    label: PROFILE_ROW_LABELS[key],
    value: values[key],
    action: PROFILE_ROW_ACTIONS[key],
  }));
}

/* ------------------------------------------------------------------ */
/* Saved items                                                         */
/* ------------------------------------------------------------------ */

/**
 * The saved makeup look, docs/01-user-flow.md section L item 2.
 *
 * The detail is the shade names in the order the shade rows are laid out on
 * /makeup, so the profile lists them the way the person picked them. They are
 * the model's own words for a colour, stored with the look, which is why they
 * are read from the row rather than recomputed: a shade renamed by a later
 * catalog change must not silently rename what somebody saved.
 *
 * Null when nothing is saved, or when the column holds a shape the schema does
 * not accept. A saved look nobody can read is not a row about the person, and
 * "Makeup look" over an empty line would say something was saved without being
 * able to say what.
 */
export function savedMakeupRow(
  categories: readonly { readonly shadeName: string }[],
): SavedItemRow | null {
  const names: string[] = [];
  for (const category of categories) {
    const name = category.shadeName.trim();
    if (name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }
  if (names.length === 0) {
    return null;
  }
  return {
    kind: "makeup",
    label: copy.profile.savedMakeupLabel,
    detail: sentenceCase(names.join(", ")),
  };
}

/**
 * The saved hair choice, docs/01-user-flow.md section L item 2.
 *
 * The label is the style's own name from the catalog, so the profile row and the
 * /hair row read the same words. A stored id the catalog no longer holds is not
 * shown: it is a choice the app can no longer draw, and a row with an id in it
 * would be a row about our storage rather than about the person.
 */
export function savedHairRow(args: {
  readonly styleId: string | null;
  readonly colorName: string | null;
}): SavedItemRow | null {
  const styleId = args.styleId;
  if (styleId === null || !isHairStyleId(styleId)) {
    return null;
  }
  return {
    kind: "hair",
    label: HAIR_STYLE_NAME[styleId],
    detail: args.colorName,
  };
}

/**
 * A saved look as one row: the occasion it was saved for, and the pieces in it.
 *
 * The occasion is the chip label the person tapped. The detail is the garment
 * words, which is what makes two saved wedding looks tell apart on a list. A row
 * is dropped when the look has no readable member left, because there is nothing
 * true left to name.
 */
export function savedLookRow(row: Look): SavedItemRow | null {
  const occasion = row.occasion;
  if (occasion === null || !isOccasion(occasion)) {
    return null;
  }
  const words: string[] = [];
  for (const member of readStoredMembers(row.garments)) {
    const type = member.type ?? null;
    if (type === null) {
      continue;
    }
    const label = garmentTypeLabel(type) ?? type;
    const lower = label.toLowerCase();
    if (!words.includes(lower)) {
      words.push(lower);
    }
  }
  if (words.length === 0) {
    return null;
  }
  return {
    kind: "look",
    label: occasionLabel(occasion),
    detail: sentenceCase(words.join(", ")),
  };
}

/* ------------------------------------------------------------------ */
/* The fixture profile                                                 */
/* ------------------------------------------------------------------ */

/**
 * The /profile screen built from the checked in fixture.
 *
 * Two paths reach it: AURUM_DEMO_FIXTURE=true in development, and a judge
 * session with no analyses left on a build with no seeded demo profile
 * (src/lib/server/judge/demo.ts). Both are the saved demo profile, so both draw
 * the same rows.
 *
 * Every value is read from the same checked in constants the report, the colour
 * screen, and the looks screen are built from, never written out again here, so
 * the demo profile screen cannot drift from the demo profile.
 *
 * isJudgeSession is true: fixture mode is the saved demo profile, which is read
 * only, and docs/01-user-flow.md ("Judge mode across the flow") says the delete
 * control is not shown on it. keepOriginals is false because the fixture keeps
 * no original: there is no capture object behind it at all.
 */
export function demoFixtureProfileView(): ProfileView {
  const saved: SavedItemRow[] = [];
  for (const occasion of DEMO_FIXTURE_SAVED_OCCASIONS) {
    const look = DEMO_FIXTURE_LOOKS[occasion].looks[0];
    if (look === undefined) {
      continue;
    }
    const words: string[] = [];
    for (const item of look.items) {
      const lower = (garmentTypeLabel(item.type) ?? item.type).toLowerCase();
      if (!words.includes(lower)) {
        words.push(lower);
      }
    }
    saved.push({
      kind: "look",
      label: occasionLabel(occasion),
      detail: words.length === 0 ? null : sentenceCase(words.join(", ")),
    });
  }

  return {
    rows: toProfileRows({
      skin_type: skinTypeRowValue({ tZone: "oily", cheeks: "dry" }),
      top_concern: topConcernRowValue(DEMO_FIXTURE_CONCERNS),
      tone_undertone: toneRowValue({
        skinToneHex: DEMO_FIXTURE_SKIN_TONE_HEX,
        undertone: DEMO_FIXTURE_UNDERTONE,
        fitzpatrick: DEMO_FIXTURE_FITZPATRICK,
      }),
      season: DEMO_FIXTURE_PALETTE.seasonDisplayName,
      face_shape: DEMO_FIXTURE_FACE_SHAPE,
      // Null, and honestly so: hair type detection needs three photos and is
      // skipped in the one selfie fan out (docs/04-integrations.md), so no
      // profile this build writes has one.
      hair_type: null,
    }),
    // No makeup selection and no hair choice are stored on the fixture, so the
    // only saved things it has are the two looks docs/07 names.
    saved,
    keepOriginals: false,
    isJudgeSession: true,
  };
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

/** The season name for a stored profile: derived, never the stored column. */
function seasonNameOf(palette: Palette | null): string | null {
  return palette === null ? null : palette.seasonDisplayName;
}

/**
 * The profile view for the signed in person or the judge session.
 *
 * Always returns a view. A session with no reading yet is not an error and not
 * an empty screen: the rows carry null, the screen says what has not been read,
 * and the "Retake" affordance beside each one is the way to fix it. That is the
 * one screen a person can reach before they have ever taken a selfie.
 */
export async function buildProfileView(
  session: AppSession,
): Promise<ProfileView> {
  const plan = await planDemoRead(session);
  if (plan.source === "fixture") {
    console.log(
      JSON.stringify({
        event: "aurum.profile_view",
        source: "fixture",
        reason: plan.reason,
        note: demoFixtureNote(plan.reason, "the profile rows are served"),
      }),
    );
    return demoFixtureProfileView();
  }

  const consent = await getConsent(session);
  const profile = await getAestheticProfile(plan.ownerId);

  if (profile === null) {
    return {
      rows: toProfileRows({
        skin_type: null,
        top_concern: null,
        tone_undertone: null,
        season: null,
        face_shape: null,
        hair_type: null,
      }),
      saved: [],
      keepOriginals: consent.keepOriginals,
      isJudgeSession: session.kind === "judge",
    };
  }

  const palette = paletteForProfile(profile);
  const zones = readZones(profile.skin_type_zones);
  const hairType = readStoredHairType(profile.hair_type);

  const saved: SavedItemRow[] = [];
  // docs/01 section L item 2 lists them in this order: makeup, hair, looks.
  const makeupRow = savedMakeupRow(readSavedMakeup(profile));
  if (makeupRow !== null) {
    saved.push(makeupRow);
  }
  const hairRow = savedHairRow({
    styleId: readSavedStyleId(profile),
    colorName: readSavedColorName(profile),
  });
  if (hairRow !== null) {
    saved.push(hairRow);
  }
  for (const look of await readSavedLooks(plan.ownerId)) {
    const row = savedLookRow(look);
    if (row !== null) {
      saved.push(row);
    }
  }

  return {
    rows: toProfileRows({
      skin_type: skinTypeRowValue(zones),
      top_concern: topConcernRowValue(readStoredConcerns(profile)),
      tone_undertone: toneRowValue({
        skinToneHex: profile.skin_tone_hex,
        // Through the same reader /color uses, so a column holding a word the
        // app does not know reads as no undertone rather than as one.
        undertone: readUndertone(profile.undertone),
        fitzpatrick: profile.fitzpatrick,
      }),
      season: seasonNameOf(palette),
      face_shape: profile.face_shape,
      hair_type: hairType?.texture ?? hairType?.curl ?? null,
    }),
    saved,
    keepOriginals: consent.keepOriginals,
    isJudgeSession: session.kind === "judge",
  };
}

/**
 * The saved looks, or none when the table cannot be read.
 *
 * A profile screen that cannot reach the looks table still shows the rows, which
 * are the part docs/06-safety-privacy.md promises ("shows exactly what is
 * stored, in plain rows"). It shows no saved looks rather than an error, which
 * is what a person with no saved looks sees anyway.
 */
async function readSavedLooks(ownerId: string): Promise<Look[]> {
  try {
    return (await listAllLooks(ownerId)).filter((row) => row.is_saved);
  } catch {
    return [];
  }
}

/**
 * aesthetic_profiles.skin_type_zones as the row reads it.
 *
 * Written here rather than imported because report-view.ts keeps its reader
 * private, and a second tiny reader is better than widening that module's
 * surface for one caller. A column that does not hold two strings reads as no
 * zones, which is the same answer a profile without a skin reading gives.
 */
function readZones(value: unknown): {
  readonly tZone: string | null;
  readonly cheeks: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { tZone: null, cheeks: null };
  }
  const record = value as Record<string, unknown>;
  const tZone = record.t_zone;
  const cheeks = record.cheeks;
  return {
    tZone: typeof tZone === "string" ? tZone : null,
    cheeks: typeof cheeks === "string" ? cheeks : null,
  };
}
