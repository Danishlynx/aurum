import "server-only";

import { getCapture, listAnalysesByIds, listOpenAnalysisJobs } from "../db";
import type { Analysis, JobRecord, JobStatus } from "../db/types";
import { sessionForOwner } from "../session";
import { pollCaptureJobs } from "./index";

/**
 * One pass over the open analysis jobs nobody is polling.
 *
 * Why it exists. Until 2026-09-23 the client poll was the only thing in the
 * system that advanced a reading: GET /api/jobs from the /analyzing screen, one
 * catch up pass on the report page, one poll on return to the foreground. A
 * tab backgrounded on /analyzing has its timers throttled or paused, a phone
 * that lost its network stops asking, a person who closed the page never asks
 * again, and in every one of those cases the task ran to completion at the
 * provider, was charged, and was never read. docs/04-integrations.md is
 * explicit that polling is mandatory: an unpolled task times out on their side
 * and the units are consumed anyway. So a stranded task is not a reading that
 * arrives late, it is a reading that was paid for and thrown away.
 *
 * What it does. pg_cron in the Supabase project calls POST /api/jobs/reconcile
 * every minute (supabase/migrations/0016_jobs_reconcile_schedule.sql). The
 * route calls this. It lists open analysis jobs whose last_polled_at is null
 * or older than OPEN_JOB_STALE_POLL_MS, joins them to their analyses for the
 * capture and the owner, dedupes by capture, and for each capture inside the
 * wall clock budget rebuilds the owner's session and runs the very same
 * pollCaptureJobs the client would have run. A result is stored and
 * reconciled, a refusal is refunded, the followers of a leader that landed are
 * started, a task past its lifetime is read once more and closed honestly, and
 * the profile is built when the core set is in. Nothing here has a second copy
 * of any of that.
 *
 * Why it is safe beside a client poll. Every primitive the poll is built on is
 * already a compare and set, because two tabs polling one capture was always
 * possible: claimForPolling stamps last_polled_at and lets one caller through
 * per second, claimPendingStart moves a follower from pending to running
 * exactly once for all time, refund() is keyed by the reservation id and is a
 * no op the second time, and reconcile() at equal units writes nothing. A
 * Vercel poll and this pass arriving at the same job therefore produce one
 * provider read, one start, one refund, one stored result, in whichever order
 * they land. The two second staleness rule on top of that keeps the pass off
 * jobs a tab is actively watching, which is a courtesy, not a requirement.
 *
 * What it does not do, and why: the ledger orphan sweep.
 *
 * The plan asked for a sweep that refunds reservations older than the job
 * lifetime whose subject has no running or succeeded analysis and no refund
 * row. The ledger as it stands cannot tell those apart from reservations that
 * must not be refunded, so the sweep is not built. Two shapes are the problem.
 * First, a reservation settled as charged leaves no ledger mark at all:
 * reconcile() at equal units writes no row (the ledger refuses a zero row by
 * constraint), so a task that succeeded, or was closed by failChargedJob as
 * charged, looks in the ledger exactly like a reservation nothing settled. The
 * analysis row tells them apart today (succeeded, or failed with credits_used
 * above zero), but a row the process never got to update (a kill between the
 * provider's answer and the first write) is pending, and the task behind it
 * may well have run and been charged. Second, "no task was created" and "a
 * task was created and its id lost" are the same shape in every table: a
 * pending analysis, a reservation, no task id. Refunding that on age alone
 * would write credit into the ledger the account does not have, which is the
 * lie failChargedJob exists to stop telling, and would make the daily and
 * global caps read lower than the account's real spend. The safe version needs
 * one of two ledger changes, either of which is its own small PR: a settlement
 * row written at equal units (note "settle <reservation id>"), so an unsettled
 * reservation is identifiable, or the provider task id recorded on the ledger
 * row when the start lands. Until then the orphans this would have swept are
 * bounded by that kill window, are logged when they happen
 * (aurum.reservation_unrefunded, aurum.fan_out_stalled), and count against the
 * caps in the conservative direction. Written down in docs/03-architecture.md,
 * "Failure modes".
 */

/** Captures one pass will poll at most, so a pass never outgrows its budget. */
export const RECONCILE_CAPTURES_PER_PASS = 25;

