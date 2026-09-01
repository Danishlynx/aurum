import "server-only";

import type { NextRequest } from "next/server";

import { isDatabaseError } from "../db/service";
import { isServerConfigError } from "../env";
import { isProviderError, toProviderLogLine } from "../providers/errors";
import { getConsent, getSession, type AppSession } from "../session";
import {
  logProviderFailure,
  logRoute,
  RequestMetrics,
  type RouteOutcome,
} from "./logging";
import { messages } from "./messages";
import {
  consumeRateLimit,
  ipSubject,
  sessionSubject,
  type RateLimitName,
} from "./rate-limit";
import {
  forbidden,
  HttpError,
  isHttpError,
  serverError,
  tooManyRequests,
  unauthorized,
} from "./responses";

/**
 * The wrapper every route handler runs inside.
 *
 * It gives the route a request id and a metrics counter, turns a thrown
 * HttpError into the { error } body the contract promises, turns anything else
 * into a 500 that says nothing about the internals, and writes exactly one
 * structured log line per request (docs/03-architecture.md, "Observability").
 */

export const REQUEST_ID_HEADER = "x-request-id";

export interface RouteContext {
  readonly requestId: string;
  readonly route: string;
  readonly request: NextRequest;
  readonly metrics: RequestMetrics;
  /** Best effort client address, used only as a rate limit subject. */
  readonly ip: string;
  /** Overrides the outcome in the log line when the status is not enough. */
  noteOutcome(outcome: RouteOutcome): void;
}

class MutableRouteContext implements RouteContext {
  outcome: RouteOutcome | null = null;
  session: AppSession | null = null;

  constructor(
    readonly requestId: string,
    readonly route: string,
    readonly request: NextRequest,
    readonly metrics: RequestMetrics,
    readonly ip: string,
  ) {}

  noteOutcome(outcome: RouteOutcome): void {
    this.outcome = outcome;
  }
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) {
      return first;
    }
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function outcomeForStatus(status: number): RouteOutcome {
  if (status === 201 || status === 202) {
    return "created";
  }
  if (status < 400) {
    return "ok";
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status < 500) {
    return "invalid_request";
  }
  return "server_error";
}

/**
 * Turns whatever a route threw into an HttpError. A provider failure is logged
 * with its issue paths (never its payload) and reported as a 502, because the
 * upstream failed, not the request.
 */
function toHttpError(
  thrown: unknown,
  context: MutableRouteContext,
): HttpError {
  if (isHttpError(thrown)) {
    return thrown;
  }

  if (isProviderError(thrown)) {
    logProviderFailure({
      requestId: context.requestId,
      route: context.route,
      ...toProviderLogLine(thrown),
    });
    return new HttpError({
      status: 502,
      message: messages.providerRefused,
      outcome: "server_error",
      code: `provider_${thrown.code}`,
    });
  }

  if (isServerConfigError(thrown)) {
    console.error(
      JSON.stringify({
        event: "aurum.config_error",
        requestId: context.requestId,
        route: context.route,
        variable: thrown.variable,
      }),
    );
    return new HttpError({
      status: 500,
      message: messages.notConfigured,
      outcome: "server_error",
      code: "not_configured",
    });
  }

  if (isDatabaseError(thrown)) {
    console.error(
      JSON.stringify({
        event: "aurum.database_error",
        requestId: context.requestId,
        route: context.route,
        operation: thrown.operation,
        code: thrown.code,
      }),
    );
    return serverError();
  }

  console.error(
    JSON.stringify({
      event: "aurum.unhandled_error",
      requestId: context.requestId,
      route: context.route,
      name: thrown instanceof Error ? thrown.name : "unknown",
    }),
  );
  return serverError();
}

export async function handleRoute(
  request: NextRequest,
  route: string,
  handler: (context: RouteContext) => Promise<Response>,
): Promise<Response> {
  const requestId =
    request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  const context = new MutableRouteContext(
    requestId,
    route,
    request,
    new RequestMetrics(),
    clientIp(request),
  );
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await handler(context);
  } catch (thrown) {
    const failure = toHttpError(thrown, context);
    context.metrics.noteError(failure.code);
    context.noteOutcome(failure.outcome);
    response = failure.toResponse();
  }

  response.headers.set(REQUEST_ID_HEADER, requestId);

  logRoute({
    requestId,
    route,
    method: request.method,
    status: response.status,
    outcome: context.outcome ?? outcomeForStatus(response.status),
    durationMs: Date.now() - startedAt,
    sessionKind: context.session === null ? "none" : context.session.kind,
    sessionId: context.session === null ? null : context.session.id,
    providerCalls: context.metrics.providerCalls,
    creditUnits: context.metrics.creditUnits,
    errorCode: context.metrics.errorCode,
  });

  return response;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** 401 unless a Supabase user or a live judge session is present. */
export async function requireSession(
  context: RouteContext,
): Promise<AppSession> {
  const session = await getSession();
  if (session === null) {
    throw unauthorized();
  }
  if (context instanceof MutableRouteContext) {
    context.session = session;
  }
  return session;
}

/** Optional session, for routes that answer either way. */
export async function readSession(
  context: RouteContext,
): Promise<AppSession | null> {
  const session = await getSession();
  if (session !== null && context instanceof MutableRouteContext) {
    context.session = session;
  }
  return session;
}

/**
 * 403 unless consent is recorded.
 * docs/06-safety-privacy.md: "The server enforces this: the capture and analyze
 * routes return 403 unless profiles.consent_at and is_adult_confirmed are set."
 */
export async function requireConsent(session: AppSession): Promise<void> {
  const consent = await getConsent(session);
  if (!consent.consented) {
    throw forbidden();
  }
}

/** Applies a rate limit to the session and the client address together. */
export async function enforceRateLimit(args: {
  readonly context: RouteContext;
  readonly name: RateLimitName;
  readonly session: AppSession;
}): Promise<void> {
  const decision = await consumeRateLimit(args.name, [
    sessionSubject(args.session.id),
    ipSubject(args.context.ip),
  ]);
  if (!decision.allowed) {
    throw tooManyRequests({ retryAfterSeconds: decision.retryAfterSeconds });
  }
}
