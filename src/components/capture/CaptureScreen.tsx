"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BackLink } from "@/components/app-shell/BackLink";
import { UploadInstead } from "@/components/capture/UploadInstead";
import { Column } from "@/components/layout/Column";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import {
  createCapture,
  startAnalysis,
  uploadCaptureImage,
} from "@/lib/client/api";
import { rememberCapturePreview } from "@/lib/client/capture-handoff";
import { decrementJudgeRemaining } from "@/lib/client/judge-session";
import {
  estimateFaceForCapture,
  estimateFaceFromSkin,
  SKIN_SAMPLE_LONG_EDGE,
} from "@/lib/client/face";
import { guidanceKey, meanLuminanceOf, motionBetween } from "@/lib/client/guidance";
import type { GuidanceKey } from "@/lib/client/guidance";
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_LONG_EDGE,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_LONG_EDGE,
  decodeImageFile,
  type DecodedImage,
  drawToCanvas,
  readImageData,
  sha256Hex,
  toDataUrl,
  toGrayscale,
  toJpegBlob,
} from "@/lib/client/image";
import { captureRejectionCopy, copy } from "@/lib/shared/copy";
import { backTargetFor } from "@/lib/shared/navigation";
import { assessCapture } from "@/lib/shared/quality";
import type { CaptureAssessment, CaptureRejectionReason } from "@/lib/shared/quality";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * Full screen camera, a soft oval frame in antique gold hairline, one line of
 * live guidance below it, a single shutter, and "Upload instead" for people
 * without a working camera.
 *
 * On capture the frame is drawn to a canvas at a 1024px long edge, which strips
 * EXIF, hashed with SHA 256, and put through the shared quality gate before
 * anything is sent. docs/04-integrations.md: never send a photo that failed the
 * gate. "Use it anyway" exists for borderline frames only, and never for a frame
 * with no face.
 *
 * analysesExhausted is the server's answer to "may this session take a photo at
 * all" (src/app/(onboarding)/capture/page.tsx). With it true the screen opens in
 * the capped state: no camera is requested, no permission prompt appears, and
 * the line docs/01-user-flow.md writes for zero remaining analyses is on screen
 * with the way into the saved demo profile under it. The same state is reached
 * from a 429 mid session, which is the judge who spends their last analysis
 * while this screen is open.
 */

/** How often the preview is measured for the live guidance line. */
const SAMPLE_INTERVAL_MS = 400;

type Phase =
  | { readonly name: "starting" }
  | { readonly name: "live" }
  | { readonly name: "camera_unavailable" }
  /** Measuring a frame, or uploading it. Both show a skeleton, never a spinner. */
  | { readonly name: "working" }
  | {
      readonly name: "review";
      readonly reason: CaptureRejectionReason;
      readonly canUseAnyway: boolean;
    }
  | { readonly name: "failed"; readonly message: string }
  | { readonly name: "capped" };

export interface CaptureScreenProps {
  /** Judge sessions only: true when the session has no analyses left. */
  readonly analysesExhausted?: boolean;
}

