import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the one ceiling that is not per owner.
 *
 * The bug this pins, seen in production on 2026-09-12: the access code is
 * published on the project page, and every submission of it mints a new judge
 * session with a fresh JUDGE_CREDITS_CAP and a fresh DAILY_CAP_PERFECTCORP_UNITS.
 * 44 sessions were created in one afternoon, every one of them inside every cap
 * the app had, and the Perfect Corp account fell from 502 units to 100. Per owner
 * caps answer "how much may this person spend". Nothing answered "how much may
 * everybody spend", and the balance they all draw on is a single number.
 *
 * GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY is that number, checked against every
 * owner's rows for the UTC day at once, before any per owner cap is read.
 */

vi.mock("server-only", () => ({}));

interface LedgerRow {
  readonly ownerId: string;
  readonly provider: string;
  readonly units: number;
}

let rows: LedgerRow[] = [];
let inserted: { provider?: string; units?: number; owner_id?: string }[] = [];

/**
 * The smallest thing that answers like the PostgREST builder the ledger uses,
 * with one addition over the one in search-cap.test.ts: it remembers whether the
 * chain was filtered on owner_id. That is the whole difference between a per
 * owner sum and the deployment wide sum, so a mock that ignored it would pass
 * whether or not the ceiling was global.
 */
