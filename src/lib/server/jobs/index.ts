import "server-only";

import {
  analysisFailureReasonFor,
  isRetakeFailure,
  type AnalysisFailureReason,
} from "@/lib/shared/analysis-failure";
import { analysisFailureCopy, copy } from "@/lib/shared/copy";

import {
  ensureAnalysis,
  findJobForSubject,
  insertJob,
  listAnalyses,
  listJobsForSubjects,
  markCaptureOriginalDeleted,
  updateAnalysis,
  updateJob,
} from "../db";
import { serviceClient, unwrapNullable } from "../db/service";
import {
  BUCKETS,
  createSignedRead,
  downloadObject,
  removeObjects,
} from "../db/storage";
import type {
  Analysis,
  AnalysisKind,
  Capture,
  JobRecord,
  JobStatus,
  JobSubjectType,
} from "../db/types";
import { ANALYSIS_KINDS } from "../db/types";
import { findReservation, refund, reconcile, reserve } from "../credits";
import { messages } from "../http/messages";
import { HttpError } from "../http/responses";
import { maybeBuildProfile } from "../profile";
import { readProfileFacts } from "../profile/facts";
import { isProviderError } from "../providers/errors";
import { PERFECTCORP_TASK_TIMEOUT_MS } from "../providers/perfectcorp";
import type { AppSession } from "../session";
import {
  normalize,
  persistMasks,
  planFor,
  readTask,
  requiresMorePhotos,
  startTask,
  uploadCapture,
} from "./analysis";

/**
 * The job lifecycle from docs/03-architecture.md, "Jobs".
 *
 * create   reserve credits, start the provider task, store provider_task_id,
 *          status running
 * poll     for each running job last polled more than a second ago, ask the
 *          provider, validate with zod, store the normalized result, mark
 *          succeeded and reconcile; on failure mark failed with a human
 *          readable error and refund
 * retry    one automatic retry for a transient failure, attempts capped at 2
 * idempotency  creating a job for a subject that already has one running
 *          returns the running job
 * timeout  a job running longer than 120 seconds fails with the timeout copy
 *
 * What a refused reading costs a judge, decided here so it is decided once.
 *
 * docs/07-payments-and-judge-mode.md: "Each capture that reaches the analyze
 * step decrements analyses_used." A capture whose tasks were created and then
 * refused by the engine (a turned head, no face) reached that step, so the
 * count moves and stays moved, and a retake is a new capture and a new count.
 * Two things make that honest rather than punitive. Retaking the same photo
 * costs nothing, because the capture is keyed by content hash and a capture
 * that already has jobs is never charged or counted again. And the reveal now
 * says which frame problem stopped the reading, so the next photo is a better
 * one rather than another guess.
 *
 * Giving the analysis back from the poll was considered and not done: a poll is
 * repeatable, so without a per capture marker column a refresh loop on a failed
 * capture would walk analyses_used back to zero and break the cap that
 * docs/07 exists to enforce. The one case that can be given back safely is
 * settled in the analyze route, which runs once: see the note there.
 */

/** docs/03-architecture.md: attempts are capped at 2. */
export const MAX_ATTEMPTS = 2;

/** One provider poll per job per second. */
export const POLL_INTERVAL_MS = 1000;

export const JOB_LIFETIME_MS = PERFECTCORP_TASK_TIMEOUT_MS;

export interface JobView {
  readonly id: string;
  readonly subjectType: JobSubjectType;
  readonly subjectId: string;
  /** The analysis kind for an analysis job, null for renders and classifiers. */
  readonly kind: AnalysisKind | null;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly error: string | null;
  readonly updatedAt: string;
}

export interface CaptureJobsView {
  readonly captureId: string;
  readonly jobs: readonly JobView[];
  /** True when every job for this capture is terminal. */
  readonly complete: boolean;
  /** Where the answer came from, so the client can label demo data. */
  readonly source: "live" | "cache" | "demo";
  /**
   * A signed URL for the mask the reveal blooms over the selfie, or null while
   * there is nothing real to draw (docs/01-user-flow.md section E step 2).
   */
  readonly maskUrl: string | null;
}

