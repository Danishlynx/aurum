import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * eval:budget, the reframe race.
 *
 * The most expensive defect this project has had, measured in real money on a
 * real account on 2026-09-10: roughly eight capture taps consumed twenty four of
 * the session's analyses and 402 Perfect Corp units, against one reading the
 * person actually received.
 *
 * The mechanism. /analyzing polls every 1.5 seconds. The poll awaited
 * GET /api/jobs, a route that declares maxDuration 60 and makes provider calls
 * inside it, and the interval had no in flight guard, so a poll slower than the
 * interval overlapped the next one. Both overlapping polls read the same settled
 * and reframeable state, both passed a finished check that was read before the
 * await and only written after it, and both went on to call
 * resubmitReframedCapture. Each of those creates a capture, uploads a face, and
 * starts a full provider fan out. One router.replace won and the other capture
 * was orphaned: charged, counted against the session, and never polled again, so
 * nothing ever gave it back.
 *
 * Two guards now stand in the way and this file holds the second one, because it
 * is the one nearest the money: resubmitReframedCapture refuses a second call
 * while the first is still running. The first guard, in the poll itself, is a
 * React ref and is exercised by e2e rather than here.
 */

vi.mock("server-only", () => ({}));

const createCapture = vi.fn();
const uploadCaptureImage = vi.fn();
const startAnalysis = vi.fn();

vi.mock("@/lib/client/api", () => ({
  createCapture: (...args: unknown[]) => createCapture(...args),
  uploadCaptureImage: (...args: unknown[]) => uploadCaptureImage(...args),
  startAnalysis: (...args: unknown[]) => startAnalysis(...args),
}));

vi.mock("@/lib/client/capture-handoff", () => ({
  rememberCapturePreview: () => undefined,
  readCapturePreview: () => null,
  forgetCapturePreview: () => undefined,
}));

/** One face, found every time, so the gate never refuses the crop under test. */
vi.mock("@/lib/client/face", () => ({
  SKIN_SAMPLE_LONG_EDGE: 96,
  estimateFaceForCapture: () =>
    Promise.resolve({
      faceCount: 1,
      faceBox: { x: 10, y: 10, width: 80, height: 80 },
      source: "model",
      pose: { yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0 },
    }),
}));

/**
 * The image layer is canvas work and there is no canvas here. Every function is
 * replaced with the smallest thing that keeps the shape the module expects.
 */
vi.mock("@/lib/client/image", () => {
  const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
  return {
    CAPTURE_JPEG_QUALITY: 0.92,
    CAPTURE_LONG_EDGE: 1024,
    CAPTURE_MIN_SHORT_EDGE: 480,
    PREVIEW_JPEG_QUALITY: 0.72,
    PREVIEW_LONG_EDGE: 720,
    drawCropToCanvas: () => canvas,
    drawToCanvas: () => canvas,
    readImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    sha256Hex: () => Promise.resolve("a".repeat(64)),
    toDataUrl: () => "data:image/jpeg;base64,x",
    toGrayscale: () => ({ data: [128], width: 1, height: 1 }),
    toJpegBlob: () => Promise.resolve(new Blob([new Uint8Array([1])])),
  };
});

vi.mock("@/lib/shared/quality", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shared/quality")>();
  return {
    ...actual,
    // The crop under test always passes, so nothing but the guard decides how
    // many submissions happen.
    assessCapture: () => ({
      verdict: "accept" as const,
      reason: null,
      canUseAnyway: false,
      failures: [],
      metrics: {
        sharpness: 100,
        blownFraction: 0,
        crushedFraction: 0,
        meanLuminance: 128,
        faceCoverage: 0.7,
        faceWidthRatio: 0.7,
        pose: null,
      },
    }),
  };
});

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";

async function loadModule() {
  return import("@/lib/client/capture-source");
}

beforeEach(() => {
  vi.resetModules();
  createCapture.mockReset();
  uploadCaptureImage.mockReset();
  startAnalysis.mockReset();

  let issued = 0;
  createCapture.mockImplementation(() => {
    issued += 1;
    return Promise.resolve({
      ok: true,
      data: { captureId: `capture-${issued}`, status: "new", uploadUrl: "https://x" },
    });
  });
  uploadCaptureImage.mockResolvedValue({ ok: true });
  /*
   * The slow one. startAnalysis is what spends units, and the whole defect is a
   * second caller arriving while the first is still inside it, so it has to take
   * long enough for a second call to be attempted.
   */
  startAnalysis.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({ ok: true });
        }, 25);
      }),
  );
});

