import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** See the note in evals/synthesis/profile.test.ts: this replaces the marker. */
vi.mock("server-only", () => ({}));

/**
 * eval:safety, the per session judge caps with the switch off.
 *
 * Why the switch exists. Every per session cap is per owner, and an owner costs
 * nothing to mint: the access code is published on the project page, and each
 * submission of it makes a session with a fresh analyses_allowed, a fresh
 * credits_cap, a fresh render count, and a fresh search allowance. So they never
 * bounded the account, which is what the 2026-09-12 incident proved by draining
 * it through 44 sessions that each stayed inside every one of them. What they
 * bounded was the founder, who cannot mint a way around a cap without typing the
 * code again, and did so 44 times in one afternoon.
 *
 * What this file holds is the pair of claims that make the switch safe to
 * default off: with the caps off the app admits the session the caps used to
 * refuse, and the deployment wide ceiling still refuses everybody. The capped
 * behaviour itself is evals/safety/judge-zero.test.ts, which now sets
 * JUDGE_PER_SESSION_CAPS=true for exactly that reason, and the ceiling is
 * evals/budget/global-cap.test.ts.
 *
 * Nothing here reaches Supabase: the judge sessions are the in memory fixture
 * store, and the one ledger call is a mock.
 */

interface LedgerRow {
  readonly ownerId: string;
  readonly provider: string;
  readonly units: number;
}

let rows: LedgerRow[] = [];
let inserted: { provider?: string; units?: number; owner_id?: string }[] = [];

/**
 * The smallest thing that answers like the PostgREST builder the ledger uses,
 * owner aware in the same way evals/budget/global-cap.test.ts needs: a chain
 * that ignores the owner filter would answer the deployment wide question with a
 * per owner sum and pass whether or not the ceiling was global.
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
          ? { data: { id: `entry-${String(inserted.length)}`, subject_id: null }, error: null }
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

import { reserve } from "@/lib/server/credits";
import {
  judgePerSessionCapsEnabled,
  JUDGE_PER_SESSION_CAPS_ON_VALUE,
} from "@/lib/server/env";
import {
  consumeJudgeAnalysis,
  createJudgeSession,
  judgeAnalysesCapReached,
  loadJudgeSession,
} from "@/lib/server/judge";
import { judgeAnalysesExhausted } from "@/lib/server/judge/demo";
import {
  clearFixtureJudgeSessions,
  JUDGE_FIXTURE_ENV,
} from "@/lib/server/judge/fixture-store";
import { refuseWhenJudgeAnalysesExhausted } from "@/lib/server/judge/guard";
import type { JudgeSession } from "@/lib/server/db/types";
import type { AppSession } from "@/lib/server/session";

const KEY = "JUDGE_PER_SESSION_CAPS";

const TOUCHED_VARS = [
  KEY,
  JUDGE_FIXTURE_ENV,
  "JUDGE_ANALYSES_ALLOWED",
  "JUDGE_CREDITS_CAP",
  "JUDGE_ACCESS_CODE_HASH",
  "JUDGE_ACCESS_CODE_HASH_B64",
  "GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY",
  "DAILY_CAP_PERFECTCORP_UNITS",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  rows = [];
  inserted = [];
  for (const name of TOUCHED_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  // A judge session with no database behind it, and a hash for the config
  // reader. No code is ever compared here; createJudgeSession only needs one to
  // stamp on the session.
  process.env[JUDGE_FIXTURE_ENV] = "true";
  process.env.JUDGE_ACCESS_CODE_HASH = "not a real hash";
  clearFixtureJudgeSessions();
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
  clearFixtureJudgeSessions();
});

/** The session as a request carries it, so the guards can be asked directly. */
function appSession(session: JudgeSession): AppSession {
  return {
    kind: "judge",
    id: session.id,
    ownerType: "judge_session",
    session,
  };
}

/* ------------------------------------------------------------------ */
/* The switch itself                                                   */
/* ------------------------------------------------------------------ */

