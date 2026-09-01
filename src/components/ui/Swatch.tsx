import type { ReactNode } from "react";

/**
 * Swatch, per docs/02-design-system.md "Components":
 *
 *   "a square of the color with a 1px Umber hairline, name below in Cormorant 24
 *   for palette swatches or Manrope 14 for shade rows. Selected: Champagne ring
 *   2px. Tapping opens one line of why below the row, not a tooltip."
 *
 * The color itself is the only value on any screen that is not a design token.
 * A palette color is data: it comes from src/lib/shared/palette.ts, which derives
 * it from the person's own tone, so it cannot be a token and cannot be written by
 * hand into a component. It is applied through an inline style, and only after
 * isHexColor has agreed that the string is a hex color and nothing else, so a
 * value arriving from anywhere but the palette can paint a square and can never
 * become a second CSS declaration.
 *
 * The ring is drawn as an outline on the square, not as a box shadow: elevation
 * is off in this system, and an outline on the square leaves the gold focus
 * hairline on the button itself visible at the same time.
 */

/** A 3, 4, 6, or 8 digit hex color. Anything else is not painted. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value.trim());
}

export type SwatchSize =
  /** Palette grid on /color: name below in Cormorant 24. */
  | "palette"
  /** Shade rows on /makeup: name below in Manrope 14. */
  | "shade";

type ColorSquareProps = {
  /** A hex color from palette data. An unpaintable value leaves a Basalt square. */
  readonly hex: string;
  /** Draws the 2px Champagne ring around the square. */
  readonly selected?: boolean;
  /** Extra layout classes for the square, never colors. */
  readonly className?: string;
};

/**
 * The square on its own, for rows that put the name beside the color rather than
 * under it (the "colors to keep away" list). Never interactive by itself.
 */
export function ColorSquare({
  hex,
  selected = false,
  className = "",
}: ColorSquareProps) {
  const paintable = isHexColor(hex);
  const ring = selected
    ? "outline outline-2 outline-offset-2 outline-accent-bright"
    : "";

  return (
    <span
      aria-hidden="true"
      className={`block border border-raised bg-surface ${ring} ${className}`}
      style={paintable ? { backgroundColor: hex.trim() } : undefined}
    />
  );
}

type SwatchProps = {
  readonly hex: string;
  /** The plain name, for example "Olive". Data, from the palette. */
  readonly name: string;
  readonly size?: SwatchSize;
  readonly selected?: boolean;
  /** Omitted for a swatch that only shows a color and a name. */
  readonly onSelect?: () => void;
  /**
   * The id of the one line of why this swatch opens below its row, when it is
   * open. Present only while this swatch is the open one, because the line is
   * not in the document otherwise.
   */
  readonly controls?: string;
  /** True when tapping this swatch opens a line of why below the row. */
  readonly expands?: boolean;
};

const NAME_CLASS: Record<SwatchSize, string> = {
  palette: "font-display text-title text-text",
  shade: "font-body text-small text-text",
};

export function Swatch({
  hex,
  name,
  size = "palette",
  selected = false,
  onSelect,
  controls,
  expands = false,
}: SwatchProps) {
  const content: ReactNode = (
    <>
      <ColorSquare hex={hex} selected={selected} className="aspect-square w-full" />
      <span className={`mt-2 block break-words text-left ${NAME_CLASS[size]}`}>
        {name}
      </span>
    </>
  );

  if (onSelect === undefined) {
    return <span className="block w-full">{content}</span>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={expands ? undefined : selected}
      aria-expanded={expands ? selected : undefined}
      aria-controls={selected ? controls : undefined}
      className="block w-full text-left"
    >
      {content}
    </button>
  );
}