describe("resubmitReframedCapture, called twice at once", () => {
  it("starts exactly one analysis, not one per caller", async () => {
    const mod = await loadModule();
    const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
    mod.rememberCaptureSource(canvas);
    mod.bindCaptureSource(CAPTURE_ID);

    // Two overlapping polls, which is exactly what the interval produced.
    const [first, second] = await Promise.all([
      mod.resubmitReframedCapture(CAPTURE_ID),
      mod.resubmitReframedCapture(CAPTURE_ID),
    ]);

    const succeeded = [first, second].filter((outcome) => outcome.ok);
    expect(succeeded).toHaveLength(1);

    /*
     * The assertion that is about money. Every startAnalysis is a provider fan
     * out: the leader alone is 20 units, and a full set is 46. Two of them for
     * one refusal is the 402 units.
     */
    expect(startAnalysis).toHaveBeenCalledTimes(1);
    expect(createCapture).toHaveBeenCalledTimes(1);
  });

  it("lets a later, separate retry through once the first has finished", async () => {
    const mod = await loadModule();
    const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
    mod.rememberCaptureSource(canvas);
    mod.bindCaptureSource(CAPTURE_ID);

    const first = await mod.resubmitReframedCapture(CAPTURE_ID);
    expect(first.ok).toBe(true);

    // The guard is held for the duration of a call, never latched: the second
    // attempt of a genuine retry ladder still runs.
    if (first.ok) {
      const second = await mod.resubmitReframedCapture(first.captureId);
      expect(second.ok).toBe(true);
    }
    expect(startAnalysis).toHaveBeenCalledTimes(2);
  });
});

/**
 * The other half of the same account: a capture the server started and the
 * client threw away.
 *
 * submit() creates the capture, uploads the face, and starts the analysis. If
 * that last response is lost in transit, the server has already created and
 * charged the 20 unit leader while the client reads !ok, gives up, and never
 * navigates to the capture, so nothing ever polls it, reconciles it, or shows
 * it to anybody. Asking once more is free: the route is idempotent for a capture
 * that already has jobs, and it is the difference between a charge with a
 * reading behind it and a charge with nothing.
 *
 * Only a transport failure is asked again. A 401, a 403 and a 429 are answers
 * the server gave before it spent anything.
 */
describe("submit, when the analyze response never comes back", () => {
  it("asks once more after a transport failure", async () => {
    startAnalysis
      .mockResolvedValueOnce({ ok: false, kind: "network", status: 0 })
      .mockResolvedValueOnce({ ok: true });

    const mod = await loadModule();
    const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
    mod.rememberCaptureSource(canvas);
    mod.bindCaptureSource(CAPTURE_ID);

    const outcome = await mod.resubmitReframedCapture(CAPTURE_ID);

    expect(outcome.ok).toBe(true);
    expect(startAnalysis).toHaveBeenCalledTimes(2);
    // One capture, one upload: the retry is the start, not the whole submit.
    expect(createCapture).toHaveBeenCalledTimes(1);
    expect(uploadCaptureImage).toHaveBeenCalledTimes(1);
  });

  it("asks exactly once more, and no further", async () => {
    startAnalysis.mockResolvedValue({ ok: false, kind: "network", status: 0 });

    const mod = await loadModule();
    const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
    mod.rememberCaptureSource(canvas);
    mod.bindCaptureSource(CAPTURE_ID);

    const outcome = await mod.resubmitReframedCapture(CAPTURE_ID);

    expect(outcome).toEqual({ ok: false, reason: "request" });
    expect(startAnalysis).toHaveBeenCalledTimes(2);
  });

  it("takes a refusal for an answer, because it was given before any spend", async () => {
    startAnalysis.mockResolvedValue({ ok: false, kind: "capped", status: 429 });

    const mod = await loadModule();
    const canvas = { width: 800, height: 1000 } as unknown as HTMLCanvasElement;
    mod.rememberCaptureSource(canvas);
    mod.bindCaptureSource(CAPTURE_ID);

    const outcome = await mod.resubmitReframedCapture(CAPTURE_ID);

    expect(outcome).toEqual({ ok: false, reason: "request" });
    expect(startAnalysis).toHaveBeenCalledTimes(1);
  });
});