/**
 * Wall clock the pass gives itself before it stops taking new captures. The
 * route declares maxDuration 60; a capture's poll is at most a handful of
 * provider reads at 15 seconds each, so 45 leaves the last capture room to
 * finish inside the function's life rather than be cut off mid write.
 */
export const RECONCILE_BUDGET_MS = 45_000;

const TERMINAL: readonly JobStatus[] = ["succeeded", "failed"];

export interface ReconcileInput {
  readonly limit: number;
  readonly budgetMs: number;
  /** Who drove the pass, for the log line. */
  readonly source?: "cron";
  /** The clock, replaceable so a test can spend the budget without waiting. */
  readonly now?: () => number;
}

export interface ReconcilePassCounts {
  /** Distinct captures with at least one open, unpolled analysis job. */
  readonly captures: number;
  /** Captures whose poll ran inside the budget. */
  readonly polled: number;
  /** Listed jobs that were terminal when their capture's poll returned. */
  readonly settled: number;
  /** Provider HTTP calls the polls made: reads, uploads, task starts. */
  readonly providerCalls: number;
  /** Captures whose poll threw, or whose row could not be read. */
  readonly errors: number;
}

interface CaptureGroup {
  readonly captureId: string;
  readonly ownerId: string;
  readonly jobIds: Set<string>;
}

/**
 * Groups the listed jobs by capture, in the order the list gave them, so the
 * job that has waited longest decides which capture is polled first. A job
 * whose analysis is gone (deleted by the person, or purged) has nothing to
 * poll for and is left to the lifetime timeout.
 */
function groupByCapture(
  jobs: readonly JobRecord[],
  analyses: readonly Analysis[],
): CaptureGroup[] {
  const analysisById = new Map(analyses.map((analysis) => [analysis.id, analysis]));
  const groups = new Map<string, CaptureGroup>();
  for (const job of jobs) {
    const analysis =
      job.subject_id === null ? undefined : analysisById.get(job.subject_id);
    if (analysis === undefined) {
      continue;
    }
    const existing = groups.get(analysis.capture_id);
    if (existing !== undefined) {
      existing.jobIds.add(job.id);
      continue;
    }
    groups.set(analysis.capture_id, {
      captureId: analysis.capture_id,
      ownerId: analysis.user_id,
      jobIds: new Set([job.id]),
    });
  }
  return [...groups.values()];
}

export async function reconcileOpenCaptures(
  input: ReconcileInput,
): Promise<ReconcilePassCounts> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const source = input.source ?? "cron";

  let polled = 0;
  let settled = 0;
  let providerCalls = 0;
  let errors = 0;

  const jobs = await listOpenAnalysisJobs(input.limit);
  const analyses = await listAnalysesByIds(
    jobs.flatMap((job) => (job.subject_id === null ? [] : [job.subject_id])),
  );
  const groups = groupByCapture(jobs, analyses);

  for (const group of groups) {
    if (now() - startedAt >= input.budgetMs) {
      break;
    }
    try {
      const capture = await getCapture(group.ownerId, group.captureId);
      if (capture === null) {
        errors += 1;
        console.warn(
          JSON.stringify({
            event: "aurum.reconcile_capture_missing",
            captureId: group.captureId,
          }),
        );
        continue;
      }
      const session = await sessionForOwner(group.ownerId);
      const view = await pollCaptureJobs({
        session,
        capture,
        onProviderCall: (count) => {
          providerCalls += count;
        },
      });
      polled += 1;
      for (const job of view.jobs) {
        if (group.jobIds.has(job.id) && TERMINAL.includes(job.status)) {
          settled += 1;
        }
      }
    } catch (thrown) {
      /*
       * One capture's failure must not end the pass for the others: the next
       * minute's pass reaches this one again. The name of the error and never
       * its message, which could carry a database detail.
       */
      errors += 1;
      console.warn(
        JSON.stringify({
          event: "aurum.reconcile_capture_failed",
          captureId: group.captureId,
          reason: thrown instanceof Error ? thrown.name : "unknown",
        }),
      );
    }
  }

  const counts: ReconcilePassCounts = {
    captures: groups.length,
    polled,
    settled,
    providerCalls,
    errors,
  };
  console.log(JSON.stringify({ event: "aurum.reconcile_pass", ...counts, source }));
  return counts;
}
