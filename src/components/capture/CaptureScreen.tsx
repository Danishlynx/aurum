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
import type { FaceEstimate } from "@/lib/client/face";
import { guidanceKey, meanLuminanceOf, motionBetween } from "@/lib/client/guidance";
import type { GuidanceKey } from "@/lib/client/guidance";
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_LONG_EDGE,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_LONG_EDGE,
  decodeImageFile,
  type DecodedImage,
  drawCropToCanvas,
  drawToCanvas,
  readImageData,
  sha256Hex,
  toDataUrl,
  toGrayscale,
  toJpegBlob,
} from "@/lib/client/image";
import { captureRejectionCopy, copy } from "@/lib/shared/copy";
import { backTargetFor } from "@/lib/shared/navigation";
import { assessCapture, autoCropBoxFor, scaleBox } from "@/lib/shared/quality";
import type { CaptureAssessment, CaptureRejectionReason } from "@/lib/shared/quality";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * Full screen camera, a soft oval frame in antique gold hairline, one line of
 * live guidance below it, a single shutter, and "Upload instead" for people
 * without a working camera.
 *
 * Composition, docs/02-design-system.md "Layout": mobile first at 390px, and on
 * desktop "a 480px column centered on the Obsidian canvas". The camera stage is
 * inside that column with the guidance, the shutter, and the upload link, so a
 * laptop webcam shows the same portrait frame a phone does rather than a wide
 * strip with the controls floating under it. The feed is center cropped into
 * the stage by object-cover, which crops the sides of a landscape webcam frame
 * and leaves the vertical framing untouched: the gate and the guidance both
 * measure the face against the frame height, so what the oval promises and what
 * is measured stay the same picture.
 *
 * The preview is mirrored, as a person expects of a camera pointed at them. The
 * frame that is taken is not: it is the picture the analysis reads and the one
 * /report shows back, and mirroring it would put a mole on the wrong cheek.
 *
 * On capture the frame is drawn to a canvas at a 1024px long edge, which strips
 * EXIF, hashed with SHA 256, and put through the shared quality gate before
 * anything is sent. docs/04-integrations.md: never send a photo that failed the
 * gate. "Use it anyway" exists for borderline frames only, and never for a frame
 * with no face.
 *
 * An uploaded photo goes through the same canvas, the same hash, and the same
 * gate, with one step in front of them: it is composed around its own face
 * first. See frameForUpload below. The oval does that job for a live frame and
 * there is nothing to point an oval at in a photo that was taken last week.
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

/**
 * The still, at the size /analyzing is handed: small enough to travel through
 * sessionStorage as a data URL, and the same picture the upload carries.
 */
function previewDataUrl(canvas: HTMLCanvasElement): string {
  return toDataUrl(
    drawToCanvas(
      canvas,
      { width: canvas.width, height: canvas.height },
      PREVIEW_LONG_EDGE,
    ),
    PREVIEW_JPEG_QUALITY,
  );
}

/**
 * Where the face is in a frame, and the frame's own pixels, measured once.
 *
 * Both callers need the estimate and one of them needs the pixels it was taken
 * from, and reading a 1024px canvas back is the expensive part, so it happens
 * here rather than twice.
 */
async function measure(canvas: HTMLCanvasElement): Promise<{
  readonly estimate: FaceEstimate;
  readonly full: ImageData;
}> {
  const full = readImageData(canvas);
  const sample = readImageData(
    drawToCanvas(
      canvas,
      { width: canvas.width, height: canvas.height },
      SKIN_SAMPLE_LONG_EDGE,
    ),
  );
  return {
    estimate: await estimateFaceForCapture(canvas, full, sample),
    full,
  };
}

/**
 * The uploaded photo, composed the way the oval composes a live one.
 *
 * A phone gallery selfie carries the face at 30 to 50 percent of the frame
 * height and the analyzers want more than 60. On 2026-09-02 one was sent as it
 * came and the engine answered error_src_face_too_small: a refusal, a refund,
 * and a person told to try again with a photo that was never going to work. The
 * camera path solves this with the oval. The upload path solves it here, by
 * finding the face and cropping to it, because the photo already has everything
 * the reading needs and only the framing is wrong.
 *
 * Three cases, and only the middle one changes anything:
 *
 * - No face, or more than one: the frame is returned untouched and the gate says
 *   so in its own words. A photo with no face is not a framing problem, and
 *   picking one face out of a group is not this screen's decision to make.
 * - One face under the rule: recomposed by autoCropBoxFor
 *   (src/lib/shared/quality.ts), taken off the decoded file at full resolution
 *   and only then downscaled, so the crop does not cost sharpness.
 * - One face already filling the frame: nothing happens.
 *
 * The gate still runs afterwards, on the composed frame, so nothing here decides
 * that a photo is good enough. It only gives the gate the best framing the photo
 * contains.
 */
async function frameForUpload(
  decoded: DecodedImage,
): Promise<HTMLCanvasElement> {
  const whole = drawToCanvas(decoded.source, decoded.size, CAPTURE_LONG_EDGE);
  const { estimate } = await measure(whole);
  if (estimate.faceCount !== 1) {
    return whole;
  }
  const crop = autoCropBoxFor({
    faceBox: estimate.faceBox,
    frame: { width: whole.width, height: whole.height },
  });
  if (crop === null) {
    return whole;
  }
  return drawCropToCanvas(
    decoded.source,
    scaleBox(crop, decoded.size.height / whole.height),
    CAPTURE_LONG_EDGE,
  );
}

