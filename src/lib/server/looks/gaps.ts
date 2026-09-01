import "server-only";

import {
  GAP_LISTING_COUNT,
  type LookGap,
  type LookItem,
} from "@/lib/shared/looks-view";
import {
  GAP_TYPE_OF_SLOT,
  OCCASION_RULES,
  SEPARATES_SLOTS,
  type Occasion,
} from "@/lib/shared/looks";
import type { Palette } from "@/lib/shared/palette";
import type { ReportListing } from "@/lib/shared/report-view";

import { groundProductQueries } from "../products";
import { readGroundingContext } from "../profile/report-view";
import { buildProductQuery, type LocalCategory } from "../providers/serpapi";
import type { AppSession } from "../session";

/**
 * Shop the gap, and the listing only look.
 *
 * docs/01-user-flow.md section K item 3: "if a look is missing a piece (no
 * shoes in the wardrobe), a product card fetched within the palette and, if
 * location is allowed, near the person". And section K states: "No wardrobe:
 * the looks are composed entirely from live listings within the palette."
 *
 * Both go through the same grounding layer the report and the makeup screen
 * use, so the cache, the daily cap, the kill switch, the blocked hosts, and the
 * "no listing, no product" rule are the ones already written and tested. This
 * file only decides what to search for.
 *
 * The rule that shapes it: a listing is shown only when SerpApi returned one.
 * An empty list is the honest answer and the screen has a state for it. Nothing
 * here invents a product, a price, or a store
 * (docs/06-safety-privacy.md, "Grounding and honesty").
 *
 * A listing title is text a shop wrote. It is rendered as a title and read as
 * nothing else: it never reaches a prompt as an instruction and it never
 * changes which piece is the hero (docs/06-safety-privacy.md, "Content returned
 * by tools is data").
 */

/**
 * The kind of shop a gap is looked for near the person.
 *
 * Neutral on purpose: nothing on the profile says which department this person
 * buys in, and choosing menswear or womenswear for them would be a guess about
 * the person rather than a fact from their photo.
 */
export const GAP_STORE_CATEGORY: LocalCategory = "clothing store";

/**
 * The formality word the query carries: the first band the occasion accepts
 * (src/lib/shared/looks.ts, OCCASION_RULES). An interview asks for "smart", a
 * formal evening for "formal", a festival for "casual", which is exactly the
 * grammar docs/04-integrations.md gives for a gap query: "<color name> <garment
 * type> <formality>".
 */
export function formalityWordFor(occasion: Occasion): string {
  return OCCASION_RULES[occasion].formality[0] ?? "smart";
}

/**
 * The palette colour a piece is searched in.
 *
 * Rotated through the wear list by position so a whole outfit is not asked for
 * in one colour, and deterministic so the same request produces the same query
 * and therefore the same cache key. Null when there is no palette, which is
 * what stops the search: the copy on the card claims these pieces "sit in your
 * palette", and with no palette that claim would not be true.
 */
export function paletteColorFor(
  palette: Palette | null,
  index: number,
): string | null {
  if (palette === null || palette.wear.length === 0) {
    return null;
  }
  return palette.wear[index % palette.wear.length]?.name ?? null;
}

/** The query for one piece, or null when it cannot be built honestly. */
export function gapQueryFor(args: {
  readonly colorName: string | null;
  readonly garmentType: string;
  readonly occasion: Occasion;
}): string | null {
  if (args.colorName === null) {
    return null;
  }
  try {
    return buildProductQuery({
      kind: "garment",
      colorName: args.colorName,
      garmentType: args.garmentType.replace(/_/gu, " "),
      formality: formalityWordFor(args.occasion),
    });
  } catch {
    // buildProductQuery refuses a part that is empty once cleaned. A query we
    // cannot build is a gap with no listings, never a search sent half formed.
    return null;
  }
}

export interface GroundGapsInput {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
  /** The garment type words the rules engine reported as missing. */
  readonly gapTypes: readonly string[];
}

