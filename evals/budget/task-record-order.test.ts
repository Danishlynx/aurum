import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, where the provider task id is written first.
 *
 * A task exists at the provider from the moment createTask answers, charged
 * whether or not anything ever reads it. The only thing that makes it readable
 * is jobs.provider_task_id: the client poll and the scheduled reconcile pass
 * both start from the job row. Until 2026-09-23 the analysis row was written
 * first and the job row second, so a process killed between the two left an
 * analysis that said running with a task id and no job row at all. Nothing
 * listed it, nothing polled it, and a second analyze call found no open job
 * and bought the reading again.
 *
 * The job row now goes first, and the analysis write is a compare and set on
 * updated_at so a poll that settles the task in the gap is never overwritten.
 * This suite pins both. Every provider and database call is a mock; nothing
 * here spends a unit.
 */

vi.mock("server-only", () => ({}));

const OWNER = "00000000-0000-4000-8000-00000000000a";
const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "pc-task-first";
const FILE_ID = "pc-file-1";
const AT = "2026-09-23T10:00:00.000Z";
/** What the database stamped on the leader row when it was read. */
const LEADER_UPDATED_AT = "2026-09-23T10:00:00.123456+00:00";

const KINDS = ["skin", "fitzpatrick", "attributes", "face_shape", "hair_type"] as const;

function analysisFor(kind: (typeof KINDS)[number]) {
  return {
    id: `analysis-${kind}`,
    capture_id: CAPTURE_ID,
    user_id: OWNER,
    kind,
    status: "pending" as const,
    provider_task_id: null,
    raw: null,
    summary: null,
    mask_paths: null,
    credits_used: 0,
    error: null,
    created_at: AT,
    updated_at: kind === "attributes" ? LEADER_UPDATED_AT : AT,
  };
}

const capture = {
  id: CAPTURE_ID,
  user_id: OWNER,
  sha256: "a".repeat(64),
  storage_path: `${OWNER}/${CAPTURE_ID}.jpg`,
  width: 1080,
  height: 1440,
  quality: null,
  deleted_at: null,
  created_at: AT,
  updated_at: AT,
};

const session = { kind: "user" as const, id: OWNER, ownerType: "user" as const };

/* ------------------------------------------------------------------ */
/* The mocks                                                           */
/* ------------------------------------------------------------------ */

const insertJob = vi.fn(async (row: Record<string, unknown>) => ({
  id: `job-${String(row.subject_id)}`,
  last_polled_at: null,
  created_at: AT,
  updated_at: AT,
  ...row,
}));
/** Typed on the real signature so the guard argument can be asserted. */
const updateAnalysis = vi.fn<
  (
    analysisId: string,
    patch: Record<string, unknown>,
    guard?: { readonly unchangedSince: string },
  ) => Promise<boolean>
>(async () => true);
const updateJob = vi.fn(async () => null);

