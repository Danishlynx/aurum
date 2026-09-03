import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the two currencies a judge session spends.
 *
 * The bug this pins, seen in production: the report logged
 * {"event":"aurum.grounding","reason":"session_cap","steps":5,"searches":0} and
 * every routine step showed "No listing found near you yet". A Perfect Corp unit
 * and a SerpApi search were both spent from judge_sessions.credits_used, and
 * JUDGE_CREDITS_CAP is sized in Perfect Corp units (docs/04-integrations.md: one
 * capture set is 58 of them, three sessions want 231). So a session that had run
 * its analyses had no room left to buy a single search with, and the grounding
 * layer, which runs last, was refused before it sent anything.
 *
 * They are separate caps now: units against the session column, searches against
 * their own allowance, counted from this session's own ledger rows.
 */

vi.mock("server-only", () => ({}));

interface LedgerRow {
  readonly provider: string;
  readonly units: number;
}

let rows: LedgerRow[] = [];
let inserted: { provider?: string; units?: number }[] = [];

/**
 * The smallest thing that answers like the PostgREST builder the ledger uses:
 * a chain that remembers which provider it was filtered on and resolves to the
 * matching rows, or to the inserted row when the chain was an insert.
 */
function builder(): Record<string, unknown> {
  let provider = "";
  let isInsert = false;
  const chain: Record<string, unknown> = {};
  const self = (): Record<string, unknown> => chain;

  Object.assign(chain, {
    select: self,
    order: self,
    maybeSingle: self,
    single: self,
    gte: self,
    eq: (column: string, value: unknown) => {
      if (column === "provider") {
        provider = String(value);
      }
      return chain;
    },
    insert: (row: { provider?: string; units?: number }) => {
      isInsert = true;
      inserted.push(row);
      return chain;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        isInsert
          ? { data: { id: `entry-${inserted.length}`, subject_id: null }, error: null }
          : {
              data: rows
                .filter((row) => row.provider === provider)
                .map((row) => ({ units: row.units })),
              error: null,
            },
      ).then(resolve),
  });
  return chain;
}

vi.mock("@/lib/server/db/service", () => ({
  serviceClient: () => ({ from: () => builder() }),
  unwrap: (_operation: string, result: { data: unknown }) => result.data,
  unwrapNullable: (_operation: string, result: { data: unknown }) => result.data,
}));

const adjustJudgeCredits = vi.fn(async () => ({
  ok: false as const,
  reason: "exhausted" as const,
}));

vi.mock("@/lib/server/judge", () => ({
  adjustJudgeCredits: (...args: unknown[]) =>
    (adjustJudgeCredits as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { reserve, refund } = await import("@/lib/server/credits");
const { dailyCaps, judgeSearchesAllowed } = await import("@/lib/server/env");

/** A judge session that has already spent every Perfect Corp unit it had. */
const SPENT_SESSION = {
  kind: "judge" as const,
  id: "00000000-0000-4000-8000-00000000000a",
  ownerType: "judge_session" as const,
  session: {
    id: "00000000-0000-4000-8000-00000000000a",
    code_hash: "not a hash",
    expires_at: "2099-01-01T00:00:00.000Z",
    analyses_allowed: 3,
    analyses_used: 3,
    credits_cap: 120,
    credits_used: 120,
    last_seen_at: null,
    consent_at: "2026-01-01T00:00:00.000Z",
    consent_version: "2026-01-01",
    is_adult_confirmed: true,
    keep_originals: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  },
};

const TOUCHED = ["JUDGE_SERPAPI_SEARCHES", "DAILY_CAP_SERPAPI_SEARCHES"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  rows = [];
  inserted = [];
  adjustJudgeCredits.mockClear();
  for (const name of TOUCHED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  saved.clear();
});

describe("eval:budget, searches and units are separate caps", () => {
  it("lets a session that has spent every unit still buy a search", async () => {
    // The exact production case: analyses done, report rendering, nothing left
    // in credits_used. The search must go through anyway.
    const outcome = await reserve({
      session: SPENT_SESSION,
      provider: "serpapi",
      units: 1,
      note: "reserve serpapi search",
    });

    expect(outcome.ok).toBe(true);
    expect(adjustJudgeCredits).not.toHaveBeenCalled();
    expect(inserted[0]?.provider).toBe("serpapi");
  });

  it("still refuses a Perfect Corp reservation against the session cap", async () => {
    const outcome = await reserve({
      session: SPENT_SESSION,
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome).toEqual({ ok: false, reason: "session_cap", remaining: 0 });
    expect(adjustJudgeCredits).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  it("gives a judge session a whole report's worth of searches", async () => {
    // 7 routine steps, the makeup shades, the looks gaps, one nearby store
    // lookup, and one broader retry each all have to fit.
    expect(judgeSearchesAllowed()).toBeGreaterThanOrEqual(40);

    rows = Array.from({ length: 39 }, () => ({ provider: "serpapi", units: 1 }));
    const fortieth = await reserve({
      session: SPENT_SESSION,
      provider: "serpapi",
      units: 1,
    });
    expect(fortieth.ok).toBe(true);
  });

  it("stops the session at its own search allowance, not at the unit cap", async () => {
    process.env.JUDGE_SERPAPI_SEARCHES = "2";
    rows = [
      { provider: "serpapi", units: 1 },
      { provider: "serpapi", units: 1 },
    ];

    const outcome = await reserve({
      session: SPENT_SESSION,
      provider: "serpapi",
      units: 1,
    });

    expect(outcome).toEqual({ ok: false, reason: "session_cap", remaining: 0 });
    expect(inserted).toHaveLength(0);
  });

  it("counts only this session's searches, never its Perfect Corp units", async () => {
    process.env.JUDGE_SERPAPI_SEARCHES = "2";
    rows = [
      { provider: "perfectcorp", units: 58 },
      { provider: "anthropic", units: 3 },
      { provider: "serpapi", units: 1 },
    ];

    const outcome = await reserve({
      session: SPENT_SESSION,
      provider: "serpapi",
      units: 1,
    });

    expect(outcome.ok).toBe(true);
  });

  it("gives a refunded search back to the search allowance and to nothing else", async () => {
    rows = [{ provider: "serpapi", units: 1 }];

    await refund({
      session: SPENT_SESSION,
      reservation: {
        id: "entry-1",
        owner: { ownerType: "judge_session", ownerId: SPENT_SESSION.id },
        provider: "serpapi",
        units: 1,
        subjectId: null,
      },
    });

    // A negative serpapi row, and the Perfect Corp counter untouched: moving it
    // here would have handed the session free units it never reserved.
    expect(inserted[0]?.units).toBe(-1);
    expect(inserted[0]?.provider).toBe("serpapi");
    expect(adjustJudgeCredits).not.toHaveBeenCalled();
  });
});

describe("eval:budget, the daily SerpApi cap", () => {
  it("defaults to 120 a day when the environment sets nothing", () => {
    expect(dailyCaps().serpapiSearches).toBe(120);
  });

  it("still lets the deployed environment set the real quota", () => {
    process.env.DAILY_CAP_SERPAPI_SEARCHES = "45";
    expect(dailyCaps().serpapiSearches).toBe(45);
  });

  it("refuses a search past the daily cap before any session cap is read", async () => {
    process.env.DAILY_CAP_SERPAPI_SEARCHES = "1";
    rows = [{ provider: "serpapi", units: 1 }];

    const outcome = await reserve({
      session: SPENT_SESSION,
      provider: "serpapi",
      units: 1,
    });

    expect(outcome).toEqual({ ok: false, reason: "daily_cap", remaining: 0 });
  });
});
