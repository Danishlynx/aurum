/**
 * What the reveal shows, decided from the jobs alone.
 *
 * docs/01-user-flow.md section E: the sequence is driven by job completion, not
 * by timers. Nothing in this module reads a clock, so the same set of jobs
 * always produces the same screen, and a slow provider can only hold a status
 * line, never fake progress.
 *
 * Pure functions. No React, no I/O, so they are unit tested directly.
 */

import type { ClientJob } from "@/lib/client/api";
import { isReframeableFailure } from "@/lib/shared/analysis-failure";
import type { copy } from "@/lib/shared/copy";
import { TERMINAL_JOB_STATUSES } from "@/lib/shared/schemas";

export type StatusKey = keyof typeof copy.analyzing;

function isTerminal(job: ClientJob): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status);
}

function waitingOn(
  jobs: readonly ClientJob[],
  kinds: readonly string[],
): boolean {
  return jobs.some(
    (job) => job.kind !== null && kinds.includes(job.kind) && !isTerminal(job),
  );
}

function succeeded(jobs: readonly ClientJob[], kind: string): boolean {
  return jobs.some((job) => job.kind === kind && job.status === "succeeded");
}

/**
 * The kinds the reveal cannot reach the report without, in the order the report
 * needs them: without the skin analysis there are no concerns and no masks, and
 * without a tone reading there is no palette. docs/03-architecture.md step 6.
 */
const CORE_KINDS = ["skin", "fitzpatrick", "attributes"] as const;

/**
 * True when every core reading of this capture was refused for something a
 * tighter crop of the same photo could fix.
 *
 * This is the whole condition for the self healing retry
 * (src/lib/client/capture-source.ts). It is deliberately unanimous and
 * deliberately narrow:
 *
 * - every core job that exists has to have failed. One still running is not a
 *   dead end yet, and one that succeeded means there is a reading to keep, so
 *   sending a different photo would throw it away.
 * - every one of them has to name a class a crop can answer: a face too small
 *   in the picture, or a face the engine could not find (isReframeableFailure).
 *   A turned head, a timeout, or a provider that broke are all left alone,
 *   because re sending the same pose or the same request buys the same answer.
 * - a failure with no class at all counts against it. This build's server sends
 *   one with every refusal; an older one does not, and guessing on its behalf
 *   would re upload a photo on no evidence.
 */
export function refusedForFraming(jobs: readonly ClientJob[]): boolean {
  const core = jobs.filter(
    (job) => job.kind !== null && (CORE_KINDS as readonly string[]).includes(job.kind),
  );
  if (core.length === 0) {
    return false;
  }
  return core.every(
    (job) =>
      job.status === "failed" &&
      job.reason !== null &&
      job.reason !== undefined &&
      isReframeableFailure(job.reason),
  );
}

/**
 * The sentence the server put on the first core job that failed.
 *
 * The words are chosen on the server, where the provider's failure code is
 * (src/lib/server/jobs/index.ts), so the reveal shows the reason the reading
 * stopped instead of a timeout line that is true only when it timed out. A job
 * that failed without a message leaves this null and the screen falls back.
 */
function coreFailureMessage(jobs: readonly ClientJob[]): string | null {
  for (const kind of CORE_KINDS) {
    for (const job of jobs) {
      if (job.kind !== kind || job.status !== "failed") {
        continue;
      }
      const error = job.error;
      if (typeof error === "string" && error.trim().length > 0) {
        return error;
      }
    }
  }
  return null;
}

/**
 * The status line for a set of jobs, in the sequence docs/01 section E gives.
 * A kind with no job is nothing to wait for, so it does not hold the line.
 */
export function statusKeyFor(jobs: readonly ClientJob[]): StatusKey {
  if (jobs.length === 0 || waitingOn(jobs, ["skin"])) {
    return "readingSkin";
  }
  if (waitingOn(jobs, ["fitzpatrick", "attributes"])) {
    return "readingTone";
  }
  if (waitingOn(jobs, ["face_shape", "hair_type"])) {
    return "readingFaceShapeAndHair";
  }
  return "buildingProfile";
}

/**
 * docs/03-architecture.md step 6: the profile is built when the core set is
 * complete, which is skin plus at least one of Fitzpatrick or attributes.
 */
export function coreSetSucceeded(jobs: readonly ClientJob[]): boolean {
  return (
    succeeded(jobs, "skin") &&
    (succeeded(jobs, "fitzpatrick") || succeeded(jobs, "attributes"))
  );
}

export type RevealState = {
  readonly status: StatusKey;
  /**
   * True once the skin analysis has come back, which is the step that produces
   * masks. A failed skin job leaves this false: docs/01 section E says a failed
   * job has its step skipped, and the report says what is missing.
   */
  readonly masksBloom: boolean;
  /** Every job for this capture has finished, one way or the other. */
  readonly settled: boolean;
  /** The core set came back, so there is a profile to show. */
  readonly coreSucceeded: boolean;
  /**
   * Why the reading cannot finish, when a core job failed and said why. Null
   * while the core set can still land and null once it has. The screen reads it
   * only after settling, because a core failure with the other core kind still
   * running is not yet a dead end.
   */
  readonly problem: string | null;
  /**
   * Every core reading was refused for something a tighter crop could fix, so
   * the screen sends the same photo back before it shows anybody a refusal.
   * Read only once settled, like problem.
   */
  readonly reframeable: boolean;
};

/**
 * The whole screen state in one value, so the component holds no derived state
 * of its own and a test can assert on a set of jobs.
 */
export function revealStateFor(jobs: readonly ClientJob[]): RevealState {
  const coreSucceeded = coreSetSucceeded(jobs);
  return {
    status: statusKeyFor(jobs),
    masksBloom: succeeded(jobs, "skin"),
    settled: jobs.length > 0 && jobs.every(isTerminal),
    coreSucceeded,
    problem: coreSucceeded ? null : coreFailureMessage(jobs),
    reframeable: !coreSucceeded && refusedForFraming(jobs),
  };
}
