import "server-only";

import type { z } from "zod";

import {
  ProviderError,
  issuePathsOf,
  providerCodeForStatus,
  providerErrorFromThrown,
} from "../errors";
import {
  SERPAPI_BASE_URL,
  SERPAPI_HTTP_TIMEOUT_MS,
  SERPAPI_ENGINES,
  type SerpApiEngineKey,
} from "./endpoints";

/**
 * Auth, base URL, timeouts, and typed errors for SerpApi.
 * The key is read from the environment inside this module and is never put in a
 * log line or an error message.
 * Spec: docs/04-integrations.md.
 */

const PROVIDER = "serpapi" as const;

export interface SerpApiConfig {
  readonly apiKey: string;
  readonly defaultGl: string;
  readonly defaultHl: string;
}

export function isSerpApiConfigured(): boolean {
  const key = process.env.SERPAPI_API_KEY;
  return typeof key === "string" && key.length > 0;
}

export function readSerpApiConfig(): SerpApiConfig {
  const apiKey = process.env.SERPAPI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "provider_not_configured",
      message: "SERPAPI_API_KEY is not set on the server.",
    });
  }
  const gl = process.env.SERPAPI_DEFAULT_GL;
  const hl = process.env.SERPAPI_DEFAULT_HL;
  return {
    apiKey,
    defaultGl: typeof gl === "string" && gl.length > 0 ? gl : "in",
    defaultHl: typeof hl === "string" && hl.length > 0 ? hl : "en",
  };
}

export type SerpApiParams = Readonly<Record<string, string | number | undefined>>;

/**
 * One search. The api_key is added last and the URL is never logged, so the key
 * cannot leak through an error message.
 */
export async function serpApiSearch<T extends z.ZodTypeAny>(args: {
  readonly engineKey: SerpApiEngineKey;
  readonly params: SerpApiParams;
  readonly schema: T;
  readonly timeoutMs?: number;
}): Promise<z.infer<T>> {
  const config = readSerpApiConfig();
  const engine = SERPAPI_ENGINES[args.engineKey];

  const url = new URL(SERPAPI_BASE_URL);
  url.searchParams.set("engine", engine.engine);
  url.searchParams.set("output", "json");
  for (const [name, value] of Object.entries(args.params)) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(name, String(value));
  }
  url.searchParams.set("api_key", config.apiKey);

  const context = `The ${engine.engine} search`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(args.timeoutMs ?? SERPAPI_HTTP_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, context);
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, `${context} response body`);
  }

  if (!response.ok) {
    throw new ProviderError({
      provider: PROVIDER,
      code: providerCodeForStatus(response.status),
      message: `${context} was rejected with status ${response.status}.`,
      status: response.status,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText) as unknown;
  } catch (thrown) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: `${context} did not return JSON.`,
      status: response.status,
      cause: thrown,
    });
  }

  const result = args.schema.safeParse(parsedJson);
  if (!result.success) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: `${context} returned a body that did not match the expected shape.`,
      status: response.status,
      issuePaths: issuePathsOf(result.error.issues),
    });
  }
  return result.data as z.infer<T>;
}

/**
 * SerpApi answers 200 with an error field when a search finds nothing or the
 * query is rejected. An empty result set is not a failure: the app shows the
 * product type and the no listing copy instead.
 */
export function assertNoSearchError(error: string | undefined, context: string): void {
  if (error === undefined) {
    return;
  }
  const lowered = error.toLowerCase();
  if (lowered.includes("hasn't returned any results") || lowered.includes("no results")) {
    return;
  }
  throw new ProviderError({
    provider: PROVIDER,
    code: "provider_error",
    message: `${context} returned an error.`,
    providerCode: error.slice(0, 120),
  });
}
