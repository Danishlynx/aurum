import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseConfig } from "../env";
import type { Database } from "./types";

/**
 * The anon client bound to the signed in person's JWT, read from the request
 * cookies by @supabase/ssr. Every query it makes runs under Row Level Security,
 * so a person can only ever reach their own rows (migration 0005).
 *
 * A judge session has no Supabase JWT, so this client sees nothing for a judge.
 * Judge owned rows are reached through the service role client with an explicit
 * owner filter. That split is the security boundary in docs/03-architecture.md.
 *
 * A new client is created per request. Sharing one across requests would share
 * one person's session with the next request, which is the bug the Supabase SSR
 * guides warn about.
 */

export type UserClient = SupabaseClient<Database, "public">;

export async function userClient(): Promise<UserClient> {
  const store = await cookies();
  const { url, anonKey } = supabaseConfig();

  return createServerClient<Database, "public">(url, anonKey, {
    cookies: {
      getAll() {
        return store.getAll().map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
        }));
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read only. The
          // middleware refreshes the session, so nothing is lost here.
        }
      },
    },
  });
}

/**
 * The authenticated user id, or null. getUser revalidates the JWT with the auth
 * server rather than trusting the cookie, which is what makes it safe to use as
 * an authorization decision.
 */
export async function currentUserId(): Promise<string | null> {
  const client = await userClient();
  const { data, error } = await client.auth.getUser();
  if (error !== null || data.user === null) {
    return null;
  }
  return data.user.id;
}
