/**
 * The deterministic decisions the wardrobe screen makes about its own content.
 *
 * Pure functions only. No React, no I/O, no server import, so the screen's rules
 * can be read and tested without a renderer and without a key (the pattern set
 * by src/components/report/report-content.ts and
 * src/components/makeup/makeup-content.ts).
 *
 * Spec: docs/01-user-flow.md section J.
 *
 * Nothing here invents an attribute. Every label comes from the vocabularies in
 * src/lib/shared/wardrobe-view.ts, and a garment with a null attribute keeps its
 * null: the card then shows a skeleton pill or the failed line, which is the
 * honest state, rather than a guess in a chip.
 */

import { copy } from "@/lib/shared/copy";
import {
  FORMALITY,
  FORMALITY_LABELS,
  GARMENT_TYPES,
  GARMENT_TYPE_LABELS,
  PATTERNS,
  PATTERN_LABELS,
  garmentFormalityLabel,
  garmentPatternLabel,
  garmentTypeLabel,
  type GarmentColor,
  type GarmentFormality,
  type GarmentPattern,
  type GarmentType,
  type GarmentView,
} from "@/lib/shared/wardrobe-view";

// ---------------------------------------------------------------------------
// The type filter
// ---------------------------------------------------------------------------

/**
 * The chip that clears the filter. It is not a garment type, so it is a symbol
 * of its own rather than a member of the vocabulary.
 */
export const ALL_TYPES = "all";

export type TypeFilter = typeof ALL_TYPES | GarmentType;

/**
 * The types the filter row offers: the ones this wardrobe actually holds, in the
 * vocabulary's own order (top to bottom, then shoes, then accessories) so the
 * row reads the way a person dresses rather than the order photos were added.
 *
 * A type nobody owns is not offered, because a chip that can only ever produce
 * an empty grid is decoration.
 */
export function typeFilterOptions(
  garments: readonly GarmentView[],
): GarmentType[] {
  const present = new Set(
    garments
      .map((garment) => garment.type)
      .filter((type): type is string => type !== null),
  );
  return GARMENT_TYPES.filter((type) => present.has(type));
}

/**
 * True when the filter row is worth drawing. One type is not a filter, it is a
 * chip that does nothing, so the row appears only once there are two to choose
 * between (docs/02-design-system.md anti slop, "remove one thing").
 */
export function showsTypeFilter(garments: readonly GarmentView[]): boolean {
  return typeFilterOptions(garments).length > 1;
}

/** The garments a filter shows. ALL_TYPES shows every one of them. */
export function filterByType(
  garments: readonly GarmentView[],
  filter: TypeFilter,
): GarmentView[] {
  if (filter === ALL_TYPES) {
    return [...garments];
  }
  return garments.filter((garment) => garment.type === filter);
}

/** The label on a filter chip. */
export function typeFilterLabel(filter: TypeFilter): string {
  return filter === ALL_TYPES
    ? copy.wardrobe.filterAll
    : GARMENT_TYPE_LABELS[filter];
}

// ---------------------------------------------------------------------------
// The chips on a card
// ---------------------------------------------------------------------------

/**
 * What one card draws, docs/01-user-flow.md section J item 2: "the classification
 * chips filled in by the classifier: type ('Shirt'), color ('Navy'), pattern
 * ('Solid'), formality ('Smart')".
 *
 * A null label is a chip the card leaves out. It is never filled with a default:
 * a garment the classifier read as a shirt with no pattern recorded has no
 * pattern chip, and saying "Solid" there would be inventing an attribute that
 * would then travel into a look and into a product query.
 */
export type GarmentChips = {
  readonly type: string | null;
  readonly colors: readonly GarmentColor[];
  readonly pattern: string | null;
  readonly formality: string | null;
};

export function garmentChips(garment: GarmentView): GarmentChips {
  return {
    type: garmentTypeLabel(garment.type),
    colors: garment.colors,
    pattern: garmentPatternLabel(garment.pattern),
    formality: garmentFormalityLabel(garment.formality),
  };
}

/**
 * True when the card has at least one chip to show. A garment whose row carries
 * nothing the app can draw falls through to the failed card copy, which is what
 * asks the person to fill it in.
 */
export function hasAnyChip(chips: GarmentChips): boolean {
  return (
    chips.type !== null ||
    chips.colors.length > 0 ||
    chips.pattern !== null ||
    chips.formality !== null
  );
}

/**
 * What one card is showing, as the screen reads it.
 *
 * "pending" is the skeleton pill state and "failed" is the "Could not read this
 * one." card (docs/01 section J, "States"). "succeeded" with no chip at all is
 * read as failed on purpose: a card with an empty chip row says nothing, and the
 * failed line is the one that tells the person what to do about it.
 */
export type CardState = "pending" | "chips" | "failed";

export function cardState(garment: GarmentView): CardState {
  if (garment.classificationStatus === "pending") {
    return "pending";
  }
  if (garment.classificationStatus === "failed") {
    return "failed";
  }
  return hasAnyChip(garmentChips(garment)) ? "chips" : "failed";
}

/**
 * True when the screen shows "Tap a chip to correct it." (docs/01 section J item
 * 2). The line is about chips, so it appears only once there is a chip on the
 * screen to tap.
 */
export function showsCorrectHint(garments: readonly GarmentView[]): boolean {
  return garments.some((garment) => cardState(garment) === "chips");
}

/**
 * True when the screen offers "Suggest what to wear".
 *
 * The type is the whole condition, because the type is what the rules engine
 * places (src/lib/shared/looks.ts, slotOfType): a garment with no type cannot
 * enter a candidate, so a wardrobe of nothing but unread photos has no outfit in
 * it and the control would lead to the "nothing fits this occasion" line every
 * time. One typed garment is enough to ask the question, and the person can
 * always give a garment its type by tapping the chip.
 *
 * This is why the control appears as the classifications land rather than as the
 * photos do: docs/01-user-flow.md section J fills the chips in "one by one as
 * results arrive", and this follows them.
 */
export function showsSuggestAction(garments: readonly GarmentView[]): boolean {
  return garments.some((garment) => garment.type !== null);
}

// ---------------------------------------------------------------------------
// The correction sheet
// ---------------------------------------------------------------------------

export type ChipOption<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
};

/**
 * The three vocabularies as chip options, built from the exported arrays so a
 * word added to src/lib/shared/wardrobe-view.ts appears in the picker without a
 * second list being kept in step.
 */
export const TYPE_OPTIONS: readonly ChipOption<GarmentType>[] = GARMENT_TYPES.map(
  (value) => ({ value, label: GARMENT_TYPE_LABELS[value] }),
);

export const PATTERN_OPTIONS: readonly ChipOption<GarmentPattern>[] = PATTERNS.map(
  (value) => ({ value, label: PATTERN_LABELS[value] }),
);

export const FORMALITY_OPTIONS: readonly ChipOption<GarmentFormality>[] =
  FORMALITY.map((value) => ({ value, label: FORMALITY_LABELS[value] }));
