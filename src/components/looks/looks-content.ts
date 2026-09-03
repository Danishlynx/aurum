/**
 * The deterministic decisions the looks screen makes about its own content.
 *
 * Pure functions only. No React, no I/O, no server import, so the screen's rules
 * can be read and tested without a renderer and without a key (the pattern set
 * by src/components/makeup/makeup-content.ts).
 *
 * Spec: docs/01-user-flow.md section K.
 *
 * Nothing here composes a look, ranks one, or writes a rationale. All of that
 * happens on the server, from src/lib/shared/looks.ts and the stylist layer, and
 * arrives as a LooksView. This module only decides how what arrived is drawn.
 */

import { copy, fill } from "@/lib/shared/copy";
import {
  shopTheGapLine,
  type LookGap,
  type LookItem,
  type LooksView,
  type LookView,
} from "@/lib/shared/looks-view";
import { garmentTypeLabel } from "@/lib/shared/wardrobe-view";

// ---------------------------------------------------------------------------
// The pieces in a look
// ---------------------------------------------------------------------------

export type GarmentLookItem = Extract<LookItem, { source: "garment" }>;
export type ListingLookItem = Extract<LookItem, { source: "listing" }>;

/**
 * The person's own pieces, which are what the flat lay is
 * (docs/01-user-flow.md section K item 2: "a flat lay of the garments (from the
 * person's wardrobe)").
 */
export function garmentItems(look: LookView): GarmentLookItem[] {
  return look.items.filter(
    (item): item is GarmentLookItem => item.source === "garment",
  );
}

/**
 * The pieces that are listings rather than clothes the person owns, which
 * happens when the look was composed from live listings (section K, "No
 * wardrobe").
 *
 * They are drawn as product cards rather than as flat lay tiles, so each one
 * carries its price, its store, its link, and the "not sponsored" line. A
 * thumbnail on its own would show a product without saying where it came from
 * or letting anyone buy it, and every piece the app puts in front of a person
 * has to be a real listing they can open
 * (docs/06-safety-privacy.md, "Grounding and honesty").
 */
export function listingItems(look: LookView): ListingLookItem[] {
  return look.items.filter(
    (item): item is ListingLookItem => item.source === "listing",
  );
}

/**
 * True when the person owns clothes and this occasion is wearing none of them.
 *
 * The rules engine composes from the wardrobe when it can and falls back to live
 * listings when it cannot (src/lib/server/looks/compose.ts, composeFromShop),
 * and that fallback runs for two different reasons: a wardrobe with nothing in
 * it, and a wardrobe that has nothing this occasion can use. The first has the
 * flow doc's own line and the "Add your clothes" control beside it. The second
 * had nothing at all: a person who had photographed six garments tapped "Formal
 * evening" and got a stack of product cards with no word about where their own
 * clothes had gone, which reads as the app ignoring the wardrobe it just asked
 * them to build.
 *
 * The view does not carry a "composed from listings" flag and does not need one:
 * a look built from the wardrobe has at least one garment item in it, so a
 * screen of looks with no garment anywhere is that state, read off the same data
 * the flat lay is drawn from.
 *
 * The line is copy.looks.noLooksForOccasion, which already says exactly this and
 * until now only appeared when there was no look at all. Both are the same fact
 * told to the person: this occasion is not dressed by what you own.
 */
export function showsNothingFitsLine(view: LooksView): boolean {
  if (view.wardrobeEmpty || view.looks.length === 0) {
    return false;
  }
  return view.looks.every((look) => garmentItems(look).length === 0);
}

/**
 * How many columns the flat lay lays its tiles out in.
 *
 * A look is two to four pieces, so the grid is chosen to keep the tiles square
 * and the block compact at 390px rather than to fill the width: four pieces read
 * best as a two by two square, three as a single row, and one or two as one row
 * of two so a single garment is never a full width photograph of a shirt.
 */
export function flatLayColumns(count: number): number {
  if (count >= 4) {
    return 2;
  }
  return Math.max(2, count);
}

