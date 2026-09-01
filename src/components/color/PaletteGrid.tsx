"use client";

import { useState } from "react";

import { Swatch } from "@/components/ui/Swatch";
import { copy } from "@/lib/shared/copy";
import type { PaletteColor } from "@/lib/shared/palette";

import {
  chunkIntoRows,
  WEAR_SWATCHES_PER_ROW,
  type OpenSwatch,
} from "./color-content";

/**
 * "Colors to wear", docs/01-user-flow.md section G item 4: a grid of named
 * swatches, 8 to 12 of them, each with a plain name and, on tap, one line of
 * why.
 *
 * docs/02-design-system.md, Swatch: "Tapping opens one line of why below the
 * row, not a tooltip." That is why the grid is built as real rows: the line
 * belongs under the row the tapped swatch sits in, and it pushes the rows below
 * it down rather than floating over them. Tapping the open swatch again closes
 * the line, so nothing on the screen is stuck open.
 *
 * The colors are data from src/lib/shared/palette.ts, derived from the person's
 * own tone. Nothing here decides a color, a name, or a reason.
 */

type PaletteGridProps = {
  readonly colors: readonly PaletteColor[];
};

export function PaletteGrid({ colors }: PaletteGridProps) {
  const [open, setOpen] = useState<OpenSwatch | null>(null);

  if (colors.length === 0) {
    return null;
  }

  const rows = chunkIntoRows(colors, WEAR_SWATCHES_PER_ROW);

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.color.wearHeading}
      </h2>

      <div className="flex flex-col gap-6">
        {rows.map((row, rowIndex) => {
          const openInRow =
            open !== null && open.row === rowIndex ? open.column : null;
          const openColor = openInRow === null ? null : row[openInRow] ?? null;
          const whyId = `wear-why-${rowIndex}`;

          return (
            <div key={`wear-row-${rowIndex}`} className="flex flex-col gap-3">
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns: `repeat(${WEAR_SWATCHES_PER_ROW}, minmax(0, 1fr))`,
                }}
              >
                {row.map((color, columnIndex) => {
                  const isOpen = openInRow === columnIndex;
                  return (
                    <Swatch
                      key={`wear-${rowIndex}-${columnIndex}`}
                      hex={color.hex}
                      name={color.name}
                      size="palette"
                      expands
                      selected={isOpen}
                      controls={whyId}
                      onSelect={() => {
                        setOpen(
                          isOpen ? null : { row: rowIndex, column: columnIndex },
                        );
                      }}
                    />
                  );
                })}
              </div>

              {openColor === null ? null : (
                <p
                  id={whyId}
                  className="max-w-[70ch] font-body text-small text-text-muted"
                >
                  {openColor.why}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
