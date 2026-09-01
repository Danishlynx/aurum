import { ScreenTitle } from "@/components/app-shell/ScreenTitle";
import { Column } from "@/components/layout/Column";
import { copy } from "@/lib/shared/copy";

/**
 * The loading states for /profile. Static Basalt shapes in the shape of the
 * content: six summary rows with their hairlines, the "Saved" heading over two
 * rows, and the "Data" heading over the toggle and the two controls.
 *
 * docs/02-design-system.md, anti slop checklist item 8: no shimmer on a
 * skeleton, no spinner.
 *
 * Two exports because the screen and the route need different halves.
 * ProfileBodySkeleton is what the screen shows while it fetches, with the real
 * title already above it. ProfileSkeleton is the whole screen, for the route
 * level loading file.
 */

const SUMMARY_ROWS = [0, 1, 2, 3, 4, 5];
const SAVED_ROWS = [0, 1];

function SummaryRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-raised py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-2">
        <div className="h-5 w-24 rounded-sm bg-surface" />
        <div className="h-6 w-40 rounded-sm bg-surface" />
      </div>
      <div className="h-6 w-14 shrink-0 rounded-sm bg-surface" />
    </div>
  );
}

export function ProfileBodySkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-8">
      <Column>
        <div className="flex flex-col">
          {SUMMARY_ROWS.map((row) => (
            <SummaryRowSkeleton key={row} />
          ))}
        </div>
      </Column>

      <Column className="flex flex-col gap-4">
        <div className="h-[30px] w-24 rounded-sm bg-surface" />
        <div className="flex flex-col">
          {SAVED_ROWS.map((row) => (
            <div
              key={row}
              className="flex flex-col gap-2 border-t border-raised py-4 first:border-t-0 first:pt-0"
            >
              <div className="h-6 w-48 rounded-sm bg-surface" />
              <div className="h-5 w-28 rounded-sm bg-surface" />
            </div>
          ))}
        </div>
      </Column>

      <Column className="flex flex-col gap-4">
        <div className="h-[30px] w-20 rounded-sm bg-surface" />
        <div className="flex items-center justify-between gap-4 border-t border-raised pt-4">
          <div className="h-6 w-44 rounded-sm bg-surface" />
          <div className="h-7 w-[52px] shrink-0 rounded-sm bg-surface" />
        </div>
        <div className="flex flex-col gap-4 border-t border-raised pt-4">
          <div className="h-6 w-40 rounded-sm bg-surface" />
          <div className="h-[52px] w-full rounded-sm bg-surface" />
        </div>
      </Column>
    </div>
  );
}

export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <ScreenTitle>{copy.nav.profile}</ScreenTitle>

      <ProfileBodySkeleton />
    </div>
  );
}
