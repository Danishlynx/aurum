import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { copy } from "@/lib/shared/copy";

/**
 * The loading state for /report, docs/01-user-flow.md section F states: "the
 * reading and routine show skeleton rows in the surface color, no shimmer, no
 * spinner."
 *
 * Every block below is the shape of the content it stands in for: the square
 * hero, the chip row above it, three lines of reading, three concern rows, and
 * two routine steps with their product cards. Basalt, static, nothing moving
 * over a face.
 *
 * The hero is a plain Basalt square rather than the selfie. The selfie arrives
 * as a signed URL from the same server read as the rest of the report, so there
 * is nothing to show before that read returns.
 */

function ConcernRowSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <SkeletonRow lines={1} height={24} />
      <SkeletonRow lines={1} height={20} />
      <div className="h-[2px] w-full bg-surface" />
    </div>
  );
}

function RoutineStepSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <SkeletonRow lines={1} height={24} />
      <SkeletonRow lines={1} height={16} />
      <div className="h-[104px] w-full rounded-md bg-surface" />
    </div>
  );
}

export function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.report}</ScreenTitle>

      <Column className="flex flex-col gap-3">
        <div aria-hidden="true" className="flex gap-2">
          <div className="h-8 w-24 rounded-sm bg-surface" />
          <div className="h-8 w-20 rounded-sm bg-surface" />
          <div className="h-8 w-16 rounded-sm bg-surface" />
        </div>
        <div aria-hidden="true" className="aspect-square w-full bg-surface" />
      </Column>

      <Column>
        <SkeletonRow lines={3} height={30} lastLineWidth={48} />
      </Column>

      <Column className="flex flex-col gap-4">
        <ConcernRowSkeleton />
        <ConcernRowSkeleton />
        <ConcernRowSkeleton />
      </Column>

      <Column className="flex flex-col gap-6">
        <SkeletonRow lines={1} height={30} lastLineWidth={40} />
        <RoutineStepSkeleton />
        <RoutineStepSkeleton />
      </Column>
    </div>
  );
}