/** The garment type in the words the chips use, lower cased for a sentence. */
function typeWord(type: string): string {
  return (garmentTypeLabel(type) ?? type).toLowerCase();
}

/** The garment type in the words the chips use, for a product card's name. */
export function typeLabel(type: string): string {
  return garmentTypeLabel(type) ?? type;
}

// ---------------------------------------------------------------------------
// Shop the gap
// ---------------------------------------------------------------------------

/**
 * The line above a gap's product cards.
 *
 * docs/01-user-flow.md section K item 3 writes it as "You do not own shoes yet.
 * These sit in your palette and are near you.", and drops the distance claim
 * when no listing in the gap carries one. Both halves of that live with the
 * view, in src/lib/shared/looks-view.ts, so the sentence has one owner; this is
 * only the screen's name for it.
 */
export function gapLine(gap: LookGap): string {
  return shopTheGapLine(gap);
}

/** What the empty product state names when a gap came back with no listing. */
export function gapProductType(gap: LookGap): string {
  return typeLabel(gap.type);
}

// ---------------------------------------------------------------------------
// The hero render
// ---------------------------------------------------------------------------

/**
 * The hero garment's type word, for the status line. Null when the look names no
 * hero, or when the hero is not among the items the view carries.
 */
export function heroGarmentWord(look: LookView): string | null {
  if (look.heroGarmentId === null) {
    return null;
  }
  const hero = garmentItems(look).find(
    (item) => item.garmentId === look.heroGarmentId,
  );
  return hero === undefined ? null : typeWord(hero.type);
}

/** "Applying the blazer", the pending line for a cloth try on. */
export function applyingLine(look: LookView): string | null {
  const word = heroGarmentWord(look);
  return word === null
    ? null
    : fill(copy.looks.applyingTemplate, { garment: word });
}

/** What the hero area of a look is showing right now. */
export type LookHero = {
  /** The render to draw, or null when there is nothing rendered. */
  readonly imageUrl: string | null;
  /** True while a new render is on its way and an older one is on screen. */
  readonly dimmed: boolean;
  /** "Applying the blazer", or null. */
  readonly statusLine: string | null;
  /** "Preview unavailable for this garment.", or null. */
  readonly unavailableLine: string | null;
  /** False when the area has nothing to say, so it is not drawn at all. */
  readonly visible: boolean;
};

export type LookHeroInput = {
  /** The render on hand for this look, from the view or from a try on. */
  readonly renderUrl: string | null;
  /** True while a cloth try on is in flight. */
  readonly pending: boolean;
  /** The line naming what is being applied, or null. */
  readonly pendingLine: string | null;
  /** True when the try on failed or could not be asked for. */
  readonly unavailable: boolean;
};

/**
 * The hero, docs/01-user-flow.md section K item 2 and its pending state: "the
 * flat lay shows first; the rendered hero arrives when the job completes."
 *
 * So a look with nothing rendered and nothing in flight draws no hero area at
 * all, which is different from /makeup and /hair: there the hero is the person's
 * own face and is always on screen, and here the flat lay is the content. The
 * pending and failed patterns are the same as those two screens (previous render
 * held at 70 percent with a status line under it, no spinner over the image, and
 * the documented unavailable line on failure).
 */
export function heroPresentation(input: LookHeroInput): LookHero {
  const imageUrl = input.unavailable ? null : input.renderUrl;
  const statusLine = input.pending ? input.pendingLine : null;
  const unavailableLine = input.unavailable
    ? copy.looks.previewUnavailable
    : null;

  return {
    imageUrl,
    dimmed: input.pending && imageUrl !== null,
    statusLine,
    unavailableLine,
    visible:
      imageUrl !== null || statusLine !== null || unavailableLine !== null,
  };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A stable React key for one piece of a look. */
export function itemKey(item: LookItem, index: number): string {
  return item.source === "garment"
    ? `garment-${item.garmentId}`
    : `listing-${index}-${item.listing.url}`;
}
