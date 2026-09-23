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
import { readFaces } from "@/lib/client/landmarks";
import type { LandmarkerDelegate } from "@/lib/client/landmarks";
import {
  guidanceKey,
  meanLuminanceOf,
  motionBetween,
} from "@/lib/client/guidance";
import type { GuidanceKey, LiveFrameStats } from "@/lib/client/guidance";
import {
  evenness,
  facePixelsIn,
  meanLumaInside,
} from "@/lib/shared/face-reading";
import type { FaceReading } from "@/lib/shared/face-reading";
import {
  AUTO_CAPTURE_COUNTDOWN_MS,
  BURST_MEASURE_LONG_EDGE,
  FRAME_GEOMETRY_VERSION,
  GUIDANCE_SAMPLE_LONG_EDGE,
  MASTER_MAX_LONG_EDGE,
  MASTER_MIN_SHORT_EDGE,
  READY_HOLD_MS,
  masterCropFor,
  masterRectFor,
  ovalStageStyle,
} from "@/lib/shared/frame-geometry";
import type { Point, Size } from "@/lib/shared/frame-geometry";
import {
  CAPTURE_JPEG_QUALITY,
  PREVIEW_JPEG_QUALITY,
  PREVIEW_LONG_EDGE,
  decodeImageFile,
  type DecodedImage,
  drawCropToCanvas,
  drawMasterCrop,
  drawToCanvas,
  readImageData,
  sha256Hex,
  toDataUrl,
  toGrayscale,
  toJpegBlob,
} from "@/lib/client/image";
import { HEIC_SNIFF_BYTES, looksLikeHeic } from "@/lib/shared/image-format";
import { uploadFailureDetail } from "@/lib/client/upload-failure";
import type { UploadFailure } from "@/lib/client/upload-failure";
import { captureRejectionCopy, copy } from "@/lib/shared/copy";
import { backTargetFor } from "@/lib/shared/navigation";
import {
  EYES_CLOSED_AT_OR_ABOVE,
  assessCapture,
  frameScore,
  pickBestFrame,
  sharpnessOf,
} from "@/lib/shared/quality";
import type {
  Box,
  CaptureAssessment,
  CaptureRejectionReason,
  FrameCandidate,
} from "@/lib/shared/quality";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * A 3:4 camera stage, a soft oval frame in antique gold hairline, one line of
 * live guidance below it, a single shutter, and "Upload instead" for people
 * without a working camera.
 *
 * The frame is the contract (src/lib/shared/frame-geometry.ts). The stage is a
 * 3:4 box and the video fills it by object-cover, so what the stage shows is
 * the largest centred 3:4 crop of whatever track the camera granted: exactly
 * masterRectFor(track), the master frame. The oval is drawn from the same
 * geometry as percentages of that stage, the live line measures a sample of
 * that crop, the shutter draws that crop straight from the video at native
 * size, and that canvas is what is uploaded. One frame, on every device.
 *
 * The geometry is read from a delivered frame, never from a timer. iOS reports
 * the landscape sensor size for the first few hundred milliseconds of a track
 * and then the portrait size, so the master rect is computed inside the first
 * requestVideoFrameCallback, again on any tick whose dimensions changed, and
 * on the element's resize event. The shutter is disabled until a rect exists.
 *
 * Mirrored once. One wrapper carries scale-x-[-1] and holds the video, the
 * frozen still and the oval, so the still is the same mirror image the person
 * framed and does not flip at the tap. The canvas that is uploaded is drawn
 * from the video, which getUserMedia never mirrors, so the picture the analysis
 * reads is un mirrored and a mole stays on its own cheek. /analyzing mirrors
 * the still and the mask together the same way.
 *
 * Composition, docs/02-design-system.md "Layout": mobile first at 390px, and on
 * desktop "a 480px column centered on the Obsidian canvas". The stage is the
 * column's full width at 3:4, and on a viewport too short to hold that under
 * the header and above the controls it shrinks its width, centred, rather than
 * cropping the frame: cropping would make the stage show something other than
 * the master frame.
 *
 * One tap, or the auto capture, takes a burst of BURST_FRAMES master crops and
 * the best of them is sent. See BURST_FRAMES for why, frameScore in
 * src/lib/shared/quality.ts for what "best" means, and READY_HOLD_MS for the
 * auto capture. Every frame is measured once, on a BURST_MEASURE_LONG_EDGE
 * copy; the winner's reading is the reading the upload carries.
 *
 * An uploaded photo goes through the same gate with one step in front of it:
 * it is composed into the master geometry around its own face
 * (frameForUpload). The oval does that job for a live frame and there is
 * nothing to point an oval at in a photo that was taken last week.
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
 * Three, since the master frame. Each frame is one master crop drawn straight
 * from the video and one detection on a 512px copy of it, so three detections
 * per tap instead of the eleven the sensor snapshot and the composition step
 * used to cost, and about 19 MB of canvases on a phone instead of five sensor
 * frames plus their 2048px sources. The still from the first one is already
 * frozen on the screen while the rest are taken.
 */
const BURST_FRAMES = 3;

