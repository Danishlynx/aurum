import "server-only";

import type {
  MakeupCategory,
  MakeupCategoryView,
  MakeupView,
} from "@/lib/shared/color-view";
import type { ReportListing } from "@/lib/shared/report-view";

import { getCapture } from "../db";
import { BUCKETS, createSignedRead } from "../db/storage";
import { demoFixtureNote, planDemoRead } from "../judge/demo";
import { groundRoutineSteps } from "../products";
import type { AppSession } from "../session";
import { paletteForProfile } from "./color";
import { getAestheticProfile } from "./db";
import { DEMO_FIXTURE_MAKEUP_VIEW } from "./demo-fixture";
import { readGroundingContext } from "./report-view";
import { buildMakeupCategoryViews, selectedShade } from "./shades";

/**
 * Everything /makeup needs, in one object.
 *
 * docs/01-user-flow.md section H is the layout this fills: the selfie, four
 * shade rows with the middle swatch selected, and a product card per selected
 * shade.
 *
 * Two things this deliberately does not do:
 *
 * 1. It never returns a render. The hero image on /makeup is either a real try
 *    on from src/lib/server/renders or the unedited selfie with
 *    copy.makeup.previewUnavailable (docs/01 section H, "Try on failed"). There
 *    is no third image, and this file is not where one could appear.
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

  const categories = buildMakeupCategoryViews({
    palette: paletteForProfile(profile),
    skinToneHex: profile.skin_tone_hex,
  });

  const product =
    options.ground === true
      ? await groundSelectedShades({
          session,
          categories,
          selection: options.selection ?? {},
        })
      : null;

  return {
    captureImageUrl: await signCapture(plan.ownerId, profile.capture_id),
    categories,
    product,
  };
}
