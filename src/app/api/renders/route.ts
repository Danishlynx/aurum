import type { NextRequest } from "next/server";

import { copy } from "@/lib/shared/copy";
import {
  renderRequestSchema,
  type RenderCreatedResponse,
} from "@/lib/shared/color-view";

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
  HttpError,
  notFound,
  ok,
  serverError,
} from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { createRender } from "@/lib/server/renders";

/**
 * POST /api/renders
 *
 * Starts one try on on the person's own capture, or returns the render the same
 * parameters produced before (docs/03-architecture.md, "Caching": "(user_id,
 * kind, params_hash) is unique. Re selecting a shade or style returns the stored
 * render").
 *
 * Six kinds, all through the same body, the same caps, and the same refusals:
 * makeup (docs/01 section H), hairstyle and hair color (section I), cloth
 * (section K), and the two Layer 6 kinds, the skin simulation on /report and the
 * accessory try on in the top look (docs/09-build-order-and-demo.md).
 *
 * The order of the gates, and why:
 * 1. fixture mode, which has no database and no key, so it is answered first
 * 2. session, or nothing else matters
 * 3. consent, because a render is processing of a person's face
 *    (docs/06-safety-privacy.md)
 * 4. rate limit, before any counter moves
 * 5. the render layer, which answers from cache, then refuses on the key, the
 *    kill switch, one render at a time, the judge render cap, and the credit cap
 *
 * Every refusal carries a sentence the screen can show. None of them carries an
 * image: with no render, /makeup shows the unedited selfie and "Preview
 * unavailable for this shade." (docs/01-user-flow.md section H).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** No key and no database in fixture mode, so no try on can be produced. */
function fixtureRefusal(): HttpError {
  return new HttpError({
    status: 503,
    message: messages.tryOnUnavailable,
    outcome: "kill_switch",
    code: "fixture_mode",
  });
}

// Vercel ends a function at its plan default (10 seconds on Hobby) unless the
// route declares its own budget. This route waits on providers, so it does.
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/renders", async (route) => {
    if (isDemoFixtureMode()) {
      route.noteOutcome("kill_switch");
      throw fixtureRefusal();
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "renders", session });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = renderRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await createRender({
      session,
      request: parsed.data,
      onProviderCall: (count) => {
        route.metrics.countProviderCall(count);
      },
      onCredits: (units) => {
        route.metrics.countCredits(units);
      },
    });

    if (outcome.ok) {
      if (outcome.cached) {
        route.noteOutcome("cache_hit");
        return ok<RenderCreatedResponse>({
          renderId: outcome.renderId,
          jobId: null,
          status: outcome.status,
          renderUrl: outcome.renderUrl ?? undefined,
        });
      }
      return ok<RenderCreatedResponse>(
        {
          renderId: outcome.renderId,
          jobId: outcome.jobId,
          status: outcome.status,
        },
        202,
      );
    }

    switch (outcome.reason) {
      case "no_profile":
        throw notFound(messages.profileNotReady);
      case "no_capture_image":
        // The session ended and the scheduled purge took the original with it
        // (docs/06-safety-privacy.md, "Retention"). There is no face to render
        // on, so the person takes a new photo.
        throw new HttpError({
          status: 409,
          message: messages.captureMissingOriginal,
          outcome: "invalid_request",
          code: "capture_missing_original",
        });
      case "nothing_to_render":
        throw badRequest(messages.invalidRequest);
      case "render_in_progress":
        // docs/03-architecture.md, "Concurrency": renders are sequential per
        // person, so credit spend stays predictable.
        throw new HttpError({
          status: 429,
          message: messages.renderInProgress,
          outcome: "rate_limited",
          code: "render_in_progress",
        });
      case "judge_render_limit":
        logCapEvent({
          requestId: route.requestId,
          route: "/api/renders",
          sessionKind: session.kind === "judge" ? "judge" : "user",
          sessionId: session.id,
          kind: "judge_credits",
          remaining: 0,
        });
        throw new HttpError({
          status: 429,
          message: messages.renderLimitReached,
          outcome: "cap_reached",
          code: "judge_renders",
          extra: { remaining: 0 },
        });
      case "session_cap":
        logCapEvent({
          requestId: route.requestId,
          route: "/api/renders",
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
          route: "/api/renders",
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
      case "kill_switch":
        route.noteOutcome("kill_switch");
        throw new HttpError({
          status: 503,
          message: messages.providerCallsDisabled,
          outcome: "kill_switch",
          code: "provider_calls_disabled",
        });
      case "not_configured":
        // No Perfect Corp key on the server. The screen says the preview is
        // unavailable, and no substitute image is ever sent in its place.
        throw new HttpError({
          status: 503,
          message: messages.tryOnUnavailable,
          outcome: "server_error",
          code: "provider_not_configured",
        });
      case "endpoint_unverified":
        // The endpoint behind this kind has not been verified against the live
        // docs, and PERFECTCORP_ALLOW_UNVERIFIED is not set. As of 2026-09-02
        // that is the earrings and the bag, whose unit costs are published
        // nowhere we can read; /looks offers neither, so this is the answer to a
        // request that did not come from a screen. Same answer as a missing key,
        // because from the person's side it is the same thing: there is no
        // preview, and nothing was invented in its place.
        throw new HttpError({
          status: 503,
          message: messages.tryOnUnavailable,
          outcome: "server_error",
          code: "provider_endpoint_unverified",
        });
      case "garment_not_found":
        // A garment id that is not this person's. Same answer as any other id
        // that is not theirs: it is not here.
        throw notFound(messages.garmentNotFound);
      case "garment_not_renderable":
        // The garment has no type recorded, so there is no garment_category to
        // send (src/lib/server/renders/cloth.ts). Nothing was reserved and
        // nothing was called. The card shows the flat lay without a try on.
        throw new HttpError({
          status: 409,
          message: messages.classifierUnavailable,
          outcome: "invalid_request",
          code: "garment_not_classified",
        });
      case "accessory_not_renderable":
        // The garment is this person's, but it is not recorded as an accessory,
        // so it is not something the accessory endpoints wear
        // (src/lib/server/renders/accessory.ts). Nothing was reserved and
        // nothing was called. Same answer as any other request that did not
        // match what the row says.
        throw new HttpError({
          status: 409,
          message: messages.classifierUnavailable,
          outcome: "invalid_request",
          code: "garment_not_an_accessory",
        });
      case "style_not_renderable":
        // The hairstyle endpoint is confirmed, but no provider template id has
        // been recorded for this style yet
        // (src/lib/server/renders/hair.ts). Nothing was reserved and nothing
        // was called.
        throw new HttpError({
          status: 503,
          message: messages.tryOnUnavailable,
          outcome: "server_error",
          code: "hairstyle_template_missing",
        });
    }

    // Every reason above throws. This keeps the handler total if one is added.
    throw serverError();
  });
}
