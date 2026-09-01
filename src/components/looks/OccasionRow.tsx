"use client";

import { forwardRef } from "react";

import { Chip } from "@/components/ui/Chip";
import { copy } from "@/lib/shared/copy";
import { OCCASIONS, occasionLabel, type Occasion } from "@/lib/shared/looks-view";

/**
 * The occasion chooser, docs/01-user-flow.md section K item 1: "a row of plain
 * chips: 'Interview', 'Wedding guest', 'Date', 'Festival', 'Everyday', 'Formal
 * evening'. One selected at a time."
 *
 * Plain chips from docs/02-design-system.md, selected taking the gold hairline.
 * The six words and their order come from src/lib/shared/looks-view.ts, which
 * takes them from the rules engine, so the chips and the occasion to formality
 * table can never drift apart.
 *
 * The row wraps rather than scrolling sideways, which is the opposite of the
 * wardrobe's type filter and of the hair style row. The reason is that this is a
 * chooser with a fixed set of six: the person has to see every occasion to pick
 * one, and the selected chip has to be on screen when the page opens. Six chips
 * take two lines at 390px, and a scrolling row would open with "Everyday"
 * selected and off the right edge.
 *
 * The ref is here for "Try another occasion", which scrolls this row back into
 * view and moves focus to it, so the quiet button at the bottom of a long screen
 * lands the person on the control it names.
 */

type OccasionRowProps = {
  readonly selected: Occasion;
  readonly onSelect: (occasion: Occasion) => void;
};

export const OccasionRow = forwardRef<HTMLDivElement, OccasionRowProps>(
  function OccasionRow({ selected, onSelect }, ref) {
    return (
      <div
        ref={ref}
        role="group"
        tabIndex={-1}
        aria-label={copy.looks.occasionsLabel}
        className="flex flex-wrap items-center gap-x-2 gap-y-3 py-1.5"
      >
        {OCCASIONS.map((occasion) => (
          <Chip
            key={occasion}
            selected={occasion === selected}
            onSelect={() => {
              onSelect(occasion);
            }}
          >
            {occasionLabel(occasion)}
          </Chip>
        ))}
      </div>
    );
  },
);
