import type { NextRequest } from "next/server";
import { z } from "zod";

import { getCapture } from "@/lib/server/db";
import { ownerOf, spentToday } from "@/lib/server/credits";
import { dailyCaps, providerCallsEnabled } from "@/lib/server/env";
import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { logCapEvent } from "@/lib/server/http/logging";
import { messages } from "@/lib/server/http/messages";
import {
  badRequest,
  capReached,
  notFound,
  ok,
} from "@/lib/server/http/responses";
import {
  createAnalysisJobs,
  readCaptureJobs,
  type CaptureJobsView,
} from "@/lib/server/jobs";
import {
  admitsCaptureSpend,
  profileMinimumUnits,
} from "@/lib/server/jobs/analysis";
import {
  consumeJudgeAnalysis,
  judgeAnalysesRemaining,
  releaseJudgeAnalysis,
} from "@/lib/server/judge";
import { refuseWhenJudgeAnalysesExhausted } from "@/lib/server/judge/guard";
import type { AppSession } from "@/lib/server/session";
import { copy } from "@/lib/shared/copy";
/**
 * POST /api/captures/[id]/analyze
 *
 * docs/03-architecture.md step 4: the server fans out the independent analyses
 * as jobs in parallel and returns their ids. The client then polls
 * GET /api/jobs?capture={id}.
 *
 * Order of the gates, and why:
 * 1. session, or nothing else matters
 * 2. consent, because docs/06-safety-privacy.md requires the 403 here
 * 3. rate limit, before any counter moves
 * 4. the capture, so a wrong id costs nothing
 * 5. the kill switch, which serves cache or demo without touching a provider
 * 6. the judge analyses cap, which is per capture and not per credit
 * 7. the credit ceilings, daily and per judge session, checked once and priced
 *    at what a report costs, so a refusal is not a half spend
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

interface AnalyzeResponse extends CaptureJobsView {
  readonly providerCallsEnabled: boolean;
  /** Present only when the answer is not a live reading. */
  readonly notice?: string;
  /** Judge sessions only. */
  readonly analysesRemaining?: number;
}

function respond(view: CaptureJobsView, extra: Partial<AnalyzeResponse>) {
  return ok<AnalyzeResponse>(
    {
      ...view,
      providerCallsEnabled: providerCallsEnabled(),
      ...extra,
    },
    202,
  );
}

/**
 * What is left under the judge session's own credit ceiling, or null for a
 * session that has none.
 *
 * It is a second ceiling, not the same one read twice: reserve() checks the
 * daily cap and, for a judge, the judge_sessions counter, and either of them can
 * refuse a reading in the middle of a fan out.
 */