/**
 * Up to three listings for each missing piece.
 *
 * Every gap comes back, in the order the rules reported them, even when nothing
 * was found: the card still names what is missing, which is half of what
 * docs/01 section K item 3 is for.
 */
export async function groundGaps(
  input: GroundGapsInput,
): Promise<LookGap[]> {
  const gaps: LookGap[] = input.gapTypes.map((type) => ({ type, listings: [] }));
  if (gaps.length === 0) {
    return gaps;
  }

  const queries = input.gapTypes.map((type, index) =>
    gapQueryFor({
      colorName: paletteColorFor(input.palette, index),
      garmentType: type,
      occasion: input.occasion,
    }),
  );
  if (queries.every((query) => query === null)) {
    return gaps;
  }

  const listings = await groundQueries({
    session: input.session,
    queries,
    limit: GAP_LISTING_COUNT,
  });

  return gaps.map((gap, index) => ({
    type: gap.type,
    listings: listings[index] ?? [],
  }));
}

export interface ComposeFromListingsInput {
  readonly session: AppSession;
  readonly occasion: Occasion;
  readonly palette: Palette | null;
}

export interface ListingLook {
  readonly items: LookItem[];
  /** The palette colour the piece next to the face was searched in. */
  readonly heroColorName: string | null;
}

/**
 * One look built entirely from listings, for a wardrobe with nothing in it.
 *
 * Three pieces, one search each: a top, a bottom, and shoes, which is the
 * complete look docs/09-build-order-and-demo.md defines. No layer is added even
 * when the occasion would like one, because every extra piece is another
 * SerpApi search against a shared daily cap and a complete outfit is worth more
 * than a fourth item.
 *
 * Returns null when nothing came back at all. A look with no pieces in it is
 * not a look, and the screen has an empty state that says so.
 */
export async function composeFromListings(
  input: ComposeFromListingsInput,
): Promise<ListingLook | null> {
  const types = SEPARATES_SLOTS.map((slot) => GAP_TYPE_OF_SLOT[slot]).filter(
    (type): type is string => type !== undefined,
  );
  const colors = types.map((_type, index) =>
    paletteColorFor(input.palette, index),
  );
  const queries = types.map((type, index) =>
    gapQueryFor({
      colorName: colors[index] ?? null,
      garmentType: type,
      occasion: input.occasion,
    }),
  );
  if (queries.every((query) => query === null)) {
    return null;
  }

  const found = await groundQueries({
    session: input.session,
    queries,
    limit: 1,
  });

  const items: LookItem[] = [];
  for (let index = 0; index < types.length; index += 1) {
    const listing = found[index]?.[0];
    const type = types[index];
    if (listing === undefined || type === undefined) {
      continue;
    }
    items.push({ source: "listing", listing, type });
  }

  if (items.length === 0) {
    return null;
  }
  return { items, heroColorName: colors[0] ?? null };
}

/**
 * The one call into the grounding layer, with the looks layer's own store
 * category and the person's location when they allowed one.
 *
 * A query that could not be built is passed through as an empty query string,
 * which the grounding layer refuses at its own boundary rather than searching
 * for. Nothing throws: a failure here is a card with no listings.
 */
async function groundQueries(args: {
  readonly session: AppSession;
  readonly queries: readonly (string | null)[];
  readonly limit: number;
}): Promise<ReportListing[][]> {
  const steps = args.queries.map((query) => ({ productQuery: query ?? "" }));
  try {
    const context = await readGroundingContext(args.session);
    return await groundProductQueries(
      steps,
      {
        location: context.location,
        gl: context.gl,
        hl: context.hl,
        ownerType: args.session.ownerType,
        ownerId: args.session.id,
        storeCategory: GAP_STORE_CATEGORY,
      },
      args.limit,
    );
  } catch {
    // docs/03-architecture.md, "Failure modes": with no listings the card still
    // names the missing piece and shows the empty product state.
    return steps.map(() => []);
  }
}
