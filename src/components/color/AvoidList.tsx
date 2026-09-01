import { ColorSquare } from "@/components/ui/Swatch";
import { copy } from "@/lib/shared/copy";
import type { PaletteColor } from "@/lib/shared/palette";

/**
 * "Colors to keep away from your face", docs/01-user-flow.md section G item 5:
 * 4 to 6 swatches with one line each ("Icy pastels wash you out").
 *
 * The doc gives these a line each rather than a line on tap, so they are rows
 * with the color beside the words instead of a second grid. That is also what
 * keeps the screen from reading as two identical grids stacked on each other
 * (docs/02-design-system.md, anti slop checklist item 4).
 */

/** 48px square, the size that sits level with a name and its one line. */
const SQUARE_CLASS = "h-12 w-12 shrink-0";

type AvoidListProps = {
  readonly colors: readonly PaletteColor[];
};

export function AvoidList({ colors }: AvoidListProps) {
  if (colors.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.color.avoidHeading}
      </h2>

      <ul className="flex flex-col gap-4">
        {colors.map((color, index) => (
          <li
            key={`avoid-${index}`}
            className="flex items-start gap-3 border-t border-raised pt-4 first:border-t-0 first:pt-0"
          >
            <ColorSquare hex={color.hex} className={SQUARE_CLASS} />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-display text-title text-text">{color.name}</p>
              <p className="max-w-[70ch] font-body text-small text-text-muted">
                {color.why}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