const TERMINAL: readonly JobStatus[] = ["succeeded", "failed"];

function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

function viewOf(job: JobRecord, kind: AnalysisKind | null): JobView {
  return {
    id: job.id,
    subjectType: job.subject_type,
    subjectId: job.subject_id ?? "",
    kind,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    updatedAt: job.updated_at,
  };
}

/**
 * The sentence a person reads when a job fails. Provider text never reaches a
 * screen: the mapping below turns a typed provider failure into copy that says
 * what happened and what to do.
 */
export function messageForFailure(thrown: unknown): string {
  if (!isProviderError(thrown)) {
    return messages.serverError;
  }
  switch (thrown.code) {
    case "request_timeout":
    case "network_error":
    case "rate_limited":
      return copy.errors.providerTimeout;
    case "endpoint_unverified":
    case "provider_not_configured":
      return messages.analysisUnavailable;
    case "task_failed":
      return messageForTaskFailure(thrown.providerCode);
    default:
      return messages.providerRefused;
  }
}

/**
 * The sentence for a task the engine created, accepted, and then refused.
 *
 * This is the path the live run found. A tone reading on a head turned a few
 * degrees comes back as error_face_angle_rightward, and until now every one of
 * those became the same generic line, which told a person nothing they could
 * act on. The code decides the reason (src/lib/shared/analysis-failure.ts) and
 * the reason decides the words (src/lib/shared/copy.ts). The provider's own
 * text never reaches a screen.
 */
export function messageForTaskFailure(errorCode: string | null): string {
  return analysisFailureCopy(analysisFailureReasonFor(errorCode));
}

/**
 * One line per refused task, so a live run can be read back afterwards.
 *
 * The provider code is an identifier, not a payload: it carries no image, no
 * signed URL, and nothing about the person. docs/03-architecture.md asks for
 * the status and the provider error code in the log, and this is that.
 */
