import { expect, test } from "@playwright/test";

import { copy } from "../src/lib/shared/copy";

/**
 * The Layer 0 and Layer 2 end to end flows, docs/09-build-order-and-demo.md.
 *
 * Everything here runs against a server with no Supabase project, no provider
 * keys, and no judge code, because that is the state of a clean clone. The
 * assertions are limited to what is true without a backend: the screens render,
 * the consent gate holds, and the health route answers.
 *
 * The Layer 2 screens are reached through fixture mode. playwright.config.ts
 * starts the server with AURUM_DEMO_FIXTURE=true, so /color and /makeup build
 * from the checked in profile and touch neither the database nor a provider.
 * What they assert is the structure docs/01-user-flow.md sections G and H set
 * out, plus the two honest absences that fixture carries: no listing, because
 * nothing was fetched from SerpApi, and no try on, because no face is checked in
 * and no render can be faked.
 *
 * The capture flow with a fixture image and the report screen need a Supabase
 * project and a consented session, so they land with Layer 1. They are listed in
 * README.md under the setup a human has to finish.
 *
 * Every expected string is imported from copy.ts rather than retyped, so a copy
 * change cannot leave a test asserting words the app no longer says.
 */

/**
 * With PLAYWRIGHT_BASE_URL set, the server was started by someone else and this
 * file cannot know whether fixture mode is on. Skipping is the honest answer;
 * guessing at the mode and asserting anyway is not.
 */
const externalServer = Boolean(process.env.PLAYWRIGHT_BASE_URL);

test.describe("landing", () => {
  test("shows the headline and routes to consent", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: copy.landing.headline, level: 1 }),
    ).toBeVisible();

    const start = page.getByRole("link", { name: copy.landing.primaryAction });
    await expect(start).toHaveAttribute("href", "/welcome");

    await start.click();
    await page.waitForURL("**/welcome");
    await expect(
      page.getByRole("heading", { name: copy.welcome.title, level: 1 }),
    ).toBeVisible();
  });

  test("offers the judge entry point", async ({ page }) => {
    await page.goto("/");

    const judgeLink = page.getByRole("link", {
      name: copy.landing.judgeFooter,
    });
    await expect(judgeLink).toHaveAttribute("href", "/judge");

    await judgeLink.click();
    await page.waitForURL("**/judge");
    await expect(
      page.getByRole("textbox", { name: copy.judge.fieldPlaceholder }),
    ).toBeVisible();
    // Nothing typed yet, so there is nothing to submit.
    await expect(
      page.getByRole("button", { name: copy.judge.submitAction }),
    ).toBeDisabled();
  });
});

test.describe("consent", () => {
  /**
   * docs/06-safety-privacy.md: no capture and no upload before both boxes are
   * checked. The disabled button is the whole message, so this asserts the gate
   * and the absence of any warning text around it.
   */
  test("holds the gate until both boxes are checked", async ({ page }) => {
    await page.goto("/welcome");

    const continueButton = page.getByRole("button", {
      name: copy.welcome.continueAction,
    });
    const age = page.getByRole("checkbox", { name: copy.welcome.checkboxAge });
    const processing = page.getByRole("checkbox", {
      name: copy.welcome.checkboxProcessing,
    });

    await expect(continueButton).toBeDisabled();

    // The input carries the semantics but is visually hidden behind the drawn
    // box, so these click the label, which is what a person taps.
    await page.getByText(copy.welcome.checkboxAge).click();
    await expect(age).toBeChecked();
    await expect(continueButton).toBeDisabled();

    await page.getByText(copy.welcome.checkboxProcessing).click();
    await expect(processing).toBeChecked();
    await expect(continueButton).toBeEnabled();

    // Keeping the original photo is opt in, and off until someone turns it on.
    await expect(
      page.getByRole("switch", { name: copy.welcome.keepOriginalToggle }),
    ).not.toBeChecked();
  });

  test("explains the data handling without leaving the screen", async ({
    page,
  }) => {
    await page.goto("/welcome");

    await page.getByRole("button", { name: copy.welcome.privacyLink }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    for (const point of copy.privacy.points) {
      await expect(sheet.getByText(point, { exact: true })).toBeVisible();
    }
  });
});

test.describe("health", () => {
  test("answers with no environment configured", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);

    const body: unknown = await response.json();
    expect(body).toMatchObject({ ok: true, providerCallsEnabled: true });
  });
});

/* ------------------------------------------------------------------ */
/* G. Color identity                                                   */
/* ------------------------------------------------------------------ */