vi.mock("@/lib/server/db", () => ({
  ensureAnalysis: async (args: { kind: (typeof KINDS)[number] }) => analysisFor(args.kind),
  findJobForSubject: async () => null,
  getCapture: async () => capture,
  insertJob: (...args: unknown[]) =>
    (insertJob as unknown as (...a: unknown[]) => unknown)(...args),
  listAnalyses: async () => KINDS.map(analysisFor),
  listJobsForSubjects: async () => [],
  updateAnalysis: (...args: unknown[]) =>
    (updateAnalysis as unknown as (...a: unknown[]) => unknown)(...args),
  updateJob: (...args: unknown[]) =>
    (updateJob as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("@/lib/server/db/service", () => ({
  serviceClient: () => {
    throw new Error("the create path never claims a job");
  },
  unwrap: (_operation: string, result: { data: unknown }) => result.data,
  unwrapNullable: (_operation: string, result: { data: unknown }) => result.data,
}));

vi.mock("@/lib/server/db/storage", () => ({
  BUCKETS: { captures: "captures", masks: "masks" },
  createSignedRead: async () => "https://example.invalid/mask.png",
  downloadObject: async () => ({
    bytes: new Uint8Array([0xff, 0xd8, 0xff]),
    contentType: "image/jpeg",
  }),
}));

/** The bytes are not a JPEG here; the header check is not what this suite is about. */
vi.mock("@/lib/server/capture/validate", () => ({
  validateCaptureObject: () => undefined,
}));

const refund = vi.fn(async () => undefined);
const reserve = vi.fn(async (args: { units: number; subjectId: string }) => ({
  ok: true as const,
  reservation: {
    id: `ledger-${args.subjectId}`,
    owner: { ownerType: "user", ownerId: OWNER },
    provider: "perfectcorp",
    units: args.units,
    subjectId: args.subjectId,
  },
}));

vi.mock("@/lib/server/credits", () => ({
  findReservation: async () => null,
  refund: (...args: unknown[]) =>
    (refund as unknown as (...a: unknown[]) => unknown)(...args),
  reconcile: vi.fn(),
  reserve: (...args: unknown[]) =>
    (reserve as unknown as (...a: unknown[]) => unknown)(...args),
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

const startTask = vi.fn(async () => ({ taskId: TASK_ID }));

vi.mock("@/lib/server/jobs/analysis", () => ({
  normalize: vi.fn(),
  persistMasks: async () => [],
  planFor: (kind: string) => ({
    kind,
    endpointKey: "facialColorTones",
    itemCount: 1,
    units: kind === "attributes" ? 20 : 10,
  }),
  readTask: vi.fn(),
  requiresMorePhotos: (kind: string) => kind === "hair_type",
  startTask: (...args: unknown[]) =>
    (startTask as unknown as (...a: unknown[]) => unknown)(...args),
  uploadCapture: async () => FILE_ID,
}));

const { createAnalysisJobs } = await import("@/lib/server/jobs");

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  insertJob.mockClear();
  updateAnalysis.mockClear();
  updateAnalysis.mockResolvedValue(true);
  updateJob.mockClear();
  refund.mockClear();
  reserve.mockClear();
  startTask.mockClear();
});

afterEach(() => {
  warn.mockRestore();
});

/** The insertJob call that recorded the leader's task, if any. */
function leaderJobWrite() {
  return insertJob.mock.calls.find(
    (call) =>
      (call[0] as { provider_task_id: unknown }).provider_task_id === TASK_ID,
  );
}

/** The updateAnalysis call that marked the leader running, if any. */
function leaderAnalysisWrite() {
  return updateAnalysis.mock.calls.find(
    (call) =>
      (call as unknown[])[0] === "analysis-attributes" &&
      ((call as unknown[])[1] as { status?: string }).status === "running",
  );
}

function orderOf(mock: { mock: { invocationCallOrder: number[]; calls: unknown[][] } }, call: unknown[] | undefined): number {
  const index = mock.mock.calls.findIndex((entry) => entry === call);
  return mock.mock.invocationCallOrder[index] ?? -1;
}

describe("eval:budget, recording a started task", () => {
  it("writes the task id to the job row before the analysis row", async () => {
    await createAnalysisJobs({ session, capture });

    expect(startTask).toHaveBeenCalledTimes(1);
    const jobWrite = leaderJobWrite();
    const analysisWrite = leaderAnalysisWrite();
    expect(jobWrite).toBeDefined();
    expect(analysisWrite).toBeDefined();

    // The job row: running, pointing at the task, first attempt.
    expect(jobWrite?.[0]).toMatchObject({
      user_id: OWNER,
      subject_type: "analysis",
      subject_id: "analysis-attributes",
      status: "running",
      provider_task_id: TASK_ID,
      attempts: 1,
    });

    // Then the analysis row, with the units the reservation holds.
    expect(analysisWrite?.[1]).toEqual({
      status: "running",
      provider_task_id: TASK_ID,
      credits_used: 20,
      error: null,
    });

    // The order is the whole point: a kill between the two leaves a job the
    // next poll can read, never an analysis nothing lists.
    expect(orderOf(insertJob, jobWrite)).toBeLessThan(
      orderOf(updateAnalysis, analysisWrite),
    );
  });

  it("guards the analysis write on the row it read, so a poll that got there first is kept", async () => {
    await createAnalysisJobs({ session, capture });
    const analysisWrite = leaderAnalysisWrite();
    expect(analysisWrite?.[2]).toEqual({ unchangedSince: LEADER_UPDATED_AT });
  });

  it("logs a start the poll overtook, and treats it as started rather than failed", async () => {
    // The database says zero rows matched: a poll read the task and stored the
    // result between the two writes. The reading is stored and paid for, which
    // is what the start was for, so nothing is refunded and no job is failed.
    updateAnalysis.mockImplementation(async (...args: unknown[]) => {
      const patch = args[1] as { status?: string };
      return patch.status === "running" ? false : true;
    });
    await createAnalysisJobs({ session, capture });

    expect(refund).not.toHaveBeenCalled();
    const failedLeader = insertJob.mock.calls.find(
      (call) =>
        (call[0] as { subject_id: string; status: string }).subject_id ===
          "analysis-attributes" &&
        (call[0] as { status: string }).status === "failed",
    );
    expect(failedLeader).toBeUndefined();
    const superseded = warn.mock.calls
      .map(
        (call: unknown[]) =>
          JSON.parse(String(call[0])) as Record<string, unknown>,
      )
      .find(
        (entry: Record<string, unknown>) =>
          entry.event === "aurum.analysis_start_superseded",
      );
    expect(superseded).toMatchObject({ captureId: CAPTURE_ID, kind: "attributes" });
  });
});
