import { expect, test, type Page } from "@playwright/test";

import { syntheticFace } from "../evals/support/synthetic-face";
import { copy } from "../src/lib/shared/copy";
import {
  FRAME_FACE_CENTER_X,
  FRAME_FACE_CENTER_Y,
  FRAME_GEOMETRY_VERSION,
  FRAME_OVAL_WIDTH,
  MASTER_ASPECT,
  MASTER_MIN_SHORT_EDGE,
} from "../src/lib/shared/frame-geometry";
import { FLAT_CAMERA_SIZE, flatCameraFile } from "./support/flat-camera";

/**
 * D. Capture, docs/01-user-flow.md section D, as a person meets it.
 *
 * Four things are proved here, and all four come from watching someone use
 * the screen rather than from a scanner.
 *
 * 1. Composition. docs/02-design-system.md, Layout: "Mobile first at 390px ...
 *    On desktop, the app renders a 480px column centered on the Obsidian
 *    canvas". The stage is a 3:4 box in that column, the master frame's own
 *    shape, on a phone and on a laptop alike.
 * 2. The way out. The camera is the one screen a person can arrive at by
 *    accident, and docs/02 puts a back control in the screen skeleton.
 * 3. The tap. The shutter answers instantly and the frame it took stays on the
 *    screen, the same mirror image the person framed, so there is no moment
 *    where nothing is happening and nothing flips.
 * 4. The frame. What is sent is the master frame: 3:4, at the engine's floor,
 *    whatever the camera granted; and after a hold of "ready" the screen takes
 *    it itself.
 *
 * The camera tests run against Chromium's fake capture device fed a still,
 * flat picture (e2e/support/flat-camera.ts), so no real face is involved and
 * the camera holds still the way a person does. Nothing in this file spends a
 * credit or writes a row: the gate runs in the browser, and the one request a
 * frame could start is stubbed.
 */

