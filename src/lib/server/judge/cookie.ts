import "server-only";

import { JUDGE_SESSION_LIFETIME_HOURS, secureCookiesEnabled } from "../env";

/**
 * The judge session cookie.
 *
 * docs/07-payments-and-judge-mode.md: "sets an httpOnly, secure, sameSite
 * strict cookie with the session id" for 24 hours. It carries the session id
 * and nothing else. The id is a random uuid minted by Postgres, so it is not
 * guessable and it reveals nothing about the code that opened the session.
 */

export const JUDGE_SESSION_COOKIE = "judge_session";

export const JUDGE_SESSION_MAX_AGE_SECONDS =
  JUDGE_SESSION_LIFETIME_HOURS * 60 * 60;

export interface JudgeCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "strict";
  readonly path: "/";
  readonly maxAge: number;
}

export function judgeCookieOptions(): JudgeCookieOptions {
  return {
    httpOnly: true,
    // Plain http localhost cannot store a Secure cookie, so development is the
    // one place the flag comes off. Everywhere else it is on.
    secure: secureCookiesEnabled(),
    sameSite: "strict",
    path: "/",
    maxAge: JUDGE_SESSION_MAX_AGE_SECONDS,
  };
}

/** Same attributes with a zero lifetime, to clear an expired session. */
export function judgeCookieClearOptions(): JudgeCookieOptions {
  return { ...judgeCookieOptions(), maxAge: 0 };
}
