import "server-only";

import { serviceClient, UNIQUE_VIOLATION, unwrapNullable } from "../db/service";
import type { Insert, RateLimitBucketRow } from "../db/types";

/**
 * A Postgres backed token bucket.
 *
 * docs/06-safety-privacy.md: "Rate limits per IP and per session on capture,
 * analyze, render, and product routes. Defaults: 10 captures per hour, 30
 * renders per hour, 60 product queries per hour per session."
 *
 * A bucket holds `capacity` tokens and refills at `refillPerHour` tokens per
 * hour, continuously rather than in steps, so a person is never blocked for a
 * full hour by one burst. The row is (bucket, subject); a subject is either
 * "session:<owner id>" or "ip:<address>".
 *
 * Writes use compare and set on refilled_at, so two requests in the same
 * millisecond cannot both spend the last token.
 */

export interface RateLimitRule {
  readonly bucket: string;
  readonly capacity: number;
  readonly refillPerHour: number;
}

/**
 * Capture and analyze hold separate buckets on purpose: they are two calls in
 * one action, and sharing a bucket would halve the ten captures an hour that
 * docs/06-safety-privacy.md allows.
 */
export const RATE_LIMITS = {
  captures: { bucket: "captures", capacity: 10, refillPerHour: 10 },
  analyze: { bucket: "analyze", capacity: 10, refillPerHour: 10 },
  renders: { bucket: "renders", capacity: 30, refillPerHour: 30 },
  products: { bucket: "products", capacity: 60, refillPerHour: 60 },
  /**
   * Wardrobe writes: upload slots, classify calls, chip corrections, deletes.
   * docs/06-safety-privacy.md names capture, analyze, render, and product
   * routes and stops there, so this bucket is in house. Sixty an hour is a
   * person emptying a wardrobe into the app in one sitting (the whole ceiling
   * is sixty garments) without leaving room for a loop.
   */
  garments: { bucket: "garments", capacity: 60, refillPerHour: 60 },
  /**
   * Looks writes: saving a composed look. In house for the same reason the
   * garments bucket is, and the same size: a person tapping through six
   * occasions and saving what they like, without leaving room for a loop. The
   * read is not limited here, because it spends its own budget through the
   * product and credit caps.
   */
  looks: { bucket: "looks", capacity: 60, refillPerHour: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole tokens left after this call. */
  readonly remaining: number;
  /** Seconds until one token is available again. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

const ALLOWED: RateLimitDecision = {
  allowed: true,
  remaining: 0,
  retryAfterSeconds: 0,
};

const CAS_ATTEMPTS = 4;

const HOUR_MS = 60 * 60 * 1000;

function refill(
  rule: RateLimitRule,
  tokens: number,
  refilledAt: string,
  now: number,
): number {
  const elapsedHours = Math.max(0, now - Date.parse(refilledAt)) / HOUR_MS;
  return Math.min(rule.capacity, tokens + elapsedHours * rule.refillPerHour);
}

function retryAfter(rule: RateLimitRule, tokens: number): number {
  const missing = Math.max(0, 1 - tokens);
  return Math.max(1, Math.ceil((missing / rule.refillPerHour) * 3600));
}

/** Takes one token from one bucket for one subject. */
async function take(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  const client = serviceClient();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const existing = unwrapNullable<RateLimitBucketRow>(
      "read rate limit",
      await client
        .from("rate_limits")
        .select("*")
        .eq("bucket", rule.bucket)
        .eq("subject", subject)
        .maybeSingle(),
    );

    if (existing === null) {
      const row: Insert<"rate_limits"> = {
        bucket: rule.bucket,
        subject,
        tokens: rule.capacity - 1,
        refilled_at: nowIso,
      };
      const inserted = await client.from("rate_limits").insert(row).select("bucket");
      if (inserted.error === null) {
        return {
          allowed: true,
          remaining: rule.capacity - 1,
          retryAfterSeconds: 0,
        };
      }
      if (inserted.error.code !== UNIQUE_VIOLATION) {
        throw new Error(`rate limit insert failed: ${inserted.error.message}`);
      }
      continue;
    }

    const available = refill(rule, existing.tokens, existing.refilled_at, now);
    if (available < 1) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: retryAfter(rule, available),
      };
    }

    const updated = unwrapNullable<{ bucket: string }>(
      "spend rate limit token",
      await client
        .from("rate_limits")
        .update({ tokens: available - 1, refilled_at: nowIso })
        .eq("bucket", rule.bucket)
        .eq("subject", subject)
        .eq("refilled_at", existing.refilled_at)
        .select("bucket")
        .maybeSingle(),
    );

    if (updated !== null) {
      return {
        allowed: true,
        remaining: Math.floor(available - 1),
        retryAfterSeconds: 0,
      };
    }
  }

  // Four lost races in a row means real contention on one subject, which is
  // exactly what the limit exists to slow down.
  return { allowed: false, remaining: 0, retryAfterSeconds: 1 };
}

/** Puts a token back when a later check in the same call refused. */
async function give(rule: RateLimitRule, subject: string): Promise<void> {
  const client = serviceClient();
  const existing = unwrapNullable<RateLimitBucketRow>(
    "read rate limit",
    await client
      .from("rate_limits")
      .select("*")
      .eq("bucket", rule.bucket)
      .eq("subject", subject)
      .maybeSingle(),
  );
  if (existing === null) {
    return;
  }
  await client
    .from("rate_limits")
    .update({
      tokens: Math.min(rule.capacity, existing.tokens + 1),
      refilled_at: existing.refilled_at,
    })
    .eq("bucket", rule.bucket)
    .eq("subject", subject)
    .eq("refilled_at", existing.refilled_at);
}

export function sessionSubject(ownerId: string): string {
  return `session:${ownerId}`;
}

export function ipSubject(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Takes a token from every subject, or none.
 *
 * Both the session and the IP are limited, so one person cannot spread a burst
 * over many sessions from one machine and one machine cannot be shared by a
 * crowd of sessions. If a later subject refuses, the tokens already taken are
 * handed back so a refused request does not also cost the person their quota.
 */
export async function consumeRateLimit(
  name: RateLimitName,
  subjects: readonly string[],
): Promise<RateLimitDecision> {
  const rule = RATE_LIMITS[name];
  const taken: string[] = [];
  let remaining: number = rule.capacity;

  for (const subject of subjects) {
    const decision = await take(rule, subject);
    if (!decision.allowed) {
      for (const spent of taken) {
        await give(rule, spent);
      }
      return decision;
    }
    taken.push(subject);
    remaining = Math.min(remaining, decision.remaining);
  }

  return taken.length === 0 ? ALLOWED : { ...ALLOWED, remaining };
}
