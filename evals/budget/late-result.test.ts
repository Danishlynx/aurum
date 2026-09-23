import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the reading that landed late.
 *
 * The job lifetime is 120 seconds (JOB_LIFETIME_MS). Until 2026-09-23 a job
 * older than that was closed by pollCaptureJobs as charged, with the timeout
 * line, without asking the provider once more. The provider does not know about
 * our lifetime: a task that finished at 115 seconds and was first polled at 125
 * (a backgrounded tab, a phone that lost its network for a minute) was sitting
 * there complete and paid for, and the poll threw it away unread. The units were
 * spent, the reading existed, and the person was told Perfect Corp did not
 * respond in time.
 *
 * The branch now reads the task once more and settles it on what it finds:
 *
 *   succeeded  stored and reconciled, exactly as an ordinary poll stores it
 *   failed     refunded, because a refused task is charged nothing
 *   running    closed as charged with the timeout line, as before
 *
 * Every provider and database call is a mock. No key, no network, no credit.
 */

vi.mock("server-only", () => ({}));

/* ------------------------------------------------------------------ */
/* The rows                                                            */
/* ------------------------------------------------------------------ */

const OWNER = "00000000-0000-4000-8000-00000000000a";
const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const ANALYSIS_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const TASK_ID = "pc-task-late";
/** A follower of the leader above, written at analyze time and never started. */
const FOLLOWER_ANALYSIS_ID = "44444444-4444-4444-8444-444444444444";
const FOLLOWER_JOB_ID = "55555555-5555-4555-8555-555555555555";

/** Well past the 120 second lifetime. */
const CREATED_AT = new Date(Date.now() - 300_000).toISOString();

