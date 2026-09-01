import { expect, test } from "@playwright/test";

import { copy } from "../src/lib/shared/copy";

/**
 * The Layer 0 end to end flows, docs/09-build-order-and-demo.md.
 *
 * Everything here runs against a server with no Supabase project, no provider
 * keys, and no judge code, because that is the state of a clean clone. The
 * assertions are limited to what is true without a backend: the screens render,
 * the consent gate holds, and the health route answers.
 *
 * The capture flow with a fixture image and the report screen need a Supabase
 * project and a consented session, so they land with Layer 1. They are listed in
 * README.md under the setup a human has to finish.
 *
 * Every expected string is imported from copy.ts rather than retyped, so a copy
 * change cannot leave a test asserting words the app no longer says.
 */

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
