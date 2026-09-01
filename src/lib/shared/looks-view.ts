/**
 * The shape /looks reads, and the request bodies it posts.
 *
 * One object per screen, built on the server, consumed by a server component or
 * fetched by the client. Nothing here does I/O, imports a provider, or touches
 * the database. It is the Layer 4 twin of src/lib/shared/hair-view.ts.
 *
 * Spec: docs/01-user-flow.md section K (layout and states),
 * docs/03-architecture.md (the looks table, "Claude API error": the stylist
 * falls back to the rules with a rule based rationale),
 * docs/04-integrations.md (the stylist output schema, cloth try on takes one
 * garment_category per call), docs/07-payments-and-judge-mode.md (the demo
 * profile carries two saved looks).
 *
 * Rules the types themselves carry:
 * - A look item is either a garment the person owns or a real listing. There is
 *   no third member, so a look can never hold an invented piece
 *   (docs/06-safety-privacy.md, "Grounding and honesty").
 * - A gap carries listings, plural and possibly empty. Empty is the honest
 *   state when nothing came back from SerpApi, and the card shows the "No
 *   listing found near you yet" line rather than a made up product.
 * - rationale is always a sentence, and rationaleSource says who wrote it. A
 *   rules rationale is never reported as the model's.
 * - renderUrl is a string or null. There is no substitute image: with no
 *   provider key the card shows the flat lay alone (docs/01 section K, "Try on
 *   pending").
 */

import { z } from "zod";

import { copy, fill } from "./copy";
import { OCCASIONS, type Occasion } from "./looks";
import type { ReportListing } from "./report-view";
import { garmentTypeLabel } from "./wardrobe-view";

// ---------------------------------------------------------------------------
// The occasions
// ---------------------------------------------------------------------------

/*
 * The six occasions are declared in src/lib/shared/looks.ts, because that is
 * what the occasion to formality table is keyed by, and re exported here so a
 * screen imports one module rather than two. One declaration, one union: the
 * assertion below fails to compile if the two ever drift.
 */
export { OCCASIONS } from "./looks";
export type { Occasion } from "./looks";

type ContractOccasion =
  | "interview"
  | "wedding_guest"
  | "date"
  | "festival"
  | "everyday"
  | "formal_evening";

type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Compile time only. Reading it is how the check is kept alive. */
export const OCCASION_UNION_MATCHES_CONTRACT: AssertSame<
  Occasion,
  ContractOccasion
> = true;

const OCCASION_SET: ReadonlySet<string> = new Set<string>(OCCASIONS);

export function isOccasion(value: string): value is Occasion {
  return OCCASION_SET.has(value);
}

/**
 * The chip the person taps, docs/01-user-flow.md section K item 1. Keyed by the
 * union so a new occasion is a compile error rather than a chip with no label.
 */
export const OCCASION_LABELS: Readonly<Record<Occasion, string>> = {
  interview: copy.looks.occasionInterview,
  wedding_guest: copy.looks.occasionWeddingGuest,
  date: copy.looks.occasionDate,
  festival: copy.looks.occasionFestival,
  everyday: copy.looks.occasionEveryday,
  formal_evening: copy.looks.occasionFormalEvening,
};

export function occasionLabel(occasion: Occasion): string {
  return OCCASION_LABELS[occasion];
}

/**
 * The occasion named inside a sentence, which is not the chip label: a chip
 * says "Wedding guest" and a rationale says "a wedding". Both are read by a
 * person, so both live in copy.ts.
 */
export const OCCASION_PHRASES: Readonly<Record<Occasion, string>> = {
  interview: copy.looks.rationale.phraseInterview,
  wedding_guest: copy.looks.rationale.phraseWeddingGuest,
  date: copy.looks.rationale.phraseDate,
  festival: copy.looks.rationale.phraseFestival,
  everyday: copy.looks.rationale.phraseEveryday,
  formal_evening: copy.looks.rationale.phraseFormalEvening,
};

/**
 * The occasion the screen opens on when the query string carries none.
 * "Everyday" is the honest default: it is the one occasion everybody has.
 */
export const DEFAULT_OCCASION: Occasion = "everyday";

/**
 * GET /api/looks?occasion=<Occasion>
 *
 * An absent or unknown occasion reads as the default rather than as an error,
 * because a chip row with nothing selected is not a state docs/01 section K has.
 */
export const OCCASION_QUERY_PARAM = "occasion";

export const looksViewQuerySchema = z.object({
  occasion: z
    .string()
    .nullish()
    .transform((value) =>
      value !== null && value !== undefined && isOccasion(value)
        ? value
        : DEFAULT_OCCASION,
    ),
});