function builder(): Record<string, unknown> {
  let provider = "";
  let ownerId: string | null = null;
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
      if (column === "owner_id") {
        ownerId = String(value);
      }
      return chain;
    },
    insert: (row: { provider?: string; units?: number; owner_id?: string }) => {
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
                .filter(
                  (row) =>
                    row.provider === provider &&
                    (ownerId === null || row.ownerId === ownerId),
                )
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

/** Every judge session in these tests has room of its own. The ceiling is not theirs. */
const adjustJudgeCredits = vi.fn(async () => ({ ok: true as const }));

vi.mock("@/lib/server/judge", () => ({
  adjustJudgeCredits: (...args: unknown[]) =>
    (adjustJudgeCredits as unknown as (...a: unknown[]) => unknown)(...args),
}));

const { reserve } = await import("@/lib/server/credits");
const { globalDailyCap, UNITS_PER_CAPTURE_SET } = await import("@/lib/server/env");

const FIRST_OWNER = "00000000-0000-4000-8000-00000000000a";
const SECOND_OWNER = "00000000-0000-4000-8000-00000000000b";

/**
 * A fresh judge session, exactly as the access code mints one: nothing used, a
 * full credits_cap, a full day's DAILY_CAP_PERFECTCORP_UNITS. Two of these is
 * the shape of the incident.
 */
function judgeSession(id: string) {
  return {
    kind: "judge" as const,
    id,
    ownerType: "judge_session" as const,
    session: {
      id,
      code_hash: "not a hash",
      expires_at: "2099-01-01T00:00:00.000Z",
      analyses_allowed: 3,
      analyses_used: 0,
      credits_cap: 120,
      credits_used: 0,
      last_seen_at: null,
      consent_at: "2026-01-01T00:00:00.000Z",
      consent_version: "2026-01-01",
      is_adult_confirmed: true,
      keep_originals: false,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

const TOUCHED = [
  "GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY",
  "DAILY_CAP_PERFECTCORP_UNITS",
  "DAILY_CAP_SERPAPI_SEARCHES",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  rows = [];
  inserted = [];
  adjustJudgeCredits.mockClear();
  for (const name of TOUCHED) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // Per owner room to spare everywhere, so anything refused below is refused by
  // the ceiling and by nothing else.
  process.env.DAILY_CAP_PERFECTCORP_UNITS = "100000";
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

describe("eval:budget, the deployment wide Perfect Corp ceiling", () => {
  it("defaults to ten capture sets a day", () => {
    // Ten full analyses a day across everyone put together. More than a demo day
    // needs, and small enough that a runaway costs at most one day of it.
    // Derived, never written down: a literal here drifted the day the capture
    // set was repriced, and pinned the ceiling to a number that was no longer true.
    expect(globalDailyCap()).toBe(UNITS_PER_CAPTURE_SET * 10);
  });

  it("lets the deployed environment set the real number", () => {
    // The value that should be set, from the balance the account actually holds.
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "180";
    expect(globalDailyCap()).toBe(180);
  });

  it("lets a reservation through while the day still has room", async () => {
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "100";
    rows = [{ ownerId: SECOND_OWNER, provider: "perfectcorp", units: 60 }];

    const outcome = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "perfectcorp",
      units: 20,
    });

    expect(outcome.ok).toBe(true);
    expect(inserted).toHaveLength(1);
  });

  it("refuses the reservation that would cross it, and says what is left", async () => {
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "100";
    rows = [{ ownerId: SECOND_OWNER, provider: "perfectcorp", units: 90 }];

    const outcome = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome).toEqual({ ok: false, reason: "global_cap", remaining: 10 });
    // Refused before any counter moved: no ledger row, and the judge session's
    // own credits_used untouched, so a refusal is never a half spend.
    expect(inserted).toHaveLength(0);
    expect(adjustJudgeCredits).not.toHaveBeenCalled();
  });

  it("spends one ceiling across two different owners, which is the whole point", async () => {
    // Each session is brand new, inside its own credits_cap and its own daily
    // cap, and neither has spent anything. Under per owner caps alone both of
    // these go through, and 44 of them drained the account.
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "60";

    const first = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "perfectcorp",
      units: 46,
    });
    expect(first.ok).toBe(true);

    rows = [{ ownerId: FIRST_OWNER, provider: "perfectcorp", units: 46 }];

    const second = await reserve({
      session: judgeSession(SECOND_OWNER),
      provider: "perfectcorp",
      units: 46,
    });
    expect(second).toEqual({ ok: false, reason: "global_cap", remaining: 14 });
  });

  it("gives a refunded reservation back to the ceiling", async () => {
    // docs/04-integrations.md: a task the engine failed consumes no unit. The
    // refund is a negative row, so it comes out of the sum and the day is not
    // eaten by work nobody was charged for.
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "50";
    rows = [
      { ownerId: FIRST_OWNER, provider: "perfectcorp", units: 46 },
      { ownerId: FIRST_OWNER, provider: "perfectcorp", units: -46 },
    ];

    const outcome = await reserve({
      session: judgeSession(SECOND_OWNER),
      provider: "perfectcorp",
      units: 46,
    });

    expect(outcome.ok).toBe(true);
  });

  it("bounds Perfect Corp and nothing else", async () => {
    // SerpApi has its own per owner cap and its own plan quota, and a search is
    // not a share of the Perfect Corp unit balance. Claude is recorded, never
    // capped. Neither is touched here.
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "1";
    rows = [
      { ownerId: SECOND_OWNER, provider: "perfectcorp", units: 400 },
      { ownerId: SECOND_OWNER, provider: "serpapi", units: 40 },
      { ownerId: SECOND_OWNER, provider: "anthropic", units: 40 },
    ];

    const search = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "serpapi",
      units: 1,
    });
    expect(search.ok).toBe(true);

    const claude = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "anthropic",
      units: 1,
    });
    expect(claude.ok).toBe(true);

    const units = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "perfectcorp",
      units: 1,
    });
    expect(units).toEqual({ ok: false, reason: "global_cap", remaining: 0 });
  });

  it("is checked before the per owner daily cap, so the log names the real one", async () => {
    // Both are over. The deployment wide one is the answer, because it is the
    // one that does not come back when this owner's day rolls over.
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "10";
    process.env.DAILY_CAP_PERFECTCORP_UNITS = "10";
    rows = [
      { ownerId: FIRST_OWNER, provider: "perfectcorp", units: 10 },
      { ownerId: SECOND_OWNER, provider: "perfectcorp", units: 10 },
    ];

    const outcome = await reserve({
      session: judgeSession(FIRST_OWNER),
      provider: "perfectcorp",
      units: 1,
    });

    expect(outcome).toEqual({ ok: false, reason: "global_cap", remaining: 0 });
  });
});
