import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { jobsReconcileSecret, providerCallsEnabled } from "@/lib/server/env";
import { handleRoute } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { HttpError, ok } from "@/lib/server/http/responses";
import {
  RECONCILE_BUDGET_MS,
  RECONCILE_CAPTURES_PER_PASS,
  reconcileOpenCaptures,
} from "@/lib/server/jobs/reconcile";

/**
 * POST /api/jobs/reconcile
 *
 * The scheduled driver for readings nobody is polling
 * (docs/03-architecture.md, "Jobs", reconcile). pg_cron in the Supabase project
 * calls it once a minute through pg_net
 * (supabase/migrations/0016_jobs_reconcile_schedule.sql); it polls every open
 * analysis job no tab is watching, so a backgrounded phone never strands a
 * task the provider will charge for whether or not it is read.
 *
 * Auth is a bearer and nothing else. There is no person behind this call, so
 * there is no session and no cookie: the caller holds the same value as
 * JOBS_RECONCILE_SECRET, read out of Vault on the database side. The compare
 * is constant time on equal length buffers. A wrong or missing bearer answers
 * 401 before anything is read, so the route cannot be used to make the server
 * do work, and an unset secret answers 503 with a log line, so a deployment
 * without the driver is visibly without it.
 *
 * Under the kill switch the route answers 200 and does nothing. The poll it
 * would run reads tasks, starts followers and builds profiles, every one of
 * which is a provider call the switch exists to stop.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * The pass gives itself RECONCILE_BUDGET_MS before it stops taking captures,
 * and the capture it is on may still need a provider read or two. 60 is the
 * same budget the poll route and the analyze route declare, for the same
 * provider.
 */
export const maxDuration = 60;

const ROUTE = "/api/jobs/reconcile";

/** The header's shape. The value inside it is compared below, never parsed. */
const authorizationSchema = z.string().regex(/^Bearer \S+$/u);

function bearerMatches(header: string | null, secret: string): boolean {
  const parsed = authorizationSchema.safeParse(header);
  if (!parsed.success) {
    return false;
  }
  const given = Buffer.from(parsed.data.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (given.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(given, expected);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, ROUTE, async (route) => {
    const secret = jobsReconcileSecret();
    if (secret === null) {
      console.warn(
        JSON.stringify({
          event: "aurum.reconcile_not_configured",
          requestId: route.requestId,
          note: "JOBS_RECONCILE_SECRET is unset, so the scheduled driver cannot run",
        }),
      );
      throw new HttpError({
        status: 503,
        message: messages.notConfigured,
        outcome: "server_error",
        code: "reconcile_not_configured",
      });
    }

    if (!bearerMatches(request.headers.get("authorization"), secret)) {
      throw new HttpError({
        status: 401,
        message: messages.reconcileUnauthorized,
        outcome: "unauthorized",
        code: "reconcile_unauthorized",
      });
    }

    if (!providerCallsEnabled()) {
      route.noteOutcome("kill_switch");
      return ok({ skipped: "kill_switch" });
    }

    const counts = await reconcileOpenCaptures({
      limit: RECONCILE_CAPTURES_PER_PASS,
      budgetMs: RECONCILE_BUDGET_MS,
      source: "cron",
    });
    route.metrics.countProviderCall(counts.providerCalls);
    return ok(counts);
  });
}
