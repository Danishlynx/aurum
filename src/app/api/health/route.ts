import type { NextRequest } from "next/server";

import { globalRemainingToday } from "@/lib/server/credits";
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
 * It answers on a machine with no environment at all, which is what makes it
 * useful during a deploy. Both of the numbers below are therefore best effort
 * and both report null rather than taking the route down: the one outbound call
 * and the one database read.
 *
 * The outbound call is the Perfect Corp credit balance, made only when that key
 * is present. It creates no task and spends nothing, and it is the fastest way
 * to know before a demo whether there are units left to spend.
 *
 * The database read is perfectcorpGlobalRemainingToday: what is left of
 * GLOBAL_CAP_PERFECTCORP_UNITS_PER_DAY after every owner's spend so far this UTC
 * day. perfectcorpCredits is what the account has; this is what the deployment
 * has agreed to spend from it before tomorrow. Watching that one number is how a
 * run of new sessions is seen while it is happening rather than afterwards, in
 * the balance.
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

/**
 * The ledger lives in Supabase, so with no project configured there is nothing
 * to count and null is the honest answer. A failed read is null for the same
 * reason: a health route that fell over on a database hiccup would be useless in
 * the moment it is most wanted.
 */
async function globalRemainingOrNull(configured: boolean): Promise<number | null> {
  if (!configured) {
    return null;
  }
  try {
    return await globalRemainingToday();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/health", async () => {
    const providers = providerConfigState();
    const supabase = isSupabaseConfigured();
    const perfectcorpCredits = await perfectCorpCreditsOrNull(providers.perfectcorp);
    const perfectcorpGlobalRemainingToday = await globalRemainingOrNull(supabase);
    return ok({
      ok: true,
      sha: buildSha(),
      providerCallsEnabled: providerCallsEnabled(),
      time: new Date().toISOString(),
      configured: {
        supabase,
        judgeCode: isJudgeCodeConfigured(),
        perfectcorp: providers.perfectcorp,
        serpapi: providers.serpapi,
        anthropic: providers.anthropic,
      },
      perfectcorpCredits,
      perfectcorpGlobalRemainingToday,
    });
  });
}
