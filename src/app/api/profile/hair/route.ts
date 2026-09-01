import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { notFound, ok } from "@/lib/server/http/responses";
import { buildHairView } from "@/lib/server/profile/hair";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import type { HairView } from "@/lib/shared/hair-view";

/**
 * GET /api/profile/hair
 *
 * The HairView docs/01-user-flow.md section I renders: the face shape line, the
 * row of styles for that shape, the row of colors inside the palette, and the
 * saved choice.
 *
 * It costs no provider call and no SerpApi search. It reports the renders that
 * already exist for the styles and colors it offers, and starting a new one is
 * POST /api/renders, which is where the credit reservation and the caps live.
 *
 * The screen itself is a server component that calls buildHairView directly.
 * This route exists for the browser, which re reads the view after a render
 * finishes or a choice is saved.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See src/app/api/profile/color/route.ts for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/hair", async (route) => {
    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    const view = await buildHairView(session);
    if (view === null) {
      // A session with no profile has no face shape to read from. The screen
      // sends the person to capture rather than drawing an empty row.
      throw notFound(messages.profileNotReady);
    }
    return ok<HairView>(view);
  });
}
