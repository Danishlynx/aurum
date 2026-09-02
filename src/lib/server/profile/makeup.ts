import "server-only";

import {
  makeupRenderParamsSchema,
  type MakeupCategory,
  type MakeupCategoryView,
  type MakeupRenderCategoryInput,
  type MakeupRenderParams,
  type MakeupView,
} from "@/lib/shared/color-view";
import type { ReportListing } from "@/lib/shared/report-view";

import { getCapture } from "../db";
import type { Insert, Json, Render } from "../db/types";
import { BUCKETS, createSignedRead } from "../db/storage";
import {
  demoFixtureNote,
  demoProfileIsReadOnly,
  planDemoRead,
} from "../judge/demo";
import { groundRoutineSteps } from "../products";
import { findRenderByHash } from "../renders/db";
import { canonicalMakeupParams, paramsHash } from "../renders/params";
import type { AppSession } from "../session";
import { paletteForProfile } from "./color";
import {
  getAestheticProfile,
  upsertAestheticProfile,
  type AestheticProfile,
} from "./db";
import { DEMO_FIXTURE_MAKEUP_VIEW } from "./demo-fixture";
import { readGroundingContext } from "./report-view";
import {
  applySavedShades,
  buildMakeupCategoryViews,
  openingIndex,
  selectedShade,
} from "./shades";

/**
 * Everything /makeup needs, in one object.
 *
 * docs/01-user-flow.md section H is the layout this fills: the selfie, four
 * shade rows with the middle swatch selected, and a product card per selected
 * shade.
 *
 * Two things this deliberately does not do:
 *
 * 1. It never starts a render, and it never invents one. It reports the try on
 *    that already exists for the shades the rows open on, the way
 *    src/lib/server/profile/hair.ts reports the renders that exist for its
 *    styles, so a look that was already paid for is on the screen at the first
 *    paint. Starting one is POST /api/renders. With nothing stored the hero is
 *    the unedited selfie with copy.makeup.previewUnavailable (docs/01 section H,
 *    "Try on failed"). There is no third image.
 * 2. It never invents a product. Grounding is the same call the report uses, and
 *    a shade with no listing shows the "No listing found near you yet" state.
 *
 * The shade maths itself is in shades.ts, which is pure and unit tested.
 */

/** Which shade of each row the screen has selected, from the query string. */
export type ShadeSelection = Partial<Record<MakeupCategory, number | null>>;

export interface MakeupViewOptions {
  /** True for ?ground=1. False costs no SerpApi search at all. */
  readonly ground?: boolean;
  readonly selection?: ShadeSelection;
}

/**
 * A signed URL, or null. A selfie that cannot be signed is a missing hero, never
 * a missing screen.
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

/**
 * One listing per row, for the selected shade of that row.
 *
 * The queries go through the same groundRoutineSteps the report uses, so the
 * cache, the daily cap, the kill switch, and the "no listing, no product" rule
 * are the ones already written and tested, not a second copy of them.
 */
export async function groundSelectedShades(args: {
  readonly session: AppSession;
  readonly categories: readonly MakeupCategoryView[];
  readonly selection: ShadeSelection;
}): Promise<(ReportListing | null)[]> {
  const queries = args.categories.map((row) => ({
    productQuery:
      selectedShade(row, args.selection[row.category] ?? null)?.productQuery ?? "",
  }));
  if (queries.length === 0) {
    return [];
  }

  const context = await readGroundingContext(args.session);
  try {
    return [
      ...(await groundRoutineSteps(queries, {
        location: context.location,
        gl: context.gl,
        hl: context.hl,
        ownerType: args.session.ownerType,
        ownerId: args.session.id,
      })),
    ];
  } catch {
    // docs/03-architecture.md, "Failure modes": with no listings the row still
    // recommends the shade and shows the empty product state.
    return args.categories.map(() => null);
  }
}

/* ------------------------------------------------------------------ */
/* The saved look                                                      */
/* ------------------------------------------------------------------ */

/**
 * The saved shades on a stored row, or an empty list.
 *
 * aesthetic_profiles.saved_makeup is jsonb (migration 0013) written by the save
 * below in the shape a render is created under, and it is read back through the
 * same schema, because a column written by an older build is an external input
 * like any other (CLAUDE.md, "Conventions"). Anything that does not parse reads
 * as nothing saved, which leaves the rows on their recommendation rather than on
 * a colour we cannot stand behind.
 */
export function readSavedMakeup(
  profile: AestheticProfile,
): MakeupRenderCategoryInput[] {
  const stored = profile.saved_makeup;
  if (stored === null || stored === undefined) {
    return [];
  }
  const parsed = makeupRenderParamsSchema.safeParse(stored);
  return parsed.success ? [...parsed.data.categories] : [];
}

/** The look the rows open on, in the shape a render is created and hashed under. */
export function openingLook(
  rows: readonly MakeupCategoryView[],
): MakeupRenderCategoryInput[] {
  const categories: MakeupRenderCategoryInput[] = [];
  for (const row of rows) {
    const shade = row.shades[openingIndex(row)];
    if (shade === undefined) {
      continue;
    }
    categories.push({
      category: row.category,
      shadeHex: shade.hex,
      shadeName: shade.name,
    });
  }
  return categories;
}

