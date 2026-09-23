import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the scheduled reconcile pass.
 *
 * Until 2026-09-23 the client poll was the only thing that advanced a reading.
 * A tab backgrounded on /analyzing stopped asking, the task at the provider ran
 * to completion, was charged (docs/04-integrations.md: polling is mandatory,
 * an unpolled task consumes its units), and was never read. pg_cron now calls
 * POST /api/jobs/reconcile every minute, and the route runs
 * reconcileOpenCaptures: open analysis jobs nobody is polling, grouped by
 * capture, each polled once with the owner's session rebuilt from the row.
 *
 * Every database call and the poll itself are mocks. No key, no network, no
 * credit. What is checked here is the pass's own arithmetic: grouping, session
 * rebuilding, the limit, the budget, the counts, and that one capture's failure
 * never ends the pass for the rest.
 */

vi.mock("server-only", () => ({}));

/** session.ts reads the cookie store for the request path; this pass has none. */
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

/* ------------------------------------------------------------------ */
/* The rows                                                            */
/* ------------------------------------------------------------------ */

const USER_OWNER = "00000000-0000-4000-8000-00000000000a";
const JUDGE_OWNER = "00000000-0000-4000-8000-00000000000b";
const GONE_OWNER = "00000000-0000-4000-8000-00000000000c";
const CAPTURE_A = "11111111-1111-4111-8111-111111111111";
const CAPTURE_B = "22222222-2222-4222-8222-222222222222";

const AT = "2026-09-23T10:00:00.000Z";

interface AnalysisRowLike {
  readonly id: string;
  readonly capture_id: string;
  readonly user_id: string;
}

interface JobRowLike {
  readonly id: string;
  readonly user_id: string;
  readonly subject_type: "analysis";
  readonly subject_id: string | null;
  readonly status: "pending" | "running";
  readonly provider_task_id: string | null;
  readonly attempts: number;
  readonly last_polled_at: string | null;
  readonly error: null;
  readonly created_at: string;
  readonly updated_at: string;
}

function analysisRow(id: string, captureId: string, ownerId: string) {
  return {
    id,
    capture_id: captureId,
    user_id: ownerId,
    kind: "attributes",
    status: "running",
    provider_task_id: `task-${id}`,
    raw: null,
    summary: null,
    mask_paths: null,
    credits_used: 20,
    error: null,
    created_at: AT,
    updated_at: AT,
  };
}

function jobRow(
  id: string,
  analysis: AnalysisRowLike,
  status: "pending" | "running" = "running",
): JobRowLike {
  return {
    id,
    user_id: analysis.user_id,
    subject_type: "analysis",
    subject_id: analysis.id,
    status,
    provider_task_id: status === "running" ? `task-${analysis.id}` : null,
    attempts: status === "running" ? 1 : 0,
    last_polled_at: null,
    error: null,
    created_at: AT,
    updated_at: AT,
  };
}

function captureRow(id: string, ownerId: string) {
  return {
    id,
    user_id: ownerId,
    sha256: "a".repeat(64),
    storage_path: `${ownerId}/${id}.jpg`,
    width: 1080,
    height: 1440,
    quality: null,
    deleted_at: null,
    created_at: AT,
    updated_at: AT,
  };
}

function judgeRow(id: string) {
  return {
    id,
    code_hash: "not a hash",
    expires_at: "2099-01-01T00:00:00.000Z",
    analyses_allowed: 3,
    analyses_used: 1,
    credits_cap: 120,
    credits_used: 20,
    last_seen_at: null,
    consent_at: AT,
    consent_version: "v2",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: AT,
    updated_at: AT,
  };
}

function profileRow(userId: string) {
  return {
    user_id: userId,
    consent_at: AT,
    consent_version: "v2",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: AT,
    updated_at: AT,
  };
}

/** Two captures: A is a judge's with two open jobs, B is a person's with one. */
const A1 = analysisRow("a1", CAPTURE_A, JUDGE_OWNER);
const A2 = { ...analysisRow("a2", CAPTURE_A, JUDGE_OWNER), kind: "skin", status: "pending" };
const B1 = analysisRow("b1", CAPTURE_B, USER_OWNER);

