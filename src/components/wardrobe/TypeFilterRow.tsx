"use client";

import { Chip } from "@/components/ui/Chip";
import { copy } from "@/lib/shared/copy";
import type { GarmentType } from "@/lib/shared/wardrobe-view";

import { ALL_TYPES, typeFilterLabel, type TypeFilter } from "./wardrobe-content";

/**
 * The filter row, docs/01-user-flow.md section J item 3: "Grid of garment cards,
 * filterable by type."
 *
 * Plain chips, one selected at a time, the same control the occasion row on
 * /looks uses (docs/02-design-system.md, Chip: "Used for occasions, garment
 * attributes, concern toggles"). Selected takes the gold hairline, which is the
 * whole elevation system here.
 *
 * The row scrolls sideways instead of wrapping, so a wardrobe with eight kinds
 * of garment in it does not push the grid off the screen at 390px. The negative
 * inline margin lets it scroll to the edge of the screen while the first chip
 * still lines up with the column, which is the pattern the hair style row uses.
 */

type TypeFilterRowProps = {
  readonly options: readonly GarmentType[];
  readonly selected: TypeFilter;
  readonly onSelect: (filter: TypeFilter) => void;
};

export function TypeFilterRow({
  options,
  selected,
  onSelect,
}: TypeFilterRowProps) {
  const filters: TypeFilter[] = [ALL_TYPES, ...options];

  return (
    <div
      role="group"
      aria-label={copy.wardrobe.filterLabel}
      className="flex items-center gap-2 overflow-x-auto py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{
        marginInline: "calc(var(--column-padding) * -1)",
        paddingInline: "var(--column-padding)",
      }}
    >
      {filters.map((filter) => (
        <span key={filter} className="shrink-0">
          <Chip
            selected={filter === selected}
            onSelect={() => {
              onSelect(filter);
            }}
          >
            {typeFilterLabel(filter)}
          </Chip>
        </span>
      ))}
    </div>
  );
}
