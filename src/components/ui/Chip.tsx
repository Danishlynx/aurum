import type { ReactNode } from "react";

/**
 * Chip, per docs/02-design-system.md: Manrope 500 12, height 32, radius-sm,
 * Basalt fill, Umber hairline. Selected: gold hairline, Ivory text.
 *
 * The visible chip is 32 high, which is smaller than the 44px tap target
 * docs/06-safety-privacy.md requires. The pseudo element extends the hit area to
 * 44 without changing the drawn size or the row rhythm.
 *
 * It extends sideways as well, by half the 8px gap every chip row uses, because
 * a short label ("All", "Eye") draws a chip under 44 wide. Half the gap is the
 * most it can take without two neighbours claiming the same pixel, so no tap
 * lands on the chip beside the one under the finger.
 *
 * The offsets are one pixel larger than the extension they buy: an absolutely
 * positioned pseudo element is placed against the padding box, and the chip has
 * a 1px hairline, so -7 reaches 6px past the drawn edge and -5 reaches 4px. The
 * hit area is 44 high and 8 wider than the chip.
 */

type ChipProps = {
  readonly children: ReactNode;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
};

const BASE =
  "relative inline-flex h-8 items-center rounded-sm border bg-surface px-3 font-body text-micro font-medium before:absolute before:-left-[5px] before:-right-[5px] before:-top-[7px] before:-bottom-[7px] before:content-['']";

export function Chip({ children, selected = false, onSelect }: ChipProps) {
  const tone = selected
    ? "border-accent text-text"
    : "border-raised text-text-muted";

  if (onSelect === undefined) {
    return <span className={`${BASE} ${tone}`}>{children}</span>;
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`${BASE} ${tone}`}
    >
      {children}
    </button>
  );
}
