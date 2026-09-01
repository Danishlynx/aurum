import type { NextRequest } from "next/server";
import { z } from "zod";

import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, HttpError, notFound, ok } from "@/lib/server/http/responses";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { patchGarment, removeGarment } from "@/lib/server/wardrobe";
import {
  garmentPatchRequestSchema,
  type GarmentDeleteResponse,
  type GarmentView,
} from "@/lib/shared/wardrobe-view";

/**
 * PATCH and DELETE /api/garments/[id]
 *
 * PATCH is "Tap a chip to correct it." (docs/01-user-flow.md section J item 2).
 * Every value is checked against the vocabulary in
 * src/lib/shared/wardrobe-view.ts before it reaches a column, and the write
 * sets user_edited so a later classifier answer cannot replace the person's own
 * words (migration 0003).
 *
 * DELETE removes the row and the object together, which is what
 * docs/06-safety-privacy.md requires: "Garment photos are kept while the
 * garment exists; deleting a garment deletes its object."
 *
 * Both refuse in fixture mode before anything else: the checked in demo
 * wardrobe has no database behind it, and a correction that stored nothing must
 * not report success.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const garmentIdSchema = z.uuid();

function fixtureRefusal(): HttpError {
  return new HttpError({
    status: 403,
    message: messages.demoProfileReadOnly,
    outcome: "forbidden",
    code: "demo_profile_read_only",
  });
}

/** The id in the path, or a 404. A malformed id is not this person's garment. */
function readGarmentId(value: string): string {
  const parsed = garmentIdSchema.safeParse(value);
  if (!parsed.success) {
    throw notFound(messages.garmentNotFound);
  }
  return parsed.data;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/garments/[id]", async (route) => {
    if (isDemoFixtureMode()) {
      throw fixtureRefusal();
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "garments", session });

    const { id } = await context.params;
    const garmentId = readGarmentId(id);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw badRequest(messages.invalidRequest);
    }

    const parsed = garmentPatchRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const outcome = await patchGarment({
      session,
      garmentId,
      patch: parsed.data,
    });
    if (!outcome.ok) {
      throw notFound(messages.garmentNotFound);
    }

    return ok<GarmentView>(outcome.view);
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleRoute(request, "/api/garments/[id]", async (route) => {
    if (isDemoFixtureMode()) {
      throw fixtureRefusal();
    }

    const session = await requireSession(route);
    await requireConsent(session);
    await enforceRateLimit({ context: route, name: "garments", session });

    const { id } = await context.params;
    const garmentId = readGarmentId(id);

    const outcome = await removeGarment({ session, garmentId });
    if (!outcome.ok) {
      throw notFound(messages.garmentNotFound);
    }

    return ok<GarmentDeleteResponse>({ ok: true });
  });
}
