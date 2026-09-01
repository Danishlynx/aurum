import { NextResponse, type NextRequest } from "next/server";

import { userClient } from "@/lib/server/db/user";
import { handleRoute } from "@/lib/server/http/handler";

/**
 * GET /api/auth/callback
 *
 * Where a Supabase magic link lands. The link carries a one time code; this
 * route exchanges it for a session, which @supabase/ssr writes into the response
 * cookies, and then redirects into the app.
 *
 * SCAFFOLD. docs/09-build-order-and-demo.md puts magic link auth in Layer 0, but
 * the judge cookie is the critical path for the hackathon build and the sign in
 * screens are deferred. The exchange below is complete and correct; what is
 * missing is the UI that sends the link and a decision about where a first time
 * person should land (/welcome for consent, /report if they already have a
 * profile). Until then everyone lands on the value of `next`, defaulting to the
 * welcome screen.
 *
 * Nothing here is used by the judge path: a judge session never touches
 * Supabase Auth (docs/07-payments-and-judge-mode.md).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DESTINATION = "/welcome";

/** Only same origin paths are accepted, so the link cannot be an open redirect. */
function safeDestination(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//")) {
    return DEFAULT_DESTINATION;
  }
  return raw;
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/auth/callback", async () => {
    const url = request.nextUrl;
    const code = url.searchParams.get("code");
    const destination = safeDestination(url.searchParams.get("next"));

    if (code === null || code.length === 0) {
      return NextResponse.redirect(new URL(DEFAULT_DESTINATION, url.origin));
    }

    const client = await userClient();
    const { error } = await client.auth.exchangeCodeForSession(code);

    if (error !== null) {
      // The code is single use and short lived, so a failure here is almost
      // always a link that was already opened. Send the person back to the
      // start rather than showing them an auth error they cannot act on.
      return NextResponse.redirect(new URL(DEFAULT_DESTINATION, url.origin));
    }

    return NextResponse.redirect(new URL(destination, url.origin));
  });
}
