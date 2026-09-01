import type { ReactNode } from "react";

/**
 * Chip, per docs/02-design-system.md: Manrope 500 12, height 32, radius-sm,
 * Basalt fill, Umber hairline. Selected: gold hairline, Ivory text.
 *
 * The visible chip is 32 high, which is smaller than the 44px tap target
 * docs/06-safety-privacy.md requires. The pseudo element extends the hit area to
 * 44 without changing the drawn size or the row rhythm.
 */

type ChipProps = {
  readonly children: ReactNode;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
};

const BASE =
  "relative inline-flex h-8 items-center rounded-sm border bg-surface px-3 font-body text-micro font-medium before:absolute before:inset-x-0 before:-top-[6px] before:-bottom-[6px] before:content-['']";

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
