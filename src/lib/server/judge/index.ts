import "server-only";

import { compare } from "bcryptjs";

import {
  JUDGE_SESSION_LIFETIME_HOURS,
  judgeConfig,
  JUDGE_RENDERS_ALLOWED,
} from "../env";
import { serviceClient, unwrap, unwrapNullable } from "../db/service";
import type { Insert, JudgeSession } from "../db/types";

export {
  JUDGE_SESSION_COOKIE,
  JUDGE_SESSION_MAX_AGE_SECONDS,
  judgeCookieClearOptions,
  judgeCookieOptions,
} from "./cookie";

/**
 * Judge sessions: gated live access with hard caps.
 * Spec: docs/07-payments-and-judge-mode.md and docs/03-architecture.md,
 * "Judge mode".
 *
 * The access code is never stored in the clear and never logged. The only
 * comparison happens here, against the bcrypt hash in JUDGE_ACCESS_CODE_HASH.
 */

/**
 * Owner id of the seeded demo profile, kept in step with scripts/seed-demo.ts.
 * Declared again rather than imported, because that script runs work at module
 * scope and must not be pulled into a request path.
 */
export const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000001";

/** True when the submitted code matches the configured hash. */
export async function verifyJudgeCode(code: string): Promise<boolean> {
  const { codeHash } = judgeConfig();
  try {
    return await compare(code, codeHash);
  } catch {
    // A malformed hash in the environment is a configuration problem, not a
    // reason to let a code through.
    return false;
  }
}

export async function createJudgeSession(): Promise<JudgeSession> {
  const config = judgeConfig();
  const expiresAt = new Date(
    Date.now() + JUDGE_SESSION_LIFETIME_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const row: Insert<"judge_sessions"> = {
    code_hash: config.codeHash,
    expires_at: expiresAt,
    analyses_allowed: config.analysesAllowed,
    credits_cap: config.creditsCap,
    last_seen_at: new Date().toISOString(),
  };

  const result = await serviceClient()
    .from("judge_sessions")
    .insert(row)
    .select("*")
    .single();
  return unwrap("create judge session", result);
}

/** Reads a session by id. Returns null when it is missing or expired. */
export async function loadJudgeSession(
  sessionId: string,
): Promise<JudgeSession | null> {
  const result = await serviceClient()
    .from("judge_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  const session = unwrapNullable("read judge session", result);
  if (session === null) {
    return null;
  }
  if (Date.parse(session.expires_at) <= Date.now()) {
    return null;
  }
  return session;
}

export async function touchJudgeSession(sessionId: string): Promise<void> {
  const result = await serviceClient()
    .from("judge_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId)
    .select("id")
    .maybeSingle();
  unwrapNullable("touch judge session", result);
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export function judgeAnalysesRemaining(session: JudgeSession): number {
  return Math.max(0, session.analyses_allowed - session.analyses_used);
}

export function judgeCreditsRemaining(session: JudgeSession): number {
  return Math.max(0, session.credits_cap - session.credits_used);
}

export function judgeRendersRemaining(rendersUsed: number): number {
  return Math.max(0, JUDGE_RENDERS_ALLOWED - rendersUsed);
}

/**
 * Counter updates use compare and set rather than a read then blind write:
 * Postgres has no column arithmetic through PostgREST, so the previous value is
 * part of the WHERE clause. A concurrent writer makes the update match zero
 * rows, and the caller retries against the new value. Two parallel analyze
 * requests can therefore never both consume the last analysis.
 */
const CAS_ATTEMPTS = 4;

export type CapOutcome =
  | { readonly ok: true; readonly session: JudgeSession }
  | { readonly ok: false; readonly reason: "exhausted" | "expired" | "conflict" };

/** Consumes one analysis from the session cap. */
export async function consumeJudgeAnalysis(
  sessionId: string,
): Promise<CapOutcome> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const session = await loadJudgeSession(sessionId);
    if (session === null) {
      return { ok: false, reason: "expired" };
    }
    if (judgeAnalysesRemaining(session) === 0) {
      return { ok: false, reason: "exhausted" };
    }

    const result = await serviceClient()
      .from("judge_sessions")
      .update({ analyses_used: session.analyses_used + 1 })
      .eq("id", sessionId)
      .eq("analyses_used", session.analyses_used)
      .select("*")
      .maybeSingle();
    const updated = unwrapNullable("consume judge analysis", result);
    if (updated !== null) {
      return { ok: true, session: updated };
    }
  }
  return { ok: false, reason: "conflict" };
}

/** Gives one analysis back when the fan out could not start a single task. */
export async function releaseJudgeAnalysis(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const session = await loadJudgeSession(sessionId);
    if (session === null || session.analyses_used === 0) {
      return;
    }
    const result = await serviceClient()
      .from("judge_sessions")
      .update({ analyses_used: session.analyses_used - 1 })
      .eq("id", sessionId)
      .eq("analyses_used", session.analyses_used)
      .select("id")
      .maybeSingle();
    if (unwrapNullable("release judge analysis", result) !== null) {
      return;
    }
  }
}

/**
 * Moves credits_used by a signed delta, clamped at zero and reported when the
 * cap would be passed. The ledger stays the source of truth; this counter is the
 * cheap read the judge banner and the stats route use.
 */
export async function adjustJudgeCredits(
  sessionId: string,
  delta: number,
): Promise<CapOutcome> {
  if (delta === 0) {
    const session = await loadJudgeSession(sessionId);
    return session === null
      ? { ok: false, reason: "expired" }
      : { ok: true, session };
  }

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const session = await loadJudgeSession(sessionId);
    if (session === null) {
      return { ok: false, reason: "expired" };
    }
    const next = Math.max(0, session.credits_used + delta);
    if (delta > 0 && next > session.credits_cap) {
      return { ok: false, reason: "exhausted" };
    }

    const result = await serviceClient()
      .from("judge_sessions")
      .update({ credits_used: next })
      .eq("id", sessionId)
      .eq("credits_used", session.credits_used)
      .select("*")
      .maybeSingle();
    const updated = unwrapNullable("adjust judge credits", result);
    if (updated !== null) {
      return { ok: true, session: updated };
    }
  }
  return { ok: false, reason: "conflict" };
}

/** Records consent against the session, since a judge has no profiles row. */
export async function recordJudgeConsent(args: {
  readonly sessionId: string;
  readonly consentVersion: string;
  readonly keepOriginals: boolean;
}): Promise<JudgeSession | null> {
  const result = await serviceClient()
    .from("judge_sessions")
    .update({
      consent_at: new Date().toISOString(),
      consent_version: args.consentVersion,
      is_adult_confirmed: true,
      keep_originals: args.keepOriginals,
    })
    .eq("id", args.sessionId)
    .select("*")
    .maybeSingle();
  return unwrapNullable("write judge consent", result);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface JudgeStats {
  readonly sessionsCreated: number;
  readonly analysesUsed: number;
  readonly creditsUsed: number;
}

/**
 * The numbers the human watches during judging
 * (docs/07-payments-and-judge-mode.md, "Observability for judging").
 * creditsUsed is summed from the sessions rather than from the ledger so the
 * figure matches the cap the sessions are actually checked against.
 */
export async function judgeStats(): Promise<JudgeStats> {
  const result = await serviceClient()
    .from("judge_sessions")
    .select("analyses_used, credits_used");
  const rows = unwrap("read judge stats", result);

  let analysesUsed = 0;
  let creditsUsed = 0;
  for (const row of rows) {
    analysesUsed += row.analyses_used;
    creditsUsed += row.credits_used;
  }

  return { sessionsCreated: rows.length, analysesUsed, creditsUsed };
}
