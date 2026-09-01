import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { copy } from "@/lib/shared/copy";

/**
 * The loading state for /makeup. Static Basalt shapes in the shape of the
 * content: the square hero, one shade row of three swatches with their names,
 * and the product card under it.
 *
 * docs/02-design-system.md, anti slop checklist item 8: no spinner over a face,
 * no shimmer on a skeleton.
 */

function ShadeRowSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <div className="h-[30px] w-24 bg-surface" />
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-2">
          <div className="aspect-square w-full bg-surface" />
          <div className="h-5 w-full bg-surface" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="aspect-square w-full bg-surface" />
          <div className="h-5 w-full bg-surface" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="aspect-square w-full bg-surface" />
          <div className="h-5 w-full bg-surface" />
        </div>
      </div>
      <div className="h-[104px] w-full rounded-md bg-surface" />
    </div>
  );
}

export function MakeupSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.makeup}</ScreenTitle>

      <Column className="flex flex-col gap-3">
        <div aria-hidden="true" className="flex gap-2">
          <div className="h-8 w-20 rounded-sm bg-surface" />
          <div className="h-8 w-20 rounded-sm bg-surface" />
        </div>
        <div aria-hidden="true" className="aspect-square w-full bg-surface" />
        <SkeletonRow lines={1} height={20} lastLineWidth={40} />
      </Column>

      <Column>
        <ShadeRowSkeleton />
      </Column>

      <Column>
        <ShadeRowSkeleton />
      </Column>
    </div>
  );
}
