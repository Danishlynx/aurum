import type { GarmentLookItem } from "./looks-content";
import { flatLayColumns } from "./looks-content";

/**
 * The flat lay, docs/01-user-flow.md section K item 2: "a card with a flat lay
 * of the garments (from the person's wardrobe)".
 *
 * One square tile per garment, the same frame the wardrobe grid uses: square
 * cornered, a 1px Umber hairline, Basalt fill, and the photo inside on
 * object-contain with padding so a tall garment and a wide one still compose.
 * No radius and no shadow, because a flat lay is a set of clothes on a bed, not
 * a row of cards.
 *
 * The photos are drawn with a plain img rather than next/image: each one is a
 * short lived signed read of the person's own object, or the local fixture
 * silhouette, and neither belongs in an edge cache
 * (docs/03-architecture.md, "Deployment").
 *
 * A garment whose photo is gone keeps its empty frame. There is no stand in
 * picture of a shirt: the look still names the piece in its rationale, and a
 * stock photograph would be a garment the person does not own.
 */

type FlatLayProps = {
  readonly items: readonly GarmentLookItem[];
  /** Names the group for a screen reader, from the look's own rationale. */
  readonly labelledBy: string;
};

export function FlatLay({ items, labelledBy }: FlatLayProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <ul
      aria-labelledby={labelledBy}
      className="grid gap-3"
      style={{
        gridTemplateColumns: `repeat(${flatLayColumns(items.length)}, minmax(0, 1fr))`,
      }}
    >
      {items.map((item) => (
        <li
          key={item.garmentId}
          className="aspect-square w-full overflow-hidden border border-raised bg-surface p-2"
        >
          {item.imageUrl === null ? null : (
            /*
             * The person's own garment photo. The rationale under the flat lay
             * already says what the look is made of, so the tile carries no alt
             * text of its own.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.imageUrl}
              alt=""
              draggable={false}
              className="h-full w-full select-none object-contain"
            />
          )}
        </li>
      ))}
    </ul>
  );
}