describe("eval:safety, JUDGE_PER_SESSION_CAPS", () => {
  it("is off when nothing is set", () => {
    expect(judgePerSessionCapsEnabled()).toBe(false);
  });

  it("is on for exactly one value", () => {
    process.env[KEY] = JUDGE_PER_SESSION_CAPS_ON_VALUE;
    expect(judgePerSessionCapsEnabled()).toBe(true);
  });

  it("is off for everything that merely looks like yes", () => {
    for (const value of [
      "True",
      "TRUE",
      "1",
      "yes",
      "on",
      "enabled",
      "tru",
      "",
      "false",
    ]) {
      process.env[KEY] = value;
      expect(judgePerSessionCapsEnabled(), `${KEY}=${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  /**
   * Trimmed, so a value pasted into a dashboard with a stray space still means
   * what it says, and not interpreted, so the set of values that turn the caps
   * back on is exactly one thing somebody typed on purpose. The comparison is
   * openAccessEnabled's rather than the kill switch's for that reason.
   */
  it("trims but does not interpret", () => {
    process.env[KEY] = `  ${JUDGE_PER_SESSION_CAPS_ON_VALUE}  `;
    expect(judgePerSessionCapsEnabled()).toBe(true);
    process.env[KEY] = "  True  ";
    expect(judgePerSessionCapsEnabled()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* A session past its analyses                                         */
/* ------------------------------------------------------------------ */

describe("eval:safety, a spent session with the caps off", () => {
  it("admits the analysis the caps used to refuse, and goes on counting", async () => {
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    const session = await createJudgeSession();
    expect(session.analyses_allowed).toBe(0);

    const first = await consumeJudgeAnalysis(session.id);
    const second = await consumeJudgeAnalysis(session.id);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // The counter is the half that stays: /api/judge/stats and the cap log lines
    // read analyses_used, and a number that stopped moving at the allowance
    // would report a session that ran two readings as having run none.
    expect((await loadJudgeSession(session.id))?.analyses_used).toBe(2);
  });

  it("refuses that same session with the switch on, which is what it measures", async () => {
    process.env.JUDGE_ANALYSES_ALLOWED = "0";
    const session = await createJudgeSession();
    process.env[KEY] = "true";

    expect(await consumeJudgeAnalysis(session.id)).toEqual({
      ok: false,
      reason: "exhausted",
    });
    expect((await loadJudgeSession(session.id))?.analyses_used).toBe(0);
  });

  it("lets the route guard through for a session at its allowance", async () => {
    process.env.JUDGE_ANALYSES_ALLOWED = "3";
    const session = await createJudgeSession();
    const spent: JudgeSession = { ...session, analyses_used: 3 };

    expect(judgeAnalysesCapReached(spent)).toBe(false);
    expect(judgeAnalysesExhausted(appSession(spent))).toBe(false);
    expect(() => {
      refuseWhenJudgeAnalysesExhausted({
        session: appSession(spent),
        route: "/api/captures/[id]/analyze",
        requestId: "request-1",
      });
    }).not.toThrow();

    // And the same row with the switch on is the 429 the flow doc writes.
    process.env[KEY] = "true";
    expect(judgeAnalysesCapReached(spent)).toBe(true);
    expect(judgeAnalysesExhausted(appSession(spent))).toBe(true);
    expect(() => {
      refuseWhenJudgeAnalysesExhausted({
        session: appSession(spent),
        route: "/api/captures/[id]/analyze",
        requestId: "request-2",
      });
    }).toThrow();
  });

  it("spends past credits_cap rather than returning session_cap", async () => {
    process.env.JUDGE_CREDITS_CAP = "0";
    const session = await createJudgeSession();
    expect(session.credits_cap).toBe(0);

    const outcome = await reserve({
      session: appSession(session),
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome.ok).toBe(true);
    expect(inserted).toHaveLength(1);
    // credits_used moved with the spend, so the banner's number and the stats
    // route still describe what this session actually cost.
    expect((await loadJudgeSession(session.id))?.credits_used).toBe(16);
  });

  it("returns session_cap for that same reservation with the switch on", async () => {
    process.env.JUDGE_CREDITS_CAP = "0";
    const session = await createJudgeSession();
    process.env[KEY] = "true";

    const outcome = await reserve({
      session: appSession(session),
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome).toEqual({ ok: false, reason: "session_cap", remaining: 0 });
    expect(inserted).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* The brake that remains                                              */
/* ------------------------------------------------------------------ */

describe("eval:safety, the ceiling still refuses with the caps off", () => {
  it("answers global_cap when the deployment's day is spent", async () => {
    expect(judgePerSessionCapsEnabled()).toBe(false);
    process.env.GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY = "100";
    process.env.JUDGE_CREDITS_CAP = "100000";
    // Somebody else's spend, which is the point: the ceiling is the one refusal
    // that is not about the caller and the one no number of fresh sessions can
    // get around.
    rows = [
      {
        ownerId: "00000000-0000-4000-8000-0000000000ff",
        provider: "perfectcorp",
        units: 90,
      },
    ];

    const session = await createJudgeSession();
    const outcome = await reserve({
      session: appSession(session),
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome).toEqual({ ok: false, reason: "global_cap", remaining: 10 });
    // Refused before anything moved, so a refusal is never a half spend.
    expect(inserted).toHaveLength(0);
    expect((await loadJudgeSession(session.id))?.credits_used).toBe(0);
  });

  it("keeps the per owner day as well, which the switch also does not touch", async () => {
    process.env.DAILY_CAP_PERFECTCORP_UNITS = "20";
    process.env.JUDGE_CREDITS_CAP = "100000";
    const session = await createJudgeSession();
    rows = [
      { ownerId: session.id, provider: "perfectcorp", units: 20 },
    ];

    const outcome = await reserve({
      session: appSession(session),
      provider: "perfectcorp",
      units: 16,
    });

    expect(outcome).toEqual({ ok: false, reason: "daily_cap", remaining: 0 });
    expect(inserted).toHaveLength(0);
  });
});
