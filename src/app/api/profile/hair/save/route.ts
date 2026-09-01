import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import {
  badRequest,
  HttpError,
  notFound,
  ok,
} from "@/lib/server/http/responses";
import { saveHairChoice } from "@/lib/server/profile/hair";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import {
  hairSaveRequestSchema,
  type HairSaveResponse,
} from "@/lib/shared/hair-view";

/**
 * POST /api/profile/hair/save
 *
 * docs/01-user-flow.md section I item 4: "'Save this' saves the chosen style and
 * color to the profile."
 *
 * The answer carries nothing to render. The screen re reads
 * GET /api/profile/hair afterwards, so what it draws is always the server's
 * record of the choice rather than the one it just posted.
 *
 * Fixture mode is answered first and refuses, because there is no database
 * behind the checked in demo profile and a save that stored nothing must not
 * report success (docs/07-payments-and-judge-mode.md: "The demo profile is read
 * only for judge sessions").
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/hair/save", async (route) => {
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

    const parsed = hairSaveRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await saveHairChoice({
      session,
      styleId: parsed.data.styleId,
      colorName: parsed.data.colorName,
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
      if (outcome.reason === "unknown_choice") {
        // A style or a color that is not in the catalog. The column can only
        // hold something the screen can draw.
        throw badRequest(messages.invalidRequest);
      }
      throw notFound(messages.profileNotReady);
    }

    return ok<HairSaveResponse>({ ok: true });
  });
}
