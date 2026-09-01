import type { ConcernView } from "@/lib/shared/report-view";

import { orderedConcerns, scoreBarPercent } from "./report-content";

/**
 * The concern list, docs/01-user-flow.md section F item 3: each concern with its
 * name, a one line plain description, and a subtle 1 to 100 score shown as a
 * thin gold bar, never a big number. The order is tone first and was decided by
 * src/lib/shared/concerns.ts before it reached this screen.
 *
 * docs/02-design-system.md, "Numbers are quiet": the number sits in Sand small
 * beside the bar. There is no heading above the list, because the concern names
 * are the content and the doc gives no words for one.
 */

type ConcernListProps = {
  readonly concerns: readonly ConcernView[];
};

export function ConcernList({ concerns }: ConcernListProps) {
  const ordered = orderedConcerns(concerns);
  if (ordered.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-4">
      {ordered.map((concern) => {
        const percent = scoreBarPercent(concern.score);
        return (
          <li
            key={concern.key}
            className="flex flex-col gap-2 border-t border-raised pt-4 first:border-t-0 first:pt-0"
          >
            <p className="font-body text-body font-semibold text-text">
              {concern.label}
            </p>
            <p className="max-w-[70ch] font-body text-small text-text-muted">
              {concern.description}
            </p>
            {/*
              The bar is the picture of the number beside it, so it is hidden
              from a screen reader and the number is read as ordinary text. That
              way nothing here needs a label string, and no copy is invented for
              an assistive technology that the screen does not also show.
            */}
            <div className="flex items-center gap-3">
              <div aria-hidden="true" className="h-[2px] flex-1 bg-raised">
                <div
                  className="h-full bg-accent"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="font-body text-small tabular-nums text-text-muted">
                {percent}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
