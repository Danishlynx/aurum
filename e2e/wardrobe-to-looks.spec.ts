import { expect, test, type Page } from "@playwright/test";

import { copy } from "../src/lib/shared/copy";
import { DEFAULT_OCCASION, type LooksView } from "../src/lib/shared/looks-view";

/**
 * The path from a person's own clothes to what to wear in them.
 *
 * docs/01-user-flow.md "Screen map" routes /wardrobe from /looks and writes no
 * route back, and section K's "No wardrobe" line asks a person to add their own
 * garments without giving them anything to tap. On the live app that meant a
 * judge landed on /looks, saw an outfit built from listings, and never found the
 * feature: photograph your wardrobe, ask what to wear out of it.
 *
 * So both halves of the loop are asserted here, in the words copy.ts holds:
 *
 * 1. Empty wardrobe on /looks: the sentence, and a gold "Add your clothes" that
 *    goes to /wardrobe.
 * 2. A wardrobe with garments in it on /wardrobe: a gold "Suggest what to wear"
 *    that goes to /looks.
 * 3. /looks with a wardrobe: the flat lay is the person's own garment photos,
 *    and the invitation is not on the screen.
 *
 * The wardrobe side runs on the fixture server (playwright.config.ts starts it
 * with AURUM_DEMO_FIXTURE=true), which serves the checked in six garment
 * wardrobe and touches neither the database nor a provider. The empty state is
 * the one thing fixture mode cannot show, because the fixture profile has
 * clothes, so that view is routed in.
 */

/**
 * With PLAYWRIGHT_BASE_URL set, the server was started by someone else and this
 * file cannot know whether fixture mode is on. Same rule as e2e/smoke.spec.ts.
 */
const externalServer = Boolean(process.env.PLAYWRIGHT_BASE_URL);

/** A looks view with nothing of the person's in it, as the route would answer. */
const EMPTY_WARDROBE_VIEW: LooksView = {
  occasion: DEFAULT_OCCASION,
  wardrobeEmpty: true,
  looks: [
    {
      id: "e2e-listings",
      occasion: DEFAULT_OCCASION,
      rationale:
        "Nothing here is yours yet, so this is what the palette suggests.",
      rationaleSource: "rules",
      items: [
        {
          source: "listing",
          type: "shirt",
          listing: {
            title: "Cotton shirt",
            priceText: "1,900",
            priceValue: 1900,
            currency: "INR",
            url: "https://store.e2e.invalid/shirt",
            imageUrl: null,
            store: "A store",
            distanceText: null,
          },
        },
      ],
      heroGarmentId: null,
      renderUrl: null,
      renderStatus: "none",
      gaps: [],
    },
  ],
};

async function stubLooks(page: Page, view: LooksView): Promise<void> {
  await page.route("**/api/looks**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(view),
    }),
  );
}

test.describe("the way into the wardrobe", () => {
  test.skip(
    externalServer,
    "Needs the fixture server this config starts, which renders /looks with no session.",
  );

  test("invites a person with no clothes in, and says where to", async ({
    page,
  }) => {
    await stubLooks(page, EMPTY_WARDROBE_VIEW);
    await page.goto("/looks");

    // docs/01 section K, "No wardrobe", verbatim.
    await expect(page.getByText(copy.looks.noWardrobe)).toBeVisible();

    const invitation = page.getByRole("link", {
      name: copy.looks.addYourClothesAction,
    });
    await expect(invitation).toBeVisible();
    await expect(invitation).toHaveAttribute("href", "/wardrobe");

    /*
     * docs/02-design-system.md, Button: "One per screen". With nothing of the
     * person's on the screen, the invitation is that one, and the leading look's
     * save steps down: saving an outfit of listings is not the thing to do next.
     */
    const goldFills = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return Array.from(document.querySelectorAll("main a, main button")).filter(
        (element) => getComputedStyle(element).backgroundColor === accent,
      ).length;
    });
    expect(goldFills).toBe(1);
  });
});

test.describe("the way out of the wardrobe", () => {
  test.skip(
    externalServer,
    "Needs the fixture server this config starts, which serves a wardrobe.",
  );

  test("offers what the clothes are for, and lands on the chips", async ({
    page,
  }) => {
    await page.goto("/wardrobe");

    const suggest = page.getByRole("link", {
      name: copy.wardrobe.suggestAction,
    });
    await expect(suggest).toBeVisible();
    await expect(suggest).toHaveAttribute("href", "/looks");

    await suggest.click();
    await page.waitForURL("**/looks");

    // The occasion chooser, docs/01 section K item 1.
    await expect(
      page.getByRole("group", { name: copy.looks.occasionsLabel }),
    ).toBeVisible();
  });

  test("composes the flat lay from the person's own garment photos", async ({
    page,
  }) => {
    await page.goto("/looks");

    /*
     * The person's own pieces, not listings: the flat lay draws one tile per
     * garment from the photo they uploaded. In fixture mode those are the
     * checked in silhouettes, served same origin from /api/wardrobe/images or
     * from the fixture path, which is what makes them assertable at all: a live
     * wardrobe photo is a signed URL that expires.
     */
    const tiles = page.locator("main ul li img");
    /*
     * The looks are fetched by the screen, so the first visit of a run is what
     * compiles GET /api/looks on a development server. That is slower than an
     * assertion timeout and is not slow in the product, so this one wait is
     * given the navigation budget.
     */
    await expect(tiles.first()).toBeVisible({ timeout: 60_000 });
    expect(await tiles.count()).toBeGreaterThan(0);

    // And the invitation belongs to the other state.
    await expect(page.getByText(copy.looks.noWardrobe)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: copy.looks.addYourClothesAction }),
    ).toHaveCount(0);
  });
});
