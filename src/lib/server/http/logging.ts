import "server-only";

/**
 * One structured line per request.
 *
 * docs/03-architecture.md, "Observability": request id, route, user or judge
 * session id, duration, provider calls made, credits spent, outcome.
 *
 * What never reaches a log line, per docs/06-safety-privacy.md: image bytes,
 * signed URLs, storage paths that are part of a signed URL, prompt text with a
 * person's data, the judge access code, and any provider key. The only free text
 * allowed is a code we chose ourselves.
 */

export type RouteOutcome =
  | "ok"
  | "created"
  | "cache_hit"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "rate_limited"
  | "cap_reached"
  | "kill_switch"
  | "server_error";

export interface RouteLogLine {
  readonly requestId: string;
  readonly route: string;
  readonly method: string;
  readonly status: number;
  readonly outcome: RouteOutcome;
  readonly durationMs: number;
  readonly sessionKind: "user" | "judge" | "none";
  /** Owner id. It is a uuid we minted, not a name, an email, or a photo. */
  readonly sessionId: string | null;
  readonly providerCalls: number;
  readonly creditUnits: number;
  /** Our own error code, never a provider payload. */
  readonly errorCode: string | null;
}

/**
 * A counter the route fills in as it works, so the log line at the end is one
 * object rather than a trail of console calls.
 */
export class RequestMetrics {
  providerCalls = 0;
  creditUnits = 0;
  errorCode: string | null = null;

  countProviderCall(count = 1): void {
    this.providerCalls += count;
  }

  countCredits(units: number): void {
    this.creditUnits += units;
  }

  noteError(code: string): void {
    this.errorCode = code;
  }
}

export function logRoute(line: RouteLogLine): void {
  // One JSON object per line: greppable in Vercel logs, parseable later.
  console.log(JSON.stringify({ event: "aurum.request", ...line }));
}

export interface ProviderLogFields {
  readonly requestId: string;
  readonly route: string;
  readonly provider: string;
  readonly code: string;
  readonly status: number | null;
  readonly providerCode: string | null;
  /** Zod issue paths only. Never values. */
  readonly issuePaths: readonly string[];
  readonly transient: boolean;
}

export function logProviderFailure(fields: ProviderLogFields): void {
  console.warn(JSON.stringify({ event: "aurum.provider_error", ...fields }));
}

export interface CapEventFields {
  readonly requestId: string;
  readonly route: string;
  readonly sessionKind: "user" | "judge";
  readonly sessionId: string;
  readonly kind: "judge_analyses" | "judge_credits" | "daily_credits" | "rate_limit";
  readonly remaining: number;
}

/** docs/07-payments-and-judge-mode.md: log judge session creation and cap events. */
export function logCapEvent(fields: CapEventFields): void {
  console.warn(JSON.stringify({ event: "aurum.cap", ...fields }));
}

export function logJudgeSessionCreated(fields: {
  readonly requestId: string;
  readonly sessionId: string;
  readonly analysesAllowed: number;
  readonly creditsCap: number;
}): void {
  console.log(JSON.stringify({ event: "aurum.judge_session_created", ...fields }));
}
