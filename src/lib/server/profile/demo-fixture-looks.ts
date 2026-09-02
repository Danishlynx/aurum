import "server-only";

import {
  composeCandidates,
  OCCASIONS,
  type Candidate,
  type Occasion,
} from "@/lib/shared/looks";
import {
  GAP_LISTING_COUNT,
  type LookGap,
  type LookItem,
  type LookView,
  type LooksView,
} from "@/lib/shared/looks-view";
import type { ReportListing } from "@/lib/shared/report-view";
import type { GarmentView } from "@/lib/shared/wardrobe-view";

import { gapQueryFor, paletteColorFor } from "../looks/gaps";
import { buildRulesRationale } from "../looks/rationale";
import { DEMO_FIXTURE_PALETTE } from "./demo-fixture";
import { DEMO_FIXTURE_WARDROBE } from "./demo-fixture-wardrobe";
import { recordedListingsFor } from "./recorded-listings";

/**
 * The looks the app serves when AURUM_DEMO_FIXTURE is "true".
 *
 * Why it exists: there is no Supabase project and no provider key yet, so
 * /looks has to be buildable, viewable, and screenshotable from checked in data
 * alone. With the switch on, buildLooksView returns this and touches neither
 * the database nor a provider.
 *
 * Nothing here is written out by hand. Every look is composed from
 * DEMO_FIXTURE_WARDROBE and DEMO_FIXTURE_PALETTE by the real composeCandidates,
 * and every rationale is written by the real buildRulesRationale, for the same
 * reason DEMO_FIXTURE_PALETTE is derived rather than typed: a fixture and the
 * code it stands for must not be able to drift. A change to the rules table or
 * to the rationale changes this screen too, and src/lib/shared/looks.test.ts
 * sees the same composition the demo does.
 *
 * docs/07-payments-and-judge-mode.md says the demo profile carries "two saved
 * looks for 'Wedding guest' and 'Interview'". Those are the first look of each
 * of those two occasions, which is exactly where a saved look sits in a live
 * read (src/lib/server/looks/compose.ts orders saved looks first). LookView
 * carries no saved flag, so leading its occasion is what saved means here.
 *
 * Three absences, all honesty rather than omission:
 *
 * 1. Every renderUrl is null and every status is "none". Nothing has been
 *    rendered: there is no Perfect Corp key, and no fixture face is checked in
 *    to render on (evals/fixtures/README.md). A stand in image would be a made
 *    up try on.
 * 2. rationaleSource is "rules" on every look, because the rules wrote them.
 *    No ANTHROPIC_API_KEY exists, so no stylist has ever ranked these.
 * 3. A gap only carries listings when a response was recorded for its own
 *    query. The recording run covered the shop the gap queries of the saved
 *    occasions (docs/SUBMISSION-RUNBOOK.md, section A14), so those cards show
 *    real products and the rest show "No listing found near you yet", which is
 *    true of them: a listing is only ever shown when a real one came back
 *    (docs/06-safety-privacy.md, "Grounding and honesty").
 */

/**
 * The query one gap is shopped for.
 *
 * Built by the same gapQueryFor and paletteColorFor the live screen calls
 * (src/lib/server/looks/gaps.ts), over the same palette and the same rotation
 * by position, which is also how scripts/record-serpapi.ts decided what to
 * record. The fixture and the recording therefore agree by construction: change
 * the palette or the query grammar and the gap stops matching a recording and
 * honestly falls back to the empty state, rather than showing a product that
 * was found for a different question.
 */
function gapQuery(
  occasion: Occasion,
  type: string,
  index: number,
): string | null {
  return gapQueryFor({
    colorName: paletteColorFor(DEMO_FIXTURE_PALETTE, index),
    garmentType: type,
    occasion,
  });
}

/**
 * The listings for one gap query, through the real normalizer and the real
 * ranker (./recorded-listings). Empty when nothing was recorded for it, which
 * is the honest state and the one the screen already has copy for.
 */
export function fixtureGapListings(query: string | null): ReportListing[] {
  if (query === null) {
    return [];
  }
  return recordedListingsFor(query, GAP_LISTING_COUNT);
}

const GARMENTS_BY_ID: ReadonlyMap<string, GarmentView> = new Map(
  DEMO_FIXTURE_WARDROBE.garments.map((garment) => [garment.id, garment] as const),
);

function itemsOf(candidate: Candidate): LookItem[] {
  const items: LookItem[] = [];
  for (const id of candidate.garmentIds) {
    const garment = GARMENTS_BY_ID.get(id);
    if (garment === undefined || garment.type === null) {
      continue;
    }
    items.push({
      source: "garment",
      garmentId: garment.id,
      imageUrl: garment.imageUrl,
      type: garment.type,
    });
  }
  return items;
}

function gapsOf(candidate: Candidate, occasion: Occasion): LookGap[] {
  return candidate.gaps.map((type, index) => ({
    type,
    listings: fixtureGapListings(gapQuery(occasion, type, index)),
  }));
}

function looksFor(occasion: Occasion): LookView[] {
  const candidates = composeCandidates({
    garments: DEMO_FIXTURE_WARDROBE.garments,
    palette: DEMO_FIXTURE_PALETTE,
    occasion,
  });

  const looks: LookView[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const items = itemsOf(candidate);
    if (items.length === 0) {
      continue;
    }
    looks.push({
      id: `fixture-look-${occasion}-${index + 1}`,
      occasion,
      rationale: buildRulesRationale({
        occasion,
        palette: DEMO_FIXTURE_PALETTE,
        garments: candidate.garmentIds
          .map((id) => GARMENTS_BY_ID.get(id))
          .filter((garment): garment is GarmentView => garment !== undefined),
        ruleNotes: candidate.ruleNotes,
        gaps: candidate.gaps,
      }),
      rationaleSource: "rules",
      items,
      heroGarmentId: candidate.heroGarmentId,
      renderUrl: null,
      renderStatus: "none",
      gaps: gapsOf(candidate, occasion),
    });
  }
  return looks;
}

/**
 * The fixture /looks screen, one entry per occasion.
 *
 * Frozen, because it is module level state that several requests read and
 * nothing is allowed to mutate it.
 */
export const DEMO_FIXTURE_LOOKS: Readonly<Record<Occasion, LooksView>> =
  Object.freeze(
    Object.fromEntries(
      OCCASIONS.map((occasion) => [
        occasion,
        Object.freeze({
          occasion,
          looks: looksFor(occasion),
          // The demo profile owns six garments, so the "No wardrobe" line never
          // shows on it. An occasion its wardrobe cannot dress comes back with
          // no looks, which is the state the screen words separately.
          wardrobeEmpty: false,
        }) as LooksView,
      ]),
    ) as Record<Occasion, LooksView>,
  );

/**
 * The two occasions docs/07-payments-and-judge-mode.md names as the demo
 * profile's saved looks. Their first look is the saved one.
 */
export const DEMO_FIXTURE_SAVED_OCCASIONS: readonly Occasion[] = [
  "wedding_guest",
  "interview",
];

export function demoFixtureLooksView(occasion: Occasion): LooksView {
  return DEMO_FIXTURE_LOOKS[occasion];
}
