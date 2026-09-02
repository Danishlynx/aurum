import "server-only";

import { cookies } from "next/headers";

import type { JudgeSession } from "../db/types";
import { logCapEvent } from "../http/logging";
import { messages } from "../http/messages";
import { capReached } from "../http/responses";
import type { AppSession } from "../session";
import { judgeAnalysesExhausted } from "./demo";
import { JUDGE_SESSION_COOKIE, loadJudgeSession } from "./index";

/**
 * The two things a screen or a route needs to know about a judge session before
 * it does any work: is there one, and does it still have an analysis left.
 *
 * Spec: docs/01-user-flow.md, "Judge mode across the flow", "At zero, capture is
 * disabled with the line ... and every screen renders from the demo profile so
 * nothing is dead", and docs/03-architecture.md, "Requests beyond a cap return
 * 429 with the copy from the flow doc".
 */

/**
 * Refuses the request when the judge session has no analyses left.
 *
 * It is a 429 with the flow doc's own sentence
 * (copy.errors.judgeExhausted through messages.judgeExhausted), not the
 * /judge screen's "used its 3 analyses" line: a session created with
 * JUDGE_ANALYSES_ALLOWED=0 never had three, and the app does not say things that
 * are not true.
 *
 * Called before anything is written and before any counter moves, so a refusal
 * costs the session nothing at all.
 */
export function refuseWhenJudgeAnalysesExhausted(args: {
  readonly session: AppSession;
  readonly route: string;
  readonly requestId: string;
}): void {
  if (!judgeAnalysesExhausted(args.session)) {
    return;
  }
  logCapEvent({
    requestId: args.requestId,
    route: args.route,
    sessionKind: "judge",
    sessionId: args.session.id,
    kind: "judge_analyses",
    remaining: 0,
  });
  throw capReached({
    message: messages.judgeExhausted,
    code: "judge_analyses",
    remaining: 0,
  });
}

/**
 * The judge session on this request, or null, without touching Supabase Auth.
 *
 * getSession in src/lib/server/session.ts falls through to the auth server when
 * there is no judge cookie, and that call needs a configured Supabase project.
 * A server component that only wants to know whether the camera should be
 * offered must not fail on a machine without one, so this reads the cookie and
 * stops there. A session that cannot be read at all is answered as no session,
 * which leaves the screen in its normal state rather than in a disabled one it
 * cannot justify.
 */
export async function readJudgeSessionFromCookie(): Promise<JudgeSession | null> {
  try {
    const store = await cookies();
    const cookie = store.get(JUDGE_SESSION_COOKIE);
    if (cookie === undefined || cookie.value.length === 0) {
      return null;
    }
    return await loadJudgeSession(cookie.value);
  } catch {
    return null;
  }
}
