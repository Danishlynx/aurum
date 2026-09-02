import type { NextRequest } from "next/server";

import { captureCreateRequestSchema } from "@/lib/shared/schemas";
import type { CaptureCreateRequest } from "@/lib/shared/schemas";

import {
  BUCKETS,
  capturePath,
  createSignedUpload,
  findCaptureBySha,
  insertCapture,
  isDatabaseError,
  setCaptureStoragePath,
  UNIQUE_VIOLATION,
} from "@/lib/server/db";
import type { Capture, Json } from "@/lib/server/db";
import {
  enforceRateLimit,
  handleRoute,
  requireConsent,
  requireSession,
} from "@/lib/server/http/handler";
import { messages } from "@/lib/server/http/messages";
import { badRequest, ok, serverError } from "@/lib/server/http/responses";
import { refuseWhenJudgeAnalysesExhausted } from "@/lib/server/judge/guard";

/**
 * POST /api/captures
 *
 * docs/03-architecture.md, "Request flow for a capture" steps 2 and 3: the
 * server checks captures for the hash; an existing capture is a cache hit worth
 * zero credits, and a new one gets a signed upload URL for the private captures
 * bucket.
 *
 * No image bytes reach this route. The client hashes the downscaled, EXIF
 * stripped image and sends the digest; the bytes go straight to storage.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The body is captureCreateRequestSchema from src/lib/shared/schemas.ts,
 * unchanged, including its refinement that a frame the gate rejected is never
 * uploaded (docs/04-integrations.md).
 */

/**
 * Stored in captures.quality, snake case to match the migration's comment.
 *
 * exposure is meanLuminance: the architecture doc names sharpness, exposure, and
 * face coverage, and mean luminance over the measured region is what the gate
 * computes for exposure.
 */
function qualityJson(quality: CaptureCreateRequest["quality"]): Json {
  return {
    sharpness: quality.sharpness,
    exposure: quality.meanLuminance,
    face_coverage: quality.faceCoverage,
    verdict: quality.verdict,
    reason: quality.reason,
    blown_fraction: quality.blownFraction,
    crushed_fraction: quality.crushedFraction,
    mean_luminance: quality.meanLuminance,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRoute(request, "/api/captures", async (context) => {
    const session = await requireSession(context);
    await requireConsent(session);
    /*
     * The judge cap, before the photo is registered rather than after.
     *
     * docs/01-user-flow.md, "Judge mode across the flow": at zero the capture is
     * disabled and every screen renders from the demo profile. The screen shows
     * that state without asking (src/app/(onboarding)/capture/page.tsx), and
     * this is the same rule where it is enforced: a session with no analyses
     * left never gets a signed upload URL, so no selfie is stored for a reading
     * that could not run.
     */
    refuseWhenJudgeAnalysesExhausted({
      session,
      route: "/api/captures",
      requestId: context.requestId,
    });
    await enforceRateLimit({ context, name: "captures", session });

    const body: unknown = await request.json().catch(() => null);
    const parsed = captureCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(messages.invalidRequest);
    }

    const ownerId = session.id;

    // Cache by content hash: the same photo never costs a second credit.
    const existing = await findCaptureBySha(ownerId, parsed.data.sha256);
    if (existing !== null) {
      context.noteOutcome("cache_hit");
      return ok({ captureId: existing.id, status: "exists" as const });
    }

    let capture: Capture;
    try {
      capture = await insertCapture({
        user_id: ownerId,
        sha256: parsed.data.sha256,
        width: parsed.data.width,
        height: parsed.data.height,
        quality: qualityJson(parsed.data.quality),
      });
    } catch (thrown) {
      // Two uploads of the same photo at the same time: the loser reads the
      // winner's row rather than failing.
      if (isDatabaseError(thrown) && thrown.code === UNIQUE_VIOLATION) {
        const winner = await findCaptureBySha(ownerId, parsed.data.sha256);
        if (winner === null) {
          throw serverError(messages.uploadFailed);
        }
        context.noteOutcome("cache_hit");
        return ok({ captureId: winner.id, status: "exists" as const });
      }
      throw thrown;
    }

    const storagePath = capturePath(ownerId, capture.id);
    const upload = await createSignedUpload(BUCKETS.captures, storagePath);
    await setCaptureStoragePath(capture.id, storagePath);

    return ok({
      captureId: capture.id,
      status: "new" as const,
      uploadUrl: upload.uploadUrl,
      uploadToken: upload.token,
      storagePath: upload.storagePath,
      expiresInSeconds: upload.expiresInSeconds,
    });
  });
}
