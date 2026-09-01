"use client";

import { Chip } from "@/components/ui/Chip";
import { Sheet } from "@/components/ui/Sheet";
import { copy } from "@/lib/shared/copy";
import type {
  GarmentFormality,
  GarmentPattern,
  GarmentType,
  GarmentView,
} from "@/lib/shared/wardrobe-view";

import {
  FORMALITY_OPTIONS,
  PATTERN_OPTIONS,
  TYPE_OPTIONS,
  type ChipOption,
} from "./wardrobe-content";

/**
 * The chip picker, docs/01-user-flow.md section J item 2: "Chips are tappable to
 * correct. One line: 'Tap a chip to correct it.'"
 *
 * A sheet rather than an inline editor, because docs/02-design-system.md gives
 * the sheet to exactly this job: a small set of choices that slides up over the
 * grid and leaves the card where it was. Each group is the vocabulary from
 * src/lib/shared/wardrobe-view.ts, so a chip can only ever set a word the grid
 * has a label for and the rules engine has a rule for.
 *
 * Tapping a chip saves that one field and leaves the sheet open, so a person who
 * came to fix a type and noticed the formality can fix both without reopening
 * it. The card behind redraws from the stored row that comes back, never from
 * what was asked for.
 *
 * Colour is not correctable here, and that is a deliberate gap rather than an
 * oversight. Type, pattern, and formality are closed vocabularies with three to
 * fifteen members, so a picker for them is a row of chips. A colour is a name
 * and a hex, and this app has no catalog of garment colours to offer: inventing
 * one in a component would put a colour name and a hex into the row, and from
 * there into a look and into a product query, on our word rather than on the
 * person's or the classifier's. Open item for the human: decide where a garment
 * colour vocabulary lives (the person's own palette is the obvious candidate),
 * then add the fourth group here.
 */

type GarmentPickerProps = {
  /** The garment being corrected, or null when the sheet is closed. */
  readonly garment: GarmentView | null;
  readonly onClose: () => void;
  readonly onPickType: (value: GarmentType) => void;
  readonly onPickPattern: (value: GarmentPattern) => void;
  readonly onPickFormality: (value: GarmentFormality) => void;
};

type GroupProps<TValue extends string> = {
  readonly heading: string;
  readonly options: readonly ChipOption<TValue>[];
  readonly selected: string | null;
  readonly onSelect: (value: TValue) => void;
};

function ChipGroup<TValue extends string>({
  heading,
  options,
  selected,
  onSelect,
}: GroupProps<TValue>) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="font-body text-small font-medium text-text-muted">
        {heading}
      </h3>
      <div role="group" aria-label={heading} className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Chip
            key={option.value}
            selected={option.value === selected}
            onSelect={() => {
              onSelect(option.value);
            }}
          >
            {option.label}
          </Chip>
        ))}
      </div>
    </section>
  );
}

export function GarmentPicker({
  garment,
  onClose,
  onPickType,
  onPickPattern,
  onPickFormality,
}: GarmentPickerProps) {
  return (
    <Sheet
      open={garment !== null}
      title={copy.wardrobe.correctSheetTitle}
      onClose={onClose}
    >
      <div className="flex flex-col gap-6">
        <p className="max-w-[64ch] font-body text-small text-text-muted">
          {copy.wardrobe.correctChipsHint}
        </p>

        <ChipGroup
          heading={copy.wardrobe.chipGroupType}
          options={TYPE_OPTIONS}
          selected={garment?.type ?? null}
          onSelect={onPickType}
        />

        <ChipGroup
          heading={copy.wardrobe.chipGroupPattern}
          options={PATTERN_OPTIONS}
          selected={garment?.pattern ?? null}
          onSelect={onPickPattern}
        />

        <ChipGroup
          heading={copy.wardrobe.chipGroupFormality}
          options={FORMALITY_OPTIONS}
          selected={garment?.formality ?? null}
          onSelect={onPickFormality}
        />
      </div>
    </Sheet>
  );
}
