import { expect, test, type Locator, type Page } from "@playwright/test";

import { copy } from "../src/lib/shared/copy";

/**
 * The Layer 6 accessibility passes, docs/09-build-order-and-demo.md: "Reduced
 * motion pass, keyboard pass, contrast pass."
 *
 * What each of these locks comes from docs/06-safety-privacy.md, "Accessibility
 * as safety":
 *
 * - "Focus is visible everywhere as a gold hairline. The whole flow works with a
 *   keyboard on desktop."
 * - "Reduced motion disables the reveal animation; nothing depends on animation
 *   to be understood."
 * - "The capture screen works with an uploaded photo for people who cannot use
 *   the camera."
 * - "Tap targets are at least 44px."
 *
 * and from docs/02-design-system.md, anti slop item 11: "Does the screen still
 * make sense at 390px with 20px padding and a 44px minimum tap target?"
 *
 * These are hand written checks, not a scanner. Nothing here is asserted against
 * a colour literal either: the focus ring is compared with the resolved value of
 * the --accent token, so the test reads the same design system the components
 * do and a token change cannot leave it passing against a stale hex.
 *
 * Everything runs against the fixture mode server playwright.config.ts starts,
 * the same as e2e/smoke.spec.ts, so no key, no database, and no face is needed.
 */

/**
 * With PLAYWRIGHT_BASE_URL set, the server was started by someone else and this
 * file cannot know whether fixture mode is on. Skipping is the honest answer.
 */
const externalServer = Boolean(process.env.PLAYWRIGHT_BASE_URL);

/** Every screen a person walks through, in flow order. */
const PUBLIC_SCREENS = ["/", "/judge", "/welcome", "/capture"] as const;
const FIXTURE_SCREENS = [
  "/report",
  "/color",
  "/makeup",
  "/hair",
  "/wardrobe",
  "/looks",
  "/profile",
] as const;

/**
 * A capture whose skin analysis has come back and whose tone reading has not.
 * revealStateFor turns that into the bloomed mask and the second status line,
 * and leaves the screen there, because nothing is terminal yet. It is the one
 * state on /analyzing that has the reveal on screen and holds it still.
 */
async function stubAnalyzingJobs(page: Page): Promise<void> {
  await page.route("**/api/jobs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobs: [
          { id: "job-skin", kind: "skin", status: "succeeded" },
          { id: "job-tone", kind: "fitzpatrick", status: "running" },
        ],
        complete: false,
      }),
    }),
  );
}

/** Presses Tab until the control has focus, and says how many presses it took. */
async function tabTo(page: Page, target: Locator, limit = 14): Promise<number> {
  for (let presses = 1; presses <= limit; presses += 1) {
    await page.keyboard.press("Tab");
    const focused = await target.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused) {
      return presses;
    }
  }
  throw new Error(`Tab did not reach the control in ${limit} presses.`);
}

/**
 * Opens a sheet and hands back the dialog.
 *
 * The click is retried on purpose, and the budget is generous for the reason
 * playwright.config.ts already gives its own timeouts: the default web server is
 * next dev, which compiles and ships a screen's client bundle on first request.
 * The markup paints before React has hydrated it, and a click that lands in
 * between is received by an element with no handler on it yet, so nothing opens.
 * Retrying is what a person does, and it keeps the assertions after it about the
 * sheet rather than about how fast the machine running them happens to be.
 */
async function openSheet(page: Page, opener: Locator): Promise<Locator> {
  const sheet = page.getByRole("dialog");
  let taps = 0;

  await expect(async () => {
    if ((await sheet.count()) === 0) {
      /*
       * A screen whose chunk the dev server failed to ship under load is
       * painted and never hydrated, and no number of taps will open anything on
       * it. Reloading is the only thing that fixes that, and it costs nothing
       * on the far more common case of hydration simply being late.
       */
      if (taps > 0 && taps % 3 === 0) {
        await page.reload();
      }
      taps += 1;
      await expect(opener).toBeVisible();
      await opener.click();
    }
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 45_000 });

  return sheet;
}

/** True while the focused element is inside the open sheet. */
function focusIsInsideDialog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog !== null && dialog.contains(document.activeElement);
  });
}

/**
 * Every element on the screen that would still move. Read from the computed
 * style rather than from class names, because a duration written as a token
 * only becomes zero after the media query has been applied.
 */
function movingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    function seconds(value: string): number {
      const trimmed = value.trim();
      const amount = Number.parseFloat(trimmed);
      if (Number.isNaN(amount)) {
        return 0;
      }
      return trimmed.endsWith("ms") ? amount / 1000 : amount;
    }

    const offenders: string[] = [];
    for (const element of Array.from(document.querySelectorAll("main, main *"))) {
      const style = getComputedStyle(element);
      const durations = [
        ...style.animationDuration.split(","),
        ...style.transitionDuration.split(","),
      ];
      if (durations.some((duration) => seconds(duration) > 0)) {
        offenders.push(
          `${element.tagName.toLowerCase()} ${String(element.className).slice(0, 60)}`,
        );
      }
    }
    return offenders;
  });
}

/** How many pixels wider than the viewport the document is, if any. */
function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(
      0,
      root.scrollWidth - root.clientWidth,
      document.body.scrollWidth - root.clientWidth,
    );
  });
}

/**
 * Every control on the screen whose largest hit surface is under 44px, with the
 * size it actually offers. docs/06-safety-privacy.md: "Tap targets are at least
 * 44px."
 *
 * A control can be hit in more than one place, and it passes if any one of those
 * places is big enough:
 *
 * - its own box,
 * - the box its ::before extends it by, which is how a 32px chip and a 28px
 *   switch reach 44 without being redrawn (docs/02-design-system.md fixes both
 *   heights, so the hit area is what has to move),
 * - the box of any label that points at it, which is how the visually hidden
 *   consent checkboxes and the file inputs are tapped.
 */
function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const MINIMUM = 44;
    /** Sub pixel layout, so a control 43.98 wide is not a finding. */
    const TOLERANCE = 0.5;

    function px(value: string): number | null {
      const amount = Number.parseFloat(value);
      return Number.isNaN(amount) ? null : amount;
    }

    /** The element's own box, grown by an absolutely positioned ::before. */
    function hitBox(element: Element): { width: number; height: number } {
      const rect = element.getBoundingClientRect();
      const before = getComputedStyle(element, "::before");
      if (before.content === "none" || before.position !== "absolute") {
        return { width: rect.width, height: rect.height };
      }

      const style = getComputedStyle(element);
      // An absolutely positioned child is placed against the padding box, so
      // the hairline has to come back out of every offset.
      const top = px(before.top);
      const bottom = px(before.bottom);
      const left = px(before.left);
      const right = px(before.right);
      const borders = {
        top: px(style.borderTopWidth) ?? 0,
        bottom: px(style.borderBottomWidth) ?? 0,
        left: px(style.borderLeftWidth) ?? 0,
        right: px(style.borderRightWidth) ?? 0,
      };

      function grow(offset: number | null, border: number): number {
        return offset === null ? 0 : Math.max(0, -offset - border);
      }

      return {
        width:
          rect.width + grow(left, borders.left) + grow(right, borders.right),
        height:
          rect.height + grow(top, borders.top) + grow(bottom, borders.bottom),
      };
    }

    function describe(element: Element): string {
      const name =
        element.getAttribute("aria-label") ??
        (element.textContent ?? "").trim().slice(0, 30);
      return `${element.tagName.toLowerCase()} "${name}"`;
    }

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'a[href], button, input, [role="switch"]',
      ),
    ).filter(
      (element) =>
        element.closest('[aria-hidden="true"]') === null &&
        !element.hasAttribute("disabled") &&
        element.getAttribute("tabindex") !== "-1",
    );

    const offenders: string[] = [];
    for (const control of controls) {
      const boxes = [hitBox(control)];
      const labels = (control as HTMLInputElement).labels;
      if (labels !== null && labels !== undefined) {
        for (const label of Array.from(labels)) {
          boxes.push(hitBox(label));
        }
      }
      const passes = boxes.some(
        (box) =>
          box.width >= MINIMUM - TOLERANCE && box.height >= MINIMUM - TOLERANCE,
      );
      if (!passes) {
        const best = boxes
          .map((box) => `${Math.round(box.width)} by ${Math.round(box.height)}`)
          .join(" or ");
        offenders.push(`${describe(control)}: ${best}`);
      }
    }
    return offenders;
  });
}

/** The motion tokens as the browser resolves them for this page. */
function motionTokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const names = [
      "--duration-reveal-bloom",
      "--duration-reveal-settle",
      "--duration-sheet",
      "--duration-crossfade",
      "--duration-toggle",
    ];
    const read: Record<string, string> = {};
    for (const name of names) {
      read[name] = style.getPropertyValue(name).trim();
    }
    return read;
  });
}

/** Every layer running a keyframe animation inside main, with its timing. */
function animatedLayers(page: Page): Promise<
  { duration: string; delay: string; fill: string; opacity: string }[]
> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("main *"))
      .map((element) => getComputedStyle(element))
      .filter((style) => style.animationName !== "none")
      .map((style) => ({
        duration: style.animationDuration,
        delay: style.animationDelay,
        fill: style.animationFillMode,
        opacity: style.opacity,
      })),
  );
}

/* ------------------------------------------------------------------ */
/* Reduced motion                                                      */
/* ------------------------------------------------------------------ */

test.describe("reduced motion", () => {
  /*
   * Emulated per page rather than through test.use, because the option is
   * declared on Page.emulateMedia in this version of Playwright rather than as
   * a test level fixture. Both set the same media feature.
   */
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  /**
   * docs/02-design-system.md, Motion: "prefers-reduced-motion: the reveal shows
   * masks without animation and all durations drop to 0. Status text still
   * updates."
   *
   * So the mask layer is on the screen, it is already at its settled opacity on
   * the first frame, and the status line has moved on to the second step. The
   * two together are the whole rule: nothing moved, and nothing was lost.
   */
  test("shows the reveal settled, with the status line still moving", async ({
    page,
  }) => {
    await stubAnalyzingJobs(page);
    await page.goto("/analyzing?capture=a11y-reduced-motion");

    // The skin job came back and the tone reading has not, so the sequence has
    // advanced without a single frame of animation.
    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();

    expect(await motionTokens(page)).toEqual({
      "--duration-reveal-bloom": "0ms",
      "--duration-reveal-settle": "0ms",
      "--duration-sheet": "0ms",
      "--duration-crossfade": "0ms",
      "--duration-toggle": "0ms",
    });

    // The mask is drawn. One layer, both of its keyframes at zero, and the fill
    // has already put it at the settled opacity rather than at full.
    const layers = await animatedLayers(page);
    expect(layers).toHaveLength(1);
    const reveal = layers[0];
    expect(reveal?.duration).toBe("0s, 0s");
    expect(reveal?.delay).toBe("0s, 0s");
    expect(reveal?.fill).toBe("forwards, forwards");
    const settled = Number.parseFloat(reveal?.opacity ?? "1");
    expect(settled).toBeGreaterThan(0);
    expect(settled).toBeLessThan(1);
  });

  /**
   * The preview of that same reveal on the landing screen
   * (docs/01-user-flow.md section A, docs/09-build-order-and-demo.md Layer 6).
   * It holds either way: with the consented fixture face in the repository the
   * preview's keyframes read the same two tokens and compute to zero, and
   * without it the hero is the static Basalt frame that has held the space since
   * Layer 0. Nothing on the first screen of the app moves for a person who asked
   * for less motion.
   */
  test("leaves nothing moving on the landing hero", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: copy.landing.headline, level: 1 }),
    ).toBeVisible();

    expect(await movingElements(page)).toEqual([]);
  });

  /**
   * The other half of the rule, on the screens that carry the tap answered
   * motion: the sheet and the toggle. Both read their duration from a token, so
   * both have to compute to zero here, and so does everything else on screen.
   */
  test("leaves nothing moving on the consent screen", async ({ page }) => {
    await page.goto("/welcome");

    expect(await movingElements(page)).toEqual([]);

    await openSheet(
      page,
      page.getByRole("button", { name: copy.welcome.privacyLink }),
    );

    expect(await movingElements(page)).toEqual([]);
  });
});

/**
 * The control for the tests above. Without the media query the same screens
 * carry the documented durations, so the zeros above are the reduced motion
 * rule doing its work and not a token that was never set.
 */
test.describe("motion, with no preference set", () => {
  test("keeps the documented durations", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await stubAnalyzingJobs(page);
    await page.goto("/analyzing?capture=a11y-motion");
    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();

    expect(await motionTokens(page)).toEqual({
      // docs/02-design-system.md, Motion: masks bloom over 600ms and settle
      // over 300ms; sheets 280ms, hero crossfade 240ms, toggles 180ms.
      "--duration-reveal-bloom": "600ms",
      "--duration-reveal-settle": "300ms",
      "--duration-sheet": "280ms",
      "--duration-crossfade": "240ms",
      "--duration-toggle": "180ms",
    });

    const layers = await animatedLayers(page);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.duration).toBe("0.6s, 0.3s");
    expect(layers[0]?.delay).toBe("0s, 0.6s");
  });
});

/* ------------------------------------------------------------------ */
/* Keyboard                                                            */
/* ------------------------------------------------------------------ */

