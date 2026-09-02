import { expect, test, type Page } from "@playwright/test";

import { JUDGE_E2E_CODE } from "../playwright.config";
import { copy, formatJudgeBanner } from "../src/lib/shared/copy";
import { CONSENT_VERSION } from "../src/lib/shared/schemas";

/**
 * The judge session this build actually ships: JUDGE_ANALYSES_ALLOWED=0.
 *
 * docs/07-payments-and-judge-mode.md reserves the Perfect Corp units for one
 * founder run, so judging spends none of them. docs/01-user-flow.md, "Judge mode
 * across the flow", is then the whole specification for what a judge sees: the
 * banner on every screen with a live count, capture disabled with "This session
 * has used its analyses. Exploring the saved demo profile.", and every screen
 * rendering from the demo profile "so nothing is dead".
 *
 * These specs run against the second server playwright.config.ts starts, on port
 * 3100. Two things about that server matter:
 *
 * 1. AURUM_DEMO_FIXTURE is deliberately not set. Every demo screen below is
 *    therefore reached through the judge session state alone, which is what
 *    proves the fixture fallback is not the development switch wearing a hat.
 * 2. JUDGE_FIXTURE_SESSION is set, because a clean clone has no judge_sessions
 *    table to write a session to. The access code is still checked, the cookie
 *    is still the real one, and the caps are still the real ones.
 *
 * No provider is reachable from that server and no key is configured, so a run
 * of this file spends nothing.
 */

const externalServer = Boolean(process.env.PLAYWRIGHT_BASE_URL);