function logTaskFailure(args: {
  readonly captureId: string;
  readonly kind: AnalysisKind;
  readonly providerCode: string | null;
  readonly reason: AnalysisFailureReason;
}): void {
  console.warn(
    JSON.stringify({
      event: "aurum.analysis_refused",
      captureId: args.captureId,
      kind: args.kind,
      providerCode: args.providerCode,
      reason: args.reason,
      retake: isRetakeFailure(args.reason),
    }),
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface StartedAnalysis {
  readonly analysis: Analysis;
  readonly kind: AnalysisKind;
  readonly reservationUnits: number;
}

/**
 * Writes the job row for one analysis, reusing the row a previous attempt left
 * behind. The partial unique index on (subject_type, subject_id) allows only one
 * open job per subject, so reusing the row is also what keeps a retry legal.
 */
async function writeJob(args: {
  readonly ownerId: string;
  readonly subjectId: string;
  readonly status: JobStatus;
  readonly providerTaskId: string | null;
  readonly attempts: number;
  readonly error: string | null;
}): Promise<JobRecord> {
  const existing = await findJobForSubject(args.ownerId, args.subjectId);
  if (existing !== null) {
    const updated = await updateJob(existing.id, {
      status: args.status,
      provider_task_id: args.providerTaskId,
      attempts: args.attempts,
      error: args.error,
      last_polled_at: null,
    });
    if (updated !== null) {
      return updated;
    }
  }
  return insertJob({
    user_id: args.ownerId,
    subject_type: "analysis",
    subject_id: args.subjectId,
    status: args.status,
    provider_task_id: args.providerTaskId,
    attempts: args.attempts,
    error: args.error,
  });
}

/**
 * Which kinds this call should start.
 *
 * A succeeded analysis is never re run: the result is already paid for. A kind
 * with an open job is returned as is, which is the idempotency rule. A failed
 * kind is retried only while its attempt count is under the cap, so a broken
 * endpoint cannot be made to spend credits in a loop by calling analyze again.
 */
function kindsToStart(
  analyses: readonly Analysis[],
  jobs: readonly JobRecord[],
): AnalysisKind[] {
  const jobBySubject = new Map(jobs.map((job) => [job.subject_id ?? "", job]));
  const pending: AnalysisKind[] = [];

  for (const analysis of analyses) {
    if (analysis.status === "succeeded") {
      continue;
    }
    const job = jobBySubject.get(analysis.id);
    if (job !== undefined && !isTerminal(job.status)) {
      continue;
    }
    if (job !== undefined && job.attempts >= MAX_ATTEMPTS) {
      continue;
    }
    pending.push(analysis.kind);
  }
  return pending;
}

export interface CreateJobsInput {
  readonly session: AppSession;
  readonly capture: Capture;
  /** Called once per provider HTTP call so the route can log the count. */
  readonly onProviderCall?: (count: number) => void;
  /** Called with the units actually reserved, for the same reason. */
  readonly onCredits?: (units: number) => void;
}

/**
 * Fans the five analyses out from one uploaded selfie.
 *
 * The image is uploaded to the provider once and every task reads that one file
 * id (docs/04-integrations.md, "Upload once, fan out tasks"). Task creation runs
 * in parallel; credits are reserved before it, one reservation per analysis, so
 * a single failed kind refunds only its own units.
 */
export async function createAnalysisJobs(
  input: CreateJobsInput,
): Promise<CaptureJobsView> {
  const ownerId = input.session.id;
  const captureId = input.capture.id;

  const analyses: Analysis[] = [];
  for (const kind of ANALYSIS_KINDS) {
    analyses.push(await ensureAnalysis({ ownerId, captureId, kind }));
  }

  const existingJobs = await listJobsForSubjects(
    ownerId,
    analyses.map((analysis) => analysis.id),
  );
  const pending = kindsToStart(analyses, existingJobs);

  if (pending.length === 0) {
    return readCaptureJobs(ownerId, captureId, "cache");
  }

  const byKind = new Map(analyses.map((analysis) => [analysis.kind, analysis]));

  // Kinds this build cannot run from a single selfie never reach the provider
  // and never reserve a unit.
  const runnable: AnalysisKind[] = [];
  for (const kind of pending) {
    const analysis = byKind.get(kind);
    if (analysis === undefined) {
      continue;
    }
    if (requiresMorePhotos(kind)) {
      await updateAnalysis(analysis.id, {
        status: "failed",
        error: messages.hairTypeNeedsThreePhotos,
        credits_used: 0,
      });
      await writeJob({
        ownerId,
        subjectId: analysis.id,
        status: "failed",
        providerTaskId: null,
        attempts: MAX_ATTEMPTS,
        error: messages.hairTypeNeedsThreePhotos,
      });
      continue;
    }
    runnable.push(kind);
  }

  if (runnable.length === 0) {
    return readCaptureJobs(ownerId, captureId, "live");
  }

  if (input.capture.storage_path === null) {
    throw new HttpError({
      status: 409,
      message: messages.captureMissingOriginal,
      outcome: "invalid_request",
      code: "capture_missing_original",
    });
  }

  // The object is read before anything is reserved, so a capture whose upload
  // never landed costs nothing and gets the upload copy rather than a 500.
  let object;
  try {
    object = await downloadObject(BUCKETS.captures, input.capture.storage_path);
  } catch {
    throw new HttpError({
      status: 409,
      message: copy.errors.uploadFailed,
      outcome: "invalid_request",
      code: "capture_not_uploaded",
    });
  }

  const fileId = await uploadCapture({
    bytes: object.bytes,
    contentType: object.contentType,
    captureId,
  });
  input.onProviderCall?.(1);

  // Reservations are sequential because each one reads the running total.
  const started: StartedAnalysis[] = [];
  for (const kind of runnable) {
    const analysis = byKind.get(kind);
    if (analysis === undefined) {
      continue;
    }
    const plan = planFor(kind);
    const outcome = await reserve({
      session: input.session,
      provider: "perfectcorp",
      units: plan.units,
      subjectId: analysis.id,
      note: `reserve ${kind}`,
    });

    if (!outcome.ok) {
      const message =
        outcome.reason === "session_cap"
          ? copy.errors.judgeExhausted
          : messages.dailyCapReached;
      await updateAnalysis(analysis.id, {
        status: "failed",
        error: message,
        credits_used: 0,
      });
      await writeJob({
        ownerId,
        subjectId: analysis.id,
        status: "failed",
        providerTaskId: null,
        attempts: MAX_ATTEMPTS,
        error: message,
      });
      continue;
    }

    input.onCredits?.(outcome.reservation.units);
    started.push({
      analysis,
      kind,
      reservationUnits: outcome.reservation.units,
    });
  }

  await Promise.all(
    started.map(async (entry) => {
      const previous = await findJobForSubject(ownerId, entry.analysis.id);
      const attempts = (previous?.attempts ?? 0) + 1;
      try {
        const task = await startTask({ kind: entry.kind, fileId });
        input.onProviderCall?.(1);
        await updateAnalysis(entry.analysis.id, {
          status: "running",
          provider_task_id: task.taskId,
          credits_used: entry.reservationUnits,
          error: null,
        });
        await writeJob({
          ownerId,
          subjectId: entry.analysis.id,
          status: "running",
          providerTaskId: task.taskId,
          attempts,
          error: null,
        });
      } catch (thrown) {
        await refundFor(input.session, entry.analysis.id);
        const message = messageForFailure(thrown);
        await updateAnalysis(entry.analysis.id, {
          status: "failed",
          error: message,
          credits_used: 0,
        });
        await writeJob({
          ownerId,
          subjectId: entry.analysis.id,
          status: "failed",
          providerTaskId: null,
          attempts,
          error: message,
        });
      }
    }),
  );

  return readCaptureJobs(ownerId, captureId, "live");
}

async function refundFor(session: AppSession, subjectId: string): Promise<void> {
  const reservation = await findReservation({
    owner: { ownerType: session.ownerType, ownerId: session.id },
    subjectId,
    provider: "perfectcorp",
  });
  if (reservation !== null) {
    await refund({ session, reservation });
  }
}

// ---------------------------------------------------------------------------
// Read and poll
// ---------------------------------------------------------------------------

/**
 * The one mask the reveal blooms, signed for the length of that screen.
 *
 * docs/01-user-flow.md section E step 2 has masks blooming over the face as the
 * skin analysis returns. This picks the mask of the top ranked concern, which is
 * the one /report opens on (src/components/report/ReportHero.tsx), so the two
 * screens show the same finding rather than two different ones. Reading the
 * facts is how it stays the same choice: the ranking rule lives in one place
 * (src/lib/shared/concerns.ts) and is not repeated here.
 *
 * One mask, not all of them: docs/02-design-system.md gives the reveal one
 * bloom, and eight translucent layers over a face is not the moment that doc
 * describes.
 *
 * Nothing here can fail the poll. A capture with no succeeded skin analysis, no
 * stored masks, or a storage call that did not answer returns null, and the
 * screen falls back to the oval.
 */
async function revealMaskUrl(
  captureId: string,
  analyses: readonly Analysis[],
): Promise<string | null> {
  const facts = readProfileFacts({ captureId, analyses });
  const top = facts.ranked[0];
  if (top === undefined) {
    return null;
  }
  const path = facts.maskPathByKey.get(top.key);
  if (path === undefined) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.masks, path);
  } catch (thrown) {
    // The bucket and the reason, never the path (migration 0006).
    console.warn(
      JSON.stringify({
        event: "aurum.reveal_mask_unsigned",
        captureId,
        reason: thrown instanceof Error ? thrown.name : "unknown",
      }),
    );
    return null;
  }
}