test.describe("color identity", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section G, top to bottom: the tone swatch with its
   * undertone label and the "Not quite right?" link, the season line, "Colors to
   * wear" (8 to 12), "Colors to keep away from your face" (4 to 6), and "What
   * this decides".
   *
   * The counts are asserted as the ranges the doc gives rather than as the
   * fixture's ten and five, because the range is the rule and the fixture is one
   * point in it. Which colors the fixture lands on is the golden files' job
   * (evals/fixtures/profiles/goldens), not this one's.
   */
  test("shows the tone, the season, and both palette groups", async ({
    page,
  }) => {
    await page.goto("/color");

    await expect(
      page.getByRole("heading", { name: copy.nav.color, level: 1 }),
    ).toBeVisible();

    // The detected undertone of the fixture profile, with the adjuster link.
    await expect(page.getByText(copy.color.undertoneWarm)).toBeVisible();
    await expect(
      page.getByRole("button", { name: copy.color.adjusterLink }),
    ).toBeVisible();

    // The season line, in the template's own words, whatever season it names.
    const seasonLead = copy.color.seasonLineTemplate.split("{")[0] ?? "";
    await expect(
      page.getByText(new RegExp(`^${seasonLead}\\S`, "u")),
    ).toBeVisible();

    const wear = page.getByRole("heading", { name: copy.color.wearHeading });
    await expect(wear).toBeVisible();
    const wearSwatches = page
      .locator("section", { has: wear })
      .getByRole("button");
    const wearCount = await wearSwatches.count();
    expect(wearCount).toBeGreaterThanOrEqual(8);
    expect(wearCount).toBeLessThanOrEqual(12);

    const avoid = page.getByRole("heading", { name: copy.color.avoidHeading });
    await expect(avoid).toBeVisible();
    const avoidRows = page.locator("section", { has: avoid }).locator("li");
    const avoidCount = await avoidRows.count();
    expect(avoidCount).toBeGreaterThanOrEqual(4);
    expect(avoidCount).toBeLessThanOrEqual(6);

    // Section G item 6: three rows, one per screen the palette decides.
    await expect(
      page.getByRole("heading", { name: copy.color.decidesHeading }),
    ).toBeVisible();
    for (const [label, href] of [
      [copy.color.decidesMakeup, "/makeup"],
      [copy.color.decidesHair, "/hair"],
      [copy.color.decidesLooks, "/looks"],
    ] as const) {
      await expect(page.getByRole("link", { name: label })).toHaveAttribute(
        "href",
        href,
      );
    }
  });

  /**
   * docs/02-design-system.md, Swatch: "Tapping opens one line of why below the
   * row, not a tooltip." So the line is in the document, tied to the swatch by
   * aria-controls, and tapping again closes it.
   */
  test("opens one line of why under a tapped swatch", async ({ page }) => {
    await page.goto("/color");

    const wear = page.getByRole("heading", { name: copy.color.wearHeading });
    const swatch = page
      .locator("section", { has: wear })
      .getByRole("button")
      .first();

    await expect(swatch).toHaveAttribute("aria-expanded", "false");
    await swatch.click();
    await expect(swatch).toHaveAttribute("aria-expanded", "true");

    const whyId = await swatch.getAttribute("aria-controls");
    expect(whyId).not.toBeNull();
    await expect(page.locator(`#${String(whyId)}`)).toBeVisible();

    await swatch.click();
    await expect(swatch).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * Section G item 2. The sheet is the whole of what fixture mode can show of
   * the adjuster: the three choices with their one line tests, and the honest
   * answer when a choice is made. There is no database behind the fixture, so
   * POST /api/profile/undertone returns 403 and the sheet says the undertone was
   * not saved rather than redrawing a palette nothing stored. The write itself,
   * and the palette it re derives, are proven in
   * evals/palette/undertone-update.test.ts.
   */
  test("offers the three undertones and does not claim a fixture save", async ({
    page,
  }) => {
    await page.goto("/color");
    await page.getByRole("button", { name: copy.color.adjusterLink }).click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(copy.color.adjusterIntro)).toBeVisible();

    for (const [name, line] of [
      [copy.color.adjusterWarm, copy.color.adjusterWarmTest],
      [copy.color.adjusterCool, copy.color.adjusterCoolTest],
      [copy.color.adjusterNeutral, copy.color.adjusterNeutralTest],
    ] as const) {
      await expect(sheet.getByText(name, { exact: true })).toBeVisible();
      await expect(sheet.getByText(line, { exact: true })).toBeVisible();
    }

    // The accessible name of a choice is its title and its one line test
    // together, so this matches on the title rather than asking for it exactly.
    await sheet
      .getByRole("button", { name: copy.color.adjusterCoolTest })
      .click();
    await expect(sheet.getByText(copy.color.adjusterFailed)).toBeVisible();
  });
});

/* ------------------------------------------------------------------ */
/* H. Makeup                                                           */
/* ------------------------------------------------------------------ */

