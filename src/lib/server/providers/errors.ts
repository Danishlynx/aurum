import "server-only";

/**
 * One typed error for every provider boundary.
 * Nothing outside a provider module reads a provider wire format, so nothing
 * outside a provider module needs to read a provider status code either.
 * Spec: docs/04-integrations.md (error handling) and docs/03-architecture.md
 * (observability: log status, provider error code, and the zod issue path).
 */

export type ProviderName = "perfectcorp" | "serpapi" | "anthropic";

export type ProviderErrorCode =
  /** A required environment variable is missing on the server. */
  | "provider_not_configured"
  /** The endpoint has not been verified against the live docs yet. */
  | "endpoint_unverified"
  /** We refused to send the request because our own input failed a check. */
  | "invalid_input"
  /** The HTTP call passed the per call timeout. */
  | "request_timeout"
  /** The HTTP call never reached the provider. */
  | "network_error"
  /** The provider rejected our credentials. */
  | "auth_failed"
  /** The provider rate limited or quota limited us. */
  | "rate_limited"
  /** The provider answered with an error status. */
  | "provider_error"
  /** The provider answered, but the body did not match the schema. */
  | "invalid_response"
  /** An asynchronous task finished in an error state. */
  | "task_failed";

const TRANSIENT_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "request_timeout",
  "network_error",
  "rate_limited",
]);

export interface ProviderErrorInit {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  readonly message: string;
  /** HTTP status, when the provider answered. */
  readonly status?: number;
  /** The provider's own error identifier, when it gives one. */
  readonly providerCode?: string;
  /** Zod issue paths only. Never values, never image bytes. */
  readonly issuePaths?: readonly string[];
  readonly cause?: unknown;
}

/**
 * A provider failure that the jobs layer can branch on without knowing which
 * provider produced it.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly providerCode: string | null;
  readonly issuePaths: readonly string[];

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderError";
    this.provider = init.provider;
    this.code = init.code;
    this.status = init.status ?? null;
    this.providerCode = init.providerCode ?? null;
    this.issuePaths = init.issuePaths ?? [];
  }

  /** True when one automatic retry with backoff is worth attempting. */
  get isTransient(): boolean {
    if (TRANSIENT_CODES.has(this.code)) {
      return true;
    }
    return this.status !== null && this.status >= 500;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

export function isTransientProviderError(value: unknown): boolean {
  return isProviderError(value) && value.isTransient;
}

/**
 * The only shape that may reach a log line. It carries no request body, no
 * response body, no signed URL, and no image bytes.
 */
export interface ProviderLogLine {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;
  readonly status: number | null;
  readonly providerCode: string | null;
  readonly issuePaths: readonly string[];
  readonly transient: boolean;
}

export function toProviderLogLine(error: ProviderError): ProviderLogLine {
  return {
    provider: error.provider,
    code: error.code,
    status: error.status,
    providerCode: error.providerCode,
    issuePaths: error.issuePaths,
    transient: error.isTransient,
  };
}

/** Maps an HTTP status to the code the jobs layer branches on. */
export function providerCodeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "provider_error";
}

/**
 * Turns a thrown fetch failure into a typed error. Timeout and abort come back
 * from AbortSignal.timeout as DOMException names, not as status codes.
 */
export function providerErrorFromThrown(
  provider: ProviderName,
  thrown: unknown,
  context: string,
): ProviderError {
  const name = thrown instanceof Error ? thrown.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderError({
      provider,
      code: "request_timeout",
      message: `${context} passed the request timeout.`,
      cause: thrown,
    });
  }
  return new ProviderError({
    provider,
    code: "network_error",
    message: `${context} did not reach the provider.`,
    cause: thrown,
  });
}

/** Collects zod issue paths without collecting any value. */
export function issuePathsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string[] {
  return issues.map((issue) =>
    issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join("."),
  );
}