export async function readCaptureJobs(
  ownerId: string,
  captureId: string,
  source: CaptureJobsView["source"],
): Promise<CaptureJobsView> {
  const analyses = await listAnalyses(ownerId, captureId);
  const jobs = await listJobsForSubjects(
    ownerId,
    analyses.map((analysis) => analysis.id),
  );
  const kindById = new Map(
    analyses.map((analysis) => [analysis.id, analysis.kind]),
  );

  const views = jobs.map((job) =>
    viewOf(job, kindById.get(job.subject_id ?? "") ?? null),
  );

  return {
    captureId,
    jobs: views,
    complete:
      views.length > 0 && views.every((view) => isTerminal(view.status)),
    source,
    maskUrl: await revealMaskUrl(captureId, analyses),
  };
}

/**
 * Claims the right to poll one job. The claim is a compare and set on
 * last_polled_at, so two polls arriving together produce one provider call, not
 * two. A job polled less than a second ago is left alone.
 *
 * Exported because the render poll (src/lib/server/renders) is a job poll too
 * and must not have a second copy of this rule.
 */
export async function claimForPolling(job: JobRecord): Promise<boolean> {
  const now = Date.now();
  if (
    job.last_polled_at !== null &&
    now - Date.parse(job.last_polled_at) < POLL_INTERVAL_MS
  ) {
    return false;
  }

  const query = serviceClient()
    .from("jobs")
    .update({ last_polled_at: new Date(now).toISOString() })
    .eq("id", job.id);

  const result =
    job.last_polled_at === null
      ? await query.is("last_polled_at", null).select("id").maybeSingle()
      : await query
          .eq("last_polled_at", job.last_polled_at)
          .select("id")
          .maybeSingle();

  return unwrapNullable("claim job for polling", result) !== null;
}