/**
 * How far apart the frames of a burst are taken.
 *
 * 90ms, so the three of them span 180ms. Long enough that consecutive frames
 * are genuinely different moments rather than the same shake sampled twice, and
 * short enough that the last one is still the photograph the person meant to
 * take rather than whatever they did next.
 */
const BURST_INTERVAL_MS = 90;

/**
 * How many more frames are taken when every frame of the burst has both eyes
 * shut. A blink is 100 to 400ms and the burst spans 180, so a tap that lands on
 * one can have all three frames closed; three more, at the same spacing, reach
 * past it. Taken only then: an open eyed burst is not made longer.
 */
const BURST_BLINK_EXTRA_FRAMES = 3;

/**
 * How far the cheek to cheek width may move between the frames of one burst
 * before the burst is discarded. 15 percent in 180ms is not a person settling,
 * it is a phone being turned or a face leaving: a burst measured on different
 * pictures would be choosing between different photographs, and the winner's
 * reading would not describe the frame it was measured on.
 */
const BURST_WIDTH_DRIFT_MAX = 0.15;

/**
 * The long edge the landmarker reads an uploaded photo at to find the face the
 * master crop is composed around. The crop itself is then cut from the decoded
 * file at full resolution.
 */
const UPLOAD_READ_LONG_EDGE = 1024;

/** The oval, as percentages of the 3:4 stage. Computed once; it never moves. */
const OVAL = ovalStageStyle();

/** Yields to the browser for a while. Nothing here runs on the UI thread. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

/**
 * Gives a canvas back.
 *
 * A burst holds several master frames at once, which on a phone is tens of
 * megabytes, and dropping the reference is not the same as freeing the
 * pixels: a canvas keeps its backing store until it is resized, and the browser
 * collects it whenever it feels like it. Setting it to nothing frees it now.
 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Which landmarker answered a frame, or none when nothing measured it. */
type ReadingSource = LandmarkerDelegate | "none";

/** The size the camera granted and the master rect cut from it. */
type Geometry = {
  readonly track: Size;
  readonly master: Box;
};

/** What the readout shows: which landmarker, what it measured, what it said. */
type LiveReadout = {
  readonly geometry: Geometry | null;
  readonly source: ReadingSource;
  readonly stats: LiveFrameStats;
  readonly key: GuidanceKey;
  /** How long the landmarker took on the sample, or null when it did not run. */
  readonly inferMs: number | null;
};

/**
 * How a frame reached the gate on this screen. The third value, "reframe", is
 * the reveal's tighter crop and is written by src/lib/client/capture-source.ts.
 */
type CapturePath = Extract<CaptureQualityPayload["path"], "camera" | "gallery">;

/**
 * What the gate knew about how a frame was measured, carried beside the
 * assessment to the upload so the stored row says so.
 */
type Provenance = {
  readonly measured: boolean;
  readonly landmarkerMs: number | null;
};

type BurstLosers = NonNullable<CaptureQualityPayload["burstLosers"]>;

/**
 * A master frame the gate has read: the canvas at native master size and the
 * one reading of it, taken on a BURST_MEASURE_LONG_EDGE copy.
 */
type MeasuredFrame = {
  readonly canvas: HTMLCanvasElement;
  readonly assessment: CaptureAssessment;
  readonly provenance: Provenance;
};

/**
 * Everything the upload needs to describe one frame: the canvas, its reading,
 * how it was measured, which path it came by, the sizes and the burst it won.
 * The whole of it travels through "Use it anyway" as well, so a borderline row
 * is stored with the same numbers an accepted one is.
 */
type Sendable = MeasuredFrame & {
  readonly path: CapturePath;
  readonly frame: NonNullable<CaptureQualityPayload["frame"]>;
  readonly burstLosers: BurstLosers | null;
};

function fixed(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined ? "-" : value.toFixed(digits);
}

function sizeText(size: Size): string {
  return `${String(size.width)}x${String(size.height)}`;
}

/** One line, short keys, raw numbers. Read out loud from a phone, on purpose. */
function formatLiveReadout(readout: LiveReadout): string {
  const d = copy.capture.debug;
  const { stats, geometry } = readout;
  const reading = stats.reading;
  const pose = reading?.pose ?? null;
  const master = geometry?.master ?? null;
  return [
    `${d.track} ${geometry === null ? "-" : sizeText(geometry.track)}`,
    `${d.master} ${
      master === null
        ? "-"
        : `${sizeText(master)}@${String(master.x)},${String(master.y)}`
    }`,
    `${d.source} ${readout.source}`,
    `${d.widthRatio} ${fixed(reading?.widthRatio, 2)}`,
    `${d.bbox} ${fixed(reading?.bboxRatio, 2)}`,
    `${d.centerX} ${fixed(reading?.center.x, 2)}`,
    `${d.centerY} ${fixed(reading?.center.y, 2)}`,
    `${d.yaw} ${fixed(pose?.yawDegrees, 0)}`,
    `${d.pitch} ${fixed(pose?.pitchDegrees, 0)}`,
    `${d.roll} ${fixed(pose?.rollDegrees, 0)}`,
    `${d.luminance} ${fixed(stats.faceLuma ?? stats.frameLuma, 2)}`,
    `${d.uneven} ${fixed(stats.faceLumaUneven, 2)}`,
    `${d.blinkLeft} ${fixed(reading?.blink?.left, 2)}`,
    `${d.blinkRight} ${fixed(reading?.blink?.right, 2)}`,
    `${d.sharpness} ${fixed(stats.sharpness, 0)}`,
    `${d.motion} ${fixed(stats.motion, 1)}`,
    `${d.ms} ${fixed(readout.inferMs, 0)}`,
    `${d.line} ${readout.key}`,
  ].join("  ");
}

