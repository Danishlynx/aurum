import { expect, test, type Page } from "@playwright/test";

import { copy } from "../src/lib/shared/copy";

/**
 * D. Capture, docs/01-user-flow.md section D, as a person meets it.
 *
 * Three things are proved here, and all three come from watching someone use
 * the screen rather than from a scanner.
 *
 * 1. Composition. docs/02-design-system.md, Layout: "Mobile first at 390px ...
 *    On desktop, the app renders a 480px column centered on the Obsidian
 *    canvas". A laptop webcam is landscape, so without that column the feed
 *    filled the window as a wide strip with the shutter floating below it.
 * 2. The way out. The camera is the one screen a person can arrive at by
 *    accident, and docs/02 puts a back control in the screen skeleton.
 * 3. The tap. The shutter answers instantly and the frame it took stays on the
 *    screen, so there is no moment where nothing is happening.
 *
 * The camera tests run against Chromium's fake capture device, so no real face
 * is involved. Nothing in this file spends a credit or writes a row: the gate
 * runs in the browser, and the one request a frame could start is stubbed.
 */

/*
 * Chromium's fake capture device, for the whole file: the screen under test is
 * a camera screen, and the composition it is asked about is the composition it
 * has with a feed running in it. Playwright allows launch options only at the
 * top level of a file, because they decide the worker.
 */
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["camera"],
});

/** The 480px column: the one child of main. */
function column(page: Page) {
  return page.locator("main > div").first();
}

/** The camera stage inside it. */
function stage(page: Page) {
  return column(page).locator("> div").first();
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

test.describe("the capture screen composes into one column", () => {
  test("fills a phone, with the controls under the stage", async ({ page }) => {
    await page.goto("/capture");
    await expect(page.locator("main")).toBeVisible();

    const box = await stage(page).boundingBox();
    expect(box?.x).toBe(0);
    expect(box?.width).toBe(390);
    // Portrait, which is the shape a face is.
    expect(box?.height ?? 0).toBeGreaterThan(box?.width ?? 0);
  });

  test.describe("on a laptop window", () => {
    test.use({
      viewport: { width: 1280, height: 900 },
      isMobile: false,
      hasTouch: false,
    });

    test("holds the 480px column rather than spreading sideways", async ({
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

      // The stage is the column, and it is taller than it is wide: the same
      // portrait frame the phone gets, not the webcam's landscape strip.
      const stageBox = await stage(page).boundingBox();
      expect(stageBox?.width).toBe(480);
      expect(stageBox?.height ?? 0).toBeGreaterThan(stageBox?.width ?? 0);
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
    // Nothing may reach the server from this test. A frame that passed the gate
    // would try to create a capture; this is the one request that could.
    await page.route("**/api/captures", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "e2e" }),
      }),
    );

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
   * The borderline frame, at 390px, which is the state this screen is judged on.
   *
   * On 2026-09-03 a founder on a Samsung S26 Ultra was told "Good. Tap to
   * capture." and then, on that same frame, "A little blurry. Hold still and tap
   * again." Softness no longer refuses a frame (src/lib/shared/quality.ts), so
   * the words are the same and the way through is on the screen underneath them.
   * This proves the way through is there, is the documented copy, and is where a
   * thumb is already looking: directly under Retake, the same full width, the
   * same 52px, both above the fold of a phone.
   *
   * The fake capture device is not a face, so the frame that produces this state
   * comes in through "Upload instead", which runs the identical gate on the
   * identical canvas. It is drawn in the page rather than carried as a fixture,
   * so no photograph of a person enters this repository
   * (docs/06-safety-privacy.md).
   */
  test("offers use it anyway under retake for a borderline frame", async ({
    page,
  }) => {
    await page.route("**/api/captures", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "e2e" }),
      }),
    );

    await page.goto("/capture");
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toBeVisible();

    /*
     * A frame the gate reads as one face, well lit, well framed, and completely
     * soft. The face region is flat skin chroma; the ground behind it is a
     * colour with the same luminance and a chroma outside the skin range, so the
     * grayscale the gate measures is flat everywhere (sharpness zero, the limit
     * motion blur converges to) while the skin heuristic still finds exactly one
     * region filling 72 percent of the frame height.
     */
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("no canvas context");
      }
      context.fillStyle = "rgb(120, 175, 150)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "rgb(205, 150, 120)";
      const faceHeight = Math.round(canvas.height * 0.72);
      const faceWidth = Math.round(faceHeight * 0.68);
      context.fillRect(
        Math.round((canvas.width - faceWidth) / 2),
        Math.round((canvas.height - faceHeight) / 2),
        faceWidth,
        faceHeight,
      );
      return canvas.toDataURL("image/png");
    });

    await page
      .locator('main input[type="file"]')
      .setInputFiles({
        name: "soft.png",
        mimeType: "image/png",
        buffer: Buffer.from(dataUrl.split(",")[1] ?? "", "base64"),
      });

    // The words, from src/lib/shared/copy.ts and nowhere else.
    await expect(page.getByText(copy.capture.rejection.blurry)).toBeVisible();

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
  });
});

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
