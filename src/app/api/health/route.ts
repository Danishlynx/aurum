import type { NextRequest } from "next/server";

import {
  buildSha,
  isJudgeCodeConfigured,
  isSupabaseConfigured,
  providerCallsEnabled,
  providerConfigState,
} from "@/lib/server/env";
import { handleRoute } from "@/lib/server/http/handler";
import { ok } from "@/lib/server/http/responses";

/**
 * GET /api/health
 *
 * docs/03-architecture.md, "Observability": build sha and the provider kill
 * switch state. The configuration block reports whether each key is present as a
 * boolean. No value, no prefix, no length: a health route that leaked a key
 * shape would be worse than no health route.
 *
 * This route never touches the database, so it answers on a machine with no
 * environment at all, which is what makes it useful during a deploy.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/health", async () => {
    const providers = providerConfigState();
    return ok({
      ok: true,
      sha: buildSha(),
      providerCallsEnabled: providerCallsEnabled(),
      time: new Date().toISOString(),
      configured: {
        supabase: isSupabaseConfigured(),
        judgeCode: isJudgeCodeConfigured(),
        perfectcorp: providers.perfectcorp,
        serpapi: providers.serpapi,
        anthropic: providers.anthropic,
      },
    });
  });
}