export type LooksViewQuery = z.infer<typeof looksViewQuerySchema>;

// ---------------------------------------------------------------------------
// GET /api/looks
// ---------------------------------------------------------------------------

/**
 * One piece in a look: a garment the person owns, or a listing standing in for
 * a piece they do not own yet (docs/01 section K, "No wardrobe").
 *
 * type is the garment type word, so the flat lay can label a piece without
 * looking anything up, and a listing item can say what it is standing in for.
 */
export type LookItem =
  | {
      source: "garment";
      garmentId: string;
      /** Short lived signed read of the garment photo, or null when it is gone. */
      imageUrl: string | null;
      type: string;
    }
  | { source: "listing"; listing: ReportListing; type: string };

/**
 * A missing piece and what to buy for it, docs/01 section K item 3.
 *
 * listings may be empty: no listing, no product. The screen then shows the
 * empty product state, never an invented one.
 */
export type LookGap = { type: string; listings: ReportListing[] };

/** Where the hero garment's cloth try on stands. Same states as /hair. */
export type LookRenderStatus = "none" | "pending" | "succeeded" | "failed";

export type LookView = {
  id: string;
  occasion: Occasion;
  /** Two sentences from the stylist, or one to two from the rules. */
  rationale: string;
  /** "rules" means the deterministic fallback wrote it, never a model. */
  rationaleSource: "model" | "rules";
  items: LookItem[];
  /**
   * The garment cloth try on renders on the person. Null when the look has no
   * garment next to the face, which is every look built from listings alone.
   */
  heroGarmentId: string | null;
  renderUrl: string | null;
  renderStatus: "none" | "pending" | "succeeded" | "failed";
  gaps: LookGap[];
};

export type LooksView = {
  occasion: Occasion;
  looks: LookView[];
  /**
   * True when the person owns no garments at all, which is the state whose line
   * is copy.looks.noWardrobe. Looks are also composed from listings when the
   * wardrobe holds nothing this occasion can use, and that is not this flag: a
   * person with six casual garments and a formal evening ahead has a wardrobe.
   */
  wardrobeEmpty: boolean;
};

/**
 * How many listings a gap offers. Three is the number in
 * src/lib/server/products/search.ts ("One is shown per routine step and three
 * for shop the gap"), which is what the shopping pool was sized for.
 */
export const GAP_LISTING_COUNT = 3;

/**
 * "You do not own shoes yet. These sit in your palette and are near you."
 * (docs/01-user-flow.md section K item 3.)
 *
 * The doc's sentence ends in a claim about distance, and docs/01 section K
 * states drop that claim when location was not allowed ("cards drop the
 * distance and say 'Online listing'"). So the line follows the listings: it
 * says "near you" only when at least one of them actually carries a distance.
 *
 * The garment type is written in the words the chips use, lower cased inside
 * the sentence, and an unknown type falls back to the stored word so the line
 * is never rendered with a blank in it.
 */
export function shopTheGapLine(gap: LookGap): string {
  const label = garmentTypeLabel(gap.type);
  const garmentType = (label ?? gap.type).toLowerCase();
  const nearby = gap.listings.some((listing) => listing.distanceText !== null);
  return fill(
    nearby ? copy.looks.shopTheGapTemplate : copy.looks.shopTheGapOnlineTemplate,
    { garmentType },
  );
}

// ---------------------------------------------------------------------------
// POST /api/renders, the cloth kind
// ---------------------------------------------------------------------------

/**
 * One cloth try on: one garment the person owns, on their own capture.
 *
 * docs/04-integrations.md: "Cloth try on takes one garment_category per call
 * (full_body, upper body, or lower body). A multi garment outfit needs one call
 * per garment, so a Look renders as a sequence of renders, not as one call."
 * Layer 4 renders the hero garment only and shows the rest as a flat lay, which
 * is the fallback docs/09-build-order-and-demo.md names for exactly this.
 *
 * The garment id is a uuid on the person's own row. The server checks it is
 * theirs before anything is uploaded; this is only the shape check at the
 * boundary.
 */
export const clothRenderParamsSchema = z.object({
  garmentId: z.uuid(),
});

export type ClothRenderParams = z.infer<typeof clothRenderParamsSchema>;

export const clothRenderRequestSchema = z.object({
  kind: z.literal("cloth"),
  params: clothRenderParamsSchema,
});

// ---------------------------------------------------------------------------
// POST /api/looks/[id]/save
// ---------------------------------------------------------------------------

/**
 * "Save this look", docs/01-user-flow.md section K item 4. There is nothing to
 * read back: the screen re reads the view, where a saved look leads its
 * occasion.
 */
export type LookSaveResponse = { ok: true };
