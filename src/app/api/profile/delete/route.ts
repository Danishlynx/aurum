import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, HttpError, ok } from "@/lib/server/http/responses";
import { deleteEverything } from "@/lib/server/profile/delete";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import {
  profileDeleteRequestSchema,
  type ProfileDeleteResponse,
} from "@/lib/shared/profile-view";

/**
 * POST /api/profile/delete
 *
 * docs/01-user-flow.md section L item 3: "'Delete everything' (typed
 * confirmation: the person types DELETE)". docs/06-safety-privacy.md, "Person's
 * controls": it "removes rows and storage objects in one transaction, then signs
 * the person out. The toast says 'Deleted.'"
 *
 * The typed word is checked here as well as on the screen, because a typed
 * confirmation that only exists in the browser is a decoration. The schema takes
 * the literal, so anything else is a 400 before a single object is touched.
 *
 * Refused for a judge session and in fixture mode: docs/06-safety-privacy.md,
 * "Keys, sessions, abuse", says "Judge sessions cannot delete the demo profile",
 * and docs/01 says the control is never shown to them. The server refuses it in
 * both modes anyway, because a control the screen hides is not a permission
 * check. In fixture mode there is no database behind the demo profile at all,
 * and reporting a delete that removed nothing would be the one lie this screen
 * must never tell.
 *
 * A POST rather than a DELETE verb: the request carries a body, some proxies
 * drop a body on DELETE, and this is the one request in the app where the body
 * is the safety gate.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/delete", async (route) => {
    if (isDemoFixtureMode()) {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    const session = await requireSession(route);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = profileDeleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await deleteEverything({ session });
    if (!outcome.ok) {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    return ok<ProfileDeleteResponse>({ ok: true });
  });
}