/* ------------------------------------------------------------------ */
/* The mocks                                                           */
/* ------------------------------------------------------------------ */

let openJobs: JobRowLike[] = [];
let analyses: Array<ReturnType<typeof analysisRow>> = [];
let captures = new Map<string, ReturnType<typeof captureRow>>();
let judgeSessions = new Map<string, ReturnType<typeof judgeRow>>();
let profiles = new Map<string, ReturnType<typeof profileRow>>();

/** The limit is asserted on the call, so the signature does not name it. */
const listOpenAnalysisJobs = vi.fn(async () => openJobs);
const listAnalysesByIds = vi.fn(async (ids: readonly string[]) =>
  analyses.filter((row) => ids.includes(row.id)),
);
const getCapture = vi.fn(async (ownerId: string, captureId: string) => {
  const capture = captures.get(captureId);
  return capture !== undefined && capture.user_id === ownerId ? capture : null;
});
const getProfile = vi.fn(async (userId: string) => profiles.get(userId) ?? null);

vi.mock("@/lib/server/db", () => ({
  getCapture: (...args: unknown[]) =>
    (getCapture as unknown as (...a: unknown[]) => unknown)(...args),
  getProfile: (...args: unknown[]) =>
    (getProfile as unknown as (...a: unknown[]) => unknown)(...args),
  listAnalysesByIds: (...args: unknown[]) =>
    (listAnalysesByIds as unknown as (...a: unknown[]) => unknown)(...args),
  listOpenAnalysisJobs: (...args: unknown[]) =>
    (listOpenAnalysisJobs as unknown as (...a: unknown[]) => unknown)(...args),
}));

const loadJudgeSession = vi.fn(async (id: string) => judgeSessions.get(id) ?? null);

vi.mock("@/lib/server/judge", () => ({
  JUDGE_SESSION_COOKIE: "aurum_judge",
  loadJudgeSession: (...args: unknown[]) =>
    (loadJudgeSession as unknown as (...a: unknown[]) => unknown)(...args),
  touchJudgeSession: vi.fn(),
}));

interface PollInputLike {
  readonly session: { kind: string; id: string; ownerType: string };
  readonly capture: { id: string };
  readonly onProviderCall?: (count: number) => void;
}

/** What the mocked poll answers per capture id: the job statuses afterwards. */
let pollOutcome = new Map<string, Array<{ id: string; status: string }>>();
let pollThrowsFor = new Set<string>();

const pollCaptureJobs = vi.fn(async (input: PollInputLike) => {
  if (pollThrowsFor.has(input.capture.id)) {
    throw new Error("provider unreachable");
  }
  input.onProviderCall?.(1);
  return {
    captureId: input.capture.id,
    jobs: pollOutcome.get(input.capture.id) ?? [],
    complete: false,
    source: "live",
    maskUrl: null,
  };
});

