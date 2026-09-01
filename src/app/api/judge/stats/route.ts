import type { NextRequest } from "next/server";

import { handleRoute } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { HttpError, ok } from "@/lib/server/http/responses";
import { judgeStats, verifyJudgeCode } from "@/lib/server/judge";

/**
 * GET /api/judge/stats?code=<code>
 *
 * docs/07-payments-and-judge-mode.md: "A tiny /api/judge/stats route (protected
 * by the same code) shows sessions created, analyses used, credits used, so the
 * human can watch the balance during judging."
 *
 * Protected by the same bcrypt comparison as the session route, so the numbers
 * are not public. The code arrives in the query string because this is opened by
 * hand in a browser during judging; it is never logged.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/judge/stats", async () => {
    const code = request.nextUrl.searchParams.get("code") ?? "";
    const matched = code.length > 0 && (await verifyJudgeCode(code));
    if (!matched) {
      throw new HttpError({
        status: 401,
        message: messages.judgeCodeDidNotMatch,
        outcome: "unauthorized",
        code: "judge_code_mismatch",
      });
    }

    const stats = await judgeStats();
    return ok({
      sessionsCreated: stats.sessionsCreated,
      analysesUsed: stats.analysesUsed,
      creditsUsed: stats.creditsUsed,
    });
  });
}