async function failJob(args: {
  readonly session: AppSession;
  readonly job: JobRecord;
  readonly analysisId: string;
  readonly message: string;
  readonly attempts?: number;
}): Promise<void> {
  await refundFor(args.session, args.analysisId);
  await updateAnalysis(args.analysisId, {
    status: "failed",
    error: args.message,
    credits_used: 0,
  });
  await updateJob(args.job.id, {
    status: "failed",
    error: args.message,
    attempts: args.attempts ?? args.job.attempts,
  });
}

/**
 * A task the provider says succeeded, whose result we could not read.
 *
 * It is not failJob: that one refunds, and refunding here would be a lie. A
 * task that fails is charged nothing, but a task that succeeds is charged
 * whether or not our schema can read the answer. That is not a hypothetical:
 * the first live skin analysis cost 16 units and was recorded as failed and
 * refunded, because data.error arrives as null and the schema wanted a string,
 * and the ledger then said the account had 16 units it did not have. So the
 * reservation is reconciled as spent, the analysis is marked failed, and the
 * step is simply missing from the report.
 */
async function failChargedJob(args: {
  readonly session: AppSession;
  readonly job: JobRecord;
  readonly analysis: Analysis;
}): Promise<void> {
  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.analysis.id,
    provider: "perfectcorp",
  });
  const units = reservation?.units ?? args.analysis.credits_used;
  if (reservation !== null) {
    await reconcile({
      session: args.session,
      reservation,
      actualUnits: reservation.units,
    });
  }
  await updateAnalysis(args.analysis.id, {
    status: "failed",
    error: messages.analysisUnavailable,
    credits_used: units,
  });
  await updateJob(args.job.id, {
    status: "failed",
    error: messages.analysisUnavailable,
    attempts: MAX_ATTEMPTS,
  });
}

