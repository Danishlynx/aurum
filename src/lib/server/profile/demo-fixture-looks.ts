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

import { buildRulesRationale } from "../looks/rationale";
import { normalizeShoppingResponse } from "../products/normalize";
import { DEMO_FIXTURE_PALETTE } from "./demo-fixture";
import { DEMO_FIXTURE_WARDROBE } from "./demo-fixture-wardrobe";

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
 * 3. Every gap is listed with an empty listings array while
 *    RECORDED_GAP_RESPONSES is empty. See the note there: a listing is only
 *    ever shown when a real one came back (docs/06-safety-privacy.md,
 *    "Grounding and honesty"), and the recorded responses in the repository
 *    today are hand written stand ins rather than real recordings.
 */

/**
 * A recorded google_shopping response for one gap, as
 * docs/07-payments-and-judge-mode.md asks for: "Product listings for the demo
 * are recorded responses so they never depend on live quota."
 *
 * EMPTY ON PURPOSE, and this is the one thing about this file that is waiting on
 * a person rather than on code. The only shopping responses in the repository
 * are hand written to the documented shape (evals/fixtures/listings/README.md
 * says so in writing, and evals/fixtures/garments/gap-listing-injected.json
 * repeats it). Serving one of them here would put a price, a store, and a "View
 * listing" link in front of a judge for a product that does not exist, which is
 * the one thing the grounding rule forbids. So the demo shows the gap and the
 * "No listing found near you yet" state, which is true.
 *
 * TODO for the human, the day a SERPAPI_API_KEY exists: run one search per gap
 * below, strip the response as evals/fixtures/listings/README.md describes, and
 * paste each one in here with its query. Nothing else changes: the entries are
 * read through normalizeShoppingResponse, the same function the live screen
 * uses, so what the demo shows is what the ranking actually picks.
 */
interface RecordedGapResponse {
  /** The garment type word the rules engine reports as missing. */
  readonly type: string;
  /** The query the response was recorded for. */
  readonly query: string;
  /** The provider response body, exactly as it came back. */
  readonly body: unknown;
}

const RECORDED_GAP_RESPONSES: readonly RecordedGapResponse[] = [];

/**
 * The listings for one gap, through the real normalizer.
 *
 * Empty until a real response is recorded, which is the honest state and the
 * one the screen already has copy for.
 */
export function fixtureGapListings(type: string): ReportListing[] {
  const recorded = RECORDED_GAP_RESPONSES.find((entry) => entry.type === type);
  if (recorded === undefined) {
    return [];
  }
  const outcome = normalizeShoppingResponse(recorded.body, recorded.query);
  return outcome.listings.slice(0, GAP_LISTING_COUNT).map((listing) => ({
    ...listing,
    // No local search has been run for the fixture, so no distance is claimed.
    distanceText: null,
  }));
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

function gapsOf(candidate: Candidate): LookGap[] {
  return candidate.gaps.map((type) => ({
    type,
    listings: fixtureGapListings(type),
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
      gaps: gapsOf(candidate),
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