/*
 * Chromium's fake capture device, for the whole file: the screen under test is
 * a camera screen, and the composition it is asked about is the composition it
 * has with a feed running in it. Playwright allows launch options only at the
 * top level of a file, because they decide the worker. The device plays the
 * flat camera file in a loop, at the file's own size.
 */
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${flatCameraFile()}`,
    ],
  },
  permissions: ["camera"],
});

/**
 * The fake device's track: the flat camera file's 360 by 480 portrait, which
 * masterRectFor keeps whole and the draw lifts to the 480 px floor: 480 by
 * 640 (src/lib/shared/frame-geometry.test.ts pins the rect).
 */
const FAKE_TRACK = FLAT_CAMERA_SIZE;

/** The 480px column: the one child of main. */
function column(page: Page) {
  return page.locator("main > div").first();
}

/** The camera stage inside it: the first div under the header. */
function stage(page: Page) {
  return column(page).locator("> div").first();
}

/** The oval, the one rounded thing on the screen (docs/02, Radius). */
function oval(page: Page) {
  return page.locator('main [class*="rounded-[50%]"]');
}

/** The resolved value of a design token, so no colour is written into a test. */
function token(page: Page, name: string): Promise<string> {
  return page.evaluate((variable) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

/**
 * What the feed is actually doing, read off the element rather than off the
 * screen. A camera that has stopped keeps its element, keeps its srcObject, and
 * simply stops producing frames, so nothing about a dead feed is visible to a
 * locator: the track's readyState is the only thing that tells the two apart.
 */
function feedState(page: Page): Promise<{
  readonly paused: boolean;
  readonly liveTracks: number;
} | null> {
  return page.evaluate(() => {
    const video = document.querySelector("main video");
    if (!(video instanceof HTMLVideoElement)) {
      return null;
    }
    const stream = video.srcObject;
    return {
      paused: video.paused,
      liveTracks:
        stream instanceof MediaStream
          ? stream
              .getVideoTracks()
              .filter((track) => track.readyState === "live").length
          : 0,
    };
  });
}

/** Every border colour actually painted on the screen. */
function paintedBorders(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("main *"))
      .map((element) => getComputedStyle(element))
      .filter((style) => Number.parseFloat(style.borderTopWidth) > 0)
      .map((style) => style.borderTopColor)
      .filter((color) => color !== "rgba(0, 0, 0, 0)"),
  );
}

/** Nothing may reach the server: this is the one request a frame could start. */
async function stubCaptureCreate(page: Page): Promise<void> {
  await page.route("**/api/captures", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "e2e" }),
    }),
  );
}

test.describe("the capture screen composes into one column", () => {
  test("fills a phone, with the controls under the stage", async ({ page }) => {
    await page.goto("/capture");
    await expect(page.locator("main")).toBeVisible();

    const box = await stage(page).boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(390);
    // 3:4, the master frame's shape: the stage shows exactly the frame that
    // is sent, so it has to be the frame's shape and nothing else.
    expect((box?.height ?? 0) / (box?.width ?? 1)).toBeCloseTo(1 / MASTER_ASPECT, 2);
  });

  test.describe("on a laptop window", () => {
    test.use({
      viewport: { width: 1280, height: 900 },
      isMobile: false,
      hasTouch: false,
    });

    /**
     * The column holds, the stage stays 3:4, and on a window too short for the
     * full 480 wide stage under the header and above the controls it shrinks
     * its width, centred, rather than cropping the frame: the shutter has to
     * be on screen without scrolling, and the frame shown has to be the frame
     * sent.
     */
    test("holds the 480px column and a 3:4 stage that fits the window", async ({
      page,
    }) => {
      await page.goto("/capture");
      await expect(page.locator("main")).toBeVisible();

      const columnBox = await column(page).boundingBox();
      expect(columnBox?.width).toBe(480);
      // Centered on the canvas, not left aligned in a 1280px window.
      expect(Math.round((columnBox?.x ?? 0) + (columnBox?.width ?? 0) / 2)).toBe(
        640,
      );

      const stageBox = await stage(page).boundingBox();
      expect(stageBox?.width ?? 0).toBeLessThanOrEqual(480);
      expect(stageBox?.width ?? 0).toBeGreaterThan(300);
      expect((stageBox?.height ?? 0) / (stageBox?.width ?? 1)).toBeCloseTo(
        1 / MASTER_ASPECT,
        1,
      );
      // Centred in the column when it is narrower than it.
      expect(Math.round((stageBox?.x ?? 0) + (stageBox?.width ?? 0) / 2)).toBe(
        640,
      );

      const shutter = page.getByRole("button", {
        name: copy.capture.shutterLabel,
      });
      await expect(shutter).toBeVisible();
      const shutterBox = await shutter.boundingBox();
      expect((shutterBox?.y ?? 0) + (shutterBox?.height ?? 0)).toBeLessThanOrEqual(
        900,
      );
    });
  });
});

test.describe("the way back", () => {
  test("returns to the screen the camera was reached from", async ({ page }) => {
    await page.goto("/welcome");
    await page.goto("/capture");

    // One back control for the whole app: the BackLink of the header row,
    // pointed by the table in src/lib/shared/navigation.ts. It is a link, not a
    // button, because its target is a screen and is known before the click.
    const back = page.getByRole("link", { name: copy.nav.back });
    await expect(back).toBeVisible();

    // docs/06-safety-privacy.md: "Tap targets are at least 44px."
    const box = await back.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    await back.click();
    await expect(page).toHaveURL(/\/welcome$/u);
  });
});

test.describe("the camera itself", () => {
  /**
   * docs/01-user-flow.md section D: the guidance is "one line at a time,
   * replaced as conditions change, never stacked".
   */
  test("shows one line of guidance, never two", async ({ page }) => {
    await page.goto("/capture");
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toBeVisible();

    let onScreen = 0;
    for (const line of Object.values(copy.capture.guidance)) {
      onScreen += await page.getByText(line, { exact: true }).count();
    }
    expect(onScreen).toBe(1);

    // Quiet, and still findable, under the shutter.
    await expect(page.getByText(copy.capture.uploadInstead)).toBeVisible();
  });

  /**
   * docs/02-design-system.md: a button "changes color the instant it is
   * touched". The shutter carries no label, so the pressed state is the only
   * thing that says the tap landed on it.
   */
  test("fills the shutter while it is held down", async ({ page }) => {
    await page.goto("/capture");
    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();
    // Enabled once the master rect has been read off a delivered frame.
    await expect(shutter).toBeEnabled();

    const accent = await token(page, "--accent");
    const resting = await shutter.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(resting).not.toBe(accent);

    const box = await shutter.boundingBox();
    await page.mouse.move(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );
    await page.mouse.down();
    const pressed = await shutter.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    await page.mouse.up();

    expect(pressed).toBe(accent);
  });

  /**
   * The handoff, docs/01-user-flow.md section D: between the tap and the route
   * there is a measure, a hash, and an upload. The frame the person took is on
   * the screen for all of it, so the tap is never answered with nothing.
   *
   * The fake device is not a face, so the gate refuses this frame, which is the
   * other half of what is checked here: the refusal is in the documented voice,
   * Retake is the primary action, and the screen still holds the frame.
   */
  test("keeps the frame on screen and answers a refused one in words", async ({
    page,
  }) => {
    await stubCaptureCreate(page);

    await page.goto("/capture");
    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(0);

    await shutter.click();

    // The still, drawn before the gate ran, and still there once it answered.
    const still = page.locator("main img");
    await expect(still).toHaveCount(1);
    await expect(still).toHaveAttribute("src", /^data:image\//u);

    await expect(
      page.getByRole("button", { name: copy.capture.retakeAction }),
    ).toBeVisible();
    await expect(still).toHaveCount(1);

    /*
     * docs/02-design-system.md: "There is no red." The only borders this screen
     * paints are the three the design system gives it, plus the Umber hairline
     * every quiet control carries.
     */
    const allowed = new Set(
      await Promise.all([
        token(page, "--accent"),
        token(page, "--accent-bright"),
        token(page, "--caution"),
        token(page, "--raised"),
      ]),
    );
    for (const color of await paintedBorders(page)) {
      expect(allowed.has(color)).toBe(true);
    }
  });

  /**
   * The still does not flip at the tap, docs/01-user-flow.md section D.
   *
   * Until 2026-09-23 the video was mirrored by CSS and the still was not, so
   * the frozen frame was the mirror image of what the person had just been
   * looking at. One wrapper now carries the flip and holds the video, the
   * still and the oval, so the still is the same mirror image the video was
   * and nothing inside the wrapper carries a transform of its own. The upload
   * is drawn from the video, which is never mirrored, so the picture the
   * analysis reads is the un mirrored one.
   */
  test("does not flip the still at the tap: the video and the still share one mirrored wrapper", async ({
    page,
  }) => {
    await stubCaptureCreate(page);

    await page.goto("/capture");
    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();

    const before = await page.evaluate(() => {
      const video = document.querySelector("main video");
      const wrapper = video?.parentElement ?? null;
      return {
        wrapperTransform:
          wrapper === null ? null : getComputedStyle(wrapper).transform,
        videoTransform: video === null ? null : getComputedStyle(video).transform,
      };
    });
    expect(before.wrapperTransform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
    expect(before.videoTransform).toBe("none");

    await shutter.click();
    await expect(page.locator("main img")).toHaveCount(1);

    const after = await page.evaluate(() => {
      const video = document.querySelector("main video");
      const still = document.querySelector("main img");
      const ring = document.querySelector('main [class*="rounded-[50%]"]');
      const wrapper = still?.parentElement ?? null;
      return {
        wrapperTransform:
          wrapper === null ? null : getComputedStyle(wrapper).transform,
        stillTransform: still === null ? null : getComputedStyle(still).transform,
        videoShares: wrapper !== null && video?.parentElement === wrapper,
        ovalShares: wrapper !== null && ring?.parentElement === wrapper,
      };
    });
    expect(after.wrapperTransform).toBe("matrix(-1, 0, 0, 1, 0, 0)");
    expect(after.stillTransform).toBe("none");
    expect(after.videoShares).toBe(true);
    expect(after.ovalShares).toBe(true);
  });

  /**
   * The borderline frame, at 390px, which is the state this screen is judged on.
   *
   * On 2026-09-03 a founder on a Samsung S26 Ultra was told "Good. Tap to
   * capture." and then, on that same frame, "A little blurry. Hold still and tap
   * again." Softness no longer flags a frame at all (src/lib/shared/quality.ts,
   * 2026-09-14), so the borderline this test walks is one the gate still
   * offers rather than refuses: a face a little too wide for the band the
   * engine reads, which is "too close". What is proved is unchanged: the way
   * through is there, is the documented copy, and is where a thumb is already
   * looking: directly under Retake, the same full width, the same 52px, both
   * above the fold of a phone.
   *
   * The fake capture device is not a face, so the face comes in through the
   * e2e seam (src/lib/client/landmarks-seam.ts): a synthetic landmarker result
   * of known width and pose, built in Node by evals/support/synthetic-face.ts
   * and put on the window before the app's scripts run. The gate then reads
   * the shutter's frame with that face, through the same conversion the real
   * model's result goes through. No photograph of a person enters this
   * repository (docs/06-safety-privacy.md). The seam exists only in a build
   * made with NEXT_PUBLIC_AURUM_E2E_SEAMS=true, which playwright.config.ts
   * sets for the fixture server it starts; a missing seam on that server is
   * a failure, and only a run pointed at another server by
   * PLAYWRIGHT_BASE_URL skips (requireSeam below).
   */
  test("offers use it anyway under retake for a borderline frame", async ({
    page,
  }) => {
    await stubCaptureCreate(page);

    await injectTooCloseFace(page);

    await page.goto("/capture");
    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();

    await requireSeam(page);

    await shutter.click();

    // The words, from src/lib/shared/copy.ts and nowhere else.
    await expect(page.getByText(copy.capture.rejection.too_close)).toBeVisible();

    await expectUseAnywayUnderRetake(page);
  });

  /**
   * The same borderline through "Upload instead". This keeps the gallery path
   * covered end to end (decodeImageFile, frameForUpload with masterCropFor,
   * then the gate): a flat, evenly lit picture drawn in the page is set on the
   * file input, the seam hands the landmarker the same too close face for the
   * decoded photo and again for the composed frame, and the review screen
   * has to answer the same way. Drawn rather than carried as a fixture, so no
   * photograph of a person enters this repository (docs/06-safety-privacy.md).
   */
  test("offers use it anyway for a borderline photo sent through upload instead", async ({
    page,
  }) => {
    await stubCaptureCreate(page);

    await injectTooCloseFace(page);

    await page.goto("/capture");
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toBeVisible();
    await requireSeam(page);

    /*
     * Mid grey over the whole picture: a face luma of 0.5 on the gate's 0 to
     * 1 scale, inside the light bands, with nothing blown and nothing
     * crushed, so the only thing wrong with the frame is the injected width.
     * 600 by 800 keeps the short edge above the 480 floor after composition.
     */
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("no canvas context");
      }
      context.fillStyle = "rgb(128, 128, 128)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    });

    await page.locator('main input[type="file"]').setInputFiles({
      name: "close.png",
      mimeType: "image/png",
      buffer: Buffer.from(dataUrl.split(",")[1] ?? "", "base64"),
    });

    await expect(page.getByText(copy.capture.rejection.too_close)).toBeVisible();
    await expectUseAnywayUnderRetake(page);
  });

  /**
   * The auto capture, docs/01-user-flow.md section D: after READY_HOLD_MS of
   * "ready" the oval turns solid (Champagne, the one place docs/02 allows it)
   * and the line says the photo is about to be taken; when the countdown
   * elapses the shutter fires itself and the still appears without a tap.
   *
   * A ready face through the seam: the oval's own width, at the target
   * centre, square to the lens, eyes open. The flat camera file supplies the
   * light and the stillness; Chromium's own animated fake picture reads as
   * motion every third sample and never lets the hold complete. Watched with
   * a MutationObserver rather than polled, because the solid oval and the
   * line last only the countdown (700ms) before the still replaces them, and
   * a poll can miss a window that short.
   */
  test("turns the oval solid after the hold, then takes the photo itself", async ({
    page,
  }) => {
    await stubCaptureCreate(page);

    await injectFace(page, {
      widthRatio: FRAME_OVAL_WIDTH,
      center: { x: FRAME_FACE_CENTER_X, y: FRAME_FACE_CENTER_Y },
    });

    await page.goto("/capture");
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toBeVisible();
    await skipWithoutSeam(page);
    await expect(oval(page)).toHaveCount(1);

    const accentBright = await token(page, "--accent-bright");
    await page.evaluate(
      ([solidColor, takingLine]) => {
        const record = { solid: false, taking: false };
        (window as unknown as { __aurumHold: typeof record }).__aurumHold = record;
        const check = (): void => {
          const ring = document.querySelector('main [class*="rounded-[50%]"]');
          const stillThere = document.querySelector("main img") !== null;
          if (stillThere) {
            return;
          }
          if (ring !== null && getComputedStyle(ring).borderTopColor === solidColor) {
            record.solid = true;
          }
          if (
            Array.from(document.querySelectorAll("main p")).some(
              (line) => line.textContent === takingLine,
            )
          ) {
            record.taking = true;
          }
        };
        const main = document.querySelector("main");
        if (main !== null) {
          new MutationObserver(check).observe(main, {
            subtree: true,
            attributes: true,
            childList: true,
            characterData: true,
          });
        }
        check();
      },
      [accentBright, copy.capture.guidance.taking] as const,
    );

    // No tap. The still appears on its own once the hold and the countdown
    // have run, and the stubbed register answer lands the screen on Retake.
    const still = page.locator("main img");
    await expect(still).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: copy.capture.retakeAction }),
    ).toBeVisible();

    const hold = await page.evaluate(
      () => (window as unknown as { __aurumHold: { solid: boolean; taking: boolean } }).__aurumHold,
    );
    expect(hold.solid).toBe(true);
    expect(hold.taking).toBe(true);
  });

  /**
   * What is sent is the master frame, docs/01-user-flow.md section D and
   * docs/03-architecture.md step 1: 3:4 whatever the camera granted, and for
   * the flat camera's 360 by 480 track that frame lifted to the 480 px
   * floor, 480 by 640. The register body carries the sizes and the geometry
   * version the calibration report keys on.
   *
   * The face is one the gate accepts and the live line does not yet call
   * ready (0.62 of the width: over the engine's 0.60, under the line's 0.64),
   * so the request is the tap's and the auto capture cannot race it.
   */
  test("sends the master frame: 3:4, at the floor, with its sizes", async ({
    page,
  }) => {
    type SentBody = {
      readonly width?: number;
      readonly height?: number;
      readonly quality?: {
        readonly frame?: Record<string, number>;
        readonly frameGeometryVersion?: number;
        readonly burstLosers?: unknown[];
        readonly faceWidthRatio?: number | null;
        readonly path?: string;
      };
    };
    // Held in an object: the route callback fills it after this flow reads it.
    const captured: { body: SentBody | null } = { body: null };
    await page.route("**/api/captures", (route) => {
      captured.body = route.request().postDataJSON() as SentBody;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "e2e" }),
      });
    });

    await injectFace(page, {
      widthRatio: 0.62,
      center: { x: FRAME_FACE_CENTER_X, y: FRAME_FACE_CENTER_Y },
    });

    await page.goto("/capture");
    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();
    await skipWithoutSeam(page);
    await expect(shutter).toBeEnabled();
    await shutter.click();

    await expect.poll(() => captured.body).not.toBeNull();
    const sent = captured.body;
    if (sent === null) {
      throw new Error("The register request never left the screen.");
    }

    const width = sent.width ?? 0;
    const height = sent.height ?? 0;
    // 3:4 to within a pixel of rounding.
    expect(Math.abs(width - height * MASTER_ASPECT)).toBeLessThanOrEqual(1);
    // The fake device's frame after the floor.
    expect(Math.min(width, height)).toBe(MASTER_MIN_SHORT_EDGE);
    expect({ width, height }).toEqual({ width: 480, height: 640 });

    expect(sent.quality?.frame).toEqual({
      sourceWidth: FAKE_TRACK.width,
      sourceHeight: FAKE_TRACK.height,
      masterWidth: 480,
      masterHeight: 640,
    });
    expect(sent.quality?.frameGeometryVersion).toBe(FRAME_GEOMETRY_VERSION);
    expect(sent.quality?.path).toBe("camera");
    // Three frames, one sent, two passed over as numbers.
    expect(sent.quality?.burstLosers).toHaveLength(2);
    expect(sent.quality?.faceWidthRatio ?? 0).toBeCloseTo(0.62, 2);
  });
});

/**
 * A synthetic face on the window before the app's scripts run, where the seam
 * reads it (src/lib/client/landmarks-seam.ts). Square to the lens, eyes open
 * unless the options say otherwise, so nothing but the given framing is wrong
 * with it.
 */
async function injectFace(
  page: Page,
  options: Parameters<typeof syntheticFace>[0],
): Promise<void> {
  const face = syntheticFace({ yaw: 0, pitch: 0, roll: 0, blink: 0, ...options });
  const injected = {
    faces: [
      {
        landmarks: face.landmarks.map((point) => ({ ...point })),
        matrix: [...face.matrix],
        blendshapes: Object.fromEntries(face.blendshapes),
      },
    ],
  };
  await page.addInitScript((result) => {
    (window as unknown as { __aurumLandmarker: unknown }).__aurumLandmarker =
      result;
  }, injected);
}

/**
 * A face at 0.87 of the frame width, cheek to cheek: above the 0.86 top of
 * the band, so the gate offers it as too close, and centred at 0.525 of the
 * height so its oval (0.87 of the width tall, being 1.35 times as tall as it
 * is wide on a 3 by 4 frame) stays inside the 0.08 top and 0.03 bottom edge
 * margins. Any wider, or centred at the target 0.47, and the oval runs into a
 * margin and the gate answers out of bounds first.
 */
async function injectTooCloseFace(page: Page): Promise<void> {
  await injectFace(page, { widthRatio: 0.87, center: { x: 0.5, y: 0.525 } });
}

const SEAM_MISSING =
  "The face model seam is off: this server was not built with NEXT_PUBLIC_AURUM_E2E_SEAMS=true (playwright.config.ts sets it for the fixture server it starts).";

function seamIsOn(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __aurumSeams?: boolean }).__aurumSeams === true,
  );
}

/**
 * The seam has to be there. When this file's own config started the server
 * it set NEXT_PUBLIC_AURUM_E2E_SEAMS for it, so a missing seam is a broken
 * build and the test fails and says so. Only a run pointed at somebody else's
 * server (PLAYWRIGHT_BASE_URL) may legitimately have no seam, and that run
 * skips with the same message rather than failing on the wrong build.
 */
async function requireSeam(page: Page): Promise<void> {
  const seamed = await seamIsOn(page);
  if (process.env.PLAYWRIGHT_BASE_URL) {
    test.skip(!seamed, SEAM_MISSING);
    return;
  }
  if (!seamed) {
    throw new Error(SEAM_MISSING);
  }
}

/** The master frame tests skip, with the same message, on a server without the seam. */
async function skipWithoutSeam(page: Page): Promise<void> {
  test.skip(!(await seamIsOn(page)), SEAM_MISSING);
}

/** The two answers to a borderline frame, in the geometry docs/02 gives them. */
async function expectUseAnywayUnderRetake(page: Page): Promise<void> {
  const retake = page.getByRole("button", { name: copy.capture.retakeAction });
  const useAnyway = page.getByRole("button", {
    name: copy.capture.useAnywayAction,
  });
  await expect(retake).toBeVisible();
  await expect(useAnyway).toBeVisible();

  const retakeBox = await retake.boundingBox();
  const useAnywayBox = await useAnyway.boundingBox();
  if (retakeBox === null || useAnywayBox === null) {
    throw new Error("Both answers to a borderline frame must be on screen.");
  }

  // docs/02-design-system.md, Components: height 52, full width on mobile.
  expect(Math.round(retakeBox.height)).toBe(52);
  expect(Math.round(useAnywayBox.height)).toBe(52);
  expect(Math.round(useAnywayBox.width)).toBe(Math.round(retakeBox.width));
  expect(retakeBox.width).toBeGreaterThan(300);

  // Directly under it, aligned with it, and not below the fold of the phone.
  expect(Math.round(useAnywayBox.x)).toBe(Math.round(retakeBox.x));
  const gap = useAnywayBox.y - (retakeBox.y + retakeBox.height);
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThanOrEqual(16);
  const viewport = page.viewportSize();
  expect(useAnywayBox.y + useAnywayBox.height).toBeLessThanOrEqual(
    viewport?.height ?? 0,
  );
}

/**
 * The retake loop, docs/01-user-flow.md section D: "Retake" is the primary
 * answer to a refused frame, so the one thing it must never do is hand back a
 * dead camera. That is the failure this file exists to catch, because it is
 * invisible: the element is there, the srcObject is there, and the picture is a
 * black rectangle that a locator is perfectly happy with.
 *
 * Both ways into it are covered. Refused by the gate, on this screen, which is
 * the loop a person walks several times. And refused by the engine, which
 * happens a screen later and comes back through a navigation.
 */
test.describe("the retake loop", () => {
  test("hands back a running camera, and does it twice", async ({ page }) => {
    await stubCaptureCreate(page);
    await page.goto("/capture");

    const shutter = page.getByRole("button", {
      name: copy.capture.shutterLabel,
    });
    await expect(shutter).toBeVisible();
    expect(await feedState(page)).toEqual({ paused: false, liveTracks: 1 });

    // The fake device is not a face, so the gate refuses this frame.
    await shutter.click();
    const retake = page.getByRole("button", { name: copy.capture.retakeAction });
    await expect(retake).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(1);

    await retake.click();

    // The frozen frame is gone, the controls are back, and there is a live
    // camera behind them rather than the last frame it produced.
    await expect(page.locator("main img")).toHaveCount(0);
    await expect(shutter).toBeVisible();
    await expect(
      page.getByRole("button", { name: copy.capture.retakeAction }),
    ).toHaveCount(0);
    expect(await feedState(page)).toEqual({ paused: false, liveTracks: 1 });

    // And the loop closes: the second tap behaves exactly like the first.
    await shutter.click();
    await expect(
      page.getByRole("button", { name: copy.capture.retakeAction }),
    ).toBeVisible();
    await expect(page.locator("main img")).toHaveCount(1);
  });

  /**
   * The other refusal: the gate passed the frame and the engine did not. The
   * reveal is a different screen, so the way back is a navigation, and the
   * camera has to be asked for again from nothing.
   */
  test("restarts the camera when the reveal sends the person back", async ({
    page,
  }) => {
    await stubCaptureCreate(page);
    await page.route("**/api/jobs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobs: [
            {
              id: "job-skin",
              kind: "skin",
              status: "failed",
              error: copy.capture.rejection.no_face,
            },
            {
              id: "job-tone",
              kind: "attributes",
              status: "failed",
              error: copy.capture.rejection.no_face,
            },
          ],
          complete: true,
        }),
      }),
    );

    await page.goto("/analyzing?capture=e2e-retake");
    await expect(page.getByText(copy.capture.rejection.no_face)).toBeVisible();

    await page
      .getByRole("link", { name: copy.report.retakePhotoAction })
      .click();

    /*
     * waitForURL rather than an expect on the URL: this is a navigation, and on
     * a development server it is the navigation that compiles the camera route,
     * which is slower than an assertion timeout and not slow in the product.
     */
    await page.waitForURL(/\/capture$/u);
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toBeVisible();
    expect(await feedState(page)).toEqual({ paused: false, liveTracks: 1 });
  });
});
