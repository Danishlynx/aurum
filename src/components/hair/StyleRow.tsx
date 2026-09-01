import { copy } from "@/lib/shared/copy";
import type { HairStyleOption } from "@/lib/shared/hair-view";

/**
 * The style row, docs/01-user-flow.md section I item 2: "a horizontal row of 3
 * to 4 rendered try ons. Tapping one enlarges it. Each has a plain name
 * ('Textured crop', 'Soft layers past the collarbone') and one line of why it
 * suits the face shape and hair type."
 *
 * A card is a square frame in Basalt with a 1px Umber hairline, holding the try
 * on for that style. A style with no render yet keeps the empty frame and its
 * name: nothing has been rendered, and a stock head of hair would be a try on we
 * never did. Selected takes the gold hairline, which is the whole elevation
 * system in docs/02-design-system.md.
 *
 * The one line of why sits under the row rather than on the card, the way
 * docs/02 has a swatch open its line under its row. It belongs to the selected
 * style, so exactly one is ever on screen.
 *
 * The row scrolls sideways instead of wrapping, so a fourth style never pushes
 * the person's own face off the top of the screen at 390px.
 */

type StyleRowProps = {
  readonly styles: readonly HairStyleOption[];
  /** Style id to the render on hand for it, from the view or from a try on. */
  readonly rendered: Readonly<Record<string, string>>;
  readonly selectedId: string | null;
  readonly onSelect: (styleId: string) => void;
};

const WHY_ID = "hair-style-why";

export function StyleRow({
  styles,
  rendered,
  selectedId,
  onSelect,
}: StyleRowProps) {
  if (styles.length === 0) {
    return null;
  }

  const selected = styles.find((style) => style.id === selectedId) ?? null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-display text-title text-text">
        {copy.hair.stylesHeading}
      </h2>

      <div
        role="group"
        aria-label={copy.hair.stylesHeading}
        /*
         * The negative inline margin lets the row scroll to the edges of the
         * screen while its first card still lines up with the column. py-1
         * leaves room for the gold focus outline, which a scroll container would
         * otherwise clip.
         */
        className="flex items-start gap-3 overflow-x-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          marginInline: "calc(var(--column-padding) * -1)",
          paddingInline: "var(--column-padding)",
        }}
      >
        {styles.map((style) => {
          const isSelected = style.id === selectedId;
          const renderUrl = rendered[style.id] ?? null;

          return (
            <button
              key={style.id}
              type="button"
              aria-pressed={isSelected}
              aria-controls={isSelected ? WHY_ID : undefined}
              onClick={() => {
                onSelect(style.id);
              }}
              /*
               * Narrow enough that a fourth card is part visible at 390px, which
               * is the only thing telling a person the row scrolls.
               */
              className="w-24 shrink-0 text-left"
            >
              <span
                className={`block aspect-square w-full overflow-hidden border bg-surface ${
                  isSelected ? "border-accent" : "border-raised"
                }`}
              >
                {renderUrl === null ? null : (
                  /*
                   * A real try on of this style on the person's own face, from a
                   * short lived signed URL. Not run through the image optimizer,
                   * for the same reason as the hero.
                   */
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={renderUrl}
                    // The name below the card says which style this is.
                    alt=""
                    draggable={false}
                    className="h-full w-full select-none object-cover"
                  />
                )}
              </span>
              <span className="mt-2 block break-words font-body text-small text-text">
                {style.name}
              </span>
            </button>
          );
        })}
      </div>

      {selected === null ? null : (
        <p
          id={WHY_ID}
          className="max-w-[70ch] font-body text-small text-text-muted"
        >
          {selected.why}
        </p>
      )}
    </section>
  );
}
