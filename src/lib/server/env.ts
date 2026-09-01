import "server-only";

import { z } from "zod";

/**
 * Every environment value the server layer reads, in one place, read lazily.
 *
 * Lazily on purpose: a route module that read env at import time would fail the
 * production build on a machine without a .env.local, and /api/health has to
 * answer even when nothing else is configured.
 *
 * Spec: docs/03-architecture.md ("Environment variables set in Vercel, never
 * committed"), docs/06-safety-privacy.md ("Provider keys exist only in server
 * env"), docs/07-payments-and-judge-mode.md (judge caps and the kill switch).
 *
 * Nothing here ever returns a secret to a caller outside src/lib/server, and
 * nothing here is logged. isConfigured style helpers return booleans only.
 */

/** Thrown when a required env value is missing. Routes turn it into a 500. */
export class ServerConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, hint: string) {
    super(`${variable} is not set on the server. ${hint}`);
    this.name = "ServerConfigError";
    this.variable = variable;
  }
}

export function isServerConfigError(value: unknown): value is ServerConfigError {
  return value instanceof ServerConfigError;
}

function optional(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function required(name: string, hint: string): string {
  const value = optional(name);
  if (value === null) {
    throw new ServerConfigError(name, hint);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = z.coerce.number().int().positive().safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}

export function supabaseConfig(): SupabaseConfig {
  return {
    url: required(
      "NEXT_PUBLIC_SUPABASE_URL",
      "Copy .env.example to .env.local and fill the Supabase project URL.",
    ),
    anonKey: required(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "Copy .env.example to .env.local and fill the Supabase anon key.",
    ),
  };
}

/**
 * Service role key. Read only inside src/lib/server/db/service.ts, and only for
 * judge sessions, seeding, and scheduled work (docs/06-safety-privacy.md).
 */
export function supabaseServiceRoleKey(): string {
  return required(
    "SUPABASE_SERVICE_ROLE_KEY",
    "The service role key is required for judge sessions and job bookkeeping.",
  );
}

export function isSupabaseConfigured(): boolean {
  return (
    optional("NEXT_PUBLIC_SUPABASE_URL") !== null &&
    optional("NEXT_PUBLIC_SUPABASE_ANON_KEY") !== null &&
    optional("SUPABASE_SERVICE_ROLE_KEY") !== null
  );
}

// ---------------------------------------------------------------------------
// Judge mode
// ---------------------------------------------------------------------------

export const JUDGE_SESSION_LIFETIME_HOURS = 24;

export interface JudgeConfig {
  /** bcrypt hash of the access code. Never the code itself. */
  readonly codeHash: string;
  readonly analysesAllowed: number;
  readonly creditsCap: number;
}

export function judgeConfig(): JudgeConfig {
  return {
    codeHash: required(
      "JUDGE_ACCESS_CODE_HASH",
      'Generate it with: node scripts/hash-code.js "your-code".',
    ),
    analysesAllowed: integer("JUDGE_ANALYSES_ALLOWED", 3),
    creditsCap: integer("JUDGE_CREDITS_CAP", 120),
  };
}

export function isJudgeCodeConfigured(): boolean {
  return optional("JUDGE_ACCESS_CODE_HASH") !== null;
}

/** Renders per judge session, docs/07-payments-and-judge-mode.md, "Caps". */
export const JUDGE_RENDERS_ALLOWED = 6;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * The global kill switch. Anything other than the literal "false" leaves
 * provider calls on, so a typo cannot silently disable the product.
 * docs/03-architecture.md, "Credits and caps".
 */
export function providerCallsEnabled(): boolean {
  return optional("PROVIDER_CALLS_ENABLED") !== "false";
}

export interface DailyCaps {
  readonly perfectcorpUnits: number;
  readonly serpapiSearches: number;
}

export function dailyCaps(): DailyCaps {
  return {
    perfectcorpUnits: integer("DAILY_CAP_PERFECTCORP_UNITS", 40),
    serpapiSearches: integer("DAILY_CAP_SERPAPI_SEARCHES", 30),
  };
}

/**
 * Build identity for /api/health. Vercel sets VERCEL_GIT_COMMIT_SHA; a local
 * dev server has neither, and "unknown" is an honest answer.
 */
export function buildSha(): string {
  return (
    optional("AURUM_BUILD_SHA") ??
    optional("VERCEL_GIT_COMMIT_SHA") ??
    optional("GITHUB_SHA") ??
    "unknown"
  );
}

/** Provider configuration state, as booleans only. No key is ever returned. */
export interface ProviderConfigState {
  readonly perfectcorp: boolean;
  readonly serpapi: boolean;
  readonly anthropic: boolean;
}

export function providerConfigState(): ProviderConfigState {
  return {
    perfectcorp: optional("PERFECTCORP_API_KEY") !== null,
    serpapi: optional("SERPAPI_API_KEY") !== null,
    anthropic: optional("ANTHROPIC_API_KEY") !== null,
  };
}

/**
 * Secure cookies are the rule. Plain http localhost cannot store a Secure
 * cookie, so development is the one place the flag comes off.
 * docs/07-payments-and-judge-mode.md asks for httpOnly, secure, sameSite strict.
 */
export function secureCookiesEnabled(): boolean {
  return process.env.NODE_ENV !== "development";
}
