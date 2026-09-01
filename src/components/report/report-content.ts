/**
 * The deterministic decisions the report screen makes about its own content.
 *
 * They live outside the components so they can be unit tested without a
 * renderer, which matters while there is no database and no provider: the report
 * UI is exercised from a fixture ReportView and from these tests.
 *
 * Pure functions only. No React, no I/O.
 */

import type { ConcernView, ReportView } from "@/lib/shared/report-view";

/**
 * docs/02-design-system.md, ReadingBlock: "Maximum five sentences." The
 * synthesis prompt already asks for three to five, so this is the guard that
 * keeps a long answer from taking over the screen, not the primary limit.
 */
export const READING_MAX_SENTENCES = 5;

/**
 * Splits on a sentence ending followed by whitespace. Copy never contains an
 * exclamation mark (docs/06-safety-privacy.md), so a period or a question mark
 * is the whole set of endings we can meet.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export type ReadingBlockContent = {
  /** The reading, trimmed so the block never exceeds five sentences. */
  readonly reading: string;
  /**
   * The one thing going well, when the reading does not already say it.
   * docs/01-user-flow.md section F item 2 requires it to be said once.
   */
  readonly goingWell: string | null;
};

/**
 * Composes the reading block from the two fields the profile layer produces.
 *
 * The going well sentence is kept whole and the reading gives up its last
 * sentences when the pair would run past the limit, because the reading is
 * ordered most important first and the going well line is required.
 */
export function readingBlockContent(
  view: Pick<ReportView, "reading" | "goingWell">,
  maxSentences: number = READING_MAX_SENTENCES,
): ReadingBlockContent {
  const reading = view.reading.trim();
  const goingWell = view.goingWell.trim();
  const alreadySaid = goingWell.length === 0 || reading.includes(goingWell);

  const goingWellSentences = alreadySaid ? 0 : splitSentences(goingWell).length;
  const room = Math.max(1, maxSentences - goingWellSentences);

  return {
    reading: splitSentences(reading).slice(0, room).join(" "),
    goingWell: alreadySaid ? null : goingWell,
  };
}

/**
 * The escalation line docs/06-safety-privacy.md requires for redness and
 * blemishes is not decided here. ReportView.showDermatologistLine carries the
 * decision, and reportDermatologistLine in src/lib/shared/report-view.ts turns
 * it into the sentence, so the safety call has one owner on the server.
 */

/**
 * The mask toggle that starts active: the top ranked concern.
 * docs/01-user-flow.md section F item 1, "Default shows the top concern."
 */
export function defaultConcernKey(
  concerns: readonly ConcernView[],
): string | null {
  let best: ConcernView | null = null;
  for (const concern of concerns) {
    if (best === null || concern.rank < best.rank) {
      best = concern;
    }
  }
  return best === null ? null : best.key;
}

/**
 * The width of the score bar as a percentage. The provider scale is 1 to 100;
 * anything outside it is clamped rather than trusted, because the bar is drawn
 * from it and a stray value would draw off the row.
 */
export function scoreBarPercent(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}

/**
 * Whether there is a hero to draw at all.
 *
 * The selfie is deleted once every reading is done unless the person opted in
 * (docs/06-safety-privacy.md, "Retention"), and a concern can come back without
 * a mask image. With neither, the hero would be an empty square above toggles
 * that change nothing, so the screen leaves it out and the concern list carries
 * the information on its own.
 */
export function hasHeroContent(
  view: Pick<ReportView, "captureImageUrl" | "concerns">,
): boolean {
  return (
    view.captureImageUrl !== null ||
    view.concerns.some((concern) => concern.maskUrl !== null)
  );
}

/**
 * The concern list and the mask toggles are both ordered tone first, which the
 * profile layer already decided. This only makes the order explicit at the
 * boundary so a fixture written out of order still renders in rank order.
 */
export function orderedConcerns(
  concerns: readonly ConcernView[],
): ConcernView[] {
  return [...concerns].sort((a, b) => a.rank - b.rank);
}
