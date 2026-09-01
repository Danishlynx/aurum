import type { NextRequest } from "next/server";

import { consentRequestSchema } from "@/lib/shared/schemas";

import { upsertProfileConsent } from "@/lib/server/db";
import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, ok, serverError } from "@/lib/server/http/responses";
import { recordJudgeConsent } from "@/lib/server/judge";

/**
 * POST /api/consent
 *
 * docs/06-safety-privacy.md: no capture and no upload before the person has
 * checked "I am 18 or older" and "I agree to have my selfie processed to build
 * my profile". This route is where that is recorded; the capture and analyze
 * routes read it and return 403 when it is missing.
 *
 * Both boxes are required, so both are literal true rather than boolean: a false
 * value is a validation failure, not a stored no.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The body is consentRequestSchema from src/lib/shared/schemas.ts, unchanged.
 * That file is the one contract both sides read, so there is nothing to
 * translate here and no second set of field names to keep in step.
 */

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/consent", async (context) => {
    const session = await requireSession(context);

    const body: unknown = await request.json().catch(() => null);
    const parsed = consentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const { keepOriginals, consentVersion } = parsed.data;

    if (session.kind === "judge") {
      // profiles.user_id references auth.users and a judge never has a row
      // there, so a judge's consent is recorded on the session (migration 0008).
      const updated = await recordJudgeConsent({
        sessionId: session.id,
        consentVersion,
        keepOriginals,
      });
      if (updated === null) {
        throw serverError();
      }
      return ok({ ok: true, keepOriginals, consentVersion });
    }

    await upsertProfileConsent({
      userId: session.id,
      consentVersion,
      keepOriginals,
    });
    return ok({ ok: true, keepOriginals, consentVersion });
  });
}
