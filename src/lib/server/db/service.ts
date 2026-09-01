import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { supabaseConfig, supabaseServiceRoleKey } from "../env";
import type { Database } from "./types";

/**
 * The service role client. It bypasses Row Level Security, so it is used only
 * where RLS cannot apply: judge sessions (a judge never holds a Supabase
 * session), the credit ledger, the jobs runner, the rate limit table, and
 * storage signing.
 *
 * docs/06-safety-privacy.md: "The service role key is used only in server
 * modules for judge sessions, seeding, and scheduled purges."
 *
 * Every read done with this client filters on the owner id from getSession().
 * Losing that filter would hand one person another person's rows, so ownership
 * is always part of the query, never assumed from context.
 */

export type ServiceClient = SupabaseClient<Database, "public">;

let cached: ServiceClient | null = null;

export function serviceClient(): ServiceClient {
  if (cached !== null) {
    return cached;
  }
  const { url } = supabaseConfig();
  const client = createClient<Database, "public">(url, supabaseServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  cached = client;
  return client;
}

/**
 * Supabase returns errors in the result rather than throwing. This turns one
 * into a thrown error carrying the operation name and the database message,
 * never a row value.
 */
export class DatabaseError extends Error {
  readonly operation: string;
  readonly code: string | null;

  constructor(operation: string, message: string, code: string | null) {
    super(`${operation} failed: ${message}`);
    this.name = "DatabaseError";
    this.operation = operation;
    this.code = code;
  }
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  return value instanceof DatabaseError;
}

/** Postgres unique violation, used to detect a lost insert race. */
export const UNIQUE_VIOLATION = "23505";

export interface SupabaseResultLike<T> {
  readonly data: T | null;
  readonly error: { message: string; code?: string | null } | null;
}

/** Unwraps a Supabase result, throwing DatabaseError when it carries one. */
export function unwrap<T>(operation: string, result: SupabaseResultLike<T>): T {
  if (result.error !== null) {
    throw new DatabaseError(
      operation,
      result.error.message,
      result.error.code ?? null,
    );
  }
  if (result.data === null) {
    throw new DatabaseError(operation, "returned no data", null);
  }
  return result.data;
}

/** Same, but null data is a valid answer (maybeSingle, delete, update). */
export function unwrapNullable<T>(
  operation: string,
  result: SupabaseResultLike<T>,
): T | null {
  if (result.error !== null) {
    throw new DatabaseError(
      operation,
      result.error.message,
      result.error.code ?? null,
    );
  }
  return result.data;
}
