import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { copy } from "@/lib/shared/copy";

/**
 * The loading state for /wardrobe. Static Basalt shapes in the shape of the
 * content: the filter row, the hint line, and four garment frames with their
 * chips.
 *
 * docs/02-design-system.md, anti slop checklist item 8: no shimmer on a
 * skeleton, no spinner. SkeletonRow's own bars are paragraph shaped, so the
 * square frames and the chip pills are drawn here in the same Basalt.
 */

const CARDS = [0, 1, 2, 3];

export function WardrobeSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.wardrobe}</ScreenTitle>

      <Column>
        <div aria-hidden="true" className="flex gap-2 py-1.5">
          <div className="h-8 w-14 rounded-sm bg-surface" />
          <div className="h-8 w-20 rounded-sm bg-surface" />
          <div className="h-8 w-24 rounded-sm bg-surface" />
        </div>
      </Column>

      <Column className="flex flex-col gap-4">
        <div aria-hidden="true" className="h-5 w-48 bg-surface" />

        <div aria-hidden="true" className="grid grid-cols-2 gap-4">
          {CARDS.map((card) => (
            <div key={card} className="flex flex-col gap-3">
              <div className="aspect-square w-full border border-raised bg-surface" />
              <div className="flex gap-2">
                <div className="h-8 w-16 rounded-sm bg-surface" />
                <div className="h-8 w-14 rounded-sm bg-surface" />
              </div>
            </div>
          ))}
        </div>
      </Column>
    </div>
  );
}
