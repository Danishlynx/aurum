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
};

/**
 * The whole screen state in one value, so the component holds no derived state
 * of its own and a test can assert on a set of jobs.
 */
export function revealStateFor(jobs: readonly ClientJob[]): RevealState {
  return {
    status: statusKeyFor(jobs),
    masksBloom: succeeded(jobs, "skin"),
    settled: jobs.length > 0 && jobs.every(isTerminal),
    coreSucceeded: coreSetSucceeded(jobs),
  };
}
