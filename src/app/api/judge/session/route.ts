import type { NextRequest } from "next/server";

import { judgeSessionRequestSchema } from "@/lib/shared/schemas";

import { JUDGE_REMAINING_COOKIE } from "@/lib/client/judge-session";

import { handleRoute } from "@/lib/server/http/handler";
import { logJudgeSessionCreated } from "@/lib/server/http/logging";
import { messages } from "@/lib/server/http/messages";
import { HttpError, ok } from "@/lib/server/http/responses";
import {
  createJudgeSession,
  judgeAnalysesRemaining,
  JUDGE_SESSION_COOKIE,
  JUDGE_SESSION_MAX_AGE_SECONDS,
  judgeCookieOptions,
  verifyJudgeCode,
} from "@/lib/server/judge";

/**
 * POST /api/judge/session
 *
 * docs/07-payments-and-judge-mode.md: the code is compared against
 * JUDGE_ACCESS_CODE_HASH, a judge_sessions row is created with expires_at 24
 * hours out, and an httpOnly, secure, sameSite strict cookie carries the session
 * id.
 *
 * The submitted code is never logged, never stored in the clear, and never
 * echoed back. A wrong code gets the flow doc's line and nothing else, so the
 * response cannot be used to probe which part was wrong.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/judge/session", async (context) => {
    /**
     * A code that is too short and a code that is simply wrong get the same 401
     * and the same sentence. A 400 for one and a 401 for the other would tell a
     * caller which half of the guess was wrong, which is the probing this route
     * is meant to refuse.
     */
    const codeDidNotMatch = new HttpError({
      status: 401,
      message: messages.judgeCodeDidNotMatch,
      outcome: "unauthorized",
      code: "judge_code_mismatch",
    });

    const body: unknown = await request.json().catch(() => null);
    const parsed = judgeSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw codeDidNotMatch;
    }

    const matched = await verifyJudgeCode(parsed.data.code);
    if (!matched) {
      throw codeDidNotMatch;
    }

    const session = await createJudgeSession();
    logJudgeSessionCreated({
      requestId: context.requestId,
      sessionId: session.id,
      analysesAllowed: session.analyses_allowed,
      creditsCap: session.credits_cap,
    });

    const remaining = judgeAnalysesRemaining(session);
    const response = ok(
      {
        analysesRemaining: remaining,
        analysesAllowed: session.analyses_allowed,
        expiresAt: session.expires_at,
      },
      200,
    );
    response.cookies.set(JUDGE_SESSION_COOKIE, session.id, judgeCookieOptions());
    /*
     * The count the banner reads, mirrored into a readable cookie
     * (src/lib/client/judge-session.ts). The client writes it too, but writing
     * it here as well is what makes the banner right on the very first render:
     * a session that starts at zero has a count of zero before any script runs,
     * so the first screen a judge sees already says how many analyses are left.
     * It carries no secret: it is one small number, and every cap is enforced
     * server side against the session row.
     */
    response.cookies.set(JUDGE_REMAINING_COOKIE, String(remaining), {
      httpOnly: false,
      secure: judgeCookieOptions().secure,
      sameSite: "strict",
      path: "/",
      maxAge: JUDGE_SESSION_MAX_AGE_SECONDS,
    });
    return response;
  });
}
