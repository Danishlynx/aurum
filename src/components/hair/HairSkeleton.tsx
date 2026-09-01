import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { copy } from "@/lib/shared/copy";

/**
 * The loading state for /hair. Static Basalt shapes in the shape of the content:
 * the face shape line, the square hero with its status line, the style row with
 * the names under the cards, and the color row.
 *
 * docs/02-design-system.md, anti slop checklist item 8: no spinner over a face,
 * no shimmer on a skeleton.
 */

function StyleCardSkeleton() {
  return (
    <div className="flex w-24 shrink-0 flex-col gap-2">
      <div className="aspect-square w-full bg-surface" />
      <div className="h-5 w-full bg-surface" />
    </div>
  );
}

function ColorSwatchSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="aspect-square w-full bg-surface" />
      <div className="h-5 w-full bg-surface" />
    </div>
  );
}

export function HairSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.hair}</ScreenTitle>

      <Column>
        <SkeletonRow lines={2} height={30} lastLineWidth={54} />
      </Column>

      <Column className="flex flex-col gap-3">
        <div aria-hidden="true" className="aspect-square w-full bg-surface" />
        <SkeletonRow lines={1} height={20} lastLineWidth={40} />
      </Column>

      <Column>
        <div aria-hidden="true" className="flex flex-col gap-3">
          <div className="h-[30px] w-24 bg-surface" />
          <div className="flex gap-3 overflow-hidden">
            <StyleCardSkeleton />
            <StyleCardSkeleton />
            <StyleCardSkeleton />
          </div>
          <div className="h-5 w-3/4 bg-surface" />
        </div>
      </Column>

      <Column>
        <div aria-hidden="true" className="flex flex-col gap-3">
          <div className="h-[30px] w-24 bg-surface" />
          <div className="grid grid-cols-4 gap-3">
            <ColorSwatchSkeleton />
            <ColorSwatchSkeleton />
            <ColorSwatchSkeleton />
            <ColorSwatchSkeleton />
          </div>
        </div>
      </Column>
    </div>
  );
}
