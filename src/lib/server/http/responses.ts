import "server-only";

import { NextResponse } from "next/server";

import type { RouteOutcome } from "./logging";
import { messages } from "./messages";

/**
 * Response shapes for every route.
 *
 * Every failure body is { error: string } where the string is a sentence the
 * person can read, per the shared API contract and docs/01-user-flow.md ("errors
 * explain and direct"). Extra fields are allowed alongside it, for example the
 * remaining count on a cap refusal, but `error` is always there and always first.
 */

export interface ErrorBody {
  readonly error: string;
  readonly [key: string]: unknown;
}

/**
 * A failure a route raises and the route wrapper turns into a response. Using a
 * throw keeps guard helpers ("require a session", "require consent") readable at
 * the call site instead of threading a union through every step.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly outcome: RouteOutcome;
  /** Our own short code for the log line. Never a provider payload. */
  readonly code: string;
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(init: {
    readonly status: number;
    readonly message: string;
    readonly outcome: RouteOutcome;
    readonly code: string;
    readonly extra?: Readonly<Record<string, unknown>>;
  }) {
    super(init.message);
    this.name = "HttpError";
    this.status = init.status;
    this.outcome = init.outcome;
    this.code = init.code;
    this.extra = init.extra ?? {};
  }

  toResponse(): NextResponse<ErrorBody> {
    return NextResponse.json<ErrorBody>(
      { error: this.message, ...this.extra },
      { status: this.status },
    );
  }
}

export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}

export function unauthorized(message: string = messages.signedOut): HttpError {
  return new HttpError({
    status: 401,
    message,
    outcome: "unauthorized",
    code: "no_session",
  });
}

export function forbidden(message: string = messages.consentRequired): HttpError {
  return new HttpError({
    status: 403,
    message,
    outcome: "forbidden",
    code: "consent_required",
  });
}

export function notFound(message: string = messages.captureNotFound): HttpError {
  return new HttpError({
    status: 404,
    message,
    outcome: "not_found",
    code: "not_found",
  });
}

export function badRequest(message: string = messages.invalidRequest): HttpError {
  return new HttpError({
    status: 400,
    message,
    outcome: "invalid_request",
    code: "invalid_request",
  });
}

export function tooManyRequests(args: {
  readonly message?: string;
  readonly retryAfterSeconds: number;
}): HttpError {
  return new HttpError({
    status: 429,
    message: args.message ?? messages.tooManyRequests,
    outcome: "rate_limited",
    code: "rate_limited",
    extra: { retryAfterSeconds: args.retryAfterSeconds },
  });
}

/** A cap, not a rate limit: the same 429 with the copy the flow doc uses. */
export function capReached(args: {
  readonly message: string;
  readonly code: "judge_analyses" | "judge_credits" | "daily_credits";
  readonly remaining: number;
}): HttpError {
  return new HttpError({
    status: 429,
    message: args.message,
    outcome: "cap_reached",
    code: args.code,
    extra: { remaining: args.remaining },
  });
}

export function serverError(message: string = messages.serverError): HttpError {
  return new HttpError({
    status: 500,
    message,
    outcome: "server_error",
    code: "server_error",
  });
}

/** A successful body. No caching: every one of these is per person. */
export function ok<T extends object>(body: T, status = 200): NextResponse<T> {
  return NextResponse.json<T>(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

