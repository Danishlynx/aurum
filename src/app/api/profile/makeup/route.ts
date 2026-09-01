import type { NextRequest } from "next/server";

import {
  enforceRateLimit,
  handleRoute,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, notFound, ok } from "@/lib/server/http/responses";
import { buildMakeupView, type ShadeSelection } from "@/lib/server/profile/makeup";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import {
  makeupViewQuerySchema,
  MAKEUP_CATEGORIES,
  type MakeupView,
} from "@/lib/shared/color-view";

/**
 * GET /api/profile/makeup
 *
 * The MakeupView docs/01-user-flow.md section H renders: the selfie, the four
 * shade rows inside the palette, and one product per selected shade.
 *
 * Without ?ground=1 this costs no SerpApi search at all. With it, the selected
 * shade of each row is grounded through the same layer the report uses, so the
 * cache, the daily cap, and the "no listing, no product" rule are the ones
 * already written (docs/06-safety-privacy.md, "Grounding and honesty").
 *
 * The selection travels as one parameter per category holding the index of the
 * chosen shade, documented beside makeupViewQuerySchema in
 * src/lib/shared/color-view.ts.
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
  return handleRoute(request, "/api/profile/makeup", async (route) => {
    const parameters = request.nextUrl.searchParams;
    const parsed = makeupViewQuerySchema.safeParse({
      ground: parameters.get("ground"),
      lip: parameters.get("lip"),
      blush: parameters.get("blush"),
      foundation: parameters.get("foundation"),
      eye: parameters.get("eye"),
    });
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const selection: ShadeSelection = {};
    for (const category of MAKEUP_CATEGORIES) {
      selection[category] = parsed.data[category] ?? null;
    }

    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    // A search costs quota, so only the grounding form is rate limited
    // (docs/06-safety-privacy.md, "Keys, sessions, abuse").
    if (parsed.data.ground && !isDemoFixtureMode()) {
      await enforceRateLimit({ context: route, name: "products", session });
    }

    const view = await buildMakeupView(session, {
      ground: parsed.data.ground,
      selection,
    });
    if (view === null) {
      throw notFound(messages.profileNotReady);
    }
    return ok<MakeupView>(view);
  });
}
