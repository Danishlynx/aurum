import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, HttpError, notFound, ok } from "@/lib/server/http/responses";
import { setKeepOriginals } from "@/lib/server/profile/delete";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { buildProfileView } from "@/lib/server/profile/view";
import type { AppSession } from "@/lib/server/session";
import {
  profileUpdateRequestSchema,
  type ProfileUpdateResponse,
  type ProfileView,
} from "@/lib/shared/profile-view";

/**
 * GET  /api/profile   the ProfileView docs/01-user-flow.md section L renders
 * PATCH /api/profile  the "Keep original photos" toggle on the same screen
 *
 * The screen itself is a server component that calls buildProfileView directly.
 * GET exists for the browser, which re reads the view after the toggle and after
 * anything else on the screen changes a value.
 *
 * There is no POST here. The two destructive controls have their own routes, so
 * a delete can never be reached by posting to the read endpoint by accident.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See src/app/api/profile/color/route.ts for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile", async (route) => {
    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    return ok<ProfileView>(await buildProfileView(session));
  });
}

export async function PATCH(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile", async (route) => {
    // Answered first, and refused: there is no database behind the checked in
    // demo profile, and a toggle that stored nothing must not report success
    // (docs/07-payments-and-judge-mode.md: "The demo profile is read only").
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

    const parsed = profileUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await setKeepOriginals({
      session,
      keepOriginals: parsed.data.keepOriginals,
    });

    if (!outcome.ok) {
      if (outcome.reason === "read_only") {
        throw new HttpError({
          status: 403,
          message: messages.demoProfileReadOnly,
          outcome: "forbidden",
          code: "demo_profile_read_only",
        });
      }
      // The retention choice is part of consent, so with no consent row there is
      // nothing to change and the person is sent back to the welcome screen.
      throw notFound(messages.profileNotReady);
    }

    return ok<ProfileUpdateResponse>({ ok: true });
  });
}
