import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import {
  badRequest,
  HttpError,
  notFound,
  ok,
} from "@/lib/server/http/responses";
import { confirmUndertone } from "@/lib/server/profile/color";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import {
  undertoneRequestSchema,
  type UndertoneUpdateResponse,
} from "@/lib/shared/color-view";

/**
 * POST /api/profile/undertone
 *
 * docs/01-user-flow.md section G item 2, the undertone adjuster: "Choosing one
 * updates the profile and re derives the palette." The reading is written again
 * as well, because docs/03-architecture.md regenerates the synthesis when the
 * person adjusts their undertone.
 *
 * The answer is the new season and whether a palette was derived. The screen
 * re reads GET /api/profile/color afterwards rather than rendering anything from
 * this body, so the palette it draws is always the server's.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/undertone", async (route) => {
    // Fixture mode is answered before the session, because there is no database
    // behind the fixture and resolving a session would only fail on the missing
    // configuration.
    if (isDemoFixtureMode()) {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    const session = await requireSession(route);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = undertoneRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await confirmUndertone({
      session,
      undertone: parsed.data.undertone,
    });

    if (!outcome.ok) {
      if (outcome.reason === "fixture_read_only") {
        throw new HttpError({
          status: 403,
          message: messages.demoProfileReadOnly,
          outcome: "forbidden",
          code: "demo_profile_read_only",
        });
      }
      throw notFound(messages.profileNotReady);
    }

    /*
     * season is null when the photo gave no skin tone: the confirmed undertone is
     * stored, but an undertone alone cannot produce a palette, and reporting a
     * season nobody derived would be an invented one. The screen keeps its
     * "Confirm your undertone" state in that case.
     */
    return ok<UndertoneUpdateResponse>({
      season: outcome.season,
      paletteChanged: outcome.paletteChanged,
    });
  });
}