function analysisRow() {
  return {
    id: ANALYSIS_ID,
    capture_id: CAPTURE_ID,
    user_id: OWNER,
    kind: "attributes" as const,
    status: "running" as const,
    provider_task_id: TASK_ID,
    raw: null,
    summary: null,
    mask_paths: null,
    credits_used: 20,
    error: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function jobRow() {
  return {
    id: JOB_ID,
    user_id: OWNER,
    subject_type: "analysis" as const,
    subject_id: ANALYSIS_ID,
    status: "running" as const,
    provider_task_id: TASK_ID,
    attempts: 1,
    last_polled_at: null,
    error: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

function followerAnalysisRow() {
  return {
    ...analysisRow(),
    id: FOLLOWER_ANALYSIS_ID,
    kind: "skin" as const,
    status: "pending" as const,
    provider_task_id: null,
    credits_used: 0,
  };
}

function followerJobRow() {
  return {
    ...jobRow(),
    id: FOLLOWER_JOB_ID,
    subject_id: FOLLOWER_ANALYSIS_ID,
    status: "pending" as const,
    provider_task_id: null,
    attempts: 0,
  };
}

/** What listAnalyses and listJobsForSubjects answer; a test may add the follower. */
let analysisRows: Array<ReturnType<typeof analysisRow> | ReturnType<typeof followerAnalysisRow>> = [
  analysisRow(),
];
let jobRows: Array<ReturnType<typeof jobRow> | ReturnType<typeof followerJobRow>> = [jobRow()];

const capture = {
  id: CAPTURE_ID,
  user_id: OWNER,
  sha256: "a".repeat(64),
  storage_path: `${OWNER}/${CAPTURE_ID}.jpg`,
  width: 1024,
  height: 1365,
  quality: null,
  deleted_at: null,
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

const session = { kind: "user" as const, id: OWNER, ownerType: "user" as const };

/* ------------------------------------------------------------------ */
/* The mocks                                                           */
/* ------------------------------------------------------------------ */

const updateAnalysis = vi.fn(async () => undefined);
/** The status each job row was last written with, for the start claim below. */
const jobStatusById = new Map<string, string>();
const updateJob = vi.fn(async (id: string, patch: { status?: string }) => {
  if (patch.status !== undefined) {
    jobStatusById.set(id, patch.status);
  }
  return null;
});
const findJobForSubject = vi.fn(async () => null);

vi.mock("@/lib/server/db", () => ({
  ensureAnalysis: vi.fn(),
  findJobForSubject: (...args: unknown[]) =>
    (findJobForSubject as unknown as (...a: unknown[]) => unknown)(...args),
  getCapture: async () => capture,
  insertJob: vi.fn(),
  listAnalyses: async () => analysisRows,
  listJobsForSubjects: async () => jobRows,
  updateAnalysis: (...args: unknown[]) =>
    (updateAnalysis as unknown as (...a: unknown[]) => unknown)(...args),
  updateJob: (...args: unknown[]) =>
    (updateJob as unknown as (...a: unknown[]) => unknown)(...args),
}));

/**
 * The poll claim always wins: this suite is about what happens after it. The
 * start claim (advanceFanOut, "status = pending") is the one thing the chain
 * has to answer honestly, because the follower test below depends on a job
 * that was just closed no longer being startable. So the chain remembers the
 * filters of the current statement and refuses a pending claim on a job whose
 * status was written as anything else.
 */
vi.mock("@/lib/server/db/service", () => {
  const chain: Record<string, unknown> = {};
  let filters: Array<readonly [string, unknown]> = [];
  const self = () => chain;
  Object.assign(chain, {
    update: () => {
      filters = [];
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value] as const);
      return chain;
    },
    is: self,
    select: self,
    maybeSingle: async () => {
      const id = filters.find(([column]) => column === "id")?.[1];
      const wantsPending = filters.some(
        ([column, value]) => column === "status" && value === "pending",
      );
      const status = typeof id === "string" ? jobStatusById.get(id) : undefined;
      if (wantsPending && status !== undefined && status !== "pending") {
        return { data: null, error: null };
      }
      return { data: { id: id ?? JOB_ID }, error: null };
    },
  });
  return {
    serviceClient: () => ({ from: () => chain }),
    unwrap: (_operation: string, result: { data: unknown }) => result.data,
    unwrapNullable: (_operation: string, result: { data: unknown }) => result.data,
  };
});

vi.mock("@/lib/server/db/storage", () => ({
  BUCKETS: { captures: "captures", masks: "masks" },
  createSignedRead: async () => "https://example.invalid/mask.png",
  downloadObject: vi.fn(),
}));

const refund = vi.fn(async () => undefined);
const reconcile = vi.fn(async () => undefined);
const reservation = {
  id: "ledger-1",
  owner_type: "user",
  owner_id: OWNER,
  provider: "perfectcorp",
  units: 20,
  subject_id: ANALYSIS_ID,
  note: "reserve attributes",
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
};

vi.mock("@/lib/server/credits", () => ({
  /** Only the leader ever reserved anything; a follower never started. */
  findReservation: async (args: { subjectId: string }) =>
    args.subjectId === ANALYSIS_ID ? reservation : null,
  refund: (...args: unknown[]) =>
    (refund as unknown as (...a: unknown[]) => unknown)(...args),
  reconcile: (...args: unknown[]) =>
    (reconcile as unknown as (...a: unknown[]) => unknown)(...args),
  reserve: vi.fn(),
}));

vi.mock("@/lib/server/env", () => ({
  isSupabaseConfigured: () => false,
}));

vi.mock("@/lib/server/profile", () => ({
  maybeBuildProfile: async () => undefined,
}));

vi.mock("@/lib/server/profile/db", () => ({
  getAestheticProfile: async () => null,
}));

vi.mock("@/lib/server/profile/facts", () => ({
  readProfileFacts: () => ({ ranked: [], maskPathByKey: new Map() }),
}));

vi.mock("@/lib/server/judge", () => ({
  releaseJudgeAnalysis: vi.fn(),
}));

vi.mock("@/lib/server/providers/perfectcorp", () => ({
  PERFECTCORP_TASK_TIMEOUT_MS: 120_000,
}));

const readTask = vi.fn();
const startTask = vi.fn();
const uploadCapture = vi.fn();

vi.mock("@/lib/server/jobs/analysis", () => ({
  normalize: () => ({
    raw: { color: { skin_color: "#997357" }, face_quality: { faceangle: "good" } },
    summary: { skinColor: "#997357" },
    maskUrls: [],
  }),
  persistMasks: async () => [],
  planFor: () => ({ kind: "attributes", endpointKey: "facialColorTones", itemCount: 1, units: 20 }),
  readTask: (...args: unknown[]) =>
    (readTask as unknown as (...a: unknown[]) => unknown)(...args),
  requiresMorePhotos: (kind: string) => kind === "hair_type",
  startTask: (...args: unknown[]) =>
    (startTask as unknown as (...a: unknown[]) => unknown)(...args),
  uploadCapture: (...args: unknown[]) =>
    (uploadCapture as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { pollCaptureJobs, JOB_LIFETIME_MS } = await import("@/lib/server/jobs");
const { copy } = await import("@/lib/shared/copy");
const { ProviderError } = await import("@/lib/server/providers/errors");

function snapshot(state: "succeeded" | "failed" | "running", errorCode: string | null = null) {
  return {
    endpointKey: "facialColorTones",
    taskId: TASK_ID,
    state,
    results: state === "succeeded" ? { color: { skin_color: "#997357" } } : null,
    errorCode,
    pollingIntervalSeconds: null,
  };
}

function analysisPatches(): Array<Record<string, unknown>> {
  return updateAnalysis.mock.calls.map((call) => (call as unknown[])[1] as Record<string, unknown>);
}

beforeEach(() => {
  updateAnalysis.mockClear();
  updateJob.mockClear();
  refund.mockClear();
  reconcile.mockClear();
  readTask.mockReset();
  startTask.mockReset();
  uploadCapture.mockReset();
  jobStatusById.clear();
  analysisRows = [analysisRow()];
  jobRows = [jobRow()];
});

function patchesFor(analysisId: string): Array<Record<string, unknown>> {
  return updateAnalysis.mock.calls
    .filter((call) => (call as unknown[])[0] === analysisId)
    .map((call) => (call as unknown[])[1] as Record<string, unknown>);
}

/* ------------------------------------------------------------------ */
/* The branch                                                          */
/* ------------------------------------------------------------------ */

describe("eval:budget, a job past its lifetime", () => {
  it("is older than the lifetime, which is the premise", () => {
    expect(Date.now() - Date.parse(CREATED_AT)).toBeGreaterThan(JOB_LIFETIME_MS);
  });

  it("reads the task once more instead of closing it blind", async () => {
    readTask.mockResolvedValue(snapshot("succeeded"));
    await pollCaptureJobs({ session, capture });
    expect(readTask).toHaveBeenCalledTimes(1);
    expect(readTask).toHaveBeenCalledWith({ kind: "attributes", taskId: TASK_ID });
  });

  it("stores a result that landed late, and reconciles rather than refunds", async () => {
    readTask.mockResolvedValue(snapshot("succeeded"));
    await pollCaptureJobs({ session, capture });

    const patches = analysisPatches();
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      status: "succeeded",
      credits_used: 20,
      error: null,
    });
    // The engine's own reading of the frame travels into the row unchanged.
    expect(patches[0]?.raw).toMatchObject({ face_quality: { faceangle: "good" } });

    // The money: spent, as it was, and never written back into the ledger.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();

    // The person is never told it did not respond in time. It did.
    for (const patch of patches) {
      expect(patch.error).not.toBe(copy.errors.providerTimeout);
    }
    expect(updateJob).toHaveBeenCalledWith(JOB_ID, { status: "succeeded", error: null });
  });

  it("refunds a refusal that landed late, with the refusal note and its elapsed time", async () => {
    readTask.mockResolvedValue(snapshot("failed", "error_face_angle_rightward"));
    await pollCaptureJobs({ session, capture });

    expect(refund).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();

    const patch = analysisPatches()[0];
    expect(patch).toMatchObject({
      status: "failed",
      credits_used: 0,
      error: copy.capture.facingAway,
    });
    const raw = patch?.raw as { refusal: { reason: string; code: string; elapsed_ms: number } };
    expect(raw.refusal.reason).toBe("face_angle");
    expect(raw.refusal.code).toBe("error_face_angle_rightward");
    // Measured from the job row's creation: about five minutes here.
    expect(raw.refusal.elapsed_ms).toBeGreaterThanOrEqual(300_000);
    expect(raw.refusal.elapsed_ms).toBeLessThan(330_000);
    // No poll counter exists on the jobs table, so none is claimed.
    expect(raw.refusal).not.toHaveProperty("poll_count");
  });

  it("closes a task that is still running as charged, with the timeout line", async () => {
    readTask.mockResolvedValue(snapshot("running"));
    await pollCaptureJobs({ session, capture });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(analysisPatches()[0]).toMatchObject({
      status: "failed",
      credits_used: 20,
      error: copy.errors.providerTimeout,
    });
    expect(updateJob).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error: copy.errors.providerTimeout,
      attempts: 2,
    });
  });

  it("closes as charged when the last read itself does not answer", async () => {
    readTask.mockRejectedValue(
      new ProviderError({
        provider: "perfectcorp",
        code: "request_timeout",
        message: "timed out",
      }),
    );
    await pollCaptureJobs({ session, capture });

    // The task is in the state it was in before the read: unread and charged.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(analysisPatches()[0]).toMatchObject({
      status: "failed",
      error: copy.errors.providerTimeout,
    });
  });

  it("closes as charged when the last read fails for a reason that is not transient", async () => {
    /*
     * A 400 on the status GET (the provider no longer serves the task, or the
     * envelope did not parse) says nothing about whether the task ran. Before
     * the review of 2026-09-23 this throw reached failJob and refunded a task
     * the provider may well have charged for. An unknown result is a charged
     * one, which is failChargedJob's own rule.
     */
    readTask.mockRejectedValue(
      new ProviderError({
        provider: "perfectcorp",
        code: "provider_error",
        status: 400,
        message: "task not found",
      }),
    );
    await pollCaptureJobs({ session, capture });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    expect(analysisPatches()[0]).toMatchObject({
      status: "failed",
      credits_used: 20,
      error: copy.errors.providerTimeout,
    });
    expect(updateJob).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error: copy.errors.providerTimeout,
      attempts: 2,
    });
  });

  it("closes the follower of a late leader unstarted and unpaid, and never starts it", async () => {
    /*
     * Every job of a capture is written at analyze time, so a follower is as old
     * as its leader and expires in the same pass. The leader's late result is
     * kept and paid for; the follower, which has no task and no reservation, is
     * closed with the timeout line and credits_used 0, and the fan out that
     * follows a leader success finds it no longer pending and leaves it alone.
     */
    analysisRows = [analysisRow(), followerAnalysisRow()];
    jobRows = [jobRow(), followerJobRow()];
    readTask.mockResolvedValue(snapshot("succeeded"));
    await pollCaptureJobs({ session, capture });

    // The leader: stored, reconciled, never refunded.
    expect(patchesFor(ANALYSIS_ID)[0]).toMatchObject({ status: "succeeded", credits_used: 20 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();

    // The follower: closed, charged nothing, because nothing was reserved.
    expect(patchesFor(FOLLOWER_ANALYSIS_ID)).toEqual([
      { status: "failed", error: copy.errors.providerTimeout, credits_used: 0 },
    ]);
    expect(updateJob).toHaveBeenCalledWith(FOLLOWER_JOB_ID, {
      status: "failed",
      error: copy.errors.providerTimeout,
      attempts: 2,
    });

    // And no unit was spent starting it: no upload, no task.
    expect(uploadCapture).not.toHaveBeenCalled();
    expect(startTask).not.toHaveBeenCalled();
  });
});
