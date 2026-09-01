import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { notFound, ok } from "@/lib/server/http/responses";
import { buildColorView } from "@/lib/server/profile/color";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import type { ColorView } from "@/lib/shared/color-view";

/**
 * GET /api/profile/color
 *
 * The ColorView docs/01-user-flow.md section G renders: the detected tone, the
 * undertone and where it came from, and the palette derived from them.
 *
 * The screen itself is a server component that calls buildColorView directly.
 * This route exists for the browser, which re reads the view after the person
 * confirms an undertone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fixture mode answers from the checked in fixture before it reads anything, so
 * there is no session to resolve and no Supabase project to resolve one against.
 * Same reasoning as src/app/(app)/report/page.tsx.
 */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/color", async (route) => {
    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    const view = await buildColorView(session);
    if (view === null) {
      // A session with no profile has no tone to show. The screen sends the
      // person to capture rather than drawing an empty palette.
      throw notFound(messages.profileNotReady);
    }
    return ok<ColorView>(view);
  });
}
