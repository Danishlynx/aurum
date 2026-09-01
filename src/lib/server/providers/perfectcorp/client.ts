import "server-only";

import type { z } from "zod";

import {
  ProviderError,
  issuePathsOf,
  providerCodeForStatus,
  providerErrorFromThrown,
} from "../errors";
import {
  PERFECTCORP_DEFAULT_BASE_URL,
  PERFECTCORP_HTTP_TIMEOUT_MS,
  getEndpoint,
  type PerfectCorpEndpointKey,
} from "./endpoints";

/**
 * Auth, base URL, timeouts, and typed errors for the Perfect Corp YouCam API.
 * Keys are read from the environment inside this module and never leave it.
 * Spec: docs/04-integrations.md.
 */

const PROVIDER = "perfectcorp" as const;

export interface PerfectCorpConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly allowUnverified: boolean;
}

function envFlag(name: string): boolean {
  return process.env[name] === "true";
}

export function isPerfectCorpConfigured(): boolean {
  const key = process.env.PERFECTCORP_API_KEY;
  return typeof key === "string" && key.length > 0;
}

export function readPerfectCorpConfig(): PerfectCorpConfig {
  const apiKey = process.env.PERFECTCORP_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "provider_not_configured",
      message: "PERFECTCORP_API_KEY is not set on the server.",
    });
  }
  const baseUrl = process.env.PERFECTCORP_BASE_URL;
  return {
    apiKey,
    baseUrl:
      typeof baseUrl === "string" && baseUrl.length > 0
        ? baseUrl.replace(/\/+$/, "")
        : PERFECTCORP_DEFAULT_BASE_URL,
    allowUnverified: envFlag("PERFECTCORP_ALLOW_UNVERIFIED"),
  };
}

/**
 * Refuses to run against an endpoint we have not verified against the live
 * docs. This keeps a guessed path from turning into a credit spend. Set
 * PERFECTCORP_ALLOW_UNVERIFIED=true once the API key has confirmed the surface.
 */
export function assertEndpointVerified(key: PerfectCorpEndpointKey): void {
  const endpoint = getEndpoint(key);
  if (endpoint.verification.state === "confirmed") {
    return;
  }
  if (readPerfectCorpConfig().allowUnverified) {
    return;
  }
  throw new ProviderError({
    provider: PROVIDER,
    code: "endpoint_unverified",
    message:
      `The Perfect Corp endpoint "${key}" has not been verified against the live docs. ` +
      `${endpoint.verification.note} Confirm it at ${endpoint.verification.source}, update ` +
      "endpoints.ts, or set PERFECTCORP_ALLOW_UNVERIFIED=true to run against it anyway.",
    providerCode: key,
  });
}

interface RawResponse {
  readonly status: number;
  readonly bodyText: string;
}

async function rawRequest(args: {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly apiKey: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly context: string;
}): Promise<RawResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.apiKey}`,
    Accept: "application/json",
  };
  if (args.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(args.url, {
      method: args.method,
      headers,
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs),
      cache: "no-store",
    });
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, args.context);
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, `${args.context} response body`);
  }

  return { status: response.status, bodyText };
}

/**
 * One JSON call to the provider, parsed with zod. On a schema failure only the
 * issue paths are carried, never the body.
 */
export async function perfectCorpJson<T extends z.ZodTypeAny>(args: {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly schema: T;
  readonly body?: unknown;
  readonly context: string;
  readonly timeoutMs?: number;
}): Promise<z.infer<T>> {
  const config = readPerfectCorpConfig();
  const { status, bodyText } = await rawRequest({
    url: `${config.baseUrl}${args.path}`,
    method: args.method,
    apiKey: config.apiKey,
    body: args.body,
    timeoutMs: args.timeoutMs ?? PERFECTCORP_HTTP_TIMEOUT_MS,
    context: args.context,
  });

  if (status < 200 || status >= 300) {
    throw new ProviderError({
      provider: PROVIDER,
      code: providerCodeForStatus(status),
      message: `${args.context} was rejected with status ${status}.`,
      status,
      providerCode: readErrorCode(bodyText),
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText) as unknown;
  } catch (thrown) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: `${args.context} did not return JSON.`,
      status,
      cause: thrown,
    });
  }

  const result = args.schema.safeParse(parsedJson);
  if (!result.success) {
    throw new ProviderError({
      provider: PROVIDER,
      code: "invalid_response",
      message: `${args.context} returned a body that did not match the expected shape.`,
      status,
      issuePaths: issuePathsOf(result.error.issues),
    });
  }
  return result.data as z.infer<T>;
}

/**
 * Reads a provider error identifier out of an error body without keeping the
 * body. Anything unrecognised comes back as null.
 */
function readErrorCode(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    for (const field of ["error_code", "code", "error"]) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0 && value.length <= 120) {
        return value;
      }
      if (typeof value === "number") {
        return String(value);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * PUT the image bytes to the pre signed URL from the file API. The headers come
 * back from that call and are echoed exactly. The URL is never logged.
 */
export async function perfectCorpUploadBytes(args: {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: ArrayBuffer;
  readonly timeoutMs?: number;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(args.url, {
      method: args.method,
      headers: { ...args.headers },
      body: args.bytes,
      signal: AbortSignal.timeout(args.timeoutMs ?? PERFECTCORP_HTTP_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, "The capture upload");
  }

  if (!response.ok) {
    throw new ProviderError({
      provider: PROVIDER,
      code: providerCodeForStatus(response.status),
      message: `The capture upload was rejected with status ${response.status}.`,
      status: response.status,
    });
  }
}

/**
 * Downloads a mask or render output. Result URLs expire, so this runs as soon
 * as a task succeeds and the bytes go straight into our private buckets.
 */
export async function perfectCorpDownloadResult(
  url: string,
  timeoutMs = PERFECTCORP_HTTP_TIMEOUT_MS,
): Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, "The result download");
  }

  if (!response.ok) {
    throw new ProviderError({
      provider: PROVIDER,
      code: providerCodeForStatus(response.status),
      message: `The result download was rejected with status ${response.status}.`,
      status: response.status,
    });
  }

  try {
    const bytes = await response.arrayBuffer();
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  } catch (thrown) {
    throw providerErrorFromThrown(PROVIDER, thrown, "The result download body");
  }
}
