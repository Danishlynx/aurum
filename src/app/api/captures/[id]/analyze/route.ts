import type { NextRequest } from "next/server";
import { z } from "zod";

import { copy } from "@/lib/shared/copy";

import { getCapture } from "@/lib/server/db";
import { ANALYSIS_KINDS } from "@/lib/server/db/types";
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
import { planFor, requiresMorePhotos } from "@/lib/server/jobs/analysis";
import {
  consumeJudgeAnalysis,
  judgeAnalysesRemaining,
  releaseJudgeAnalysis,
} from "@/lib/server/judge";
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
 * 7. the daily credit cap, checked once so a refusal is not a half spend
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

/** The cheapest kind the fan out could still start with the units left. */
function cheapestPlannedUnits(): number {
  const runnable = ANALYSIS_KINDS.filter((kind) => !requiresMorePhotos(kind));
  return runnable.reduce(
    (lowest, kind) => Math.min(lowest, planFor(kind).units),
    Number.POSITIVE_INFINITY,
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/captures/[id]/analyze", async (route) => {
    const session = await requireSession(route);
    await requireConsent(session);
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
          message: copy.judge.exhausted,
          code: "judge_analyses",
          remaining: 0,
        });
      }
    }

    const caps = dailyCaps();
    const usedToday = await spentToday(ownerOf(session), "perfectcorp");
    if (caps.perfectcorpUnits - usedToday < cheapestPlannedUnits()) {
      if (firstRun && session.kind === "judge") {
        await releaseJudgeAnalysis(session.id);
      }
      logCapEvent({
        requestId: route.requestId,
        route: "/api/captures/[id]/analyze",
        sessionKind: session.kind,
        sessionId: session.id,
        kind: "daily_credits",
        remaining: Math.max(0, caps.perfectcorpUnits - usedToday),
      });
      throw capReached({
        message: messages.dailyCapReached,
        code: "daily_credits",
        remaining: Math.max(0, caps.perfectcorpUnits - usedToday),
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

    const analysesRemaining =
      session.kind === "judge"
        ? judgeAnalysesRemaining(session.session) - (firstRun ? 1 : 0)
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