/** The largest of the faces the landmarker found, or null for none. */
function largestOf(faces: readonly FaceReading[]): FaceReading | null {
  if (faces.length === 0) {
    return null;
  }
  return faces.reduce((best, face) =>
    face.ovalBox.height > best.ovalBox.height ? face : best,
  );
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
 * The uploaded photo, composed into the master geometry around its own face.
 *
 * A phone gallery selfie carries the face at 30 to 50 percent of the frame
 * height and the analyzers want more than 60 of the width. On 2026-09-02 one
 * was sent as it came and the engine answered error_src_face_too_small: a
 * refusal, a refund, and a person told to try again with a photo that was
 * never going to work. The camera path solves this with the oval. The upload
 * path solves it here: the landmarker reads a 1024px copy, the face oval it
 * finds is put onto the file's own pixels, and masterCropFor
 * (src/lib/shared/frame-geometry.ts) composes the same 3:4 frame the camera
 * would have, with the face at the oval's width and centre, never narrower
 * than the face, slid inside the picture rather than shrunk.
 *
 * Without exactly one face (none, more than one, or nothing measured) there is
 * nothing to compose around, and the frame is the centred master rect of the
 * photo: the same crop the camera would have shown of it. A photo with no face
 * is a refusal the person has to hear, picking one face out of a group is not
 * this screen's decision, and an unmeasured photo is offered to the engine's
 * own gate as it is.
 *
 * The crop is cut from the decoded file at full resolution and drawn once,
 * with the engine's cap and floor (MASTER_MAX_LONG_EDGE, MASTER_MIN_SHORT_EDGE),
 * so a 4000px photo arrives at 1440 and a small one is lifted to the 480 px
 * short edge the skin analysis requires. The gate still runs afterwards, on
 * the composed frame, so nothing here decides that a photo is good enough.
 */
async function frameForUpload(decoded: DecodedImage): Promise<HTMLCanvasElement> {
  const probe = drawToCanvas(decoded.source, decoded.size, UPLOAD_READ_LONG_EDGE);
  let crop: Box | null = null;
  try {
    const result = await readFaces(probe);
    const face =
      result !== null && result.faces.length === 1 ? result.faces[0] : undefined;
    if (face !== undefined) {
      // The reading is normalized, so the oval lands on the file's own pixels
      // without going through the probe's size.
      crop = masterCropFor(facePixelsIn(face, decoded.size).ovalBox, decoded.size);
    }
  } finally {
    // The probe was only ever the thing the face was found in.
    releaseCanvas(probe);
  }
  const region = crop ?? masterRectFor(decoded.size);
  return drawCropToCanvas(
    decoded.source,
    region,
    MASTER_MAX_LONG_EDGE,
    MASTER_MIN_SHORT_EDGE,
  );
}

/**
 * The gate's reading of one master frame, taken once, on a copy.
 *
 * The frame is measured at BURST_MEASURE_LONG_EDGE (512): the landmarker reads
 * the copy, and the light over the oval, the evenness between the eyes, the
 * blink and the sharpness all come off that same copy. Nothing ever calls
 * getImageData at master size, which on a phone is a 6 MB read per frame. The
 * copy is released as soon as it has been read.
 *
 * One function for the burst and for the uploaded photo, because every frame
 * that can be sent has to be judged by identical code: a frame that wins on a
 * measurement the gate does not make is a frame chosen for the wrong reason.
 */
async function measureFrame(canvas: HTMLCanvasElement): Promise<MeasuredFrame> {
  const copy = drawToCanvas(
    canvas,
    { width: canvas.width, height: canvas.height },
    BURST_MEASURE_LONG_EDGE,
  );
  try {
    const image = toGrayscale(readImageData(copy));
    const result = await readFaces(copy);
    const faces = result?.faces ?? [];
    return {
      canvas,
      assessment: assessCapture({
        image,
        faceCount: faces.length,
        reading: largestOf(faces),
        measured: result !== null,
      }),
      provenance: {
        measured: result !== null,
        landmarkerMs: result === null ? null : result.inferMs,
      },
    };
  } finally {
    releaseCanvas(copy);
  }
}

/** Where the gate read the face's centre, in the frame's own pixels, or null. */
function faceCenterIn(frame: MeasuredFrame): Point | null {
  const center = frame.assessment.metrics.faceCenter;
  if (center === null) {
    return null;
  }
  return {
    x: center.x * frame.canvas.width,
    y: center.y * frame.canvas.height,
  };
}

/** True when both eyes read as closed on this frame. */
function blinked(frame: MeasuredFrame): boolean {
  const blink = frame.assessment.metrics.blink;
  return (
    blink !== null &&
    blink.left >= EYES_CLOSED_AT_OR_ABOVE &&
    blink.right >= EYES_CLOSED_AT_OR_ABOVE
  );
}

/**
 * True when the cheek to cheek width moved by more than BURST_WIDTH_DRIFT_MAX
 * between any two frames of the burst that carry one. Frames without a face
 * say nothing about drift: they are rejects, and the winner is never one.
 */
function widthDrifted(frames: readonly MeasuredFrame[]): boolean {
  const widths = frames
    .map((frame) => frame.assessment.metrics.faceWidthRatio)
    .filter((width): width is number => width !== null && width > 0);
  if (widths.length < 2) {
    return false;
  }
  const smallest = Math.min(...widths);
  const largest = Math.max(...widths);
  return largest / smallest - 1 > BURST_WIDTH_DRIFT_MAX;
}

/** A finite number as it is, anything else as null, for a stored column. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The frames of the burst that were not sent, as numbers only, so a threshold
 * can be checked against the frames the scoring passed over as well as the one
 * it chose (docs/03-architecture.md, captures.quality).
 */
function losersOf(frames: readonly MeasuredFrame[]): BurstLosers {
  return frames.map((frame) => {
    const { metrics } = frame.assessment;
    return {
      yaw: finiteOrNull(metrics.pose?.yawDegrees),
      pitch: finiteOrNull(metrics.pose?.pitchDegrees),
      roll: finiteOrNull(metrics.pose?.rollDegrees),
      faceWidthRatio: finiteOrNull(metrics.faceWidthRatio),
      faceLuma: finiteOrNull(metrics.faceLuma),
      blinkMax:
        metrics.blink === null
          ? null
          : finiteOrNull(Math.max(metrics.blink.left, metrics.blink.right)),
      sharpness: finiteOrNull(metrics.sharpness),
      score: finiteOrNull(frameScore(frame.assessment)),
    };
  });
}

/** The first HEIC_SNIFF_BYTES of a file, sniffed. False when they cannot be read. */
async function fileLooksLikeHeic(file: File): Promise<boolean> {
  try {
    const head = await file.slice(0, HEIC_SNIFF_BYTES).arrayBuffer();
    return looksLikeHeic(new Uint8Array(head));
  } catch {
    return false;
  }
}

/**
 * The two frame callbacks, read as optional: the DOM types declare them on
 * every video element, Firefox before 132 and older WebViews do not have them,
 * and the fallback (loadedmetadata) is chosen at run time.
 */
type FrameCallbacks = Partial<
  Pick<HTMLVideoElement, "requestVideoFrameCallback" | "cancelVideoFrameCallback">
>;

export function CaptureScreen({ analysesExhausted = false }: CaptureScreenProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previousSampleRef = useRef<ArrayLike<number> | null>(null);
  /** Stops the interval stacking detections it has not waited for. */
  const sampleInFlightRef = useRef(false);
  /** One burst at a time, whether the tap or the countdown asked for it. */
  const burstInFlightRef = useRef(false);
  /**
   * The size the camera granted and the master rect cut from it, read from a
   * delivered frame (see the geometry effect). Refs for the sampler and the
   * shutter, which read them on every tick; the state beside them is what
   * enables the shutter and feeds the readout.
   */
  const geometryRef = useRef<Geometry | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  /**
   * The borderline frame waiting on "Use it anyway", with everything the upload
   * needs to describe it. The provenance and the path travel with it because a
   * row without them cannot be read later: until 2026-09-23 handleUseAnyway
   * sent the frame without saying what had measured it, so every borderline
   * row lost its provenance at the one moment provenance mattered most.
   */
  const pendingRef = useRef<Sendable | null>(null);
  /**
   * The still that froze on the screen when the shutter fired. It is the same
   * data URL /analyzing is handed, drawn once and kept, so the frame the person
   * is looking at while the upload runs is the frame the reveal opens with and
   * the two screens never disagree.
   */
  const previewRef = useRef<string | null>(null);
  /**
   * The stream the feed is running on, so retake can ask whether there is still
   * a camera behind the frozen frame before it puts the person back in front of
   * one. Null whenever there is not.
   */
  const streamRef = useRef<MediaStream | null>(null);
  /** The latest handleShutter, for the countdown timer to call. */
  const shutterRef = useRef<() => void>(() => {});

  const [phase, setPhase] = useState<Phase>(
    analysesExhausted ? { name: "capped" } : { name: "starting" },
  );
  const [guidance, setGuidance] = useState<GuidanceKey>("light");
  /**
   * True once the line has read "ready" for READY_HOLD_MS without a break:
   * the oval is solid, the line says the photo is being taken, and the
   * countdown to the shutter is running. False the moment the line moves.
   */
  const [readyHeld, setReadyHeld] = useState(false);
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

  /**
   * The master rect for the size the camera is delivering now. Called from
   * every place that reads the video's dimensions; recomputes only when they
   * changed, which on iOS happens once, a few hundred milliseconds in, when
   * the landscape sensor size gives way to the portrait one.
   */
  const applyTrack = useCallback((width: number, height: number): void => {
    if (!(width > 0) || !(height > 0)) {
      return;
    }
    const current = geometryRef.current;
    if (
      current !== null &&
      current.track.width === width &&
      current.track.height === height
    ) {
      return;
    }
    const next: Geometry = {
      track: { width, height },
      master: masterRectFor({ width, height }),
    };
    geometryRef.current = next;
    setGeometry(next);
  }, []);

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
    let stopWatching: (() => void) | null = null;

    const release = (): void => {
      stopWatching?.();
      stopWatching = null;
      stream?.getTracks().forEach((track) => {
        track.stop();
      });
      if (streamRef.current === stream) {
        streamRef.current = null;
      }
      geometryRef.current = null;
      setGeometry(null);
    };

    /*
     * Geometry from delivered frames. requestVideoFrameCallback fires once
     * per composited frame with the dimensions that frame actually has, which
     * is the only honest answer on iOS, where videoWidth reads the landscape
     * sensor size until the first portrait frame lands. Every tick compares
     * the dimensions and recomputes on a change; the resize event covers a
     * rotation between ticks; loadedmetadata is the fallback for a browser
     * without frame callbacks.
     */
    const watch = (video: HTMLVideoElement): (() => void) => {
      const callbacks: FrameCallbacks = video;
      const onResize = (): void => {
        applyTrack(video.videoWidth, video.videoHeight);
      };
      video.addEventListener("resize", onResize);

      if (
        typeof callbacks.requestVideoFrameCallback === "function" &&
        typeof callbacks.cancelVideoFrameCallback === "function"
      ) {
        let handle: number | null = null;
        const tick = (): void => {
          handle = null;
          if (cancelled) {
            return;
          }
          applyTrack(video.videoWidth, video.videoHeight);
          handle = video.requestVideoFrameCallback(tick);
        };
        handle = video.requestVideoFrameCallback(tick);
        return () => {
          video.removeEventListener("resize", onResize);
          if (handle !== null) {
            video.cancelVideoFrameCallback(handle);
          }
        };
      }

      video.addEventListener("loadedmetadata", onResize);
      return () => {
        video.removeEventListener("resize", onResize);
        video.removeEventListener("loadedmetadata", onResize);
      };
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
            // 1920 over 1280: the master frame is sent at up to 1440 on its
            // long edge, and starting from a larger, denoised sensor frame
            // keeps it crisp. A night time room at 1280 was reaching the gate
            // visibly soft.
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
      stopWatching = watch(video);
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
  }, [analysesExhausted, applyTrack, cameraAttempt]);

  // -------------------------------------------------------------------------
  // The live guidance line
  // -------------------------------------------------------------------------

  const sample = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.readyState < 2 || video.videoWidth === 0) {
      return;
    }
    // A rotation between frame callbacks is caught here as well, so the rect
    // the sample is cut with is the rect of the frame it is cut from.
    applyTrack(video.videoWidth, video.videoHeight);
    const geometryNow = geometryRef.current;
    if (geometryNow === null) {
      return;
    }
    /*
     * An in flight guard, because this runs on an interval: a detection that
     * takes longer than SAMPLE_INTERVAL_MS must not stack up a queue of frames
     * that are already stale by the time they are answered.
     */
    if (sampleInFlightRef.current) {
      return;
    }
    sampleInFlightRef.current = true;

    /*
     * The master crop at GUIDANCE_SAMPLE_LONG_EDGE
     * (src/lib/shared/frame-geometry.ts): the frame the shutter will send,
     * at a size where the cheek span is comfortably above 150 pixels at the
     * smallest width the gate sends, so the landmarker reads the eyes for the
     * uneven measure, and a face big enough to resample down to
     * SHARPNESS_MEASURE_LONG_EDGE the same way the gate resamples the burst
     * copy. Same frame, same function, same answer.
     */
    const canvas = drawMasterCrop(video, geometryNow.master, GUIDANCE_SAMPLE_LONG_EDGE, 0);
    const gray = toGrayscale(readImageData(canvas));
    const sampleSize = { width: canvas.width, height: canvas.height };

    /*
     * The landmarker when it is warm, and nothing when it is not.
     *
     * readFaces resolves at once once the model is loaded, and the consent
     * screen starts loading it (warmFaceDetector in ConsentForm), so by the time
     * anybody reaches this screen it is normally ready. While it is not, the
     * frame is unmeasured and the line says so rather than guessing at a face.
     */

    void readFaces(canvas)
      .catch(() => null)
      .then((result) => {
        releaseCanvas(canvas);
        const reading = largestOf(result?.faces ?? []);
        const pixels = reading === null ? null : facePixelsIn(reading, sampleSize);

        const stats: LiveFrameStats = {
          measured: result !== null,
          sample: sampleSize,
          // The granted track, not the sample: the sample is always 3:4.
          trackIsLandscape: geometryNow.track.width > geometryNow.track.height,
          coarsePointer: window.matchMedia("(pointer: coarse)").matches,
          frameLuma: meanLuminanceOf(gray) / 255,
          faceLuma:
            pixels === null ? null : meanLumaInside(gray, pixels.ovalPolygon),
          faceLumaUneven:
            pixels === null
              ? null
              : evenness(gray, pixels.eyeBoxes.left, pixels.eyeBoxes.right),
          reading,
          motion: motionBetween(previousSampleRef.current, gray.data),
          sharpness: sharpnessOf(gray, pixels === null ? null : pixels.ovalBox),
        };
        const key = guidanceKey(stats);
        setGuidance(key);
        if (debugReadout) {
          setLiveStats({
            geometry: geometryNow,
            source: result === null ? "none" : result.delegate,
            stats,
            key,
            inferMs: result === null ? null : result.inferMs,
          });
        }
        previousSampleRef.current = gray.data;
      })
      .finally(() => {
        sampleInFlightRef.current = false;
      });
  }, [applyTrack, debugReadout]);

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
  // The ready hold and the auto capture
  // -------------------------------------------------------------------------

  /*
   * After READY_HOLD_MS of continuous "ready" the oval turns solid and the
   * countdown runs; when AUTO_CAPTURE_COUNTDOWN_MS elapses the shutter fires
   * itself. Both timers live in this effect, so leaving "ready" for any
   * reason, the line moving, a tap, the camera going away, is one cleanup: the
   * countdown cancels the moment the line leaves ready, and the oval goes back
   * to the hairline. The tap works at any time, before, during and after the
   * hold (docs/01-user-flow.md section D; the decision with the founder).
   */
  useEffect(() => {
    if (guidance !== "ready" || phase.name !== "live" || geometry === null) {
      return;
    }
    let countdown: number | null = null;
    const hold = window.setTimeout(() => {
      setReadyHeld(true);
      countdown = window.setTimeout(() => {
        shutterRef.current();
      }, AUTO_CAPTURE_COUNTDOWN_MS);
    }, READY_HOLD_MS);
    return () => {
      window.clearTimeout(hold);
      if (countdown !== null) {
        window.clearTimeout(countdown);
      }
      setReadyHeld(false);
    };
  }, [guidance, phase.name, geometry]);

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  const upload = useCallback(
    async (sendable: Sendable) => {
      const { canvas, assessment, provenance, path } = sendable;
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
          /*
           * Every number the gate measured: the oval luma and its evenness, the
           * cheek to cheek width, the oval box and centre, the pose and the
           * blink, beside the exposure fractions and the sharpness. Then the
           * calibration fields: whether the landmarker measured the frame (an
           * unmeasured row carries no face numbers and must never move a
           * threshold), the platform, the path, the sizes (the track or file
           * the frame was cut from and the master frame it became), the burst's
           * losers as numbers, what the model cost, and which geometry all of
           * it was measured in.
           */
          ...assessment.metrics,
          measured: provenance.measured,
          platform: currentPlatform(),
          path,
          attempt: 1,
          frame: sendable.frame,
          ...(sendable.burstLosers === null
            ? {}
            : { burstLosers: sendable.burstLosers }),
          ...(provenance.landmarkerMs === null
            ? {}
            : { landmarkerMs: provenance.landmarkerMs }),
          frameGeometryVersion: FRAME_GEOMETRY_VERSION,
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
        /*
         * The server read the stored bytes and would not send them: not a
         * JPEG, not the registered size, outside the engine's limits, or not
         * the registered digest (docs/03-architecture.md, "Failure modes").
         * The app reached the server, so requestFailed would be untrue; it is
         * the photo that did not arrive as registered, and a retake is the way
         * out. The step and status line names it.
         */
        if (started.kind === "unreadable") {
          setPhase({
            name: "failed",
            message: copy.errors.uploadFailed,
            failure: { step: "analyze", status: started.status },
          });
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
  // The gate's answer
  // -------------------------------------------------------------------------

  /**
   * What happens to a frame the gate has read: an accepted frame is uploaded
   * with the reading it was chosen on, and anything else waits on the review
   * screen with "Use it anyway" where the gate allows it. No second reading:
   * the assessment that ranked the burst is the assessment the row stores.
   */
  const settle = useCallback(
    async (sendable: Sendable) => {
      if (sendable.assessment.verdict === "accept") {
        await upload(sendable);
        return;
      }
      pendingRef.current = sendable;
      setPhase({
        name: "review",
        // Non null for every verdict other than accept.
        reason: sendable.assessment.reason ?? "no_face",
        canUseAnyway: sendable.assessment.canUseAnyway,
      });
    },
    [upload],
  );

  /**
   * The frame on the screen, the instant the shutter fires.
   *
   * docs/01-user-flow.md section D ends at "Route to /analyzing", and between
   * the shutter and that route there is a measure, a hash, an upload, and two
   * requests. Freezing the frame first means the answer is the photo, not a
   * live camera that carried on moving while the work happened. The still is
   * drawn inside the same mirrored wrapper as the video, so it is the mirror
   * image the person framed and nothing flips.
   */
  function freeze(canvas: HTMLCanvasElement): void {
    const dataUrl = previewDataUrl(canvas);
    previewRef.current = dataUrl;
    setStill(dataUrl);
    setPhase({ name: "working" });
  }

  /**
   * Back to the live camera without a photo, with the line that says why:
   * the burst was discarded because the picture changed under it.
   */
  function rearm(frames: readonly HTMLCanvasElement[]): void {
    for (const frame of frames) {
      releaseCanvas(frame);
    }
    previewRef.current = null;
    previousSampleRef.current = null;
    setStill(null);
    setGuidance("upright");
    setPhase({ name: "live" });
  }

  function handleShutter(): void {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0 || burstInFlightRef.current) {
      return;
    }
    applyTrack(video.videoWidth, video.videoHeight);
    const geometryNow = geometryRef.current;
    if (geometryNow === null) {
      return;
    }
    burstInFlightRef.current = true;
    const { track, master } = geometryNow;

    /*
     * The shutter is answered before anything is measured. The first master
     * crop is one canvas draw with a source rect, so the picture on the screen
     * is the picture that was in front of the camera at that instant, and the
     * feed does not carry on moving underneath while the face is found.
     *
     * That first frame is what freezes, and it is deliberately not always what
     * gets sent. See BURST_FRAMES: the instant of the tap is the instant the
     * finger moved the phone, so two more frames are taken behind the frozen
     * one and the best of the three is the one that goes. The person sees an
     * answer immediately either way, and by the time the burst has been judged
     * the winner has replaced it on screen.
     */
    const first = drawMasterCrop(video, master, MASTER_MAX_LONG_EDGE, MASTER_MIN_SHORT_EDGE);
    freeze(first);

    void (async () => {
      const frames: HTMLCanvasElement[] = [first];
      try {
        /*
         * One more master crop, or null when the burst has to be discarded:
         * the camera went away, or the track changed size under it (a phone
         * turning, iOS swapping to the portrait sensor size), which means the
         * master rect these frames were cut with no longer describes the
         * picture.
         */
        const takeOne = async (): Promise<HTMLCanvasElement | null> => {
          await delay(BURST_INTERVAL_MS);
          const live = videoRef.current;
          if (live === null || live.videoWidth === 0) {
            return null;
          }
          if (live.videoWidth !== track.width || live.videoHeight !== track.height) {
            applyTrack(live.videoWidth, live.videoHeight);
            return null;
          }
          return drawMasterCrop(live, master, MASTER_MAX_LONG_EDGE, MASTER_MIN_SHORT_EDGE);
        };

        /*
         * The burst itself, taken before anything is measured. Measuring
         * between frames would stretch the spacing out to however long a
         * detection happened to take, and the point of BURST_INTERVAL_MS is
         * that the frames are known moments of the same second.
         */
        for (let taken = 1; taken < BURST_FRAMES; taken += 1) {
          const next = await takeOne();
          if (next === null) {
            rearm(frames);
            return;
          }
          frames.push(next);
        }

        // Each frame measured once, on its 512px copy, and never again.
        const measured: MeasuredFrame[] = [];
        for (const frame of frames) {
          measured.push(await measureFrame(frame));
        }

        /*
         * Every frame with both eyes shut is a tap that landed on a blink. Up
         * to BURST_BLINK_EXTRA_FRAMES more, measured as they come, until one
         * has the eyes open; the burst is then chosen from all of them.
         */
        let extra = 0;
        while (measured.every(blinked) && extra < BURST_BLINK_EXTRA_FRAMES) {
          extra += 1;
          const next = await takeOne();
          if (next === null) {
            rearm(frames);
            return;
          }
          frames.push(next);
          measured.push(await measureFrame(next));
        }

        if (widthDrifted(measured)) {
          rearm(frames);
          return;
        }

        /*
         * The best frame, or the frame the shutter was aimed at when the gate
         * refused all of them.
         *
         * pickBestFrame answers null when every candidate is a reject, and
         * that is not a case to handle by giving up: the person still has to
         * be told what was wrong. Frames 90ms apart are refused for the same
         * reason as each other in practice, so the first one carries the same
         * message as any of them and is the one the person actually meant to
         * take. It lands on the review screen exactly as a single refused
         * frame always has.
         */
        const candidates: FrameCandidate<MeasuredFrame>[] = measured.map(
          (frame) => ({ assessment: frame.assessment, value: frame }),
        );
        const winner = pickBestFrame(candidates) ?? measured[0];
        if (winner === undefined) {
          rearm(frames);
          return;
        }

        // The losers are of no further use, and on a phone they are tens of
        // megabytes of face. Their numbers go with the winner.
        const losers = measured.filter((frame) => frame !== winner);
        const burstLosers = losersOf(losers);
        for (const loser of losers) {
          releaseCanvas(loser.canvas);
        }

        /*
         * The retry frame is the photograph that is being sent, with the face
         * centre the gate read in it, so the one reframe crops around the face
         * rather than around a guess.
         */
        rememberCaptureSource(winner.canvas, faceCenterIn(winner));
        /*
         * The winner replaces the first frame on screen, so what the person is
         * looking at while the upload runs is the frame that is being uploaded.
         */
        if (winner.canvas !== first) {
          freeze(winner.canvas);
        }
        await settle({
          ...winner,
          path: "camera",
          frame: {
            sourceWidth: track.width,
            sourceHeight: track.height,
            masterWidth: winner.canvas.width,
            masterHeight: winner.canvas.height,
          },
          burstLosers,
        });
      } finally {
        burstInFlightRef.current = false;
      }
    })();
  }

  useEffect(() => {
    shutterRef.current = handleShutter;
  });

  function handleFile(file: File): void {
    void (async () => {
      setPhase({ name: "working" });
      let decoded: DecodedImage;
      try {
        decoded = await decodeImageFile(file);
      } catch {
        /*
         * Nothing was uploaded, so "Upload did not complete" would be untrue.
         * A HEIC from an iPhone's gallery, handed to a browser that cannot
         * decode it, is the one case with a name and a way out; everything
         * else keeps the documented line.
         */
        setPhase({
          name: "failed",
          message: (await fileLooksLikeHeic(file))
            ? copy.errors.unsupportedImageFormat
            : copy.errors.uploadFailed,
        });
        return;
      }
      let master: HTMLCanvasElement;
      try {
        master = await frameForUpload(decoded);
      } catch {
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      } finally {
        // The decoder holds the picture until it is told not to, and the crop
        // is read off it, so it is released once and only once the last draw is
        // done.
        decoded.release();
      }
      let read: MeasuredFrame;
      try {
        read = await measureFrame(master);
      } catch {
        releaseCanvas(master);
        setPhase({ name: "failed", message: copy.errors.uploadFailed });
        return;
      }
      // One photo, so there is nothing to choose between: this is the frame the
      // retry crops tighter, around the face the gate found in it.
      rememberCaptureSource(master, faceCenterIn(read));
      freeze(master);
      await settle({
        ...read,
        path: "gallery",
        frame: {
          sourceWidth: decoded.size.width,
          sourceHeight: decoded.size.height,
          masterWidth: master.width,
          masterHeight: master.height,
        },
        burstLosers: null,
      });
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
    const pending = pendingRef.current;
    if (pending !== null) {
      releaseCanvas(pending.canvas);
    }
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
    void upload(pending);
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
   * refusal, which is the same rule as "there is no red". The frame turns
   * solid only after READY_HOLD_MS of ready, which is when the photo is about
   * to take itself.
   */
  const frameTone =
    phase.name === "review" && phase.canUseAnyway
      ? "border-caution"
      : readyHeld && phase.name === "live"
        ? "border-accent-bright"
        : "border-accent";

  const guidanceLine = readyHeld
    ? copy.capture.guidance.taking
    : copy.capture.guidance[guidance];

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

        {/*
          The stage: a 3:4 box, the column's full width, which is the master
          frame's shape and the reason what it shows IS the master frame. On a
          viewport too short to hold it, the width shrinks (centred) rather
          than the frame being cropped: the cap is the viewport height less
          the 312px the header (24 + 44) and the control block (24 + 24 + 24 +
          72 + 24 + 52 + 24) take, at 3:4. A phone at 844px tall keeps the full
          390; a 900px laptop window gets 441 of the 480 column.
        */}
        <div className="relative mx-auto aspect-[3/4] w-full max-w-[calc((100svh_-_312px)_*_0.75)] overflow-hidden bg-surface">
          {/*
            One mirrored wrapper for everything that shows the person: the
            video, the still and the oval, so the still is the same mirror
            image the person framed and does not flip at the tap. The oval is
            symmetric, so mirroring it changes nothing but keeps it in the same
            box. Nothing outside this wrapper is mirrored and nothing inside it
            carries a transform of its own.
          */}
          <div className="absolute inset-0 scale-x-[-1]">
            {showCamera ? (
              <video
                ref={videoRef}
                muted
                playsInline
                autoPlay
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : null}
            {still !== null ? (
              /*
               * The frame the person just took. Not decorative, but it has no
               * description that is not already on the screen.
               *
               * While the upload runs it sits at 70 percent, which is the
               * pattern docs/02-design-system.md gives for a render that is
               * being replaced. It is the one thing on the screen that says
               * the tap landed and the work is still going.
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
              /*
               * The target oval, from ovalStageStyle: percentages of the 3:4
               * stage, which are shares of the master frame, so the ring is
               * drawn on the same pixels the gate measures the oval at.
               */
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute rounded-[50%] border ${frameTone}`}
                style={{
                  left: `${String(OVAL.leftPercent)}%`,
                  top: `${String(OVAL.topPercent)}%`,
                  width: `${String(OVAL.widthPercent)}%`,
                  height: `${String(OVAL.heightPercent)}%`,
                }}
              />
            ) : null}
          </div>
        </div>

        <div className="py-6">
          <Column className="flex flex-col gap-6">
            {phase.name === "live" ? (
              <>
                <p
                  aria-live="polite"
                  className="min-h-[24px] font-body text-body text-text"
                >
                  {guidanceLine}
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
                 *
                 * Disabled until the master rect has been read from a delivered
                 * frame: a tap before that would have no frame to cut.
                 */}
                <div className="flex justify-center">
                  <button
                    type="button"
                    aria-label={copy.capture.shutterLabel}
                    disabled={geometry === null}
                    onClick={handleShutter}
                    className="group flex h-[72px] w-[72px] items-center justify-center rounded-sm border border-accent bg-transparent active:bg-accent disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
