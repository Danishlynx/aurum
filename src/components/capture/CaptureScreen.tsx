"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { BackLink } from "@/components/app-shell/BackLink";
import { UploadInstead } from "@/components/capture/UploadInstead";
import { Column } from "@/components/layout/Column";
import { Button, ButtonLink } from "@/components/ui/Button";
import { SkeletonRow } from "@/components/ui/SkeletonRow";
import { createCapture, uploadCaptureImage } from "@/lib/client/api";
import type { CaptureQualityPayload } from "@/lib/client/api";
import { rememberCapturePreview } from "@/lib/client/capture-handoff";
import {
  bindCaptureSource,
  rememberCaptureSource,
  startAnalysisWithOneRetry,
} from "@/lib/client/capture-source";
import { currentPlatform } from "@/lib/client/platform";
import { decrementJudgeRemaining } from "@/lib/client/judge-session";
import { detectFaces } from "@/lib/client/landmarks";
import {
  estimateFaceForCapture,
  estimateFaceFromSkin,
  SKIN_SAMPLE_LONG_EDGE,
} from "@/lib/client/face";
import type { FaceEstimate, FaceEstimateSource } from "@/lib/client/face";
import {
  GUIDANCE_SAMPLE_LONG_EDGE,
  guidanceKey,
  meanLuminanceOf,
  motionBetween,
} from "@/lib/client/guidance";
import type { GuidanceKey, LiveFrameStats } from "@/lib/client/guidance";
import {
  CAPTURE_JPEG_QUALITY,
  CAPTURE_LONG_EDGE,
  CAPTURE_SOURCE_LONG_EDGE,
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
import { uploadFailureDetail } from "@/lib/client/upload-failure";
import type { UploadFailure } from "@/lib/client/upload-failure";
import { captureRejectionCopy, copy } from "@/lib/shared/copy";
import { backTargetFor } from "@/lib/shared/navigation";
import {
  assessCapture,
  autoCropBoxFor,
  faceWidthRatio,
  pickBestFrame,
  scaleBox,
  sharpnessOf,
} from "@/lib/shared/quality";
import type {
  CaptureAssessment,
  CaptureRejectionReason,
  FrameCandidate,
} from "@/lib/shared/quality";

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
 * One tap takes a short burst rather than one frame, and the best of it is sent.
 * See BURST_FRAMES for why, and frameScore in src/lib/shared/quality.ts for what
 * "best" means. There is still one shutter and it still fires only when it is
 * tapped.
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

/**
 * How many frames one tap takes.
 *
 * The problem, which every production face capture app solves this way. A person
 * taps the shutter and the finger pressing the glass moves the phone, so the
 * single frame at that instant is the one frame of the second most likely to be
 * shaken. This product gets one attempt at a reading: it has been paid for and
 * nobody retakes. Sending the frame from the moment of the tap is therefore
 * sending the worst frame available on purpose.
 *
 * Five, because that is enough to have the shake over by the end of it and
 * cheap enough to be over before anybody notices. Each frame costs a canvas at
 * sensor size, a composition, and a detection, and the still from the first one
 * is already frozen on the screen while the rest are taken, so the wait is spent
 * looking at the photograph rather than at a camera that kept moving.
 *
 * This is not auto capture. There is still exactly one shutter and it still
 * fires only when it is tapped (docs/01-user-flow.md section D).
 */
const BURST_FRAMES = 5;

/**
 * How far apart the frames of a burst are taken.
 *
 * 90ms, so the five of them span 360ms. Long enough that consecutive frames are
 * genuinely different moments rather than the same shake sampled twice, and
 * short enough that the last one is still the photograph the person meant to
 * take rather than whatever they did next.
 */
const BURST_INTERVAL_MS = 90;

/** Yields to the browser for a while. Nothing here runs on the UI thread. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/**
 * Gives a canvas back.
 *
 * A burst holds several frames at sensor size at once, which on a phone is tens
 * of megabytes, and dropping the reference is not the same as freeing the
 * pixels: a canvas keeps its backing store until it is resized, and the browser
 * collects it whenever it feels like it. Setting it to nothing frees it now.
 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** What the readout shows: which estimator, what it measured, what it said. */
type LiveReadout = {
  readonly source: FaceEstimateSource;
  readonly stats: LiveFrameStats;
  readonly key: GuidanceKey;
};

/**
 * How a frame reached the gate on this screen. The third value, "reframe", is
 * the reveal's tighter crop and is written by src/lib/client/capture-source.ts.
 */
type CapturePath = Extract<CaptureQualityPayload["path"], "camera" | "gallery">;

function fixed(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? "-" : value.toFixed(digits);
}

/** One line, short keys, raw numbers. Read out loud from a phone, on purpose. */
function formatLiveReadout(readout: LiveReadout): string {
  const d = copy.capture.debug;
  const { stats } = readout;
  const pose = stats.pose ?? null;
  return [
    `${d.source} ${readout.source}`,
    `${d.coverage} ${fixed(stats.faceCoverage, 2)}`,
    `${d.widthRatio} ${fixed(stats.faceWidthRatio, 2)}`,
    `${d.centerY} ${fixed(stats.faceCenterY, 2)}`,
    `${d.yaw} ${fixed(pose?.yawDegrees, 0)}`,
    `${d.pitch} ${fixed(pose?.pitchDegrees, 0)}`,
    `${d.roll} ${fixed(pose?.rollDegrees, 0)}`,
    `${d.luminance} ${fixed(stats.meanLuminance, 0)}`,
    `${d.sharpness} ${fixed(stats.sharpness, 0)}`,
    `${d.motion} ${fixed(stats.motion, 1)}`,
    `${d.line} ${readout.key}`,
  ].join("  ");
}

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
  | {
      readonly name: "failed";
      readonly message: string;
      /**
       * Which step stopped and what came back, for the second line under the
       * message. Absent when the failure happened before any request was made
       * and there is nothing to report beyond the message itself.
       */
      readonly failure?: UploadFailure;
    }
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
 * The video frame, as it was at the instant of the tap, at the sensor's own
 * resolution.
 *
 * A video element is a moving picture, and every read of it answers with
 * whatever frame is on it now. frameForUpload reads its source twice, once to
 * find the face and once to take the crop, so handing it the live element meant
 * the crop was taken from a later frame than the one the face was measured in:
 * a person who moved in the tens of milliseconds between the two got a crop
 * centered on where their face used to be. One snapshot, read as many times as
 * needed, is the whole fix.
 *
 * Taken at full sensor size rather than at CAPTURE_LONG_EDGE, because the crop
 * is cut from this canvas and a crop off an already downscaled copy would land
 * under the 1024 the capture is meant to arrive at. fitWithin never scales up,
 * so passing the long edge back is a copy at native size.
 */
function snapshotOf(video: HTMLVideoElement): HTMLCanvasElement {
  const size = { width: video.videoWidth, height: video.videoHeight };
  return drawToCanvas(video, size, Math.max(size.width, size.height));
}

/**
 * One photo, composed: the frame that will be judged and sent, and the same
 * photo uncropped for the retry that crops it tighter.
 */
type ComposedFrame = {
  /** The frame to judge and upload, at CAPTURE_LONG_EDGE. */
  readonly canvas: HTMLCanvasElement;
  /** The same photo whole, at CAPTURE_SOURCE_LONG_EDGE. */
  readonly source: HTMLCanvasElement;
};

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
async function frameForUpload(decoded: DecodedImage): Promise<ComposedFrame> {
  /*
   * The photo itself, kept before anything is cropped out of it.
   *
   * The framing below can be wrong, because on a browser with no face detector
   * it is composed around lit skin rather than around a face, and when the
   * engine says so the reveal sends this frame back cropped tighter
   * (src/lib/client/capture-source.ts).
   *
   * It is returned rather than remembered here, and that is a change the burst
   * forced. rememberCaptureSource holds one slot, so composing five frames and
   * remembering each of them would leave the retry holding the last frame of the
   * burst while the upload carried a different one: a tighter crop of a
   * photograph nobody sent. The caller composes, chooses, and only then says
   * which frame the retry belongs to.
   */
  const source = drawToCanvas(
    decoded.source,
    decoded.size,
    CAPTURE_SOURCE_LONG_EDGE,
  );
  const whole = drawToCanvas(decoded.source, decoded.size, CAPTURE_LONG_EDGE);
  const { estimate } = await measure(whole);
  if (estimate.faceCount !== 1) {
    return { canvas: whole, source };
  }
  const crop = autoCropBoxFor({
    faceBox: estimate.faceBox,
    frame: { width: whole.width, height: whole.height },
  });
  if (crop === null) {
    return { canvas: whole, source };
  }
  const cropped = drawCropToCanvas(
    decoded.source,
    scaleBox(crop, decoded.size.height / whole.height),
    CAPTURE_LONG_EDGE,
  );
  // The uncropped copy was only ever the thing the face was found in.
  releaseCanvas(whole);
  return { canvas: cropped, source };
}

/**
 * The gate's reading of one composed frame. No screen state, no upload.
 *
 * One function rather than two, because the burst and the frame that is finally
 * sent have to be judged by identical code: a frame that wins on a measurement
 * the gate does not make is a frame chosen for the wrong reason.
 */
async function readFrame(canvas: HTMLCanvasElement): Promise<{
  readonly assessment: CaptureAssessment;
  readonly faceSource: FaceEstimateSource;
}> {
  const { estimate, full } = await measure(canvas);
  return {
    assessment: assessCapture({
      image: toGrayscale(full),
      faceCount: estimate.faceCount,
      faceBox: estimate.faceBox,
      pose: estimate.pose ?? null,
      faceEstimateTrusted: estimate.source !== "skin_region",
    }),
    faceSource: estimate.source,
  };
}

export function CaptureScreen({ analysesExhausted = false }: CaptureScreenProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previousSampleRef = useRef<ArrayLike<number> | null>(null);
  /** Stops the interval stacking detections it has not waited for. */
  const sampleInFlightRef = useRef(false);
  /**
   * The borderline frame waiting on "Use it anyway", with everything the upload
   * needs to describe it. faceSource and path travel with it because a row
   * without them cannot be read later: until 2026-09-23 handleUseAnyway sent
   * the frame without its estimator, so every borderline row lost its provenance
   * at the one moment provenance mattered most.
   */
  const pendingRef = useRef<{
    canvas: HTMLCanvasElement;
    assessment: CaptureAssessment;
    faceSource: FaceEstimateSource;
    path: CapturePath;
  } | null>(null);
  /**
   * The still that froze on the screen when the shutter was tapped. It is the
   * same data URL /analyzing is handed, drawn once and kept, so the frame the
   * person is looking at while the upload runs is the frame the reveal opens
   * with and the two screens never disagree.
   */
  const previewRef = useRef<string | null>(null);
  /**
   * The stream the feed is running on, so retake can ask whether there is still
   * a camera behind the frozen frame before it puts the person back in front of
   * one. Null whenever there is not.
   */
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>(
    analysesExhausted ? { name: "capped" } : { name: "starting" },
  );
  const [guidance, setGuidance] = useState<GuidanceKey>("light");
  const [still, setStill] = useState<string | null>(null);
  /**
   * The last live measurement, kept only for the readout below. It is written
   * on every sample whether or not anybody is looking, because the readout is
   * switched on by the URL and the measurement is already in hand.
   */
  const [liveStats, setLiveStats] = useState<LiveReadout | null>(null);
  /**
   * ?debug=1 on /capture shows the numbers the live line was computed from.
   *
   * Every threshold in src/lib/shared/quality.ts is a guess until it has been
   * read against a real face on a real phone, and until 2026-09-14 the only way
   * to learn what one measured was to describe a screen in words. This turns the
   * measurement into text a person can read out. Read once, at mount: it is a
   * developer switch, not a state.
   */
  const [debugReadout] = useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("debug") === "1";
  });
  /**
   * Bumped to ask for the camera again. It is a dependency of the effect below,
   * so a bump is a full restart: the old tracks are stopped and getUserMedia is
   * called afresh. See handleRetake for the one thing that bumps it.
   */
  const [cameraAttempt, setCameraAttempt] = useState(0);

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

    const release = (): void => {
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
    };

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
            // 1920 over 1280: the capture is downscaled to 1024, and starting
            // from a larger, denoised sensor frame keeps that 1024 crisp. A
            // night time room at 1280 was reaching the gate visibly soft.
            width: { ideal: 1920 },
            height: { ideal: 1920 },
          },
          audio: false,
        });
      } catch {
        setPhase({ name: "camera_unavailable" });
        return;
      }
      const video = videoRef.current;
      if (cancelled || video === null) {
        // Nobody is going to show these frames. A stream left running here is a
        // camera light on with no camera screen behind it.
        release();
        return;
      }
      streamRef.current = stream;
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
      release();
    };
  }, [analysesExhausted, cameraAttempt]);

  // -------------------------------------------------------------------------
  // The live guidance line
  // -------------------------------------------------------------------------

  const sample = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.readyState < 2 || video.videoWidth === 0) {
      return;
    }
    /*
     * GUIDANCE_SAMPLE_LONG_EDGE, not the smaller skin sample the heuristic is
     * happy with: the sharpness the line promises has to be measured on a face
     * big enough to resample down to SHARPNESS_MEASURE_LONG_EDGE, the same way
     * the gate will resample the 1024px capture. Same function, same size, same
     * answer. The skin heuristic works off area fractions, so a larger sample
     * costs it nothing but pixels.
     */
    const canvas = drawToCanvas(
      video,
      { width: video.videoWidth, height: video.videoHeight },
      GUIDANCE_SAMPLE_LONG_EDGE,
    );
    const image = readImageData(canvas);
    const gray = toGrayscale(image);

    /*
     * The real detector when it is already warm, the colour threshold when it is
     * not.
     *
     * detectFaces resolves immediately once the model is loaded, and the consent
     * screen starts loading it (warmFaceDetector in ConsentForm), so by the time
     * anybody reaches this screen it is normally ready. While it is not, this
     * loop keeps running on the heuristic exactly as it did before rather than
     * standing still with no line under the oval.
     *
     * An in flight guard, because this runs on an interval: a detection that
     * takes longer than SAMPLE_INTERVAL_MS must not stack up a queue of frames
     * that are already stale by the time they are answered.
     */
    if (sampleInFlightRef.current) {
      return;
    }
    sampleInFlightRef.current = true;

    void detectFaces(canvas)
      .catch(() => null)
      .then((detected) => {
        const model =
          detected !== null && detected.faces.length > 0
            ? detected.faces.reduce((best, face) =>
                face.box.height > best.box.height ? face : best,
              )
            : null;
        const faceBox =
          model !== null ? model.box : estimateFaceFromSkin(image).faceBox;
        const trusted = detected !== null;

        const stats: LiveFrameStats = {
          meanLuminance: meanLuminanceOf(gray),
          faceCoverage:
            faceBox === null ? null : faceBox.height / image.height,
          // The ratio the engine gates on and the crop is built to satisfy.
          // The live line asks about it against LIVE_FACE_WIDTH_RATIO_MIN, which
          // is far below the engine's own number because the crop closes the gap.
          faceWidthRatio:
            faceBox === null ? null : faceWidthRatio(faceBox, image),
          // Where the middle of the face sits down the frame, which is what
          // says the phone is being held below the person's eyes. Only read when
          // a detector drew the box: the colour threshold's box runs into the
          // neck and its middle says nothing about the phone.
          faceCenterY:
            faceBox === null
              ? null
              : (faceBox.y + faceBox.height / 2) / image.height,
          faceEstimateTrusted: trusted,
          motion: motionBetween(previousSampleRef.current, gray.data),
          sharpness: sharpnessOf(gray, faceBox),
          pose: model?.pose ?? null,
        };
        const key = guidanceKey(stats);
        setGuidance(key);
        if (debugReadout) {
          setLiveStats({
            source: trusted ? "model" : "skin_region",
            stats,
            key,
          });
        }
        previousSampleRef.current = gray.data;
      })
      .finally(() => {
        sampleInFlightRef.current = false;
      });
  }, [debugReadout]);

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
    async (
      canvas: HTMLCanvasElement,
      assessment: CaptureAssessment,
      /*
       * Which estimator measured this frame, recorded alongside the numbers it
       * produced. Without it a stored quality row cannot be read later: a face
       * coverage of 0.7 from the real detector and one from the colour threshold
       * fallback are not the same claim, and the thresholds all of this is
       * calibrated against have to be set from the first kind only.
       */
      faceSource: FaceEstimateSource,
      /** The shutter or "Upload instead", for the same column. */
      path: CapturePath,
    ) => {
      setPhase({ name: "working" });

      let blob: Blob;
      let sha256: string;
      try {
        blob = await toJpegBlob(canvas, CAPTURE_JPEG_QUALITY);
        sha256 = await sha256Hex(blob);
      } catch {
        setPhase({
          name: "failed",
          message: copy.errors.uploadFailed,
          failure: { step: "encode", status: 0 },
        });
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
          faceSource,
          /*
           * The calibration fields this build can already fill. A frame is
           * measured when a face model drew its box; the colour threshold
           * fallback measures skin coloured area and its numbers must never
           * move a threshold. The frame sizes, the oval luma and the blink land
           * with the master frame and the landmarker in later PRs.
           */
          measured: faceSource !== "skin_region",
          platform: currentPlatform(),
          path,
          attempt: 1,
        },
      });

      if (!created.ok) {
        /*
         * No session, or a session without consent: both are answered by the
         * consent screen, which records consent for the session it finds and,
         * with open access on, mints one for a device that has none. A judge
         * session lives 24 hours (JUDGE_SESSION_LIFETIME_HOURS) and this screen
         * can be reached from a bookmark, a restored tab, or any screen's
         * "Start with a selfie" long after that, so a 401 here is the ordinary
         * way a second day begins, not a broken upload. Until 2026-09-14 it
         * was reported as one: "Upload did not complete", with a retake button
         * that led straight back to the same answer.
         */
        if (created.kind === "unauthorized" || created.kind === "forbidden") {
          router.push("/welcome");
          return;
        }
        if (created.kind === "capped") {
          setPhase({ name: "capped" });
          return;
        }
        setPhase({
          name: "failed",
          message: copy.errors.uploadFailed,
          failure: { step: "register", status: created.status },
        });
        return;
      }

      if (created.data.status === "new") {
        const put = await uploadCaptureImage(created.data.uploadUrl, blob);
        if (!put.ok) {
          setPhase({
            name: "failed",
            message: copy.errors.uploadFailed,
            failure: { step: "store", status: put.status },
          });
          return;
        }
      }

      /*
       * Asked once more on a transport failure, because the first request may
       * have landed. POST analyze creates the leader task and charges 20 units
       * for it before it answers; a response lost on the way back used to leave
       * that capture paid for and never polled. The route is idempotent for a
       * capture that already has jobs, so the second ask finds the first one's
       * work or does it (src/lib/client/capture-source.ts says the rest).
       */
      const started = await startAnalysisWithOneRetry(created.data.captureId);
      if (!started.ok) {
        if (started.kind === "capped") {
          setPhase({ name: "capped" });
          return;
        }
        if (started.kind === "unauthorized" || started.kind === "forbidden") {
          router.push("/welcome");
          return;
        }
        setPhase({
          name: "failed",
          message: copy.errors.requestFailed,
          failure: { step: "analyze", status: started.status },
        });
        return;
      }

      if (created.data.status === "new") {
        // A cache hit spends no credit, so only a new capture counts down.
        decrementJudgeRemaining();
      }

      // The frame held for the retry belongs to this capture from here on.
      bindCaptureSource(created.data.captureId);

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
    async (canvas: HTMLCanvasElement, path: CapturePath) => {
      setPhase({ name: "working" });

      /*
       * This judges the frame. It does not compose it.
       *
       * Both callers have already been through frameForUpload, which is the one
       * place a frame is recomposed around the face it contains: handleShutter
       * runs the snapshot through it before freezing, and handleFile runs the
       * decoded file through it. Composing again here was a real regression, on
       * for one deploy, and it did two things at once.
       *
       * It cropped a crop. frameForUpload takes its crop off the native snapshot
       * and downscales once, which is what keeps the upload sharp. A second pass
       * had only the finished 1024px frame to cut from, so the picture was
       * downscaled, cropped, and downscaled again, and arrived visibly soft.
       *
       * And it tightened a tightening. Each pass frames the face at
       * AUTO_CROP_FACE_COVERAGE of the result, so running it twice put the face
       * far closer than either pass intended, cut the forehead and the hairline
       * off the top, and left the engine looking at a frame with no whole face in
       * it. "No face in the frame" on a photograph with a face in it.
       *
       * The width rule this was added for is not lost by removing it: it lives in
       * autoCropBoxFor, which frameForUpload already calls, so the camera path
       * gets it through the same single composition the upload path does.
       */
      const { assessment, faceSource } = await readFrame(canvas);

      if (assessment.verdict === "accept") {
        await upload(canvas, assessment, faceSource, path);
        return;
      }

      pendingRef.current = { canvas, assessment, faceSource, path };
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
    /*
     * The tap is answered before anything is measured. The snapshot is one
     * synchronous canvas draw, so the picture on the screen is the picture that
     * was in front of the camera at the instant of the tap, and the feed does
     * not carry on moving underneath while the face is found.
     *
     * That first frame is what freezes, and it is deliberately not what gets
     * sent. See BURST_FRAMES: the instant of the tap is the instant the finger
     * moved the phone, so the shutter takes four more frames behind the frozen
     * one and the best of the five is the one that goes. The person sees an
     * answer immediately either way, and by the time the burst has been judged
     * the winner has replaced it on screen.
     */
    const first = snapshotOf(video);
    freeze(first);

    void (async () => {
      /*
       * The burst itself, taken before anything is measured. Measuring between
       * frames would stretch the spacing out to however long a detection
       * happened to take, and the point of BURST_INTERVAL_MS is that the five
       * frames are five known moments of the same second.
       */
      const snapshots = [first];
      for (let taken = 1; taken < BURST_FRAMES; taken += 1) {
        await delay(BURST_INTERVAL_MS);
        const live = videoRef.current;
        if (live === null || live.videoWidth === 0) {
          // The camera went away mid burst. What was caught is the burst.
          break;
        }
        snapshots.push(snapshotOf(live));
      }

      /*
       * Every frame through the same composition and the same gate the single
       * frame path has always used. The stage shows a center crop of the
       * sensor, but the sensor frame is wider than the stage, so a face filling
       * the oval on screen can still be a small fraction of the raw capture,
       * and the provider refused exactly that live (error_src_face_too_small,
       * 2026-09-03). A canvas is a canvas image source, so a snapshot goes
       * through the same face framing the upload path uses.
       *
       * Each sensor sized frame is given back the moment its composition has
       * been cut from it, so the burst never holds more of them than it is
       * still reading.
       */
      const candidates: FrameCandidate<ComposedFrame>[] = [];
      for (const snapshot of snapshots) {
        const composed = await frameForUpload({
          source: snapshot,
          size: { width: snapshot.width, height: snapshot.height },
          release: () => {},
        });
        releaseCanvas(snapshot);
        const read = await readFrame(composed.canvas);
        candidates.push({ assessment: read.assessment, value: composed });
      }

      /*
       * The best frame, or the frame the tap was aimed at when the gate refused
       * all five.
       *
       * pickBestFrame answers null when every candidate is a reject, and that
       * is not a case to handle by giving up: the person still has to be told
       * what was wrong. Five frames 90ms apart are refused for the same reason
       * as each other in practice, so the first one carries the same message as
       * any of them and is the one the person actually meant to take. It then
       * goes through the existing gate and lands on the review screen exactly
       * as a single refused frame always has.
       */
      const fallback = candidates.length > 0 ? candidates[0].value : null;
      const winner = pickBestFrame(candidates) ?? fallback;
      if (winner === null) {
        return;
      }

      // The losers are of no further use, and on a phone they are tens of
      // megabytes of face.
      for (const candidate of candidates) {
        if (candidate.value !== winner) {
          releaseCanvas(candidate.value.canvas);
          releaseCanvas(candidate.value.source);
        }
      }

      /*
       * The retry frame belongs to the photograph that is being sent, which is
       * why this is here and not inside frameForUpload any more.
       */
      rememberCaptureSource(winner.source);
      /*
       * The winner replaces the first frame on screen, so what the person is
       * looking at while the upload runs is the frame that is being uploaded,
       * down to the crop.
       */
      freeze(winner.canvas);
      /*
       * Through the gate unchanged, which reads the winner once more. That
       * second reading is the price of leaving the gate and the upload exactly
       * as they were: one detection on one canvas, against a burst that has
       * already run five.
       */
      await assess(winner.canvas, "camera");
    })();
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
      let composed: ComposedFrame;
      try {
        composed = await frameForUpload(decoded);
      } catch {
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      } finally {
        // The decoder holds the picture until it is told not to, and the crop
        // is read off it, so it is released once and only once the last draw is
        // done.
        decoded.release();
      }
      // One photo, so there is nothing to choose between: this is the frame the
      // retry crops tighter.
      rememberCaptureSource(composed.source);
      freeze(composed.canvas);
      await assess(composed.canvas, "gallery");
    })();
  }

  /**
   * Whether there is still a running camera behind the frozen frame.
   *
   * The feed keeps playing under the still through the whole review, so most
   * retakes have one and cost nothing. It can be gone anyway: the browser
   * releases a track when the tab is backgrounded or another app takes the
   * device, and a track in that state keeps its element and its srcObject and
   * simply stops producing frames. Checking srcObject alone therefore says
   * "live" over a black rectangle, which is the retake that looks broken.
   */
  function cameraIsLive(): boolean {
    if (videoRef.current === null) {
      return false;
    }
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    return tracks.some((track) => track.readyState === "live");
  }

  /**
   * Back to the camera, docs/01-user-flow.md section D: "Retake" is the primary
   * answer to a refused frame, so it has to end with a live camera every time.
   * With the feed still running it is instant. With the feed gone, and that
   * includes the browser that refused it the first time, the camera is asked
   * for again rather than the person being left with a dead frame.
   */
  function handleRetake(): void {
    pendingRef.current = null;
    previewRef.current = null;
    // The next motion reading compares against the next frame, not against one
    // measured before a photo was taken.
    previousSampleRef.current = null;
    setStill(null);
    if (cameraIsLive()) {
      setPhase({ name: "live" });
      return;
    }
    setPhase({ name: "starting" });
    setCameraAttempt((attempt) => attempt + 1);
  }

  function handleUseAnyway(): void {
    const pending = pendingRef.current;
    if (pending === null) {
      return;
    }
    void upload(
      pending.canvas,
      pending.assessment,
      pending.faceSource,
      pending.path,
    );
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
                {debugReadout && liveStats !== null ? (
                  <p
                    aria-hidden="true"
                    className="font-body text-micro text-text-muted"
                  >
                    {formatLiveReadout(liveStats)}
                  </p>
                ) : null}
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
                {/*
                  The two answers to a refused frame, as one stack rather than
                  two things the column has spaced apart. Retake is the primary
                  and stays first, and "Use it anyway" sits directly under it at
                  the same full width and the same 52px, because on a phone a
                  person who has just been told their frame is soft is looking at
                  the bottom of the screen for the way forward and there is no
                  room down there to go hunting. docs/01-user-flow.md section D:
                  it is shown for borderline frames and for nothing else.
                */}
                <div className="flex flex-col gap-3">
                  <Button variant="primary" onClick={handleRetake}>
                    {copy.capture.retakeAction}
                  </Button>
                  {phase.canUseAnyway ? (
                    <Button variant="secondary" onClick={handleUseAnyway}>
                      {copy.capture.useAnywayAction}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}

            {phase.name === "failed" ? (
              <>
                <p role="status" className="font-body text-body text-text">
                  {phase.message}
                </p>
                {phase.failure !== undefined ? (
                  <p className="font-body text-small text-text-muted">
                    {uploadFailureDetail(phase.failure)}
                  </p>
                ) : null}
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
