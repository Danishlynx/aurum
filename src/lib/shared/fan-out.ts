/**
 * The order the analyses of one capture are started in, and what a capture that
 * produced nothing costs.
 *
 * Why there is an order at all. Every analysis reads the same selfie, but they
 * do not agree about what a readable selfie is. The facial color tones analysis
 * (kind "attributes", 20 units) is the strictest about pose: it is created with
 * face_angle_strictness_level "high" and it refused the founder's frame live on
 * 2026-09-03 with error_face_angle_downward. The skin analysis (16 units) is the
 * laxest and took the very same frame. Both are needed for a profile, so the
 * fan out that started all five together charged 16 units for a capture that
 * could never build one.
 *
 * So the strictest reading goes first, alone. Everything else waits for it and
 * is started only once it has succeeded (src/lib/server/jobs/index.ts). A pose
 * the engine will not read now costs nothing at all, which is what makes the
 * self healing retry on the capture side free to run.
 *
 * Pure functions, no I/O, so the rule is one testable thing rather than a shape
 * of the jobs runner.
 */

import { z } from "zod";

import { analysisKindSchema, jobStatusSchema } from "./schemas";

export type FanOutKind = z.infer<typeof analysisKindSchema>;

/**
 * The reading whose refusal makes every other reading pointless: it is the
 * strictest gate on the frame and half of the core set.
 */
export const LEADER_ANALYSIS_KIND: FanOutKind = "attributes";

export type FanOutOrder = {
  /** Started first and alone. Null when it is not in this run at all. */
  readonly leader: FanOutKind | null;
  /**
   * Started once the leader succeeds. When there is no leader in this run these
   * are started immediately, which is what a re analysis after a successful tone
   * reading does.
   */
  readonly followers: readonly FanOutKind[];
};

/** Splits the kinds this run should start into the leader and the rest. */
export function fanOutOrder(kinds: readonly FanOutKind[]): FanOutOrder {
  const leader = kinds.includes(LEADER_ANALYSIS_KIND)
    ? LEADER_ANALYSIS_KIND
    : null;
  return {
    leader,
    followers: kinds.filter((kind) => kind !== LEADER_ANALYSIS_KIND),
  };
}

export type AnalysisOutcome = {
  readonly status: z.infer<typeof jobStatusSchema>;
  readonly creditsUsed: number;
};

/**
 * True when this capture actually bought something.
 *
 * docs/07-payments-and-judge-mode.md counts "each capture that reaches the
 * analyze step" against a judge session. That was written for a fan out where
 * reaching the analyze step meant readings were run and charged. With the tone
 * reading in front, a capture can reach that step, be refused on the pose, and
 * leave the account exactly where it was: no task succeeded, so no unit was
 * spent (a failed task is charged nothing). Counting that as one of three
 * analyses would take a judge's session away for a photo that produced nothing,
 * so the analysis is given back and this is the test for it.
 *
 * A succeeded analysis whose credits somehow read zero still counts: the ledger
 * is the account of record and a success is what the person was given.
 */
export function reachedChargedSuccess(
  analyses: readonly AnalysisOutcome[],
): boolean {
  return analyses.some(
    (analysis) => analysis.status === "succeeded" || analysis.creditsUsed > 0,
  );
}
