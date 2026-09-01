import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, notFound, ok } from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { pollRender } from "@/lib/server/renders";
import type { RenderView } from "@/lib/shared/color-view";

/**
 * GET /api/renders/[id]
 *
 * One pass over one try on: the client polls this while a render is running, the
 * same way it polls GET /api/jobs for an analysis. Each poll asks the provider
 * at most once, and the poll claim in the jobs layer keeps two polls arriving
 * together from producing two provider calls.
 *
 * renderUrl is present only on a succeeded render. There is no placeholder and
 * no substitute image: a pending or failed render answers with null, and
 * /makeup shows the unedited selfie with "Preview unavailable for this shade."
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.uuid() });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/renders/[id]", async (route) => {
    // Fixture mode never starts a render, so it has none to report on.
    if (isDemoFixtureMode()) {
      throw notFound(messages.tryOnUnavailable);
    }

    const session = await requireSession(route);

    const params = paramsSchema.safeParse(await context.params);
    if (!params.success) {
      throw badRequest(messages.invalidRequest);
    }

    const view = await pollRender({
      session,
      renderId: params.data.id,
      onProviderCall: (count) => {
        route.metrics.countProviderCall(count);
      },
    });
    if (view === null) {
      throw notFound(messages.tryOnUnavailable);
    }

    return ok<RenderView>(view);
  });
}
