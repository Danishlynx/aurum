import type { NextRequest } from "next/server";

import { judgeSessionRequestSchema } from "@/lib/shared/schemas";

import { handleRoute } from "@/lib/server/http/handler";
import { logJudgeSessionCreated } from "@/lib/server/http/logging";
import { messages } from "@/lib/server/http/messages";
import { HttpError, ok } from "@/lib/server/http/responses";
import {
  createJudgeSession,
  judgeAnalysesRemaining,
  JUDGE_SESSION_COOKIE,
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

    const response = ok(
      {
        analysesRemaining: judgeAnalysesRemaining(session),
        analysesAllowed: session.analyses_allowed,
        expiresAt: session.expires_at,
      },
      200,
    );
    response.cookies.set(JUDGE_SESSION_COOKIE, session.id, judgeCookieOptions());
    return response;
  });
}
