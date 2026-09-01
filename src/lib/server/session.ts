import "server-only";

import { cookies } from "next/headers";

import { getProfile } from "./db";
import type { CreditOwnerType, JudgeSession, Profile } from "./db/types";
import { currentUserId } from "./db/user";
import {
  JUDGE_SESSION_COOKIE,
  loadJudgeSession,
  touchJudgeSession,
} from "./judge";

/**
 * One session type for both ways into the app.
 *
 * docs/07-payments-and-judge-mode.md: "Server routes accept either a Supabase
 * JWT or a valid judge cookie. Data written during a judge session is owned by
 * the session id." Everything downstream (captures, analyses, jobs, the credit
 * ledger, storage paths) keys off `ownerId`, so neither path needs a branch.
 */

export interface UserSession {
  readonly kind: "user";
  /** auth.users id. Also the owner id on every row this person writes. */
  readonly id: string;
  readonly ownerType: "user";
}

export interface JudgeSessionContext {
  readonly kind: "judge";
  /** judge_sessions id. Also the owner id on every row the session writes. */
  readonly id: string;
  readonly ownerType: "judge_session";
  readonly session: JudgeSession;
}

export type AppSession = UserSession | JudgeSessionContext;

export function ownerTypeOf(session: AppSession): CreditOwnerType {
  return session.ownerType;
}

/**
 * Resolves the caller.
 *
 * The judge cookie is checked first when it is present, which keeps the judge
 * path off the auth server entirely. A person with a Supabase session and no
 * judge cookie takes the second branch, where getUser revalidates the JWT
 * rather than trusting the cookie.
 */
export async function getSession(): Promise<AppSession | null> {
  const store = await cookies();
  const judgeCookie = store.get(JUDGE_SESSION_COOKIE);

  if (judgeCookie !== undefined && judgeCookie.value.length > 0) {
    const session = await loadJudgeSession(judgeCookie.value);
    if (session !== null) {
      await touchJudgeSession(session.id);
      return {
        kind: "judge",
        id: session.id,
        ownerType: "judge_session",
        session,
      };
    }
  }

  const userId = await currentUserId();
  if (userId !== null) {
    return { kind: "user", id: userId, ownerType: "user" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface ConsentState {
  /** True only when both consent_at and is_adult_confirmed are recorded. */
  readonly consented: boolean;
  readonly keepOriginals: boolean;
  readonly consentVersion: string | null;
}

/**
 * Consent lives on profiles for a signed in person and on judge_sessions for a
 * judge, because profiles.user_id references auth.users and a judge never has a
 * row there (migration 0002 and migration 0008).
 *
 * docs/06-safety-privacy.md: "the capture and analyze routes return 403 unless
 * profiles.consent_at and is_adult_confirmed are set."
 */
export async function getConsent(session: AppSession): Promise<ConsentState> {
  if (session.kind === "judge") {
    const row = session.session;
    return {
      consented: row.consent_at !== null && row.is_adult_confirmed,
      keepOriginals: row.keep_originals,
      consentVersion: row.consent_version,
    };
  }

  const profile: Profile | null = await getProfile(session.id);
  if (profile === null) {
    return { consented: false, keepOriginals: false, consentVersion: null };
  }
  return {
    consented: profile.consent_at !== null && profile.is_adult_confirmed,
    keepOriginals: profile.keep_originals,
    consentVersion: profile.consent_version,
  };
}
