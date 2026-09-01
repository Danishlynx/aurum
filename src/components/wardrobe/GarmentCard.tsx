import { Chip } from "@/components/ui/Chip";
import { ColorSquare } from "@/components/ui/Swatch";
import { copy } from "@/lib/shared/copy";
import type { GarmentView } from "@/lib/shared/wardrobe-view";

import { cardState, garmentChips } from "./wardrobe-content";

/**
 * One garment card, docs/01-user-flow.md section J item 2: "Each photo becomes a
 * card with the classification chips filled in by the classifier: type
 * ('Shirt'), color ('Navy'), pattern ('Solid'), formality ('Smart'). Chips are
 * tappable to correct."
 *
 * States, section J:
 *
 * - Classifying: "cards show with a dimmed image and the chips as skeleton
 *   pills, replaced one by one as results arrive." The pills are static Basalt
 *   in the shape of a chip, no shimmer and no spinner
 *   (docs/02-design-system.md, SkeletonRow).
 * - Classification failed: "that card shows 'Could not read this one. Tap to
 *   fill in details.'" That line is itself the control, so a tap on it opens the
 *   same picker the chips open.
 *
 * Why the chips sit inside one button rather than being four buttons: they all
 * open the same picker, and a chip that opens a sheet is not a toggle. One
 * control with the chips inside it keeps the tap target honest (the whole row,
 * comfortably past 44px), announces the garment's own words as its name, and
 * says it opens a dialog. Tapping a chip still opens the picker, which is what
 * the doc asks for.
 *
 * The photo is drawn with a plain img rather than next/image. It is either a
 * short lived signed read of the person's own object or the local fixture
 * silhouette, and neither belongs in an edge cache (docs/03-architecture.md,
 * "Deployment"). object-contain with padding keeps a tall garment and a wide one
 * both composed inside the same square, the way the product frame does.
 *
 * The frame is square cornered with a 1px Umber hairline and no shadow: radius
 * is reserved for chips, product cards, and sheets, and elevation does not exist
 * in this system. A grid of these reads as a contact sheet rather than as a row
 * of identical rounded cards (docs/02 anti slop, item 4).
 */

type GarmentCardProps = {
  readonly garment: GarmentView;
  /** Opens the picker for this garment. */
  readonly onCorrect: (garmentId: string) => void;
};

function SkeletonPill({ width }: { readonly width: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-8 rounded-sm bg-surface"
      style={{ width: `${width}px` }}
    />
  );
}

export function GarmentCard({ garment, onCorrect }: GarmentCardProps) {
  const state = cardState(garment);
  const chips = garmentChips(garment);

  function correct(): void {
    onCorrect(garment.id);
  }

  return (
    <li className="flex flex-col gap-3">
      <div className="aspect-square w-full overflow-hidden border border-raised bg-surface p-2">
        {garment.imageUrl === null ? null : (
          /*
           * The person's own garment photo, or the checked in fixture
           * silhouette. The chips beside it already name what it is, so it
           * carries no alt text of its own.
           */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={garment.imageUrl}
            alt=""
            draggable={false}
            className={`h-full w-full select-none object-contain ${
              state === "pending" ? "opacity-70" : "opacity-100"
            }`}
          />
        )}
      </div>

      {state === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <SkeletonPill width={64} />
          <SkeletonPill width={56} />
          <SkeletonPill width={48} />
        </div>
      ) : null}

      {state === "failed" ? (
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={correct}
          className="min-h-[44px] max-w-[64ch] text-left font-body text-small text-text underline-offset-4 hover:underline focus-visible:underline"
        >
          {copy.wardrobe.classificationFailed}
        </button>
      ) : null}

      {state === "chips" ? (
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={correct}
          className="flex min-h-[44px] w-full flex-wrap content-center items-center gap-2 text-left"
        >
          {chips.type === null ? null : <Chip>{chips.type}</Chip>}

          {chips.colors.map((color) => (
            /*
             * Data, not a token: the hex comes from the classifier or from the
             * person, and it is painted through the ColorSquare guard, which
             * refuses anything that is not a hex colour.
             */
            <Chip key={`${color.name}-${color.hex}`}>
              <ColorSquare hex={color.hex} className="mr-2 h-3 w-3 shrink-0" />
              {color.name}
            </Chip>
          ))}

          {chips.pattern === null ? null : <Chip>{chips.pattern}</Chip>}

          {chips.formality === null ? null : <Chip>{chips.formality}</Chip>}
        </button>
      ) : null}
    </li>
  );
}
