import type { NextRequest } from "next/server";

import { handleRoute, requireSession } from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { HttpError, serverError } from "@/lib/server/http/responses";
import {
  buildProfileDownload,
  ProfileDownloadError,
} from "@/lib/server/profile/download";
import { isDemoFixtureMode } from "@/lib/server/profile/report-view";
import { profileDownloadFileName } from "@/lib/shared/profile-view";

/**
 * GET /api/profile/download
 *
 * docs/06-safety-privacy.md, "Person's controls": "'Download my data' returns
 * JSON of profile, analyses summaries, garments metadata, and looks."
 *
 * Refused for a judge session and in fixture mode, and this is a rule rather
 * than a limitation: docs/06-safety-privacy.md, "Keys, sessions, abuse", says
 * "Judge sessions cannot delete the demo profile and cannot download data". The
 * demo profile is not the judge's data to take a copy of, and in fixture mode
 * there is no database behind it at all, so a file produced here would be a copy
 * of a checked in fixture dressed up as somebody's record.
 *
 * The answer is a file rather than a body: content-disposition attachment with
 * a plain dated name, no-store, and application/json. Nothing in it is signed
 * and nothing in it points into a bucket (see src/lib/shared/profile-view.ts).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/profile/download", async (route) => {
    if (isDemoFixtureMode()) {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    const session = await requireSession(route);
    if (session.kind === "judge") {
      throw new HttpError({
        status: 403,
        message: messages.demoProfileReadOnly,
        outcome: "forbidden",
        code: "demo_profile_read_only",
      });
    }

    // Named payload rather than document, so nothing in this file reads like the
    // DOM global of the same name.
    let payload;
    try {
      payload = await buildProfileDownload({ ownerId: session.id });
    } catch (thrown) {
      if (thrown instanceof ProfileDownloadError) {
        // The document failed its own exclusion checks. A partial or repaired
        // export is worse than none: the person would not know which of the two
        // they were holding.
        console.error(
          JSON.stringify({
            event: "aurum.profile_download_refused",
            requestId: route.requestId,
            reason: thrown.reason,
          }),
        );
        throw serverError();
      }
      throw thrown;
    }

    return new Response(`${JSON.stringify(payload, null, 2)}\n`, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${profileDownloadFileName(
          payload.exportedAt,
        )}"`,
        "cache-control": "no-store",
      },
    });
  });
}
