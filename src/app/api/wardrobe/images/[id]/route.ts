import type { NextRequest } from "next/server";

import { handleRoute } from "@/lib/server/http/handler";
import { notFound } from "@/lib/server/http/responses";
import {
  fixtureGarmentSvg,
} from "@/lib/server/profile/demo-fixture-wardrobe";
import { judgeAnalysesRemaining } from "@/lib/server/judge";
import { readJudgeSessionFromCookie } from "@/lib/server/judge/guard";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";

/**
 * GET /api/wardrobe/images/[id]
 *
 * Serves one checked in fixture silhouette, and nothing else.
 *
 * Why it exists: in fixture mode there is no Supabase project, so there is no
 * bucket to sign a read against, and the flat lay on /wardrobe and /looks would
 * have nothing to draw. The six silhouettes are drawn in code
 * (src/lib/server/profile/demo-fixture-wardrobe.ts), so this route hands them
 * over as a same origin path that next/image accepts.
 *
 * Two limits keep it from becoming a general image route:
 *
 * 1. It answers only for a caller who is being shown the checked in fixture
 *    wardrobe: AURUM_DEMO_FIXTURE in development, or a judge session with no
 *    analyses left, which reads the same six garments
 *    (src/lib/server/judge/demo.ts). With a real database the wardrobe view
 *    carries signed URLs for the person's own objects, and no garment photo is
 *    ever served through here.
 * 2. It answers only for the six fixture ids. Anything else is a 404 rather
 *    than a lookup, so no id from a request can reach storage through it.
 *
 * The response is markup this app wrote, not user content, but it is still sent
 * with a content security policy that allows nothing and with sniffing off, so
 * the shape can never be treated as a script.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fixture data never changes between deploys, so it can sit in a cache. */
const CACHE_CONTROL = "public, max-age=3600, immutable";

/**
 * True when the caller is a judge session with no analyses left, which is being
 * shown the same six garments the fixture wardrobe holds. Read from the judge
 * cookie alone, so this never reaches Supabase Auth and never needs a project.
 */
async function judgeReadsTheFixture(): Promise<boolean> {
  const judge = await readJudgeSessionFromCookie();
  return judge !== null && judgeAnalysesRemaining(judge) === 0;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/wardrobe/images/[id]", async () => {
    if (!isDemoFixtureMode() && !(await judgeReadsTheFixture())) {
      throw notFound();
    }

    const { id } = await context.params;
    const svg = fixtureGarmentSvg(id);
    if (svg === null) {
      throw notFound();
    }

    return new Response(svg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": CACHE_CONTROL,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
