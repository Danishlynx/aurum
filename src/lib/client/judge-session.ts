/**
 * The judge session as the browser can see it.
 *
 * The session itself lives in the httpOnly cookie the server sets on
 * POST /api/judge/session (docs/07-payments-and-judge-mode.md), which client
 * code cannot and should not read.
 *
 * docs/01-user-flow.md wants the banner on every screen with a live count, and
 * there is no route that returns the remaining count for the current session.
 * Until there is, the count is mirrored into a second, readable, non secret
 * cookie: written when the session is created, decremented when an analysis is
 * accepted. A wrong count here can only ever make the banner stale; the caps
 * themselves are enforced server side and are not affected by this value.
 *
 * OPEN ITEM: replace this with a server route that returns the live count, and
 * delete the mirror cookie.
 */

/** Set by the server. httpOnly, secure, sameSite strict. Presence only. */
export const JUDGE_SESSION_COOKIE = "judge_session";

/** The mirrored count. Readable, non secret, same 24 hour life as the session. */
export const JUDGE_REMAINING_COOKIE = "judge_analyses_remaining";

const TWENTY_FOUR_HOURS_SECONDS = 60 * 60 * 24;

/** Parses a cookie value into a count. Returns null for anything unexpected. */
export function parseRemaining(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0 || value > 999) {
    return null;
  }
  return value;
}

function writeRemaining(remaining: number): void {
  const attributes = [
    `${JUDGE_REMAINING_COOKIE}=${String(remaining)}`,
    "path=/",
    `max-age=${String(TWENTY_FOUR_HOURS_SECONDS)}`,
    "samesite=strict",
  ];
  if (window.location.protocol === "https:") {
    attributes.push("secure");
  }
  document.cookie = attributes.join("; ");
}

export function readJudgeRemaining(): number | null {
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${JUDGE_REMAINING_COOKIE}=`));
  if (entry === undefined) {
    return null;
  }
  return parseRemaining(entry.slice(JUDGE_REMAINING_COOKIE.length + 1));
}

export function rememberJudgeRemaining(remaining: number): void {
  writeRemaining(Math.max(0, Math.trunc(remaining)));
}

/** Called once an analysis has actually been accepted by the server. */
export function decrementJudgeRemaining(): void {
  const current = readJudgeRemaining();
  if (current === null || current === 0) {
    return;
  }
  writeRemaining(current - 1);
}