export function CaptureScreen({ analysesExhausted = false }: CaptureScreenProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previousSampleRef = useRef<ArrayLike<number> | null>(null);
  const pendingRef = useRef<{
    canvas: HTMLCanvasElement;
    assessment: CaptureAssessment;
  } | null>(null);
  /**
   * The still that froze on the screen when the shutter was tapped. It is the
   * same data URL /analyzing is handed, drawn once and kept, so the frame the
   * person is looking at while the upload runs is the frame the reveal opens
   * with and the two screens never disagree.
   */
  const previewRef = useRef<string | null>(null);

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

      // Already drawn when the frame froze on the screen. Drawing it a second
      // time here would cost another full size canvas pass at the one moment
      // the person is waiting on us.
      rememberCapturePreview(
        created.data.captureId,
        previewRef.current ?? previewDataUrl(canvas),
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

      const { estimate, full } = await measure(canvas);
      const assessment = assessCapture({
        image: toGrayscale(full),
        faceCount: estimate.faceCount,
        faceBox: estimate.faceBox,
      });

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

  /**
   * The frame on the screen, the instant the shutter is tapped.
   *
   * docs/01-user-flow.md section D ends at "Route to /analyzing", and between
   * the tap and that route there is a measure, a hash, an upload, and two
   * requests. Freezing the frame first means the answer to the tap is the
   * photo, not a live camera that carried on moving while the work happened.
   */
  function freeze(canvas: HTMLCanvasElement): void {
    const dataUrl = previewDataUrl(canvas);
    previewRef.current = dataUrl;
    setStill(dataUrl);
    setPhase({ name: "working" });
  }

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
    freeze(canvas);
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
      let canvas: HTMLCanvasElement;
      try {
        canvas = await frameForUpload(decoded);
      } catch {
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      } finally {
        // The decoder holds the picture until it is told not to, and the crop
        // is read off it, so it is released once and only once the last draw is
        // done.
        decoded.release();
      }
      freeze(canvas);
      await assess(canvas);
    })();
  }

  function handleRetake(): void {
    pendingRef.current = null;
    previewRef.current = null;
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

  /*
   * No camera in the two states that will never take a frame: the browser that
   * refused it, and the judge session that has spent its analyses (which is
   * either the state this screen opened in or the one a 429 moved it to).
   */
  const showCamera =
    phase.name !== "camera_unavailable" && phase.name !== "capped";
  /** Nothing to frame means no oval: an empty ring is decoration. */
  const showOval = showCamera || still !== null;

  /*
   * docs/02-design-system.md, Tokens: Champagne is "the live 'Good. Tap to
   * capture' frame" and nothing else on this screen, and Amber is for
   * "borderline capture frames only". So a frame the gate refused outright
   * keeps the ordinary Antique gold hairline: the words under it carry the
   * refusal, which is the same rule as "there is no red".
   */
  const frameTone =
    phase.name === "review" && phase.canUseAnyway
      ? "border-caution"
      : guidance === "ready" && phase.name === "live"
        ? "border-accent-bright"
        : "border-accent";

  return (
    <main className="flex min-h-[100svh] flex-col items-center bg-canvas">
      <div className="flex w-full max-w-[var(--column-max)] flex-1 flex-col">
        {/*
          The header row of the screen skeleton (docs/02-design-system.md,
          "Layout"), on the canvas above the camera rather than floating over
          it: a Sand chevron laid over a live preview is legible against a dark
          wall and invisible against a bright window, and the one thing on this
          screen that must always be findable is the way out of it. It is also
          the same chevron, in the same place, as every other screen that has
          one, which is what makes it findable without being looked for.

          Back goes to /welcome, the screen this one is reached from
          (docs/01-user-flow.md section C: "Continue to capture"). The target
          comes from the table in src/lib/shared/navigation.ts rather than from
          here. It is drawn in every phase, including the capped one, because a
          judge session with no analyses left needs a way off this screen more
          than anyone.
        */}
        <header className="pt-6">
          <Column>
            <BackLink href={backTargetFor("/capture")} />
          </Column>
        </header>

        <div className="relative min-h-[420px] flex-1 overflow-hidden bg-surface">
          {showCamera ? (
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              aria-hidden="true"
              className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
            />
          ) : null}
          {still !== null ? (
            /*
             * The frame the person just took. Not decorative, but it has no
             * description that is not already on the screen.
             *
             * While the upload runs it sits at 70 percent, which is the pattern
             * docs/02-design-system.md gives for a render that is being
             * replaced. It is the one thing on the screen that says the tap
             * landed and the work is still going.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={still}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover ${
                phase.name === "working" ? "opacity-70" : ""
              }`}
            />
          ) : null}
          {showOval ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={`aspect-[18/25] h-[62%] rounded-[50%] border ${frameTone}`}
              />
            </div>
          ) : null}
        </div>

        <div className="py-6">
          <Column className="flex flex-col gap-6">
            {phase.name === "live" ? (
              <>
                <p
                  aria-live="polite"
                  className="min-h-[24px] font-body text-body text-text"
                >
                  {copy.capture.guidance[guidance]}
                </p>
                {/*
                 * docs/02-design-system.md, Layout: the shutter is one of the
                 * three centered elements in the app. Everything else on this
                 * screen, the guidance line and the upload link included, stays
                 * left aligned with the column.
                 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    aria-label={copy.capture.shutterLabel}
                    onClick={handleShutter}
                    className="group flex h-[72px] w-[72px] items-center justify-center rounded-sm border border-accent bg-transparent active:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {/*
                     * Pressed, the control inverts: the ring fills with Antique
                     * gold and the square goes to Obsidian. Two tokens, no
                     * transition, so the change lands on the touch rather than
                     * fading in after it.
                     */}
                    <span
                      aria-hidden="true"
                      className="block h-10 w-10 rounded-sm bg-accent group-active:bg-canvas"
                    />
                  </button>
                </div>
                <UploadInstead variant="quiet" onFile={handleFile} />
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
      </div>
    </main>
  );
}
