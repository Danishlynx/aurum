import type { NextRequest } from "next/server";

import {
  enforceRateLimit,
  handleRoute,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import {
  badRequest,
  HttpError,
  notFound,
  ok,
} from "@/lib/server/http/responses";
import { resolveGroundingLocale } from "@/lib/server/locale";
import {
  buildMakeupView,
  saveMakeupLook,
  type ShadeSelection,
} from "@/lib/server/profile/makeup";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import type { AppSession } from "@/lib/server/session";
import {
  makeupRenderParamsSchema,
  makeupViewQuerySchema,
  MAKEUP_CATEGORIES,
  type MakeupSaveResponse,
  type MakeupView,
} from "@/lib/shared/color-view";

/**
 * GET /api/profile/makeup, and POST for "Save this look".
 *
 * The MakeupView docs/01-user-flow.md section H renders: the selfie, the four
 * shade rows inside the palette, and one product per selected shade.
 *
 * Without ?ground=1 this costs no SerpApi search at all. With it, the selected
 * shade of each row is grounded through the same layer the report uses, so the
 * cache, the daily cap, and the "no listing, no product" rule are the ones
 * already written (docs/06-safety-privacy.md, "Grounding and honesty").
 *
 * The selection travels as one parameter per category holding the index of the
 * chosen shade, documented beside makeupViewQuerySchema in
 * src/lib/shared/color-view.ts.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** See src/app/api/profile/color/route.ts for why this exists. */
const FIXTURE_SESSION: AppSession = {
  kind: "user",
  id: "demo-fixture",
  ownerType: "user",
};

/**
 * The refusal a save gets on the demo profile, in the words and with the code
 * the hair save already uses (docs/07-payments-and-judge-mode.md: "The demo
 * profile is read only for judge sessions").
 */
function readOnlyRefusal(): HttpError {
  return new HttpError({
    status: 403,
    message: messages.demoProfileReadOnly,
    outcome: "forbidden",
    code: "demo_profile_read_only",
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/makeup", async (route) => {
    const parameters = request.nextUrl.searchParams;
    const parsed = makeupViewQuerySchema.safeParse({
      ground: parameters.get("ground"),
      lip: parameters.get("lip"),
      blush: parameters.get("blush"),
      foundation: parameters.get("foundation"),
      eye: parameters.get("eye"),
    });
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const selection: ShadeSelection = {};
    for (const category of MAKEUP_CATEGORIES) {
      selection[category] = parsed.data[category] ?? null;
    }

    const session = isDemoFixtureMode()
      ? FIXTURE_SESSION
      : await requireSession(route);

    // A search costs quota, so only the grounding form is rate limited
    // (docs/06-safety-privacy.md, "Keys, sessions, abuse").
    if (parsed.data.ground && !isDemoFixtureMode()) {
      await enforceRateLimit({ context: route, name: "products", session });
    }

    const view = await buildMakeupView(session, {
      ground: parsed.data.ground,
      selection,
      // The market comes from this request, not from the server's own country
      // (src/lib/server/locale.ts), so tapping a shade in Portland returns a
      // shop in Portland.
      locale: resolveGroundingLocale(request.headers),
    });
    if (view === null) {
      throw notFound(messages.profileNotReady);
    }
    return ok<MakeupView>(view);
  });
}

/**
 * POST /api/profile/makeup
 *
 * "Save this look", docs/01-user-flow.md section H item 4: the selected shades
 * are saved to the profile, and the screen opens on them next time
 * (migration 0013).
 *
 * The body is makeupRenderParamsSchema, the same shape POST /api/renders takes,
 * because it is the same look: saving it is what lets the next visit find the
 * render it was made with instead of asking for another one.
 *
 * No provider is called and no credit is spent here. Nothing is grounded either,
 * so this route is not rate limited: it writes one column on the caller's own
 * row.
 */
export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/makeup", async (route) => {
    // Answered first, exactly as the hair save answers it: there is no database
    // behind the checked in demo profile, and a save that stored nothing must
    // not report success.
    if (isDemoFixtureMode()) {
      throw readOnlyRefusal();
    }

    const session = await requireSession(route);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = makeupRenderParamsSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await saveMakeupLook({ session, params: parsed.data });
    if (outcome.ok) {
      return ok<MakeupSaveResponse>({ ok: true });
    }
    if (outcome.reason === "no_profile") {
      throw notFound(messages.profileNotReady);
    }
    throw readOnlyRefusal();
  });
}
