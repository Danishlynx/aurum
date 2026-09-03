import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { ok } from "@/lib/server/http/responses";
import { resolveGroundingLocale } from "@/lib/server/locale";
import { buildLooksView } from "@/lib/server/looks";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import {
  DEFAULT_OCCASION,
  looksViewQuerySchema,
  OCCASION_QUERY_PARAM,
  type LooksView,
} from "@/lib/shared/looks-view";

/**
 * GET /api/looks?occasion=<occasion>
 *
 * The LooksView docs/01-user-flow.md section K renders: two to three composed
 * looks for one occasion, each with a rationale, a flat lay of the person's own
 * garments, whatever try on already exists for the hero, and a card for the
 * pieces the look is missing.
 *
 * An absent or unknown occasion reads as "everyday" rather than as an error: a
 * chip row with nothing selected is not a state section K has.
 *
 * What it costs: no Perfect Corp call at all, one Claude call for the ranking
 * when a key is present, and one SerpApi search per distinct missing piece,
 * cached and capped like every other search. With no keys it still answers, with
 * the rules ranking and empty product cards.
 *
 * The screen itself is a server component that calls buildLooksView directly.
 * This route exists for the browser, which re reads the view when the occasion
 * chip changes or a look is saved.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See src/app/api/profile/color/route.ts for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

// Vercel ends a function at its plan default (10 seconds on Hobby) unless the
// route declares its own budget. This route waits on providers, so it does.
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/looks", async (route) => {
    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    const parsed = looksViewQuerySchema.safeParse({
      occasion: request.nextUrl.searchParams.get(OCCASION_QUERY_PARAM),
    });
    const occasion = parsed.success ? parsed.data.occasion : DEFAULT_OCCASION;

    // The pieces a look is missing are shopped for in the caller's own country,
    // read from this request (src/lib/server/locale.ts).
    return ok<LooksView>(
      await buildLooksView(
        session,
        occasion,
        resolveGroundingLocale(request.headers),
      ),
    );
  });
}