vi.mock("@/lib/server/jobs", () => ({
  pollCaptureJobs: (...args: unknown[]) =>
    (pollCaptureJobs as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { reconcileOpenCaptures, RECONCILE_BUDGET_MS, RECONCILE_CAPTURES_PER_PASS } =
  await import("@/lib/server/jobs/reconcile");
const { sessionForOwner } = await import("@/lib/server/session");

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

function passLine(): Record<string, unknown> | null {
  const line = log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .map((text: string) => JSON.parse(text) as Record<string, unknown>)
    .find(
      (entry: Record<string, unknown>) => entry.event === "aurum.reconcile_pass",
    );
  return line ?? null;
}

function polledCaptureIds(): string[] {
  return pollCaptureJobs.mock.calls.map((call) => call[0].capture.id);
}

function sessionPassedFor(captureId: string): PollInputLike["session"] | undefined {
  return pollCaptureJobs.mock.calls.find((call) => call[0].capture.id === captureId)?.[0]
    .session;
}

async function run(overrides: { limit?: number; budgetMs?: number; now?: () => number } = {}) {
  return reconcileOpenCaptures({
    limit: overrides.limit ?? RECONCILE_CAPTURES_PER_PASS,
    budgetMs: overrides.budgetMs ?? RECONCILE_BUDGET_MS,
    now: overrides.now,
  });
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  listOpenAnalysisJobs.mockClear();
  listAnalysesByIds.mockClear();
  getCapture.mockClear();
  getProfile.mockClear();
  loadJudgeSession.mockClear();
  pollCaptureJobs.mockClear();

  analyses = [A1, A2, B1];
  openJobs = [jobRow("job-a1", A1), jobRow("job-a2", A2, "pending"), jobRow("job-b1", B1)];
  captures = new Map([
    [CAPTURE_A, captureRow(CAPTURE_A, JUDGE_OWNER)],
    [CAPTURE_B, captureRow(CAPTURE_B, USER_OWNER)],
  ]);
  judgeSessions = new Map([[JUDGE_OWNER, judgeRow(JUDGE_OWNER)]]);
  profiles = new Map([[USER_OWNER, profileRow(USER_OWNER)]]);
  pollOutcome = new Map();
  pollThrowsFor = new Set();
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
});

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

describe("eval:budget, the scheduled reconcile pass", () => {
  it("runs 25 captures at most, inside 45 seconds, which is what the plan set", () => {
    expect(RECONCILE_CAPTURES_PER_PASS).toBe(25);
    expect(RECONCILE_BUDGET_MS).toBe(45_000);
  });

  it("polls nothing and logs zeros when no job is open", async () => {
    openJobs = [];
    const counts = await run();
    expect(counts).toEqual({ captures: 0, polled: 0, settled: 0, providerCalls: 0, errors: 0 });
    expect(pollCaptureJobs).not.toHaveBeenCalled();
    expect(getCapture).not.toHaveBeenCalled();
    expect(passLine()).toEqual({ event: "aurum.reconcile_pass", ...counts, source: "cron" });
  });

  it("groups open jobs by capture and polls each capture once", async () => {
    // Three jobs, two captures: A carries two of them and is polled once.
    const counts = await run();
    expect(polledCaptureIds()).toEqual([CAPTURE_A, CAPTURE_B]);
    expect(counts.captures).toBe(2);
    expect(counts.polled).toBe(2);
    expect(counts.errors).toBe(0);
  });

  it("asks the database for at most the limit", async () => {
    await run({ limit: 7 });
    expect(listOpenAnalysisJobs).toHaveBeenCalledTimes(1);
    expect(listOpenAnalysisJobs).toHaveBeenCalledWith(7);
  });

  it("joins the listed jobs to their analyses, and only theirs", async () => {
    await run();
    expect(listAnalysesByIds).toHaveBeenCalledWith(["a1", "a2", "b1"]);
  });

  it("rebuilds a judge session when one is live, and a user session otherwise", async () => {
    await run();
    // The judge: the same shape the cookie path builds, row included, so the
    // ledger and the judge counter settle under the right owner.
    expect(sessionPassedFor(CAPTURE_A)).toEqual({
      kind: "judge",
      id: JUDGE_OWNER,
      ownerType: "judge_session",
      session: judgeRow(JUDGE_OWNER),
    });
    // The person: the plain user shape.
    expect(sessionPassedFor(CAPTURE_B)).toEqual({
      kind: "user",
      id: USER_OWNER,
      ownerType: "user",
    });
  });

  it("reads the capture under its owner, never unscoped", async () => {
    await run();
    expect(getCapture).toHaveBeenCalledWith(JUDGE_OWNER, CAPTURE_A);
    expect(getCapture).toHaveBeenCalledWith(USER_OWNER, CAPTURE_B);
  });

  it("counts a job as settled only when its poll left it terminal", async () => {
    pollOutcome = new Map([
      [
        CAPTURE_A,
        [
          { id: "job-a1", status: "succeeded" },
          { id: "job-a2", status: "running" },
        ],
      ],
      [CAPTURE_B, [{ id: "job-b1", status: "failed" }]],
    ]);
    const counts = await run();
    expect(counts.settled).toBe(2);
  });

  it("does not count a job it did not list, even when the poll reports it terminal", async () => {
    // A job that was already terminal before the pass is not the pass's doing.
    pollOutcome = new Map([
      [CAPTURE_A, [{ id: "job-old", status: "succeeded" }]],
    ]);
    const counts = await run();
    expect(counts.settled).toBe(0);
  });

  it("sums the provider calls the polls made", async () => {
    const counts = await run();
    // The mocked poll reports one call per capture.
    expect(counts.providerCalls).toBe(2);
  });

  it("stops taking captures when the budget is spent, and says how many it reached", async () => {
    // The clock: the pass starts at 0, checks the budget before each capture,
    // and by the second check the first capture has taken longer than the
    // whole budget.
    const ticks = [0, 0, RECONCILE_BUDGET_MS + 1];
    const now = () => ticks.shift() ?? RECONCILE_BUDGET_MS + 1;
    const counts = await run({ now });
    expect(polledCaptureIds()).toEqual([CAPTURE_A]);
    expect(counts.captures).toBe(2);
    expect(counts.polled).toBe(1);
    expect(counts.errors).toBe(0);
  });

  it("keeps going when one capture's poll throws, and counts it", async () => {
    pollThrowsFor = new Set([CAPTURE_A]);
    const counts = await run();
    expect(polledCaptureIds()).toEqual([CAPTURE_A, CAPTURE_B]);
    expect(counts.polled).toBe(1);
    expect(counts.errors).toBe(1);
    const failed = warn.mock.calls
      .map(
        (call: unknown[]) =>
          JSON.parse(String(call[0])) as Record<string, unknown>,
      )
      .find(
        (entry: Record<string, unknown>) =>
          entry.event === "aurum.reconcile_capture_failed",
      );
    expect(failed).toEqual({
      event: "aurum.reconcile_capture_failed",
      captureId: CAPTURE_A,
      reason: "Error",
    });
  });

  it("skips a capture whose row is gone and counts it", async () => {
    captures.delete(CAPTURE_A);
    const counts = await run();
    expect(polledCaptureIds()).toEqual([CAPTURE_B]);
    expect(counts.errors).toBe(1);
    expect(counts.polled).toBe(1);
  });

  it("leaves a job whose analysis is gone to the lifetime timeout", async () => {
    analyses = [B1];
    const counts = await run();
    expect(polledCaptureIds()).toEqual([CAPTURE_B]);
    expect(counts.captures).toBe(1);
  });

  it("polls a capture first when its job has waited longest", async () => {
    // The list is ordered by the database (last_polled_at nulls first); the
    // pass keeps that order rather than re sorting by capture id.
    openJobs = [jobRow("job-b1", B1), jobRow("job-a1", A1)];
    await run();
    expect(polledCaptureIds()).toEqual([CAPTURE_B, CAPTURE_A]);
  });
});

/* ------------------------------------------------------------------ */
/* The owner's session, rebuilt from a row                             */
/* ------------------------------------------------------------------ */

describe("sessionForOwner", () => {
  it("answers a judge context for a live judge session", async () => {
    const session = await sessionForOwner(JUDGE_OWNER);
    expect(session).toEqual({
      kind: "judge",
      id: JUDGE_OWNER,
      ownerType: "judge_session",
      session: judgeRow(JUDGE_OWNER),
    });
    // Nothing else was looked up: the judge is known from the first read.
    expect(getProfile).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers the user shape for a person with a profile, without a warning", async () => {
    const session = await sessionForOwner(USER_OWNER);
    expect(session).toEqual({ kind: "user", id: USER_OWNER, ownerType: "user" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the user shape for an owner that is neither, and logs it", async () => {
    // An expired judge session: loadJudgeSession hides it, and a judge never
    // has a profiles row. The ledger still settles as charged under this shape;
    // the fallback is logged so it can be counted.
    const session = await sessionForOwner(GONE_OWNER);
    expect(session).toEqual({ kind: "user", id: GONE_OWNER, ownerType: "user" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "aurum.reconcile_owner_fallback",
      ownerId: GONE_OWNER,
    });
  });
});