function judgeCreditsRemaining(session: AppSession): number | null {
  if (session.kind !== "judge") {
    return null;
  }
  return Math.max(
    0,
    session.session.credits_cap - session.session.credits_used,
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/captures/[id]/analyze", async (route) => {
    const session = await requireSession(route);
    await requireConsent(session);
    /*
     * A session that starts at zero is refused here, before the capture is even
     * looked up, so the answer costs nothing and cannot be mistaken for a
     * reading that is on its way. The cap is checked again below for the session
     * that spends its last analysis mid visit, where the counter has to move
     * under a compare and set rather than a read.
     */
    refuseWhenJudgeAnalysesExhausted({
      session,
      route: "/api/captures/[id]/analyze",
      requestId: route.requestId,
    });
    await enforceRateLimit({ context: route, name: "analyze", session });

    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) {
      throw badRequest(messages.invalidRequest);
    }

    const capture = await getCapture(session.id, params.data.id);
    if (capture === null) {
      throw notFound();
    }

    const existing = await readCaptureJobs(session.id, capture.id, "cache");

    // Kill switch: serve what is cached, and say plainly that this is not live.
    // docs/03-architecture.md, "Credits and caps"; docs/07, "Kill switch".
    if (!providerCallsEnabled()) {
      route.noteOutcome("kill_switch");
      return respond(
        { ...existing, source: existing.jobs.length > 0 ? "cache" : "demo" },
        { notice: messages.providerCallsDisabled },
      );
    }

    // Idempotency: a capture that already has jobs is never charged again, and
    // never costs the judge session another analysis.
    const firstRun = existing.jobs.length === 0;

    if (firstRun && session.kind === "judge") {
      const outcome = await consumeJudgeAnalysis(session.id);
      if (!outcome.ok) {
        logCapEvent({
          requestId: route.requestId,
          route: "/api/captures/[id]/analyze",
          sessionKind: "judge",
          sessionId: session.id,
          kind: "judge_analyses",
          remaining: 0,
        });
        throw capReached({
          // The flow doc's line for a session at zero, not the /judge screen's
          // "used its 3 analyses" sentence: a session created with
          // JUDGE_ANALYSES_ALLOWED=0 never had three of them.
          message: messages.judgeExhausted,
          code: "judge_analyses",
          remaining: 0,
        });
      }
    }

    /*
     * Admission is priced at what a report actually costs, not at what the
     * cheapest reading costs.
     *
     * This asked for 10 units, the price of the cheapest kind, until now. The
     * fan out does not buy the cheapest kind: it buys the 20 unit tone reading
     * alone, and a profile needs the 16 unit skin analysis with it. So anywhere
     * between 20 and 35 units of headroom, the leader was admitted, started,
     * succeeded and charged, the skin reading was then refused by the same cap,
     * and the person had paid 20 units for a capture that could never become a
     * report. Refusing before anything is bought is the only honest answer to
     * that, and the copy is the one the cap already uses.
     *
     * Both ceilings are asked, and the tighter one decides
     * (admitsCaptureSpend). A judge session can be inside the daily cap and out
     * of its own credits, which fails in exactly the same way.
     */
    const caps = dailyCaps();
    const usedToday = await spentToday(ownerOf(session), "perfectcorp");
    const dailyRemaining = Math.max(0, caps.perfectcorpUnits - usedToday);
    const sessionRemaining = judgeCreditsRemaining(session);
    if (!admitsCaptureSpend({ dailyRemaining, sessionRemaining })) {
      if (firstRun && session.kind === "judge") {
        await releaseJudgeAnalysis(session.id);
      }
      // Which ceiling is short decides the line the person reads: the judge
      // sentence for a spent session, the daily one otherwise.
      const sessionIsShort =
        sessionRemaining !== null && sessionRemaining < profileMinimumUnits();
      logCapEvent({
        requestId: route.requestId,
        route: "/api/captures/[id]/analyze",
        sessionKind: session.kind,
        sessionId: session.id,
        kind: sessionIsShort ? "judge_credits" : "daily_credits",
        remaining: sessionIsShort ? (sessionRemaining ?? 0) : dailyRemaining,
      });
      throw capReached({
        message: sessionIsShort
          ? copy.errors.judgeExhausted
          : messages.dailyCapReached,
        code: sessionIsShort ? "judge_credits" : "daily_credits",
        remaining: sessionIsShort ? (sessionRemaining ?? 0) : dailyRemaining,
      });
    }

    let view: CaptureJobsView;
    try {
      view = await createAnalysisJobs({
        session,
        capture,
        onProviderCall: (count) => {
          route.metrics.countProviderCall(count);
        },
        onCredits: (units) => {
          route.metrics.countCredits(units);
        },
      });
    } catch (thrown) {
      if (firstRun && session.kind === "judge") {
        await releaseJudgeAnalysis(session.id);
      }
      throw thrown;
    }

    /*
     * The fan out started nothing.
     *
     * Every kind came back failed, which means no task exists, every reservation
     * that was taken has already been refunded inside createAnalysisJobs, and
     * the session spent nothing. docs/07-payments-and-judge-mode.md counts "each
     * capture that reaches the analyze step", and a capture that reached it and
     * produced no task did not reach a reading, so the analysis goes back.
     *
     * This is safe to do here and only here: it runs in the same request that
     * consumed the analysis, so it cannot run twice for one capture. The other
     * total failure, where the tasks were created and the engine then refused
     * every one of them, is settled on the polling route instead, and a poll can
     * be repeated (a refresh, a second tab). Giving an analysis back from there
     * without a per capture marker would let a refresh loop reset the cap, so
     * that case keeps the documented decrement. See the note in
     * src/lib/server/jobs/index.ts.
     */
    let returnedAnalysis = false;
    if (
      firstRun &&
      session.kind === "judge" &&
      view.jobs.length > 0 &&
      view.jobs.every((job) => job.status === "failed")
    ) {
      await releaseJudgeAnalysis(session.id);
      returnedAnalysis = true;
    }

    const analysesRemaining =
      session.kind === "judge"
        ? judgeAnalysesRemaining(session.session) -
          (firstRun && !returnedAnalysis ? 1 : 0)
        : undefined;

    // Retention is settled on the polling route: the original is removed once
    // every job for the capture is terminal, including the case where they all
    // failed at once (docs/03-architecture.md step 7).
    return respond(view, {
      analysesRemaining:
        analysesRemaining === undefined
          ? undefined
          : Math.max(0, analysesRemaining),
    });
  });
}
