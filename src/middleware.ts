import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, both cheap.
 *
 * 1. Give every request an id. Routes read it back out of the header and put it
 *    on their one structured log line (docs/03-architecture.md, Observability),
 *    so a report of "it failed at 10:42" can be found.
 * 2. Refresh the Supabase auth session when the request carries one. Supabase's
 *    SSR guides require this: without a middleware that writes refreshed tokens
 *    back to the response, a signed in person is logged out at random.
 *
 * A judge session is not touched here. Its cookie is a plain session id checked
 * on the server against judge_sessions, with no token to refresh.
 *
 * Nothing from src/lib/server is imported: middleware runs in the edge runtime,
 * and those modules are Node only by design.
 */

const REQUEST_ID_HEADER = "x-request-id";

/** Cookies @supabase/ssr writes. Present only for a signed in person. */
const SUPABASE_COOKIE_PREFIX = "sb-";

function hasSupabaseSession(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith(SUPABASE_COOKIE_PREFIX));
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();

  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);

  let response = NextResponse.next({ request: { headers: forwardedHeaders } });
  response.headers.set(REQUEST_ID_HEADER, requestId);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (
    typeof url !== "string" ||
    url.length === 0 ||
    typeof anonKey !== "string" ||
    anonKey.length === 0 ||
    !hasSupabaseSession(request)
  ) {
    return response;
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll().map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
        }));
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request: { headers: forwardedHeaders } });
        response.headers.set(REQUEST_ID_HEADER, requestId);
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, headerValue] of Object.entries(headers)) {
          response.headers.set(key, headerValue);
        }
      },
    },
  });

  // Reading the user is what triggers a refresh when the access token is stale.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  /**
   * Everything except Next's own assets and the favicon. Route handlers are
   * included on purpose: they are where the request id is read.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