test.describe("keyboard", () => {
  /**
   * docs/06-safety-privacy.md: "Focus is visible everywhere as a gold hairline."
   * The ring is compared with the resolved --accent token rather than with a
   * colour written into this file, so the design system stays the only source
   * of the value.
   */
  test("puts the gold hairline on the landing action, first in the tab order", async ({
    page,
  }) => {
    await page.goto("/");

    const start = page.getByRole("link", { name: copy.landing.primaryAction });
    await expect(start).toBeVisible();

    // docs/01-user-flow.md section A: the primary action is the point of this
    // screen, so it is the first thing a keyboard reaches.
    expect(await tabTo(page, start)).toBe(1);

    const ring = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();

      const active = document.activeElement;
      if (active === null) {
        return null;
      }
      const style = getComputedStyle(active);
      return {
        accent,
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
      };
    });

    expect(ring).not.toBeNull();
    // A hairline, not a glow: 1px, solid, antique gold.
    expect(ring?.style).toBe("solid");
    expect(ring?.width).toBe("1px");
    expect(ring?.color).toBe(ring?.accent);
  });

  /**
   * The consent gate, docs/06-safety-privacy.md: no capture before both boxes
   * are checked. Walked here entirely from the keyboard, because a person who
   * cannot use a pointer has to be able to give consent and then leave.
   */
  test("checks both consent boxes and reaches the primary action", async ({
    page,
  }) => {
    await page.goto("/welcome");

    const age = page.getByRole("checkbox", { name: copy.welcome.checkboxAge });
    const processing = page.getByRole("checkbox", {
      name: copy.welcome.checkboxProcessing,
    });
    const keepOriginals = page.getByRole("switch", {
      name: copy.welcome.keepOriginalToggle,
    });
    const continueAction = page.getByRole("button", {
      name: copy.welcome.continueAction,
    });

    await expect(continueAction).toBeDisabled();

    /*
     * The back control from the screen skeleton is the first thing in the
     * document (docs/02-design-system.md, "Layout": back, title, then the
     * screen), so it is the first thing a keyboard reaches. It is a link with no
     * visible label, which the design system allows for this control and the
     * shutter alone, so it is reached by its accessible name.
     */
    expect(
      await tabTo(page, page.getByRole("link", { name: copy.nav.back })),
    ).toBe(1);

    expect(await tabTo(page, age)).toBe(1);
    await page.keyboard.press("Space");
    await expect(age).toBeChecked();

    expect(await tabTo(page, processing)).toBe(1);
    await page.keyboard.press("Space");
    await expect(processing).toBeChecked();

    // The optional retention toggle sits between the boxes and the button, and
    // it is reachable rather than skipped: it is a choice, not decoration.
    expect(await tabTo(page, keepOriginals)).toBe(1);
    await expect(keepOriginals).not.toBeChecked();

    // Enabled by the two boxes above, so it is now in the tab order.
    await expect(continueAction).toBeEnabled();
    expect(await tabTo(page, continueAction)).toBe(1);
  });

  /**
   * docs/06-safety-privacy.md: "The capture screen works with an uploaded photo
   * for people who cannot use the camera." There is no camera in this browser,
   * so the screen is in its camera unavailable state, and the upload has to be
   * reachable from the keyboard with the focus ring on the control a person
   * actually sees (the input carries the semantics, the label carries the look).
   */
  test("reaches the upload path on capture with the focus ring visible", async ({
    page,
  }) => {
    await page.goto("/capture");

    const upload = page.locator('input[type="file"]');
    await expect(upload).toHaveCount(1);
    await tabTo(page, upload);

    const ring = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();

      const input = document.querySelector('input[type="file"]');
      const label = input?.parentElement?.querySelector("label") ?? null;
      if (label === null) {
        return null;
      }
      const style = getComputedStyle(label);
      return { accent, width: style.outlineWidth, color: style.outlineColor };
    });

    expect(ring?.width).toBe("1px");
    expect(ring?.color).toBe(ring?.accent);
  });

  test.describe("profile", () => {
    test.skip(
      externalServer,
      "Needs the fixture mode server playwright.config.ts starts.",
    );

    /**
     * docs/01-user-flow.md section L. The data controls are the ones that must
     * never need a pointer: they are how a person changes what is kept and how
     * they take their data back.
     */
    test("reaches the data controls in the order the screen shows them", async ({
      page,
    }) => {
      await page.goto("/profile");

      const keepOriginals = page.getByRole("switch", {
        name: copy.profile.keepOriginalsToggle,
      });
      const download = page.getByRole("link", {
        name: copy.profile.downloadAction,
      });
      await expect(keepOriginals).toBeVisible();

      // Reached from the top of the screen, past the profile link and the row
      // affordances, without a single unreachable control in between.
      await tabTo(page, keepOriginals);
      // The next control is the one the screen draws next.
      expect(await tabTo(page, download)).toBe(1);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Sheets                                                              */
/* ------------------------------------------------------------------ */

test.describe("sheets", () => {
  /**
   * The sheet is the one surface that covers the screen it opened over, so it
   * owns focus while it is up (docs/06-safety-privacy.md, "Accessibility as
   * safety"). Every sheet in the app is src/components/ui/Sheet.tsx, so what is
   * proven on one is true of all of them: the privacy sheet on /welcome, the
   * undertone adjuster on /color, the chip picker on /wardrobe, and the typed
   * delete confirmation on /profile.
   *
   * The delete sheet itself cannot be opened in fixture mode, and that is the
   * documented behaviour rather than a gap: fixture mode serves the demo
   * profile, and docs/01-user-flow.md "Judge mode across the flow" says "Judge
   * sessions never see the Delete everything control on the demo profile". The
   * absence of the control is asserted in e2e/smoke.spec.ts; the sheet it opens
   * is proven here through the two sheets this mode can open.
   */
  test("keeps focus inside the privacy sheet and gives it back on Escape", async ({
    page,
  }) => {
    await page.goto("/welcome");

    const opener = page.getByRole("button", { name: copy.welcome.privacyLink });
    const sheet = await openSheet(page, opener);
    expect(await focusIsInsideDialog(page)).toBe(true);

    // The sheet's own controls carry the same 44px rule as the screen's.
    expect(await smallTapTargets(page)).toEqual([]);

    // Tab cannot walk out onto the screen behind the scrim, forwards or back.
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press("Tab");
      expect(await focusIsInsideDialog(page)).toBe(true);
    }
    for (let press = 0; press < 4; press += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusIsInsideDialog(page)).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    // Back on the control that opened it, not at the top of the document.
    await expect(opener).toBeFocused();
  });

  test.describe("garment picker", () => {
    test.skip(
      externalServer,
      "Needs the fixture mode server playwright.config.ts starts.",
    );

    /**
     * The same contract on a sheet with several controls in it, which is the
     * shape the delete confirmation has: something to operate, then the close.
     */
    test("traps focus across a sheet full of chips and returns it", async ({
      page,
    }) => {
      await page.goto("/wardrobe");

      const opener = page.locator('button[aria-haspopup="dialog"]').first();
      const sheet = await openSheet(page, opener);
      expect(await focusIsInsideDialog(page)).toBe(true);

      expect(await smallTapTargets(page)).toEqual([]);

      // More stops than the sheet holds, so the trap has to wrap at least once.
      const stops = await sheet.getByRole("button").count();
      expect(stops).toBeGreaterThan(1);
      for (let press = 0; press <= stops; press += 1) {
        await page.keyboard.press("Tab");
        expect(await focusIsInsideDialog(page)).toBe(true);
      }

      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(opener).toBeFocused();
    });
  });
});

/* ------------------------------------------------------------------ */
/* Layout at 390px                                                     */
/* ------------------------------------------------------------------ */

test.describe("layout at 390px", () => {
  /**
   * docs/02-design-system.md, anti slop item 11, and the mobile first layout
   * rule: the column is 390px with 20px of padding, and nothing on any screen
   * pushes the page sideways. Rows that hold more than fits (the mask toggles,
   * the type filter, the hair styles) scroll inside themselves; the page does
   * not scroll with them.
   */
  /**
   * And docs/06-safety-privacy.md: "Tap targets are at least 44px." The design
   * system draws a 32px chip and a 28px switch, and it wins on what is drawn, so
   * the hit area is what moves. Measured from the rendered boxes rather than
   * from class names, because the pseudo element that does the moving has no
   * node of its own to read.
   *
   * Both questions are asked of one rendered screen rather than of two, so the
   * suite opens each screen once. The dev server compiles on demand, and every
   * extra navigation is a screen it has to build again.
   */
  for (const path of PUBLIC_SCREENS) {
    test(`${path} composes at 390px`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();

      expect(await horizontalOverflow(page)).toBe(0);
      expect(await smallTapTargets(page)).toEqual([]);
    });
  }

  test("/analyzing does not scroll sideways", async ({ page }) => {
    await stubAnalyzingJobs(page);
    await page.goto("/analyzing?capture=a11y-layout");
    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test.describe("the screens the profile serves", () => {
    test.skip(
      externalServer,
      "Needs the fixture mode server playwright.config.ts starts.",
    );

    for (const path of FIXTURE_SCREENS) {
      test(`${path} composes at 390px`, async ({ page }) => {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();

        expect(await horizontalOverflow(page)).toBe(0);
        expect(await smallTapTargets(page)).toEqual([]);
      });
    }
  });
});