async function succeedJob(args: {
  readonly session: AppSession;
  readonly job: JobRecord;
  readonly analysis: Analysis;
  readonly captureId: string;
  readonly normalized: ReturnType<typeof normalize>;
}): Promise<void> {
  const normalized = args.normalized;
  const maskPaths = await persistMasks({
    ownerId: args.session.id,
    captureId: args.captureId,
    masks: normalized.maskUrls,
  });

  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.analysis.id,
    provider: "perfectcorp",
  });
  const units = reservation?.units ?? args.analysis.credits_used;
  if (reservation !== null) {
    await reconcile({
      session: args.session,
      reservation,
      actualUnits: reservation.units,
    });
  }

  await updateAnalysis(args.analysis.id, {
    status: "succeeded",
    raw: normalized.raw,
    summary: normalized.summary,
    mask_paths: maskPaths,
    credits_used: units,
    error: null,
  });
  await updateJob(args.job.id, { status: "succeeded", error: null });
}

export interface PollInput {
  readonly session: AppSession;
  readonly capture: Capture;
  readonly keepOriginals: boolean;
  readonly onProviderCall?: (count: number) => void;
}

/**
 * One pass over the open jobs for a capture.
 *
 * Nothing here waits on a provider for longer than one HTTP call, so the route
 * returns in the time the client's 1.5 second poll allows and Vercel function
 * timeouts stay irrelevant (docs/03-architecture.md, principle 2).
 */
export async function pollCaptureJobs(
  input: PollInput,
): Promise<CaptureJobsView> {
  const ownerId = input.session.id;
  const captureId = input.capture.id;

  const analyses = await listAnalyses(ownerId, captureId);
  const analysisById = new Map(
    analyses.map((analysis) => [analysis.id, analysis]),
  );
  const jobs = await listJobsForSubjects(
    ownerId,
    analyses.map((analysis) => analysis.id),
  );

  // One restart per poll keeps a bad minute from turning into a burst of
  // uploads. The next poll picks up the next one.
  let restartsLeft = 1;

  for (const job of jobs) {
    if (isTerminal(job.status)) {
      continue;
    }
    const analysis =
      job.subject_id === null ? undefined : analysisById.get(job.subject_id);
    if (analysis === undefined) {
      continue;
    }

    if (Date.now() - Date.parse(job.created_at) > JOB_LIFETIME_MS) {
      await failJob({
        session: input.session,
        job,
        analysisId: analysis.id,
        message: copy.errors.providerTimeout,
      });
      continue;
    }

    if (job.provider_task_id === null) {
      continue;
    }

    if (!(await claimForPolling(job))) {
      continue;
    }

    try {
      const snapshot = await readTask({
        kind: analysis.kind,
        taskId: job.provider_task_id,
      });
      input.onProviderCall?.(1);

      if (snapshot.state === "succeeded") {
        /*
         * Normalizing is separated from storing on purpose. It is the step that
         * can throw on a task the provider already charged for, and that case
         * must not be refunded (failChargedJob). Everything after it is our own
         * storage, where a throw is a server error and the poll retries.
         */
        let normalized;
        try {
          normalized = normalize(analysis.kind, snapshot);
        } catch (thrown) {
          console.warn(
            JSON.stringify({
              event: "aurum.analysis_unreadable",
              captureId,
              kind: analysis.kind,
              issuePaths: isProviderError(thrown) ? thrown.issuePaths : [],
            }),
          );
          await failChargedJob({ session: input.session, job, analysis });
          continue;
        }
        await succeedJob({
          session: input.session,
          job,
          analysis,
          captureId,
          normalized,
        });
        continue;
      }

      if (snapshot.state === "failed") {
        /*
         * The refusal the person can act on. A failed task is charged nothing,
         * so the reservation goes back whatever the reason
         * (docs/04-integrations.md, "Input errors").
         */
        const reason = analysisFailureReasonFor(snapshot.errorCode);
        logTaskFailure({
          captureId,
          kind: analysis.kind,
          providerCode: snapshot.errorCode,
          reason,
        });
        await failJob({
          session: input.session,
          job,
          analysisId: analysis.id,
          message: messageForTaskFailure(snapshot.errorCode),
          // A refused frame is not a transient failure: sending the same photo
          // again buys the same refusal. Retaking is the way out, so the job is
          // closed at the attempt cap rather than left open for a retry.
          attempts: isRetakeFailure(reason) ? MAX_ATTEMPTS : job.attempts,
        });
      }
      // Still running: last_polled_at was already stamped by the claim.
    } catch (thrown) {
      const transient = isProviderError(thrown) && thrown.isTransient;
      if (transient && job.attempts < MAX_ATTEMPTS && restartsLeft > 0) {
        restartsLeft -= 1;
        const restarted = await restartJob({
          session: input.session,
          job,
          analysis,
          capture: input.capture,
          onProviderCall: input.onProviderCall,
        });
        if (restarted) {
          continue;
        }
      }
      await failJob({
        session: input.session,
        job,
        analysisId: analysis.id,
        message: messageForFailure(thrown),
        attempts: job.attempts + 1,
      });
    }
  }

  const view = await readCaptureJobs(ownerId, captureId, "live");

  // docs/03-architecture.md step 6: the profile is built once the core set is in
  // (skin plus at least one of Fitzpatrick or attributes), which is usually
  // before every job is terminal. maybeBuildProfile makes that decision itself
  // and does nothing when the set is short or when nothing has changed, so this
  // is safe to call on every poll. A failure here must not stop the reveal: the
  // person keeps polling, and the next poll tries again.
  try {
    await maybeBuildProfile({ session: input.session, captureId });
  } catch (thrown) {
    console.warn(
      JSON.stringify({
        event: "aurum.profile_build_failed",
        captureId,
        reason: thrown instanceof Error ? thrown.name : "unknown",
      }),
    );
  }

  if (view.complete) {
    await finishCapture({
      capture: input.capture,
      keepOriginals: input.keepOriginals,
    });
  }

  return view;
}

