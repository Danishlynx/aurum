import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { copy } from "@/lib/shared/copy";

/**
 * The loading states for /looks. Static Basalt shapes in the shape of the
 * content: a flat lay of four tiles, the two line rationale under it, and the
 * product card of a gap.
 *
 * docs/02-design-system.md, anti slop checklist item 8: no shimmer on a
 * skeleton, no spinner.
 *
 * Two exports because the screen and the route need different halves.
 * LooksBodySkeleton is what the screen shows while it fetches an occasion, with
 * the real chips still above it, so the control the person just tapped never
 * disappears under its own loading state. LooksSkeleton is the whole screen, for
 * the route level loading file.
 */

const TILES = [0, 1, 2, 3];

export function LooksBodySkeleton() {
  return (
    <Column className="flex flex-col gap-4">
      <div aria-hidden="true" className="grid grid-cols-2 gap-3">
        {TILES.map((tile) => (
          <div
            key={tile}
            className="aspect-square w-full border border-raised bg-surface"
          />
        ))}
      </div>

      <SkeletonRow lines={2} height={24} lastLineWidth={58} />

      <div
        aria-hidden="true"
        className="h-[104px] w-full rounded-md bg-surface"
      />
    </Column>
  );
}

export function LooksSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.looks}</ScreenTitle>

      <Column>
        <div aria-hidden="true" className="flex gap-2 py-1.5">
          <div className="h-8 w-20 rounded-sm bg-surface" />
          <div className="h-8 w-28 rounded-sm bg-surface" />
          <div className="h-8 w-16 rounded-sm bg-surface" />
        </div>
      </Column>

      <LooksBodySkeleton />
    </div>
  );
}
