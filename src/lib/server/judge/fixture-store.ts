import "server-only";

import type { JudgeSession } from "../db/types";

/**
 * A judge session with no database behind it, for development and end to end
 * tests.
 *
 * Why it exists: every judge route reads and writes judge_sessions, so on a
 * clean clone with no Supabase project there is no way to walk the judge flow at
 * all, and the zero analyses behaviour this build depends on
 * (JUDGE_ANALYSES_ALLOWED=0, docs/07-payments-and-judge-mode.md) could only be
 * proven in unit tests. This store is the smallest seam that lets the real
 * routes, the real cookie, the real caps, and the real screens run without one.
 *
 * What it is not: it is not an authentication bypass. POST /api/judge/session
 * still compares the submitted code against JUDGE_ACCESS_CODE_HASH before
 * anything here is called, so a wrong code gets the same 401 it always did.
 *
 * How it is kept out of production, the same way AURUM_DEMO_FIXTURE is
 * (.env.example: "it must never be true in production"), plus one guard the
 * fixture switch does not need: sessions held in one process's memory are wrong
 * on a serverless deployment whatever the environment says, so NODE_ENV
 * production refuses the switch outright.
 *
 * The map hangs off globalThis because the Next.js development server
 * re evaluates modules on recompile, and a session that vanished mid test would
 * look like an expired cookie rather than a reloaded module.
 */

export const JUDGE_FIXTURE_ENV = "JUDGE_FIXTURE_SESSION";

export function isJudgeFixtureSessionMode(): boolean {
  return (
    process.env[JUDGE_FIXTURE_ENV] === "true" &&
    process.env.NODE_ENV !== "production"
  );
}

const STORE_KEY = Symbol.for("aurum.judge.fixtureSessions");

type Store = Map<string, JudgeSession>;

function store(): Store {
  const holder = globalThis as typeof globalThis & {
    [STORE_KEY]?: Store;
  };
  const existing = holder[STORE_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created: Store = new Map<string, JudgeSession>();
  holder[STORE_KEY] = created;
  return created;
}

/** Mints a session with the caps the environment configures, as the row would. */
export function createFixtureJudgeSession(args: {
  readonly codeHash: string;
  readonly expiresAt: string;
  readonly analysesAllowed: number;
  readonly creditsCap: number;
}): JudgeSession {
  const now = new Date().toISOString();
  const session: JudgeSession = {
    id: crypto.randomUUID(),
    code_hash: args.codeHash,
    expires_at: args.expiresAt,
    analyses_allowed: args.analysesAllowed,
    analyses_used: 0,
    credits_cap: args.creditsCap,
    credits_used: 0,
    last_seen_at: now,
    consent_at: null,
    consent_version: null,
    is_adult_confirmed: false,
    keep_originals: false,
    created_at: now,
    updated_at: now,
  };
  store().set(session.id, session);
  return session;
}

/** The session, or null when it is unknown or expired, as the reader would. */
export function readFixtureJudgeSession(
  sessionId: string,
): JudgeSession | null {
  const session = store().get(sessionId);
  if (session === undefined) {
    return null;
  }
  if (Date.parse(session.expires_at) <= Date.now()) {
    return null;
  }
  return session;
}

/**
 * Moves the columns a route would move. Returns null for an unknown session, so
 * a caller cannot tell an in memory session from a row that was deleted.
 */
export function updateFixtureJudgeSession(
  sessionId: string,
  patch: Partial<JudgeSession>,
): JudgeSession | null {
  const session = readFixtureJudgeSession(sessionId);
  if (session === null) {
    return null;
  }
  const updated: JudgeSession = {
    ...session,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  store().set(sessionId, updated);
  return updated;
}

/** Every live session, for the stats route. */
export function listFixtureJudgeSessions(): JudgeSession[] {
  return [...store().values()];
}

/** Empties the store. Tests only; nothing in a request path calls it. */
export function clearFixtureJudgeSessions(): void {
  store().clear();
}