test.describe("judge session with no analyses", () => {
  test.skip(
    externalServer,
    "Needs the judge mode server playwright.config.ts starts on port 3100.",
  );

  /** Types the code on /judge and waits for where a zero session lands. */
  async function openJudgeSession(page: Page): Promise<void> {
    await page.goto("/judge");
    await page
      .getByRole("textbox", { name: copy.judge.fieldPlaceholder })
      .fill(JUDGE_E2E_CODE);
    await page.getByRole("button", { name: copy.judge.submitAction }).click();
    await page.waitForURL("**/report");
  }

  /**
   * Records consent the way this session can: through the route.
   *
   * docs/06-safety-privacy.md keeps consent in front of every capture, and a
   * judge's consent is recorded on the session row rather than on a profiles row
   * (migration 0008). A zero session no longer passes the consent screen on its
   * way in, so the tests below that need consent recorded ask the route for it
   * directly, which is what the screen does.
   */
  async function recordConsent(page: Page): Promise<void> {
    const response = await page.request.post("/api/consent", {
      data: {
        isAdultConfirmed: true,
        agreesToProcessing: true,
        keepOriginals: false,
        consentVersion: CONSENT_VERSION,
      },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      keepOriginals: false,
    });
  }

  /**
   * The code opens the app rather than a dead end.
   *
   * A session that was given three analyses and spent them shows the exhausted
   * panel docs/01 section B writes. A session that was given none never had
   * three and can never take a photo, so consent gates nothing for it and the
   * capture screen behind consent is one it cannot use. docs/01 section C:
   * "Returning person with a profile: this screen is skipped; they land on
   * /report." This session reads the saved demo profile, so it is that person.
   */
  test("lands on the demo profile with the banner already at zero", async ({
    page,
  }) => {
    await openJudgeSession(page);

    await expect(page).toHaveURL(/\/report$/u);
    await expect(
      page.getByRole("heading", { name: copy.nav.report, level: 1 }),
    ).toBeVisible();

    // The banner, on the first screen after the code, with the real count. The
    // server writes the readable count cookie alongside the session cookie, so
    // this is right before any script on the page runs.
    await expect(page.getByText(formatJudgeBanner(0)).first()).toBeVisible();
    await expect(
      page.getByText("Judge session. 0 analyses remaining.").first(),
    ).toBeVisible();
  });

  /**
   * The same decision, made on the server, for everyone who arrives at /welcome
   * without going through the access form: a bookmark, the back button, or the
   * landing page's own "Start with a selfie".
   */
  test("sends this session away from the consent screen", async ({ page }) => {
    await openJudgeSession(page);

    await page.goto("/welcome");

    await expect(page).toHaveURL(/\/report$/u);
    await expect(
      page.getByRole("heading", { name: copy.welcome.title, level: 1 }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: copy.welcome.continueAction }),
    ).toHaveCount(0);
    await expect(page.getByText(formatJudgeBanner(0)).first()).toBeVisible();
  });

  /**
   * Consent still works for a judge, and is still recorded on the session row.
   * The screen is no longer in this session's path, but the route it posts to is
   * the same one, and it is what the capture guard reads.
   */
  test("records consent against the session", async ({ page }) => {
    await openJudgeSession(page);

    await recordConsent(page);
  });

  /**
   * The capture screen opens disabled, with the flow doc's line and the way into
   * the saved demo profile under it. No camera is asked for at all: the screen
   * knows before it renders that a photo could not be read, so it never puts up
   * a permission prompt or a shutter it would refuse to honour.
   */
  test("shows the disabled capture screen instead of the camera", async ({
    page,
  }) => {
    await openJudgeSession(page);
    await page.goto("/capture");

    await expect(
      page.getByText(
        "This session has used its analyses. Exploring the saved demo profile.",
      ),
    ).toBeVisible();
    await expect(page.getByText(copy.errors.judgeExhausted)).toBeVisible();

    const demoLink = page.getByRole("link", {
      name: copy.judge.exploreDemoAction,
    });
    await expect(demoLink).toHaveAttribute("href", "/report");

    // No camera, no shutter, and no upload path: nothing on this screen offers a
    // photo the server would refuse.
    await expect(page.locator("video")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: copy.capture.shutterLabel }),
    ).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  /**
   * The routes, asked directly. A disabled screen is not a permission check, so
   * both halves of the capture path are asked for and both answer 429 with the
   * flow doc's sentence.
   */
  test("answers the capture routes with 429 and the flow doc copy", async ({
    page,
  }) => {
    await openJudgeSession(page);

    // Consent first, so the refusal below is the cap and not the consent gate.
    await recordConsent(page);

    const captures = await page.request.post("/api/captures", {
      data: {
        sha256: "a".repeat(64),
        width: 1024,
        height: 1024,
        quality: {
          verdict: "accept",
          reason: null,
          sharpness: 120,
          meanLuminance: 128,
          faceCoverage: 0.5,
          blownFraction: 0.01,
          crushedFraction: 0.01,
        },
      },
    });
    // The body is { error, ...extra } (src/lib/server/http/responses.ts): the
    // sentence the person reads, and the remaining count beside it.
    expect(captures.status()).toBe(429);
    expect(await captures.json()).toMatchObject({
      error: copy.errors.judgeExhausted,
      remaining: 0,
    });

    const analyze = await page.request.post(
      "/api/captures/00000000-0000-4000-8000-0000000000aa/analyze",
    );
    expect(analyze.status()).toBe(429);
    expect(await analyze.json()).toMatchObject({
      error: copy.errors.judgeExhausted,
      remaining: 0,
    });
  });

  /**
   * Every screen a judge can reach renders the demo profile, with no fixture
   * switch set on this server. This is the "nothing is dead" half of the flow
   * doc, walked in order.
   */
  test("renders the demo profile from /report through /profile", async ({
    page,
  }) => {
    await openJudgeSession(page);

    await expect(
      page.getByRole("heading", { name: copy.nav.report, level: 1 }),
    ).toBeVisible();
    // The demo profile's reading, not an empty screen and not a redirect back
    // to capture, which is what a judge used to get here.
    await expect(page).toHaveURL(/\/report$/u);
    await expect(page.getByText(formatJudgeBanner(0)).first()).toBeVisible();

    await page.goto("/color");
    await expect(
      page.getByRole("heading", { name: copy.nav.color, level: 1 }),
    ).toBeVisible();
    /*
     * The undertone line, whichever of the three it is.
     *
     * A judge at zero analyses reads the seeded demo profile when a Supabase
     * project is configured, and the checked in fixture when it is not
     * (src/lib/server/judge/demo.ts, planDemoRead). Those two are deliberately
     * different people: the fixture is synthetic and warm, the seeded profile
     * carries the real values one live run measured. Pinning one of them would
     * make this spec pass on a clean clone and fail on the founder's machine,
     * which says nothing about the app. What matters here is that the screen is
     * not dead: an undertone was read and a season came out of it.
     */
    await expect(
      page.getByText(
        new RegExp(
          `^(${copy.color.undertoneWarm}|${copy.color.undertoneCool}|${copy.color.undertoneNeutral})$`,
          "u",
        ),
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        copy.color.seasonLineTemplate.replace("{season}", "").trim(),
      ),
    ).toBeVisible();

    await page.goto("/makeup");
    await expect(
      page.getByRole("heading", { name: copy.nav.makeup, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: copy.makeup.rowLip, level: 2 }),
    ).toBeVisible();

    await page.goto("/hair");
    await expect(
      page.getByRole("heading", { name: copy.nav.hair, level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: copy.hair.stylesHeading }),
    ).toBeVisible();

    await page.goto("/wardrobe");
    await expect(
      page.getByRole("heading", { name: copy.nav.wardrobe, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("listitem")).toHaveCount(6);

    await page.goto("/looks");
    await expect(
      page.getByRole("heading", { name: copy.nav.looks, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole("article").first()).toBeVisible();

    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: copy.nav.profile, level: 1 }),
    ).toBeVisible();
    const rows = page.locator("main ul").first().locator("li");
    await expect(rows).toHaveCount(6);
    // docs/01-user-flow.md: "Judge sessions never see the Delete everything
    // control on the demo profile."
    await expect(
      page.getByRole("button", { name: copy.profile.deleteAction }),
    ).toHaveCount(0);
  });

  /**
   * The demo profile is read only for a judge session
   * (docs/07-payments-and-judge-mode.md), which the screen reports rather than
   * showing a confirmation for a save that never landed.
   */
  test("answers a save on the demo profile with the read only line", async ({
    page,
  }) => {
    await openJudgeSession(page);

    await page.goto("/hair");
    await page.getByRole("button", { name: copy.hair.saveAction }).click();

    // The banner is a status region too, so the toast is reached by its words
    // rather than by its role.
    await expect(page.getByText(copy.hair.saveReadOnly)).toBeVisible();
    await expect(page.getByText(copy.hair.savedToast)).toHaveCount(0);
  });
});
