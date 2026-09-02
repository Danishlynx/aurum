import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { ProviderError } from "../errors";
import { ANTHROPIC_HTTP_TIMEOUT_MS } from "./endpoints";

/**
 * The Claude API client. The key is read from the environment inside this
 * module and never leaves it. Retries are handled by our own jobs layer, so the
 * SDK's own retry is turned off and every failure surfaces as a typed error.
 *
 * Spec: docs/04-integrations.md (general rules: server only, keys from env,
 * timeouts 30 seconds).
 */

const PROVIDER = "anthropic" as const;

let cached: Anthropic | null = null;

export function isAnthropicConfigured(): boolean {
  const key = process.env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.length > 0;
}

export function anthropicClient(): Anthropic {
  if (cached !== null) {
    return cached;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "provider_not_configured",
      message: "ANTHROPIC_API_KEY is not set on the server.",
    });
  }
  // Identity linked API keys (a 2026 console key type) are rejected with 400
  // unless every request names the workspace it acts on. Standard workspace
  // keys need no header, so this stays optional and absent by default.
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  cached = new Anthropic({
    apiKey,
    // The TypeScript SDK takes milliseconds.
    timeout: ANTHROPIC_HTTP_TIMEOUT_MS,
    maxRetries: 0,
    ...(typeof workspaceId === "string" && workspaceId.length > 0
      ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } }
      : {}),
  });
  return cached;
}

/** Used by tests and by the health route to drop a stale client. */
export function resetAnthropicClient(): void {
  cached = null;
}

/**
 * Maps an SDK failure onto the typed error the jobs layer branches on. Nothing
 * from the request or the response body is carried across.
 */
export function toAnthropicProviderError(thrown: unknown, context: string): ProviderError {
  if (thrown instanceof ProviderError) {
    return thrown;
  }
  if (thrown instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError({
      provider: PROVIDER,
      code: "request_timeout",
      message: `${context} passed the request timeout.`,
      cause: thrown,
    });
  }
  if (thrown instanceof Anthropic.APIConnectionError) {
    return new ProviderError({
      provider: PROVIDER,
      code: "network_error",
      message: `${context} did not reach the provider.`,
      cause: thrown,
    });
  }
  if (thrown instanceof Anthropic.AuthenticationError) {
    return new ProviderError({
      provider: PROVIDER,
      code: "auth_failed",
      message: `${context} was rejected: the API key was not accepted.`,
      status: thrown.status ?? 401,
      cause: thrown,
    });
  }
  if (thrown instanceof Anthropic.RateLimitError) {
    return new ProviderError({
      provider: PROVIDER,
      code: "rate_limited",
      message: `${context} was rate limited.`,
      status: thrown.status ?? 429,
      cause: thrown,
    });
  }
  if (thrown instanceof Anthropic.APIError) {
    return new ProviderError({
      provider: PROVIDER,
      code: "provider_error",
      message: `${context} was rejected with status ${String(thrown.status)}.`,
      status: typeof thrown.status === "number" ? thrown.status : undefined,
      providerCode: typeof thrown.type === "string" ? thrown.type : undefined,
      cause: thrown,
    });
  }
  return new ProviderError({
    provider: PROVIDER,
    code: "provider_error",
    message: `${context} failed.`,
    cause: thrown,
  });
}