/**
 * The one automatic retry for a transient failure. The provider file id is not
 * stored between requests, so a restart uploads the selfie again before creating
 * the task. Attempts are capped at 2, which bounds that cost.
 */
async function restartJob(args: {
  readonly session: AppSession;
  readonly job: JobRecord;
  readonly analysis: Analysis;
  readonly capture: Capture;
  readonly onProviderCall?: (count: number) => void;
}): Promise<boolean> {
  if (args.capture.storage_path === null) {
    return false;
  }
  try {
    const object = await downloadObject(
      BUCKETS.captures,
      args.capture.storage_path,
    );
    const fileId = await uploadCapture({
      bytes: object.bytes,
      contentType: object.contentType,
      captureId: args.capture.id,
    });
    args.onProviderCall?.(1);

    const task = await startTask({ kind: args.analysis.kind, fileId });
    args.onProviderCall?.(1);

    await updateAnalysis(args.analysis.id, {
      status: "running",
      provider_task_id: task.taskId,
      error: null,
    });
    await updateJob(args.job.id, {
      status: "running",
      provider_task_id: task.taskId,
      attempts: args.job.attempts + 1,
      error: null,
      last_polled_at: null,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Retention, docs/03-architecture.md step 7: once every job for a capture is
 * terminal the original object is deleted, unless the person opted in to keeping
 * it. Derived data (scores, masks) stays, because that is the product.
 */
async function finishCapture(args: {
  readonly capture: Capture;
  readonly keepOriginals: boolean;
}): Promise<void> {
  if (args.keepOriginals || args.capture.storage_path === null) {
    return;
  }
  await removeObjects(BUCKETS.captures, [args.capture.storage_path]);
  await markCaptureOriginalDeleted(args.capture.id);
}
