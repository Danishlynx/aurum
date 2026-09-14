import "server-only";

import { openAccessEnabled } from "../env";
import { judgeAnalysesCapReached } from "../judge";
import { readJudgeSessionFromCookie } from "../judge/guard";
import { getConsent, getSession } from "../session";
import type { AppSession } from "../session";

/**
 * Whether /capture should offer the camera, or send the person to consent
 * first.
 *
 * The camera screen is entirely client side and, until 2026-09-14, was offered
 * to anyone who reached it. That was fine while the only way in was the consent
 * screen. It is not fine now: every empty screen in the (app) group links
 * straight to /capture ("Start with a selfie"), a restored tab or a bookmark
 * lands there directly, and a judge session lives 24 hours
 * (JUDGE_SESSION_LIFETIME_HOURS). So a person who consented yesterday framed a
 * selfie today, tapped, and was told "Upload did not complete. Your photo was
 * not saved. Try again." The register call had answered 401. Retake led back
 * to the same answer. Nothing on the screen said what was missing.
 *
 * The rule: with open access on, the consent screen can always repair a
 * missing session (POST /api/consent mints one for a device that has none,
 * src/app/api/consent/route.ts), so a person without a consented session is
 * sent there before they frame anything, rather than after they have taken a
 * photo that cannot be sent.
 *
 * Only with open access on. With the access code in front of the app, a
 * missing session is repaired at /judge and the consent screen would only say
 * so; and the e2e servers run in that mode with no Supabase project and no
 * session at all, where the camera screen has always rendered as a public
 * screen. In that mode this reads the judge cookie alone, exactly as the page
 * did before, and never reaches the auth server.
 *
 * Fail open, deliberately: a session read that throws (no project configured,
 * a database that did not answer) offers the camera rather than a redirect it
 * cannot justify. The capture and analyze routes still answer 401 and 403
 * themselves, and the screen sends those to consent too
 * (src/components/capture/CaptureScreen.tsx). This guard is the early answer,
 * not the only one.
 */

export type CaptureEntry =
  | { readonly kind: "welcome" }
  | { readonly kind: "camera"; readonly analysesExhausted: boolean };

/** The facts the decision is made from, so the decision can be tested alone. */
export type CaptureEntryFacts = {
  readonly openAccess: boolean;
  /** Null when there is no session on the request. */
  readonly session: AppSession | null;
  /** Null when there is no session to hold a consent. */
  readonly consented: boolean | null;
};

export function captureEntryFor(facts: CaptureEntryFacts): CaptureEntry {
  const { openAccess, session, consented } = facts;
  if (openAccess && (session === null || consented !== true)) {
    return { kind: "welcome" };
  }
  return {
    kind: "camera",
    analysesExhausted:
      session !== null &&
      session.kind === "judge" &&
      judgeAnalysesCapReached(session.session),
  };
}

/**
 * Reads the request and decides. With open access on, the session read is the
 * same one every route makes (getSession), so the answer here is the answer
 * the register call is about to give.
 */
export async function readCaptureEntry(): Promise<CaptureEntry> {
  if (!openAccessEnabled()) {
    const judge = await readJudgeSessionFromCookie();
    return {
      kind: "camera",
      analysesExhausted: judge !== null && judgeAnalysesCapReached(judge),
    };
  }

  let session: AppSession | null;
  let consented: boolean | null = null;
  try {
    session = await getSession();
    if (session !== null) {
      consented = (await getConsent(session)).consented;
    }
  } catch {
    // A read that failed says nothing about the session, and a screen is not
    // disabled on nothing. See "Fail open" above.
    return { kind: "camera", analysesExhausted: false };
  }
  return captureEntryFor({ openAccess: true, session, consented });
}