/** A signed URL for a finished render, or null. Never a substitute image. */
async function signRender(render: Render | null): Promise<string | null> {
  if (
    render === null ||
    render.status !== "succeeded" ||
    render.storage_path === null
  ) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.renders, render.storage_path);
  } catch {
    return null;
  }
}

/**
 * The stored try on for the look the rows open on, or null.
 *
 * The hash is built by the same canonicalMakeupParams and paramsHash the render
 * layer stores a row under, so this finds exactly the render those shades
 * produced and nothing else. A screen that cannot read its render history still
 * renders: it simply shows the selfie and asks for a try on, which is what a
 * first visit looks like anyway.
 */
async function findOpeningRender(args: {
  readonly ownerId: string;
  readonly captureId: string | null;
  readonly categories: readonly MakeupRenderCategoryInput[];
}): Promise<string | null> {
  if (args.captureId === null || args.categories.length === 0) {
    return null;
  }
  const parsed = makeupRenderParamsSchema.safeParse({
    categories: args.categories,
  });
  if (!parsed.success) {
    return null;
  }
  try {
    const render = await findRenderByHash({
      ownerId: args.ownerId,
      kind: "makeup",
      paramsHash: paramsHash(
        "makeup",
        canonicalMakeupParams({
          captureId: args.captureId,
          params: parsed.data,
        }),
      ),
    });
    return await signRender(render);
  } catch {
    return null;
  }
}

/**
 * The makeup view for the signed in person or the judge session.
 *
 * Returns null when there is no profile yet, which is the "nothing to show"
 * case: the caller sends the person to capture rather than rendering an empty
 * screen.
 */
export async function buildMakeupView(
  session: AppSession,
  options: MakeupViewOptions = {},
): Promise<MakeupView | null> {
  const plan = await planDemoRead(session);
  if (plan.source === "fixture") {
    console.log(
      JSON.stringify({
        event: "aurum.makeup_view",
        source: "fixture",
        reason: plan.reason,
        note: demoFixtureNote(plan.reason, "the shade rows are served"),
      }),
    );
    return DEMO_FIXTURE_MAKEUP_VIEW;
  }

  const profile = await getAestheticProfile(plan.ownerId);
  if (profile === null) {
    return null;
  }

  /*
   * The rows the palette derives, then the saved look on top of them
   * (docs/01-user-flow.md section H item 4). A saved shade the palette no longer
   * derives is added to its row rather than dropped, so the screen opens on the
   * look the person kept and the render it was made with is the one asked for.
   */
  const saved = readSavedMakeup(profile);
  const categories = applySavedShades(
    buildMakeupCategoryViews({
      palette: paletteForProfile(profile),
      skinToneHex: profile.skin_tone_hex,
    }),
    saved,
  );

  /*
   * Which look the stored render is looked up under.
   *
   * A saved look is looked up exactly as it was saved, because that is exactly
   * what was rendered: the hash covers the whole category list, so a saved look
   * of two categories and the screen's four rows are two different pictures, and
   * asking under the four would miss the render the two produced. With nothing
   * saved it is the look the rows open on, which is the same request the screen
   * would make itself.
   */
  const lookForRender = saved.length > 0 ? saved : openingLook(categories);

  const [product, renderUrl] = await Promise.all([
    options.ground === true
      ? groundSelectedShades({
          session,
          categories,
          selection: options.selection ?? {},
        })
      : Promise.resolve(null),
    findOpeningRender({
      ownerId: plan.ownerId,
      captureId: profile.capture_id,
      categories: lookForRender,
    }),
  ]);

  return {
    captureImageUrl: await signCapture(plan.ownerId, profile.capture_id),
    renderUrl,
    categories,
    product,
  };
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

export type SaveMakeupOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "no_profile" | "fixture_read_only";
    };

/**
 * "Save this look", docs/01-user-flow.md section H item 4.
 *
 * The shades are stored in the shape a render is created and hashed under
 * (migration 0013), which is what makes the next visit open on them and find the
 * try on they were rendered with instead of asking for another one.
 *
 * Written through the same schema the render route validates, so the column can
 * only ever hold categories this build knows and hexes it can draw.
 */
export async function saveMakeupLook(args: {
  readonly session: AppSession;
  readonly params: MakeupRenderParams;
}): Promise<SaveMakeupOutcome> {
  if (demoProfileIsReadOnly(args.session)) {
    // The same answer /hair gives: the checked in fixture has no database
    // behind it, and a judge session at zero analyses is reading the saved demo
    // profile, which is read only. Reporting a save that reached nothing would
    // be a confirmation of something that did not happen.
    return { ok: false, reason: "fixture_read_only" };
  }

  const existing = await getAestheticProfile(args.session.id);
  if (existing === null) {
    return { ok: false, reason: "no_profile" };
  }

  // Only the one column moves. version counts rebuilds of the reading and the
  // palette (build.ts), and choosing a lipstick changes neither.
  const row: Insert<"aesthetic_profiles"> = {
    user_id: args.session.id,
    saved_makeup: { categories: args.params.categories } as unknown as Json,
  };
  await upsertAestheticProfile(row);

  console.log(
    JSON.stringify({
      event: "aurum.makeup_look_saved",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      categories: args.params.categories.map((entry) => entry.category),
    }),
  );

  return { ok: true };
}
