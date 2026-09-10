import type { NextRequest } from "next/server";

import { consentRequestSchema } from "@/lib/shared/schemas";

import { JUDGE_REMAINING_COOKIE } from "@/lib/client/judge-session";

import { upsertProfileConsent } from "@/lib/server/db";
import { openAccessEnabled } from "@/lib/server/env";
import {
  handleRoute,
  readSession,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, ok, serverError } from "@/lib/server/http/responses";
import {
  createJudgeSession,
  judgeAnalysesRemaining,
  JUDGE_SESSION_COOKIE,
  JUDGE_SESSION_MAX_AGE_SECONDS,
  judgeCookieOptions,
  recordJudgeConsent,
} from "@/lib/server/judge";
import type { AppSession } from "@/lib/server/session";

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
 *
 * It is also where a session comes from when the app is running without an
 * access code. See openAccessEnabled below.
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
    /*
     * Where a session comes from when there is no access code.
     *
     * With AURUM_OPEN_ACCESS on (src/lib/server/env.ts), somebody who has never
     * entered a code reaches this route with no session at all, and consent is
     * the right place to mint one. It is the first thing anybody writes, it is
     * the moment the app is given permission to hold anything, and a session
     * created any earlier would be a row written for a person who only ever
     * looked at the landing page.
     *
     * What is minted is a judge session in every respect except the code, so
     * every cap in docs/07-payments-and-judge-mode.md applies to it unchanged:
     * its own analyses, its own credits, its own renders, its own searches.
     * Nothing here weakens the consent gate itself. The two boxes are still
     * required, the record is still written before any capture route will
     * answer, and a request that already carries a session takes the ordinary
     * path and mints nothing.
     */
    const existing = await readSession(context);
    let mintedSession: Awaited<ReturnType<typeof createJudgeSession>> | null =
      null;

    let session: AppSession;
    if (existing !== null) {
      session = existing;
    } else if (openAccessEnabled()) {
      mintedSession = await createJudgeSession();
      session = {
        kind: "judge",
        id: mintedSession.id,
        ownerType: "judge_session",
        session: mintedSession,
      };
    } else {
      // Throws the 401 this route has always thrown when nobody is signed in
      // and no code has been entered.
      session = await requireSession(context);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = consentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const { keepOriginals, consentVersion } = parsed.data;

    let response: Response;
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
      response = ok({ ok: true, keepOriginals, consentVersion });
    } else {
      await upsertProfileConsent({
        userId: session.id,
        consentVersion,
        keepOriginals,
      });
      response = ok({ ok: true, keepOriginals, consentVersion });
    }

    /*
     * The cookies are written only for a session this request created. They
     * carry exactly what POST /api/judge/session writes for a session opened
     * with a code: the httpOnly session id, and the readable count the banner
     * renders from, which holds one small number and no secret because every cap
     * is enforced server side against the row.
     */
    if (mintedSession !== null) {
      response.headers.append(
        "set-cookie",
        serializeCookie(JUDGE_SESSION_COOKIE, mintedSession.id, {
          ...judgeCookieOptions(),
        }),
      );
      response.headers.append(
        "set-cookie",
        serializeCookie(
          JUDGE_REMAINING_COOKIE,
          String(judgeAnalysesRemaining(mintedSession)),
          {
            httpOnly: false,
            secure: judgeCookieOptions().secure,
            sameSite: "strict",
            path: "/",
            maxAge: JUDGE_SESSION_MAX_AGE_SECONDS,
          },
        ),
      );
    }

    return response;
  });
}

type CookieOptions = {
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "strict" | "lax" | "none";
  readonly path?: string;
  readonly maxAge?: number;
};

/**
 * One Set-Cookie header, written by hand.
 *
 * ok() returns a plain Response rather than a NextResponse, so there is no
 * cookies helper on it, and two cookies have to be appended rather than set: a
 * second call to headers.set would replace the first one and the session would
 * arrive without its banner count.
 */
function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path !== undefined) {
    parts.push(`Path=${options.path}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.sameSite !== undefined) {
    const value_ =
      options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1);
    parts.push(`SameSite=${value_}`);
  }
  if (options.secure === true) {
    parts.push("Secure");
  }
  if (options.httpOnly === true) {
    parts.push("HttpOnly");
  }
  return parts.join("; ");
}
