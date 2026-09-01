import type { NextRequest } from "next/server";
import { z } from "zod";

import { copy } from "@/lib/shared/copy";
import {
  type GarmentClassifyResponse,
} from "@/lib/shared/wardrobe-view";

import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { logCapEvent } from "@/lib/server/http/logging";
import { messages } from "@/lib/server/http/messages";
import {
  capReached,
  HttpError,
  notFound,
  ok,
  serverError,
} from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { classifyGarment } from "@/lib/server/wardrobe";

/**
 * POST /api/garments/[id]/classify
 *
 * Reads one garment photo with Claude and fills its chips
 * (docs/01-user-flow.md section J item 2, docs/04-integrations.md Classifier).
 *
 * The answer carries a job id, not a garment. The screen re reads
 * GET /api/wardrobe afterwards, so every chip it draws comes from the stored
 * row rather than from the response to the call that produced it.
 *
 * 202 rather than 200, and why the work still happens inside the request: the
 * client treats classification as a job, and the job row is the record the
 * failed card state is read from. But a Claude call is one HTTP round trip with
 * its own timeout, not a Perfect Corp task with a provider side id to poll, and
 * a serverless function does no work after its response is sent, so there is
 * nothing a later poll could advance. The call is awaited here and the job is
 * already terminal when its id comes back.
 *
 * Every refusal leaves the garment with empty chips and a failed job, which is
 * the state docs/01 section J describes: "Could not read this one. Tap to fill
 * in details." Nothing is ever guessed in its place. docs/03-architecture.md
 * gives the stylist a deterministic fallback and gives the classifier none, on
 * purpose: a made up garment attribute would end up in a look and in a product
 * query, and the app does not invent data about the world.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const garmentIdSchema = z.uuid();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/garments/[id]/classify", async (route) => {
    if (isDemoFixtureMode()) {
      // The checked in wardrobe already carries its attributes and there is no
      // database to write a job to. Saying so beats reporting a classification
      // that never ran.
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "garments", session });

    const { id } = await context.params;
    const parsedId = garmentIdSchema.safeParse(id);
    if (!parsedId.success) {
      throw notFound(messages.garmentNotFound);
    }

    const outcome = await classifyGarment({
      session,
      garmentId: parsedId.data,
      onProviderCall: (count) => {
        route.metrics.countProviderCall(count);
      },
      onCredits: (units) => {
        route.metrics.countCredits(units);
      },
    });

    if (outcome.ok) {
      if (outcome.alreadyRunning) {
        // Idempotency, the same rule the analysis jobs follow: asking again for
        // a classification that is already running returns the running one.
        route.noteOutcome("cache_hit");
      }
      return ok<GarmentClassifyResponse>(
        {
          jobId: outcome.jobId,
          garmentId: outcome.garmentId,
          status: outcome.status,
        },
        202,
      );
    }

    switch (outcome.reason) {
      case "not_found":
        throw notFound(messages.garmentNotFound);
      case "no_image":
      case "unsupported_image":
        throw new HttpError({
          status: 409,
          message: messages.garmentImageUnreadable,
          outcome: "invalid_request",
          code: "garment_image_unreadable",
        });
      case "image_too_large":
        throw new HttpError({
          status: 413,
          message: messages.garmentImageTooLarge,
          outcome: "invalid_request",
          code: "garment_image_too_large",
        });
      case "not_configured":
        // No Claude key on the server. The card shows the failed state, which
        // is true: nothing read this photo.
        throw new HttpError({
          status: 503,
          message: messages.classifierUnavailable,
          outcome: "server_error",
          code: "provider_not_configured",
        });
      case "kill_switch":
        route.noteOutcome("kill_switch");
        throw new HttpError({
          status: 503,
          message: messages.providerCallsDisabled,
          outcome: "kill_switch",
          code: "provider_calls_disabled",
        });
      case "session_cap":
        logCapEvent({
          requestId: route.requestId,
          route: "/api/garments/[id]/classify",
          sessionKind: session.kind === "judge" ? "judge" : "user",
          sessionId: session.id,
          kind: "judge_credits",
          remaining: outcome.remaining ?? 0,
        });
        throw capReached({
          message: copy.errors.judgeExhausted,
          code: "judge_credits",
          remaining: outcome.remaining ?? 0,
        });
      case "daily_cap":
        logCapEvent({
          requestId: route.requestId,
          route: "/api/garments/[id]/classify",
          sessionKind: session.kind === "judge" ? "judge" : "user",
          sessionId: session.id,
          kind: "daily_credits",
          remaining: outcome.remaining ?? 0,
        });
        throw capReached({
          message: messages.dailyCapReached,
          code: "daily_credits",
          remaining: outcome.remaining ?? 0,
        });
    }

    // Every reason above throws. This keeps the handler total if one is added.
    throw serverError();
  });
}
