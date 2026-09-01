import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { copy } from "@/lib/shared/copy";

/**
 * The loading state for /color. docs/01-user-flow.md "Global states and rules":
 * "Loading uses the surface color skeletons in the exact shape of the content.
 * No spinners. No shimmer."
 *
 * Every block is the shape of what replaces it: the wide tone swatch and its
 * label, the season line, one row of the wear grid, and two of the rows below.
 */

function SwatchRowSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-3 gap-3">
      <div className="flex flex-col gap-2">
        <div className="aspect-square w-full bg-surface" />
        <div className="h-[30px] w-full bg-surface" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="aspect-square w-full bg-surface" />
        <div className="h-[30px] w-full bg-surface" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="aspect-square w-full bg-surface" />
        <div className="h-[30px] w-full bg-surface" />
      </div>
    </div>
  );
}

export function ColorSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.color}</ScreenTitle>

      <Column className="flex flex-col gap-3">
        <div aria-hidden="true" className="h-24 w-full bg-surface" />
        <SkeletonRow lines={1} height={30} />
      </Column>

      <Column>
        <SkeletonRow lines={2} height={24} lastLineWidth={70} />
      </Column>

      <Column className="flex flex-col gap-6">
        <SkeletonRow lines={1} height={30} lastLineWidth={40} />
        <SwatchRowSkeleton />
        <SwatchRowSkeleton />
      </Column>

      <Column className="flex flex-col gap-4">
        <SkeletonRow lines={1} height={30} lastLineWidth={56} />
        <SkeletonRow lines={3} height={20} lastLineWidth={64} />
      </Column>
    </div>
  );
}
