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
import { getCreditBalance } from "@/lib/server/providers/perfectcorp";

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
 *
 * The one outbound call it makes is the Perfect Corp credit balance, and only
 * when that key is present. It creates no task and spends nothing, and it is the
 * fastest way to know before a demo whether there are units left to spend. It is
 * strictly best effort: a slow or unhappy provider reports null rather than
 * taking the health route down with it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A health check waits this long for the balance and no longer. */
const CREDIT_TIMEOUT_MS = 4_000;

async function perfectCorpCreditsOrNull(configured: boolean): Promise<number | null> {
  if (!configured) {
    return null;
  }
  try {
    const balance = await getCreditBalance({ timeoutMs: CREDIT_TIMEOUT_MS });
    return balance.totalUnits;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/health", async () => {
    const providers = providerConfigState();
    const perfectcorpCredits = await perfectCorpCreditsOrNull(providers.perfectcorp);
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
      perfectcorpCredits,
    });
  });
}
