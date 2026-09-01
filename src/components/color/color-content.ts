/**
 * The deterministic decisions the color screen makes about its own content.
 *
 * Pure functions and data only. No React, no I/O, no server import, so the same
 * module is safe inside the client components on this screen and can be unit
 * tested without a renderer (the pattern set by
 * src/components/report/report-content.ts).
 *
 * Spec: docs/01-user-flow.md section G.
 */

import { copy } from "@/lib/shared/copy";
import type { Undertone } from "@/lib/shared/palette";

/**
 * The label beside the wide tone swatch. docs/01 section G item 1 gives the
 * shape ("Warm undertone"); the three strings live in copy.color.
 *
 * With no undertone the swatch shows "Confirm your undertone", which is the
 * state docs/01 section G describes for a photo whose attributes failed.
 */
export function undertoneLabel(undertone: Undertone | null): string {
  switch (undertone) {
    case "warm":
      return copy.color.undertoneWarm;
    case "cool":
      return copy.color.undertoneCool;
    case "neutral":
      return copy.color.undertoneNeutral;
    default:
      return copy.color.confirmUndertone;
  }
}

/**
 * docs/01 section G states: "Undertone unknown (attributes failed): the top
 * swatch shows 'Confirm your undertone' and the adjuster opens automatically."
 */
export function adjusterOpensAutomatically(undertone: Undertone | null): boolean {
  return undertone === null;
}

/**
 * The search parameter that opens the undertone adjuster on arrival, and the
 * href that carries it.
 *
 * docs/01-user-flow.md section L item 1 gives the "Tone and undertone" row on
 * /profile an "Adjust" affordance, and section G item 2 puts the adjuster on
 * this screen. The two screens meet on this parameter rather than on a second
 * copy of the sheet, so there is still one place a person can change their
 * undertone.
 */
export const ADJUSTER_QUERY_PARAM = "adjust";
export const ADJUSTER_QUERY_VALUE = "undertone";
export const COLOR_ADJUSTER_HREF = `/color?${ADJUSTER_QUERY_PARAM}=${ADJUSTER_QUERY_VALUE}`;

/**
 * Whether the query asked for the adjuster. Tolerant on purpose: a missing
 * value, an unknown value, or a parameter a browser repeated leaves the sheet
 * closed, so nothing but the documented link can open it.
 */
export function adjusterRequestedByQuery(
  value: string | string[] | undefined,
): boolean {
  if (Array.isArray(value)) {
    return value.includes(ADJUSTER_QUERY_VALUE);
  }
  return value === ADJUSTER_QUERY_VALUE;
}

/** One choice in the undertone adjuster, docs/01 section G item 2. */
export type UndertoneOption = {
  readonly undertone: Undertone;
  readonly name: string;
  /** The one line test under the name. */
  readonly test: string;
};

/**
 * The three choices, in the order the doc lists them: Warm, Cool, Neutral, each
 * with its one line test.
 */
export const UNDERTONE_OPTIONS: readonly UndertoneOption[] = [
  {
    undertone: "warm",
    name: copy.color.adjusterWarm,
    test: copy.color.adjusterWarmTest,
  },
  {
    undertone: "cool",
    name: copy.color.adjusterCool,
    test: copy.color.adjusterCoolTest,
  },
  {
    undertone: "neutral",
    name: copy.color.adjusterNeutral,
    test: copy.color.adjusterNeutralTest,
  },
];

/**
 * How many swatches sit in one row of the "Colors to wear" grid at 390px with
 * 20px padding: three squares of about 103px with 12px gaps, each with room for
 * a plain name in Cormorant 24 under it.
 */
export const WEAR_SWATCHES_PER_ROW = 3;

/**
 * Splits the wear colors into rows.
 *
 * The grid is built row by row rather than as one CSS grid because tapping a
 * swatch opens its one line of why directly below its own row
 * (docs/02-design-system.md, Swatch: "below the row, not a tooltip"), which is
 * only expressible when the rows are real elements.
 */
export function chunkIntoRows<T>(
  items: readonly T[],
  perRow: number = WEAR_SWATCHES_PER_ROW,
): T[][] {
  const size = Math.max(1, Math.floor(perRow));
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

/** Where a color sits in the grid, or null when nothing is open. */
export type OpenSwatch = { readonly row: number; readonly column: number };

/** True when the open swatch, if any, belongs to this row. */
export function isRowOpen(open: OpenSwatch | null, row: number): boolean {
  return open !== null && open.row === row;
}

/** One row of the "What this decides" list, docs/01 section G item 6. */
export type DecidesRow = {
  readonly href: string;
  readonly label: string;
  readonly line: string;
};

export const DECIDES_ROWS: readonly DecidesRow[] = [
  { href: "/makeup", label: copy.nav.makeup, line: copy.color.decidesMakeup },
  { href: "/hair", label: copy.nav.hair, line: copy.color.decidesHair },
  { href: "/looks", label: copy.nav.looks, line: copy.color.decidesLooks },
];
