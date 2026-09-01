import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { HttpError, notFound, ok } from "@/lib/server/http/responses";
import { saveLook } from "@/lib/server/looks";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { LookSaveResponse } from "@/lib/shared/looks-view";

/**
 * POST /api/looks/[id]/save
 *
 * "Save this look", docs/01-user-flow.md section K item 4. The look is already
 * a row by the time the screen shows it, so this flips is_saved on it and
 * nothing else: a saved look keeps the pieces and the rationale it was saved
 * under (src/lib/server/looks/save.ts).
 *
 * Fixture mode is answered first: the checked in demo looks have no database
 * behind them, and a save that stored nothing must not report success
 * (docs/07-payments-and-judge-mode.md, "The demo profile is read only").
 *
 * There is no body. The id in the path is the whole request.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const lookIdSchema = z.uuid();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/looks/[id]/save", async (route) => {
    if (isDemoFixtureMode()) {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "looks", session });

    const { id } = await context.params;
    const parsed = lookIdSchema.safeParse(id);
    if (!parsed.success) {
      // A malformed id is not this person's look.
      throw notFound(messages.lookNotFound);
    }

    const outcome = await saveLook({ session, lookId: parsed.data });
    if (!outcome.ok) {
      if (outcome.reason === "fixture_read_only") {
        throw new HttpError({
          status: 403,
          message: messages.demoProfileReadOnly,
          outcome: "forbidden",
          code: "demo_profile_read_only",
        });
      }
      throw notFound(messages.lookNotFound);
    }

    return ok<LookSaveResponse>({ ok: true });
  });
}
