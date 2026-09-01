import type { NextRequest } from "next/server";

import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, HttpError, ok } from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { createGarmentSlots } from "@/lib/server/wardrobe";
import {
  garmentCreateRequestSchema,
  type GarmentCreateResponse,
} from "@/lib/shared/wardrobe-view";

/**
 * POST /api/garments
 *
 * docs/01-user-flow.md section J item 2: "multi select from the camera roll.
 * Each photo becomes a card". This claims one row and one signed upload slot per
 * photo, the same shape POST /api/captures uses, and no image bytes reach this
 * server (docs/03-architecture.md, "Request flow for a capture" steps 2 and 3).
 *
 * The order of the gates, and why:
 * 1. fixture mode, which has no database, so a write cannot be answered honestly
 * 2. session, or nothing else matters
 * 3. consent, because a garment photo is the person's own data and the same
 *    consent record governs what we store (docs/06-safety-privacy.md)
 * 4. rate limit, before any row is written
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fixtureRefusal(): HttpError {
  return new HttpError({
    status: 403,
    message: messages.demoProfileReadOnly,
    outcome: "forbidden",
    code: "demo_profile_read_only",
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/garments", async (route) => {
    if (isDemoFixtureMode()) {
      throw fixtureRefusal();
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "garments", session });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = garmentCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await createGarmentSlots({
      session,
      count: parsed.data.count,
    });

    if (!outcome.ok) {
      throw new HttpError({
        status: 409,
        message: messages.wardrobeFull,
        outcome: "invalid_request",
        code: "wardrobe_full",
        extra: { remaining: outcome.remaining },
      });
    }

    return ok<GarmentCreateResponse>({ slots: outcome.slots }, 201);
  });
}