test.describe("makeup", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section H item 2: "'Lip', 'Blush', 'Foundation', 'Eye'.
   * Each row shows three swatches inside the palette, the middle one selected."
   */
  test("shows four shade rows of three, with the middle one selected", async ({
    page,
  }) => {
    await page.goto("/makeup");

    await expect(
      page.getByRole("heading", { name: copy.nav.makeup, level: 1 }),
    ).toBeVisible();

    for (const label of [
      copy.makeup.rowLip,
      copy.makeup.rowBlush,
      copy.makeup.rowFoundation,
      copy.makeup.rowEye,
    ]) {
      await expect(
        page.getByRole("heading", { name: label, level: 2 }),
      ).toBeVisible();

      const row = page.getByRole("group", { name: label });
      const swatches = row.getByRole("button");
      await expect(swatches).toHaveCount(3);
      await expect(swatches.nth(1)).toHaveAttribute("aria-pressed", "true");
      await expect(swatches.nth(0)).toHaveAttribute("aria-pressed", "false");
      await expect(swatches.nth(2)).toHaveAttribute("aria-pressed", "false");
    }

    await expect(
      page.getByRole("button", { name: copy.makeup.saveLookAction }),
    ).toBeVisible();
  });

  /**
   * The two absences the fixture carries, both of them the documented state
   * rather than an unfinished screen.
   *
   * No face is checked in, so there is nothing to render a look on and the hero
   * says so (section H, "Try on failed"). A render can never be faked, so there
   * is no image on the hero at all and no Before and After toggle to compare
   * with. Nothing was fetched from SerpApi, so every product card shows "No
   * listing found near you yet" instead of a product we did not find.
   */
  test("says the preview is unavailable rather than showing a stand in", async ({
    page,
  }) => {
    await page.goto("/makeup");

    await expect(
      page.getByText(copy.makeup.previewUnavailable),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: copy.makeup.after }),
    ).toHaveCount(0);

    await expect(page.getByText(copy.productCard.noListing).first()).toBeVisible();
    await expect(page.getByRole("link", { name: copy.productCard.viewListing })).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* I. Hair                                                             */
/* ------------------------------------------------------------------ */

test.describe("hair", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section I, items 1 to 3: the face shape line, "a
   * horizontal row of 3 to 4 rendered try ons", and "a row of 3 to 4 hair colors
   * inside the palette".
   *
   * The counts are asserted as the doc's ranges rather than as the fixture's
   * four and three, for the same reason the palette counts are: the range is the
   * rule. Which styles the rules table lands on for an oval face is
   * src/lib/shared/hair-rules.test.ts's job.
   */
  test("shows the face shape line, a row of styles, and a row of colors", async ({
    page,
  }) => {
    await page.goto("/hair");

    await expect(
      page.getByRole("heading", { name: copy.nav.hair, level: 1 }),
    ).toBeVisible();

    // Item 1. The sentence opens with the template from copy.ts and continues
    // with the consequence line the rules table writes for the shape, so this
    // matches the opening and asserts there is more sentence after it.
    const shapeLead = copy.hair.faceShapeLineTemplate.split("{")[0] ?? "";
    const shapeLine = page.locator("p", {
      hasText: new RegExp(`^${shapeLead}\\S`, "u"),
    });
    await expect(shapeLine).toHaveCount(1);
    await expect(shapeLine).toBeVisible();

    const styles = page
      .getByRole("group", { name: copy.hair.stylesHeading })
      .getByRole("button");
    const styleCount = await styles.count();
    expect(styleCount).toBeGreaterThanOrEqual(3);
    expect(styleCount).toBeLessThanOrEqual(4);

    const colors = page
      .getByRole("group", { name: copy.hair.colorsHeading })
      .getByRole("button");
    const colorCount = await colors.count();
    expect(colorCount).toBeGreaterThanOrEqual(3);
    expect(colorCount).toBeLessThanOrEqual(4);

    // One line of why under the row, for the style the screen opens on.
    await expect(
      page.locator("#hair-style-why"),
    ).toBeVisible();

    await expect(
      page.getByRole("button", { name: copy.hair.saveAction }),
    ).toBeVisible();
  });

  /**
   * The absence the fixture carries, which is the same one /makeup carries: no
   * face is checked in, so there is nothing to render a style on. The hero says
   * so (section I, "same pending and failed patterns as Makeup") and shows no
   * image at all, because a try on can never be faked.
   */
  test("says the preview is unavailable rather than showing a stand in", async ({
    page,
  }) => {
    await page.goto("/hair");

    await expect(
      page.getByText(copy.hair.previewUnavailableStyle),
    ).toBeVisible();

    // Tapping a color moves the hero to the color, and with no photo the line
    // moves with it. Still no image either way.
    const colors = page.getByRole("group", { name: copy.hair.colorsHeading });
    await colors.getByRole("button").first().click();
    await expect(page.getByText(copy.hair.previewUnavailableColor)).toBeVisible();
  });

  /**
   * Section I item 4. The demo profile is read only, so the save is refused with
   * a 403 and the screen says which of the two things happened rather than
   * showing the confirmation toast for a write that never landed.
   */
  test("answers the save with the read only line, not a confirmation", async ({
    page,
  }) => {
    await page.goto("/hair");

    await page.getByRole("button", { name: copy.hair.saveAction }).click();

    const toast = page.getByRole("status");
    await expect(toast).toHaveText(copy.hair.saveReadOnly);
    await expect(page.getByText(copy.hair.savedToast)).toHaveCount(0);
  });
});
