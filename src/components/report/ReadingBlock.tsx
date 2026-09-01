import { copy } from "@/lib/shared/copy";
import type { ReportView } from "@/lib/shared/report-view";

import { readingBlockContent } from "./report-content";

/**
 * The reading, docs/01-user-flow.md section F item 2: three to five sentences
 * written as a consultant would speak, naming the top concern and where it sits,
 * the skin type per zone, and one thing that is going well.
 *
 * docs/02-design-system.md, ReadingBlock: Cormorant 19/30 in Ivory on the canvas,
 * no box, no border, maximum five sentences. Olive is the one color reserved for
 * a "going well" indicator, which is exactly what the second line is.
 *
 * The partial state sits directly under it: when the tone reading failed, the
 * report still renders and says so, in the doc's words.
 */

type ReadingBlockProps = {
  readonly view: Pick<
    ReportView,
    "reading" | "goingWell" | "toneReadingAvailable"
  >;
};

export function ReadingBlock({ view }: ReadingBlockProps) {
  const content = readingBlockContent(view);

  return (
    <div className="flex flex-col gap-3">
      {content.reading.length > 0 ? (
        <p className="max-w-[64ch] font-display text-reading text-text">
          {content.reading}
        </p>
      ) : null}
      {content.goingWell === null ? null : (
        <p className="max-w-[64ch] font-display text-reading text-positive">
          {content.goingWell}
        </p>
      )}
      {view.toneReadingAvailable ? null : (
        <p className="max-w-[64ch] font-body text-small text-text-muted">
          {copy.report.toneUnavailable}
        </p>
      )}
    </div>
  );
}
