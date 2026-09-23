import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the door to the scheduled reconcile pass.
 *
 * POST /api/jobs/reconcile is called by pg_cron through pg_net with a bearer
 * and nothing else: no session, no cookie, no person. The route must therefore
 * be a wall to anyone without the bearer, and must be visibly off when the
 * bearer is not configured. What is checked here: 401 for a missing or wrong
 * bearer with no database call, 503 when JOBS_RECONCILE_SECRET is unset, 200
 * skipped under the kill switch with nothing polled, and the one pass with
 * the plan's limit and budget otherwise.
 *
 * The database client is a mock that throws when touched, so "touches nothing"
 * is a failing test rather than a comment.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  secret: null as string | null,
  providerCalls: true,
}));

vi.mock("@/lib/server/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/server/env")>();
  return {
    ...original,
    jobsReconcileSecret: () => state.secret,
    providerCallsEnabled: () => state.providerCalls,
  };
});

const serviceClient = vi.fn(() => {
  throw new Error("the database was touched");
});

vi.mock("@/lib/server/db/service", () => ({
  DatabaseError: class DatabaseError extends Error {},
  isDatabaseError: () => false,
  serviceClient: (...args: unknown[]) =>
    (serviceClient as unknown as (...a: unknown[]) => unknown)(...args),
  UNIQUE_VIOLATION: "23505",
  unwrap: (_operation: string, result: { data: unknown }) => result.data,
  unwrapNullable: (_operation: string, result: { data: unknown }) => result.data,
}));

const getSession = vi.fn(async () => null);

vi.mock("@/lib/server/session", () => ({
  getConsent: vi.fn(),
  getSession: (...args: unknown[]) =>
    (getSession as unknown as (...a: unknown[]) => unknown)(...args),
  sessionForOwner: vi.fn(),
}));

const reconcileOpenCaptures = vi.fn();

vi.mock("@/lib/server/jobs/reconcile", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/server/jobs/reconcile")>();
  return {
    ...original,
    reconcileOpenCaptures: (...args: unknown[]) =>
      (reconcileOpenCaptures as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const { NextRequest } = await import("next/server");
const { POST, dynamic, maxDuration, runtime } = await import(
  "@/app/api/jobs/reconcile/route"
);
const { messages } = await import("@/lib/server/http/messages");
const { RECONCILE_BUDGET_MS, RECONCILE_CAPTURES_PER_PASS } = await import(
  "@/lib/server/jobs/reconcile"
);

const SECRET = "a-long-random-value-that-only-the-scheduler-holds";

const COUNTS = { captures: 2, polled: 2, settled: 3, providerCalls: 4, errors: 0 };

function call(headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/jobs/reconcile", {
      method: "POST",
      headers,
    }),
  );
}

function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  state.secret = SECRET;
  state.providerCalls = true;
  serviceClient.mockClear();
  getSession.mockClear();
  reconcileOpenCaptures.mockReset();
  reconcileOpenCaptures.mockResolvedValue(COUNTS);
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
});

function warned(event: string): boolean {
  return warn.mock.calls.some(
    (entry: unknown[]) =>
      (JSON.parse(String(entry[0])) as { event: string }).event === event,
  );
}

describe("eval:budget, POST /api/jobs/reconcile", () => {
  it("declares the node runtime, no caching, and the same budget as the poll route", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBe(60);
  });

  it("answers 503 while the secret is unset, whatever the bearer says, and touches nothing", async () => {
    state.secret = null;
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: messages.notConfigured });
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
    // The deployment is visibly without its driver.
    expect(warned("aurum.reconcile_not_configured")).toBe(true);
  });

  it("answers 401 without a bearer and touches nothing", async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: messages.reconcileUnauthorized });
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers 401 for a wrong bearer of the same length", async () => {
    const wrong = `${SECRET.slice(0, -1)}X`;
    expect(wrong).toHaveLength(SECRET.length);
    const response = await call(bearer(wrong));
    expect(response.status).toBe(401);
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("answers 401 for a wrong bearer of another length", async () => {
    const response = await call(bearer(`${SECRET}-and-more`));
    expect(response.status).toBe(401);
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("answers 401 for the right value in the wrong shape", async () => {
    // The secret without the scheme, and the secret under another scheme.
    expect((await call({ authorization: SECRET })).status).toBe(401);
    expect((await call({ authorization: `Basic ${SECRET}` })).status).toBe(401);
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("never reads a cookie or a session, even on the way in", async () => {
    await call(bearer(SECRET));
    expect(getSession).not.toHaveBeenCalled();
  });

  it("answers 200 skipped under the kill switch and polls nothing", async () => {
    state.providerCalls = false;
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skipped: "kill_switch" });
    expect(reconcileOpenCaptures).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("runs one pass with the plan's limit and budget, and answers its counts", async () => {
    const response = await call(bearer(SECRET));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(COUNTS);
    expect(reconcileOpenCaptures).toHaveBeenCalledTimes(1);
    expect(reconcileOpenCaptures).toHaveBeenCalledWith({
      limit: RECONCILE_CAPTURES_PER_PASS,
      budgetMs: RECONCILE_BUDGET_MS,
      source: "cron",
    });
    expect(RECONCILE_CAPTURES_PER_PASS).toBe(25);
    expect(RECONCILE_BUDGET_MS).toBe(45_000);
  });

  it("reports the pass's provider calls on the request log line", async () => {
    await call(bearer(SECRET));
    const line = log.mock.calls
      .map(
        (entry: unknown[]) =>
          JSON.parse(String(entry[0])) as Record<string, unknown>,
      )
      .find(
        (entry: Record<string, unknown>) => entry.event === "aurum.request",
      );
    expect(line).toMatchObject({
      route: "/api/jobs/reconcile",
      status: 200,
      sessionKind: "none",
      providerCalls: COUNTS.providerCalls,
    });
  });
});
