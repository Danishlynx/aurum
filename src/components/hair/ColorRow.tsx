import { Swatch } from "@/components/ui/Swatch";
import { copy } from "@/lib/shared/copy";
import type { HairColorOption } from "@/lib/shared/hair-view";

/**
 * The color row, docs/01-user-flow.md section I item 3: "a row of 3 to 4 hair
 * colors inside the palette, rendered on the selected style. One line each
 * ('Warm chestnut brings out the warmth in your skin')."
 *
 * The swatch is the shade variant from docs/02-design-system.md: the color
 * square with its 1px Umber hairline, the name under it in Manrope 14, and a 2px
 * Champagne ring on the selected one. The color itself is palette data, painted
 * through the ColorSquare guard in src/components/ui/Swatch.tsx, never a token
 * and never a hex written into a component.
 *
 * The one line of why sits under the row for the selected color, which is where
 * docs/02 puts a swatch's line.
 *
 * Empty state: the colors come from the palette, so a profile with no palette
 * has none to show. The section then carries the quiet line saying so and how to
 * get one, rather than an empty row or an invented color.
 *
 * The section title sits 16 above its content, which is the gap every other
 * section title in the app keeps. src/components/makeup/ShadeRow.tsx carries the
 * same note.
 */

type ColorRowProps = {
  readonly colors: readonly HairColorOption[];
  readonly selectedName: string | null;
  readonly onSelect: (colorName: string) => void;
};

const WHY_ID = "hair-color-why";

export function ColorRow({ colors, selectedName, onSelect }: ColorRowProps) {
  const selected = colors.find((color) => color.name === selectedName) ?? null;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-title text-text">
        {copy.hair.colorsHeading}
      </h2>

      {colors.length === 0 ? (
        <p className="max-w-[64ch] font-body text-body text-text-muted">
          {copy.hair.colorsUnavailable}
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label={copy.hair.colorsHeading}
            className="grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${colors.length}, minmax(0, 1fr))`,
            }}
          >
            {colors.map((color) => (
              <Swatch
                key={color.name}
                hex={color.hex}
                name={color.name}
                size="shade"
                selected={color.name === selectedName}
                controls={WHY_ID}
                onSelect={() => {
                  onSelect(color.name);
                }}
              />
            ))}
          </div>

          {selected === null ? null : (
            <p
              id={WHY_ID}
              className="max-w-[70ch] font-body text-small text-text-muted"
            >
              {selected.why}
            </p>
          )}
        </>
      )}
    </section>
  );
}
