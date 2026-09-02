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

test.describe("judge stats", () => {
  /**
   * docs/07-payments-and-judge-mode.md: "A tiny /api/judge/stats route
   * (protected by the same code) shows sessions created, analyses used, credits
   * used." The numbers themselves need a Supabase project and a judge code, so
   * what a clean clone can prove is the half that matters most: they are not
   * public. Without the code the route refuses before it counts anything.
   */
  test("does not hand the numbers to a request with no code", async ({
    request,
  }) => {
    const response = await request.get("/api/judge/stats");
    expect(response.status()).toBe(401);

    const body = await response.text();
    for (const field of ["sessionsCreated", "analysesUsed", "creditsUsed"]) {
      expect(body).not.toContain(field);
    }
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

/* ------------------------------------------------------------------ */
/* J. Wardrobe                                                         */
/* ------------------------------------------------------------------ */

test.describe("wardrobe", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section J items 2 and 3: each photo becomes a card with
   * the classification chips filled in ("type ('Shirt'), color ('Navy'), pattern
   * ('Solid'), formality ('Smart')"), one line saying the chips are tappable, and
   * a grid "filterable by type".
   *
   * The demo profile owns the six garments docs/07-payments-and-judge-mode.md
   * names, so six cards is the fixture's own number rather than a range from the
   * doc. Which chips each card carries is the fixture's business
   * (src/lib/server/profile/demo-fixture-wardrobe.ts); what this asserts is that
   * every card arrived in the chips state rather than the pending or failed one,
   * which is what proves the wardrobe route, the view contract, and the card all
   * line up.
   */
  test("shows the six garment cards with their chips and the type filter", async ({
    page,
  }) => {
    await page.goto("/wardrobe");

    await expect(
      page.getByRole("heading", { name: copy.nav.wardrobe, level: 1 }),
    ).toBeVisible();

    const cards = page.getByRole("listitem");
    await expect(cards).toHaveCount(6);

    // One chip row per card, each opening the correction sheet. A card in the
    // pending or failed state would not have one, so the count is the assertion
    // that all six classifications are present.
    const chipRows = page.locator('button[aria-haspopup="dialog"]');
    await expect(chipRows).toHaveCount(6);

    // Section J item 2, the line that says the chips can be corrected.
    await expect(page.getByText(copy.wardrobe.correctChipsHint)).toBeVisible();

    // The navy blazer, chip by chip, as the doc writes them.
    const blazer = chipRows.first();
    for (const label of ["Blazer", "Navy", "Solid", "Formal"]) {
      await expect(blazer.getByText(label, { exact: true })).toBeVisible();
    }

    // Every card drew its garment image.
    await expect(page.locator("ul img")).toHaveCount(6);

    // Item 3, the filter: "All" plus one chip per type the wardrobe holds, and
    // the six fixture garments are six different types.
    const filters = page.getByRole("group", {
      name: copy.wardrobe.filterLabel,
    });
    await expect(filters).toBeVisible();
    await expect(filters.getByRole("button")).toHaveCount(7);
    await expect(
      filters.getByRole("button", { name: copy.wardrobe.filterAll }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * The filter does something. One type is picked and the grid narrows to the
   * garments of that type, which is the whole of what section J item 3 asks for.
   */
  test("narrows the grid to one type and back", async ({ page }) => {
    await page.goto("/wardrobe");

    const filters = page.getByRole("group", {
      name: copy.wardrobe.filterLabel,
    });
    const shoes = filters.getByRole("button", { name: "Shoes" });
    await shoes.click();

    await expect(shoes).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("listitem")).toHaveCount(1);

    await filters.getByRole("button", { name: copy.wardrobe.filterAll }).click();
    await expect(page.getByRole("listitem")).toHaveCount(6);
  });
});

/* ------------------------------------------------------------------ */
/* K. Looks                                                            */
/* ------------------------------------------------------------------ */

test.describe("looks", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section K items 1 to 3: the occasion chips, "two to
   * three looks, each a card with a flat lay of the garments", "a two line
   * rationale", and "Shop the gap" for a piece the person does not own.
   *
   * The count is asserted as the doc's range rather than as the fixture's three,
   * for the same reason the palette and hair counts are: the range is the rule
   * and the fixture is one point in it. Which combinations the rules engine
   * lands on is src/lib/shared/looks.test.ts and evals/stylist's job.
   */
  test("composes wedding guest looks with rationales and a flat lay", async ({
    page,
  }) => {
    await page.goto("/looks");

    await expect(
      page.getByRole("heading", { name: copy.nav.looks, level: 1 }),
    ).toBeVisible();

    // Item 1. Six chips, and the screen opens on the default occasion.
    const occasions = page.getByRole("group", {
      name: copy.looks.occasionsLabel,
    });
    await expect(occasions.getByRole("button")).toHaveCount(6);
    await expect(
      occasions.getByRole("button", { name: copy.looks.occasionEveryday }),
    ).toHaveAttribute("aria-pressed", "true");

    const weddingGuest = occasions.getByRole("button", {
      name: copy.looks.occasionWeddingGuest,
    });
    await weddingGuest.click();
    await expect(weddingGuest).toHaveAttribute("aria-pressed", "true");

    // Item 2. Each look is an article named by its own rationale.
    const looks = page.getByRole("article");
    await expect(looks.first()).toBeVisible();
    const lookCount = await looks.count();
    expect(lookCount).toBeGreaterThanOrEqual(2);
    expect(lookCount).toBeLessThanOrEqual(3);

    const top = looks.first();

    /*
     * "A two line rationale ... Never a numeric score." Two sentences, and the
     * occasion named in the second one. The rules engine wrote this rationale,
     * because there is no ANTHROPIC_API_KEY for the stylist to rank with, and it
     * still has to name the occasion and the coloring
     * (docs/09-build-order-and-demo.md Layer 4 definition of done).
     */
    /*
     * The rationale is what names the card for a screen reader, so the article
     * points at it by id. Reaching it that way rather than by position keeps the
     * assertion off the hero status line, which sits above it whenever a try on
     * was attempted.
     */
    const rationaleId = await top.getAttribute("aria-labelledby");
    expect(rationaleId).not.toBeNull();
    const text = (
      await page.locator(`#${String(rationaleId)}`).innerText()
    ).trim();
    expect(text.split(/(?<=\.)\s+/u).filter(Boolean)).toHaveLength(2);
    expect(text).toContain("palette");
    expect(text).toContain(copy.looks.rationale.phraseWeddingGuest);

    // The flat lay of the garments the person owns, one tile per piece.
    const tiles = top.locator("ul img");
    expect(await tiles.count()).toBeGreaterThanOrEqual(2);

    await expect(
      top.getByRole("button", { name: copy.looks.saveLookAction }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: copy.nav.wardrobe }),
    ).toHaveAttribute("href", "/wardrobe");
  });

  /**
   * Item 3, and the grounding rule under it. The demo wardrobe's only shoes are
   * casual loafers, which a wedding guest look cannot use, so every look for
   * that occasion reports a shoes gap.
   *
   * What the card under that line is allowed to show is fixed by
   * docs/06-safety-privacy.md, "Grounding and honesty": a product only ever
   * appears with a real listing that came back with a source URL, and a gap with
   * nothing behind it says "No listing found near you yet" instead. The demo
   * profile carries a recorded Google Shopping response for this query
   * (src/lib/server/profile/recorded-listings), so the grounded branch is the
   * one that renders here. This asserts the rule rather than one of its two
   * outcomes: every listing carries a link out and the not sponsored line, and
   * nothing is shown that has neither a link nor the absence line.
   */
  test("shows the shoes gap grounded in a real listing, or not at all", async ({
    page,
  }) => {
    await page.goto("/looks?occasion=wedding_guest");

    const occasions = page.getByRole("group", {
      name: copy.looks.occasionsLabel,
    });
    await occasions
      .getByRole("button", { name: copy.looks.occasionWeddingGuest })
      .click();

    const top = page.getByRole("article").first();
    await expect(
      top.getByRole("heading", { name: copy.looks.shopTheGapHeading }),
    ).toBeVisible();

    // The gap line names the piece.
    await expect(top.getByText(/You do not own shoes yet\./u)).toBeVisible();

    const listings = top.getByRole("link", {
      name: copy.productCard.viewListing,
    });
    const listingCount = await listings.count();

    if (listingCount === 0) {
      await expect(
        top.getByText(copy.productCard.noListing).first(),
      ).toBeVisible();
      return;
    }

    // Every listing shown points at a real source and says where it came from.
    for (let index = 0; index < listingCount; index += 1) {
      await expect(listings.nth(index)).toHaveAttribute(
        "href",
        /^https:\/\//u,
      );
    }
    await expect(top.getByText(copy.productCard.notSponsored)).toHaveCount(
      listingCount,
    );
  });

  /**
   * Section K item 4. The demo profile is read only, so the save is refused with
   * a 403 and the screen says so rather than showing the confirmation toast for
   * a write that never landed. Same shape as the hair save above.
   */
  test("answers the save with the read only line, not a confirmation", async ({
    page,
  }) => {
    await page.goto("/looks");

    const top = page.getByRole("article").first();
    await expect(top).toBeVisible();
    await top.getByRole("button", { name: copy.looks.saveLookAction }).click();

    const toast = page.getByRole("status");
    await expect(toast).toHaveText(copy.looks.saveReadOnly);
    await expect(page.getByText(copy.looks.savedToast)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* L. Profile                                                          */
/* ------------------------------------------------------------------ */

test.describe("profile", () => {
  test.skip(
    externalServer,
    "Needs the fixture mode server playwright.config.ts starts.",
  );

  /**
   * docs/01-user-flow.md section L items 1 and 2: the summary rows with their
   * "Retake" and "Adjust" affordances, and what the person has saved.
   *
   * The six row labels are asserted by name and in order, because the order is
   * the doc's own and the contract in src/lib/shared/profile-view.ts fixes it.
   * The values are the fixture's business (evals/safety/data-controls.test.ts
   * checks them against the same checked in constants the report and /color are
   * built from); what this proves is that the route, the contract, and the
   * screen agree end to end.
   *
   * The hair type row carries no value on any profile this build writes, because
   * hair type detection needs three photos and is skipped in the one selfie fan
   * out. It shows the honest line rather than a dash, which is the one row that
   * proves the missing value state renders.
   */
  test("shows the six summary rows with their affordances", async ({ page }) => {
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: copy.nav.profile, level: 1 }),
    ).toBeVisible();

    const rows = page.locator("main ul").first().locator("li");
    await expect(rows).toHaveCount(6);

    for (const [index, label] of [
      copy.profile.rowSkinType,
      copy.profile.rowTopConcern,
      copy.profile.rowToneAndUndertone,
      copy.profile.rowSeason,
      copy.profile.rowFaceShape,
      copy.profile.rowHairType,
    ].entries()) {
      await expect(rows.nth(index).getByText(label, { exact: true })).toBeVisible();
    }

    // Item 1, the affordances: a retake on the five rows a photo decides, and
    // the adjuster on the undertone. The season row has neither, because a
    // season is derived rather than chosen.
    await expect(
      page.getByRole("link", { name: copy.profile.retakeAffordance }),
    ).toHaveCount(4);
    const adjust = page.getByRole("link", {
      name: copy.profile.adjustAffordance,
    });
    await expect(adjust).toHaveCount(1);
    await expect(adjust).toHaveAttribute("href", /\/color\?/u);

    // The one row with no reading behind it says so rather than showing a dash.
    await expect(page.getByText(copy.profile.valueUnavailable)).toBeVisible();
  });

  /**
   * Item 2. The demo profile has two saved looks
   * (docs/07-payments-and-judge-mode.md), so the section is present and not
   * empty, and it never claims a saved makeup look, because no column stores one.
   */
  test("lists what the demo profile has saved", async ({ page }) => {
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: copy.profile.savedHeading, level: 2 }),
    ).toBeVisible();
    await expect(page.getByText(copy.profile.savedEmpty)).toHaveCount(0);

    const saved = page
      .locator("section", {
        has: page.getByRole("heading", { name: copy.profile.savedHeading }),
      })
      .locator("li");
    await expect(saved).toHaveCount(2);
    await expect(
      saved.getByText(copy.looks.occasionWeddingGuest, { exact: true }),
    ).toBeVisible();
  });

  /**
   * Item 3, the data controls, and the two rules that govern them on the demo
   * profile.
   *
   * The download link is rendered where docs/01 section L item 3 puts it, and
   * tapping it on the demo profile says why rather than saving a file: the
   * server refuses the route with 403 (docs/06-safety-privacy.md, "Keys,
   * sessions, abuse": "Judge sessions cannot delete the demo profile and cannot
   * download data"), and following the link would hand the person a file holding
   * that refusal where their data should be.
   *
   * The delete control is absent, not merely disabled: docs/01-user-flow.md
   * "Judge mode across the flow" says "Judge sessions never see the Delete
   * everything control on the demo profile", and fixture mode is that session.
   */
  test("shows the data controls without the delete control", async ({
    page,
  }) => {
    await page.goto("/profile");

    await expect(
      page.getByRole("heading", { name: copy.profile.dataHeading, level: 2 }),
    ).toBeVisible();

    const keepOriginals = page.getByRole("switch", {
      name: copy.profile.keepOriginalsToggle,
    });
    await expect(keepOriginals).toBeVisible();
    await expect(keepOriginals).not.toBeChecked();

    const download = page.getByRole("link", {
      name: copy.profile.downloadAction,
    });
    await expect(download).toHaveAttribute("href", "/api/profile/download");
    await download.click();
    await expect(page.getByRole("status")).toHaveText(
      copy.profile.downloadReadOnly,
    );
    // The tap was answered on the screen, so the browser never left it.
    await expect(page).toHaveURL(/\/profile$/u);

    await expect(
      page.getByRole("button", { name: copy.profile.deleteAction }),
    ).toHaveCount(0);
  });

  /**
   * The toggle answers with the read only line rather than moving, which is the
   * same refusal the hair and looks saves get. The demo profile has no database
   * behind it, so a toggle that moved would be showing a retention setting
   * nothing stored.
   */
  test("answers the retention toggle with the read only line", async ({
    page,
  }) => {
    await page.goto("/profile");

    const keepOriginals = page.getByRole("switch", {
      name: copy.profile.keepOriginalsToggle,
    });
    await keepOriginals.click();

    const toast = page.getByRole("status");
    await expect(toast).toHaveText(copy.profile.readOnly);
    await expect(keepOriginals).not.toBeChecked();
  });

  /**
   * The two writes and the download, refused at the route rather than only in
   * the screen. A hidden control is not a permission check, so each one is asked
   * for directly and each one answers 403.
   */
  test("refuses the download, the toggle, and the delete at the route", async ({
    request,
  }) => {
    for (const response of [
      await request.get("/api/profile/download"),
      await request.patch("/api/profile", { data: { keepOriginals: true } }),
      await request.post("/api/profile/delete", {
        data: { confirmation: copy.profile.deleteConfirmWord },
      }),
    ]) {
      expect(response.status()).toBe(403);
    }
  });
});
