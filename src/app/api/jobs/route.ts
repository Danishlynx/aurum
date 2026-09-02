import type { NextRequest } from "next/server";
import { z } from "zod";

import { getCapture } from "@/lib/server/db";
import { providerCallsEnabled } from "@/lib/server/env";
import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, notFound, ok } from "@/lib/server/http/responses";
import {
  pollCaptureJobs,
  readCaptureJobs,
  type CaptureJobsView,
} from "@/lib/server/jobs";
import { getConsent } from "@/lib/server/session";

/**
 * GET /api/jobs?capture=<id>
 *
 * docs/03-architecture.md step 5: the client polls this every 1.5 seconds; each
 * poll checks pending provider tasks, stores completed results, and returns the
 * set. Polling the provider is throttled to one call per job per second inside
 * the jobs runner, so a faster client cannot multiply provider calls.
 *
 * The response is a superset of the shared API contract: every job carries id,
 * kind, status, and error, plus the attempt count, the capture level `complete`
 * flag the reveal screen uses, and the signed mask that screen blooms.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ capture: z.uuid() });

// Vercel ends a function at its plan default (10 seconds on Hobby) unless the
// route declares its own budget. This route waits on providers, so it does.
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/jobs", async (route) => {
    const session = await requireSession(route);

    const parsed = querySchema.safeParse({
      capture: request.nextUrl.searchParams.get("capture") ?? "",
    });
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const capture = await getCapture(session.id, parsed.data.capture);
    if (capture === null) {
      throw notFound();
    }

    let view: CaptureJobsView;
    if (providerCallsEnabled()) {
      const consent = await getConsent(session);
      view = await pollCaptureJobs({
        session,
        capture,
        keepOriginals: consent.keepOriginals,
        onProviderCall: (count) => {
          route.metrics.countProviderCall(count);
        },
      });
    } else {
      // Kill switch on: report what is stored and never touch a provider.
      route.noteOutcome("kill_switch");
      view = await readCaptureJobs(session.id, capture.id, "cache");
    }

    return ok({
      captureId: view.captureId,
      jobs: view.jobs,
      complete: view.complete,
      source: view.source,
      /*
       * The mask the reveal blooms, docs/01-user-flow.md section E step 2: a
       * signed URL for one object this person owns, valid for the read window in
       * src/lib/server/db/storage.ts, and null until the skin analysis has
       * produced one.
       */
      maskUrl: view.maskUrl,
    });
  });
}
