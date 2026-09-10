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

/**
 * Same as integer, but zero is a value rather than a typo.
 *
 * A cap of zero is a real setting: JUDGE_ANALYSES_ALLOWED=0 is how this build
 * gives judges the saved demo profile and spends no Perfect Corp units on them
 * (docs/07-payments-and-judge-mode.md, "Caps"). Read through integer, that zero
 * failed the positive check and silently became the default of three, which is
 * the opposite of what was asked for.
 */
function count(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = z.coerce.number().int().min(0).safeParse(raw);
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

/**
 * The bcrypt hash of the access code, from either of the two variables that can
 * carry it.
 *
 * Why there are two: a bcrypt hash begins "$2b$10$", and dotenv expansion treats
 * every dollar segment in a .env file as a variable to substitute. A hash pasted
 * into .env.local can therefore reach the server with those segments eaten,
 * which reads as a code that does not match and is very hard to see. The base64
 * form has no dollar in it and cannot be mangled, so it is the safe way to carry
 * one through an environment file or a test harness. It holds the same hash and
 * is checked the same way; it is not a second secret and not a weaker one.
 */
function judgeCodeHash(): string | null {
  const encoded = optional("JUDGE_ACCESS_CODE_HASH_B64");
  if (encoded !== null) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // A value that is not base64 is a configuration mistake, not a code that
      // matches. Fall through to the plain variable.
    }
  }
  return optional("JUDGE_ACCESS_CODE_HASH");
}

export function judgeConfig(): JudgeConfig {
  const codeHash = judgeCodeHash();
  if (codeHash === null) {
    throw new ServerConfigError(
      "JUDGE_ACCESS_CODE_HASH",
      'Generate it with: node scripts/hash-code.js "your-code".',
    );
  }
  return {
    codeHash,
    analysesAllowed: count("JUDGE_ANALYSES_ALLOWED", 3),
    creditsCap: count("JUDGE_CREDITS_CAP", 120),
  };
}

export function isJudgeCodeConfigured(): boolean {
  return judgeCodeHash() !== null;
}

/**
 * Renders per judge session, docs/07-payments-and-judge-mode.md, "Caps".
 *
 * Raised from 6 to 12 on 2026-09-03. Six was set before the try on screens were
 * finished, and one demo session now walks through more than six pictures on its
 * own: four makeup rows are one render each, then a hairstyle, then a hair
 * colour, then a garment. A judge hitting the cap half way through /hair sees
 * the same empty hero as a judge with no photo, which is the wrong lesson to
 * teach about the app. The credit cap (JUDGE_CREDITS_CAP) is still the hard
 * ceiling on spend; this number only stops a runaway loop.
 */
export const JUDGE_RENDERS_ALLOWED = 12;

/**
 * SerpApi searches one judge session may spend, over its whole life.
 *
 * This is a separate allowance from JUDGE_CREDITS_CAP on purpose. A Perfect Corp
 * unit and a SerpApi search are two different currencies bought from two
 * different companies, and JUDGE_CREDITS_CAP is sized in Perfect Corp units
 * (docs/04-integrations.md: "three full sessions with 20 percent headroom", where
 * one capture set alone is 58 units). Counting searches into that same number
 * meant the analyses spent the budget first and the report then had nothing left
 * to ground with, which is the "No listing found near you yet" every step showed.
 *
 * The floor the number has to clear, for one session that grounds everything:
 * the routine is up to 7 steps, the makeup shades add a handful, the looks gaps
 * add up to 3 per look, the nearby store lookup takes 1, and a step whose strict
 * query found nothing retries once with a broader one. 40 covers that with room,
 * and the daily cap below still holds the real quota discipline.
 */
export function judgeSearchesAllowed(): number {
  return count("JUDGE_SERPAPI_SEARCHES", 40);
}

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

/**
 * Open access: the app works without an access code.
 *
 * Off unless the value is the literal "true", which is the opposite reading to
 * the kill switch above and is deliberate. A typo must never open the app, and a
 * missing variable must never open the app, because what this removes is the
 * only thing standing between a published URL and the account's credits.
 *
 * What it is for. The access code exists so a judge can use the real app without
 * signing up and without being able to drain the balance
 * (docs/07-payments-and-judge-mode.md). That is the right shape for judging and
 * the wrong shape for the person building the thing, who is on a phone, testing
 * the capture screen for the twentieth time, and typing a code every time a
 * session runs out of analyses.
 *
 * What it does not remove. Consent still comes first, every cap still applies,
 * and each visitor still gets their own session with its own analyses, credits,
 * renders, and searches counted against it. It removes the code, not the brakes.
 *
 * What it costs. The access code is published in README.md and on the project
 * page, so it was never a secret; what it was is a step that a passer by would
 * not bother with. With this on, anyone who opens the URL gets a session and can
 * spend one session's worth of the account's units. Size JUDGE_CREDITS_CAP for
 * the number of strangers you are willing to pay for, and turn this off before
 * judging opens.
 */
export function openAccessEnabled(): boolean {
  return optional("AURUM_OPEN_ACCESS") === "true";
}

/**
 * The values that turn open access on, as a list, so a test can assert that
 * nothing else does. Exported rather than inlined because the asymmetry with
 * providerCallsEnabled above is the kind of thing that gets "tidied" into
 * consistency by somebody who has not read why it is not consistent.
 */
export const OPEN_ACCESS_ON_VALUE = "true";

export interface DailyCaps {
  readonly perfectcorpUnits: number;
  readonly serpapiSearches: number;
}

/**
 * The SerpApi default is 120 rather than 30 because a daily cap is spent per
 * owner, and one owner grounding a whole report (routine, shades, looks gaps,
 * one nearby store lookup, one broader retry where the strict query found
 * nothing) can reach 30 on the first pass. 30 stopped a single session halfway.
 *
 * It is still a cap, and it is still the env value that wins where one is set:
 * the discipline against the real SerpApi monthly quota lives in the deployed
 * environment, and every search is logged.
 */
/**
 * One capture set, in Perfect Corp units, at the prices in
 * src/lib/server/credits/costs.ts: the tone reading leads at 20, then the skin
 * analysis at 16 and the face shape reading at 10.
 *
 * Written down here because the daily cap has to be able to fit one, and until
 * 2026-09-10 it could not.
 */
export const UNITS_PER_CAPTURE_SET = 46;

/**
 * The Perfect Corp default was 40, which is less than one capture set, and that
 * is not a conservative setting: it is a cap that guarantees the thing it is
 * capping can never finish.
 *
 * What it did. The fan out starts the 20 unit leader alone and, when it
 * succeeds, starts the 16 unit skin reading and the 10 unit face shape reading.
 * Under a 40 unit ceiling the first two fit at 36 and the third is refused by a
 * cap it can never clear. The person has already been charged 20, and on any
 * capture where the leader landed and the skin reading did not, they were
 * charged 20 for nothing at all. The analyze route's own admission check prices
 * the cheapest kind at 10, so a capture is waved through and then runs into this
 * halfway.
 *
 * 240 is five capture sets and change. It is a real limit, it is per owner per
 * UTC day, and it is above the number that has to fit rather than below it. The
 * discipline against the account balance is JUDGE_CREDITS_CAP and the deployed
 * environment, not a default that breaks the product.
 */
export function dailyCaps(): DailyCaps {
  return {
    perfectcorpUnits: integer(
      "DAILY_CAP_PERFECTCORP_UNITS",
      UNITS_PER_CAPTURE_SET * 5,
    ),
    serpapiSearches: integer("DAILY_CAP_SERPAPI_SEARCHES", 120),
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
