import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { ok } from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import { buildWardrobeView } from "@/lib/server/wardrobe";
import type { WardrobeView } from "@/lib/shared/wardrobe-view";

/**
 * GET /api/wardrobe
 *
 * The WardrobeView docs/01-user-flow.md section J renders: the grid of garment
 * cards with their chips, their photos, and the state of each classification.
 *
 * It costs no provider call. An empty wardrobe answers with an empty array,
 * which is the empty state the screen opens on, not an error.
 *
 * The screen itself is a server component that calls buildWardrobeView
 * directly. This route exists for the browser, which re reads the view after an
 * upload, a classification, or a correction.
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
  return handleRoute(request, "/api/wardrobe", async (route) => {
    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    return ok<WardrobeView>(await buildWardrobeView(session));
  });
}