export function CaptureScreen({ analysesExhausted = false }: CaptureScreenProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previousSampleRef = useRef<ArrayLike<number> | null>(null);
  const pendingRef = useRef<{
    canvas: HTMLCanvasElement;
    assessment: CaptureAssessment;
  } | null>(null);

  const [phase, setPhase] = useState<Phase>(
    analysesExhausted ? { name: "capped" } : { name: "starting" },
  );
  const [guidance, setGuidance] = useState<GuidanceKey>("light");
  const [still, setStill] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // The camera
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (analysesExhausted) {
      // No camera is asked for on a session that cannot have a photo read. A
      // permission prompt here would be asking for something we would refuse to
      // use.
      return;
    }

    let stream: MediaStream | null = null;
    let cancelled = false;

    async function start(): Promise<void> {
      const media = navigator.mediaDevices;
      if (media === undefined || typeof media.getUserMedia !== "function") {
        setPhase({ name: "camera_unavailable" });
        return;
      }
      try {
        stream = await media.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 1280 },
          },
          audio: false,
        });
      } catch {
        setPhase({ name: "camera_unavailable" });
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay was refused. The element still shows frames once tapped.
      }
      setPhase({ name: "live" });
    }

    void start();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
    };
  }, [analysesExhausted]);

  // -------------------------------------------------------------------------
  // The live guidance line
  // -------------------------------------------------------------------------

  const sample = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.readyState < 2 || video.videoWidth === 0) {
      return;
    }
    const canvas = drawToCanvas(
      video,
      { width: video.videoWidth, height: video.videoHeight },
      SKIN_SAMPLE_LONG_EDGE,
    );
    const image = readImageData(canvas);
    const gray = toGrayscale(image);
    const estimate = estimateFaceFromSkin(image);

    setGuidance(
      guidanceKey({
        meanLuminance: meanLuminanceOf(gray),
        faceCoverage:
          estimate.faceBox === null
            ? null
            : estimate.faceBox.height / image.height,
        motion: motionBetween(previousSampleRef.current, gray.data),
      }),
    );
    previousSampleRef.current = gray.data;
  }, []);

  useEffect(() => {
    if (phase.name !== "live") {
      return;
    }
    const timer = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [phase.name, sample]);

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  const upload = useCallback(
    async (canvas: HTMLCanvasElement, assessment: CaptureAssessment) => {
      setPhase({ name: "working" });

      let blob: Blob;
      let sha256: string;
      try {
        blob = await toJpegBlob(canvas, CAPTURE_JPEG_QUALITY);
        sha256 = await sha256Hex(blob);
      } catch {
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      }

      const created = await createCapture({
        sha256,
        width: canvas.width,
        height: canvas.height,
        quality: {
          verdict: assessment.verdict,
          reason: assessment.reason,
          ...assessment.metrics,
        },
      });

      if (!created.ok) {
        if (created.kind === "forbidden") {
          router.push("/welcome");
          return;
        }
        if (created.kind === "capped") {
          setPhase({ name: "capped" });
          return;
        }
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      }

      if (created.data.status === "new") {
        const put = await uploadCaptureImage(created.data.uploadUrl, blob);
        if (!put.ok) {
          setPhase({ name: "failed", message: copy.errors.uploadFailed });
          return;
        }
      }

      const started = await startAnalysis(created.data.captureId);
      if (!started.ok) {
        if (started.kind === "capped") {
          setPhase({ name: "capped" });
          return;
        }
        if (started.kind === "forbidden") {
          router.push("/welcome");
          return;
        }
        setPhase({ name: "failed", message: copy.errors.requestFailed });
        return;
      }

      if (created.data.status === "new") {
        // A cache hit spends no credit, so only a new capture counts down.
        decrementJudgeRemaining();
      }

      const preview = drawToCanvas(
        canvas,
        { width: canvas.width, height: canvas.height },
        PREVIEW_LONG_EDGE,
      );
      rememberCapturePreview(
        created.data.captureId,
        toDataUrl(preview, PREVIEW_JPEG_QUALITY),
      );

      router.push(
        `/analyzing?capture=${encodeURIComponent(created.data.captureId)}`,
      );
    },
    [router],
  );

  // -------------------------------------------------------------------------
  // The gate
  // -------------------------------------------------------------------------

  const assess = useCallback(
    async (canvas: HTMLCanvasElement) => {
      setPhase({ name: "working" });

      const full = readImageData(canvas);
      const sampleCanvas = drawToCanvas(
        canvas,
        { width: canvas.width, height: canvas.height },
        SKIN_SAMPLE_LONG_EDGE,
      );
      const estimate = await estimateFaceForCapture(
        canvas,
        full,
        readImageData(sampleCanvas),
      );
      const assessment = assessCapture({
        image: toGrayscale(full),
        faceCount: estimate.faceCount,
        faceBox: estimate.faceBox,
      });

      const preview = drawToCanvas(
        canvas,
        { width: canvas.width, height: canvas.height },
        PREVIEW_LONG_EDGE,
      );
      setStill(toDataUrl(preview, PREVIEW_JPEG_QUALITY));

      if (assessment.verdict === "accept") {
        await upload(canvas, assessment);
        return;
      }

      pendingRef.current = { canvas, assessment };
      setPhase({
        name: "review",
        // Non null for every verdict other than accept.
        reason: assessment.reason ?? "no_face",
        canUseAnyway: assessment.canUseAnyway,
      });
    },
    [upload],
  );

  function handleShutter(): void {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0) {
      return;
    }
    const canvas = drawToCanvas(
      video,
      { width: video.videoWidth, height: video.videoHeight },
      CAPTURE_LONG_EDGE,
    );
    void assess(canvas);
  }

  function handleFile(file: File): void {
    void (async () => {
      setPhase({ name: "working" });
      let decoded: DecodedImage;
      try {
        decoded = await decodeImageFile(file);
      } catch {
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      }
      const canvas = drawToCanvas(decoded.source, decoded.size, CAPTURE_LONG_EDGE);
      decoded.release();
      await assess(canvas);
    })();
  }

  function handleRetake(): void {
    pendingRef.current = null;
    setStill(null);
    setPhase(
      videoRef.current?.srcObject === null || videoRef.current === null
        ? { name: "camera_unavailable" }
        : { name: "live" },
    );
  }

  function handleUseAnyway(): void {
    const pending = pendingRef.current;
    if (pending === null) {
      return;
    }
    void upload(pending.canvas, pending.assessment);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const frameTone =
    phase.name === "review"
      ? "border-caution"
      : guidance === "ready" && phase.name === "live"
        ? "border-accent-bright"
        : "border-accent";

  return (
    <main className="flex min-h-[100svh] flex-col">
      {/*
        The header row of the screen skeleton (docs/02-design-system.md,
        "Layout"), on the canvas above the camera rather than floating over it:
        a Sand chevron laid over a live preview is legible against a dark wall
        and invisible against a bright window, and the one thing on this screen
        that must always be findable is the way out of it.

        Back goes to /welcome, the screen this one is reached from
        (docs/01-user-flow.md section C: "Continue to capture"). It is drawn in
        every phase, including the capped one, because a judge session with no
        analyses left needs a way off this screen more than anyone.
      */}
      <header className="pt-6">
        <Column>
          <BackLink href={backTargetFor("/capture")} />
        </Column>
      </header>

      <div className="relative min-h-[420px] flex-1 overflow-hidden bg-surface">
        {phase.name === "camera_unavailable" || analysesExhausted ? null : (
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            aria-hidden="true"
            className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
          />
        )}
        {still !== null ? (
          // The frame the person just took. Not decorative, but it has no
          // description that is not already on the screen.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={still}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className={`aspect-[18/25] h-[62%] rounded-[50%] border ${frameTone}`}
          />
        </div>
      </div>

      <div className="bg-canvas py-6">
        <Column className="flex flex-col gap-6">
          {phase.name === "live" ? (
            <>
              <p
                aria-live="polite"
                className="min-h-[24px] font-body text-body text-text"
              >
                {copy.capture.guidance[guidance]}
              </p>
              <div className="flex justify-center">
                <button
                  type="button"
                  aria-label={copy.capture.shutterLabel}
                  onClick={handleShutter}
                  className="flex h-[72px] w-[72px] items-center justify-center rounded-sm border border-accent bg-transparent"
                >
                  <span
                    aria-hidden="true"
                    className="block h-10 w-10 rounded-sm bg-accent"
                  />
                </button>
              </div>
              <div className="flex justify-center">
                <UploadInstead variant="quiet" onFile={handleFile} />
              </div>
            </>
          ) : null}

          {phase.name === "starting" || phase.name === "working" ? (
            <SkeletonRow lines={2} height={24} />
          ) : null}

          {phase.name === "camera_unavailable" ? (
            <>
              <p className="font-body text-body text-text">
                {copy.capture.cameraUnavailable}
              </p>
              <UploadInstead variant="primary" onFile={handleFile} />
            </>
          ) : null}

          {phase.name === "review" ? (
            <>
              <p role="status" className="font-body text-body text-text">
                {captureRejectionCopy(phase.reason)}
              </p>
              <Button variant="primary" onClick={handleRetake}>
                {copy.capture.retakeAction}
              </Button>
              {phase.canUseAnyway ? (
                <Button variant="secondary" onClick={handleUseAnyway}>
                  {copy.capture.useAnywayAction}
                </Button>
              ) : null}
            </>
          ) : null}

          {phase.name === "failed" ? (
            <>
              <p role="status" className="font-body text-body text-text">
                {phase.message}
              </p>
              <Button variant="primary" onClick={handleRetake}>
                {copy.capture.retakeAction}
              </Button>
            </>
          ) : null}

          {phase.name === "capped" ? (
            <>
              <p role="status" className="font-body text-body text-text">
                {copy.errors.judgeExhausted}
              </p>
              <ButtonLink variant="primary" href="/report">
                {copy.judge.exploreDemoAction}
              </ButtonLink>
            </>
          ) : null}
        </Column>
      </div>
    </main>
  );
}
