/**
 * Takes the submission screenshot set, docs/09-build-order-and-demo.md, "Devpost
 * page checklist": "Screenshots: capture, reveal, report, color, makeup, hair,
 * looks, profile. All at 390px, all from the demo profile."
 *
 * This is runbook step E12 in docs/SUBMISSION-RUNBOOK.md made mechanical. It
 * walks every screen in flow order at the one viewport the product is designed
 * for, saves a full page frame and a fold frame of each, and writes a review
 * file that answers the machine checkable half of the anti slop checklist in
 * docs/02-design-system.md so the human only has to look at the ones it flags.
 *
 * What it cannot answer is the other half: whether the hierarchy reads, whether
 * a screen survives removing one thing, whether the face looks like the person.
 * Open the PNGs. The checklist is thirteen items and this file covers six.
 *
 * It is deliberately not a Playwright test. A test that writes files into a
 * gitignored directory and passes either way is a script wearing a test's
 * clothes, and it would run on every `npm run e2e`.
 *
 * How to run it:
 *
 *   npm run build
 *   npm run start          (in another terminal, with AURUM_DEMO_FIXTURE=true)
 *   npm run shots
 *
 * Against a deployed build instead, which is what the submission set should be:
 *
 *   AURUM_SHOTS_BASE_URL=https://your-deployment npm run shots
 *
 * The screens after /capture are served by the demo profile. On a clean clone
 * that is the checked in fixture (AURUM_DEMO_FIXTURE=true) and every face frame
 * is empty, because there is no consented face in this repository. That set is a
 * template: it proves the layout at 390px and nothing about the renders. The
 * submission set is taken again after runbook steps A to D, from a deployment
 * with the founder's own capture behind it.
 */

import { chromium, devices } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE_URL = process.env.AURUM_SHOTS_BASE_URL ?? "http://localhost:3000";

/**
 * Where the frames land. The default is the submission set.
 *
 * AURUM_SHOTS_OUT_DIR moves a run somewhere else, which is what a review of a
 * branch wants: a set taken to check a change is not the set the Devpost page
 * links, and overwriting the submission frames to look at a margin would lose
 * the ones taken from the deployment with the founder's own capture behind it.
 */
const OUT_DIR = resolve(
  process.cwd(),
  process.env.AURUM_SHOTS_OUT_DIR ?? "evals/results/screenshots/final",
);

/**
 * /analyzing polls for jobs that only exist once a capture has been accepted by
 * a real provider. This is the one screen the set cannot reach by navigating to
 * it, so the poll is answered with the state the reveal is designed around: the
 * skin analysis back, the tone reading still running, which is the bloomed mask
 * and the second status line. It is the same stub e2e/a11y.spec.ts uses, and it
 * is a stub of our own route, not an invented provider response.
 */
const ANALYZING_JOBS = {
  jobs: [
    { id: "job-skin", kind: "skin", status: "succeeded" },
    { id: "job-tone", kind: "fitzpatrick", status: "running" },
  ],
  complete: false,
};

/** Every screen a person walks through, in flow order. */
const SCREENS = [
  { name: "01-landing", path: "/" },
  { name: "02-judge", path: "/judge" },
  { name: "03-welcome", path: "/welcome" },
  { name: "04-capture", path: "/capture" },
  { name: "05-analyzing", path: "/analyzing?capture=screenshots", stub: true },
  { name: "06-report", path: "/report" },
  { name: "07-color", path: "/color" },
  { name: "08-makeup", path: "/makeup" },
  { name: "09-hair", path: "/hair" },
  { name: "10-wardrobe", path: "/wardrobe" },
  { name: "11-looks", path: "/looks" },
  { name: "12-profile", path: "/profile" },
];

/**
 * The words docs/02-design-system.md bans from copy, plus the three markers that
 * mean a screen shipped with a hole in it.
 *
 * "glow" from the doc's list is left to the lexicon check in evals/safety, which
 * reads copy.ts with word boundaries. Matching it in rendered text catches a
 * product title from a live listing, which is a brand's word and not ours.
 */
const BANNED_WORDS = [
  "amazing",
  "perfect",
  "flawless",
  "unlock",
  "elevate",
  "journey",
  "lorem",
  "placeholder",
  "todo",
];

/**
 * "Perfect Corp" is the provider's name, on the consent screen and under the
 * skin age line. It is not the superlative the checklist bans, so it comes out
 * before the scan rather than being explained in a review file every time.
 */
const NOT_A_SUPERLATIVE = /perfect corp/g;

/**
 * The exceptions the checklist and the flow doc write into themselves. Every
 * other screen is allowed none of either.
 *
 * Item 1: "Is there a gradient anywhere other than the single radial vignette
 * behind the hero on /analyzing?" Item 7: "Is anything animating that the person
 * did not trigger, other than the reveal?" So /analyzing is allowed one gradient
 * layer and the reveal's own animation.
 *
 * And docs/01-user-flow.md section A gives the landing hero the same licence for
 * the same reveal: "This single orchestrated motion is the only non user
 * triggered animation in the app." It has no animated layers today, because the
 * consented fixture face is not in the repository and the hero holds a plain
 * frame instead. The allowance is written now so that dropping the face in does
 * not make this script cry wolf on the one motion the product is designed
 * around.
 */
const REVEAL_SCREENS = {
  "01-landing": { gradients: 0, animating: 4 },
  "05-analyzing": { gradients: 1, animating: 8 },
};

/** What this screen may have, for a screen the docs give no exception. */
const NO_EXCEPTION = { gradients: 0, animating: 0 };

/**
 * Reads the anti slop items a browser can answer, from computed style rather
 * than from class names, so a token change is visible here.
 *
 * Item 1 gradients, item 2 shadows, item 3 all caps, item 5 arrows and middle
 * dots, item 7 unrequested motion, item 10 superlatives and placeholders, and
 * item 11 sideways scroll.
 */
function readScreen() {
  const main = document.querySelector("main");
  const text = (main?.textContent ?? "").trim();
  const inMain = Array.from(document.querySelectorAll("main *"));

  function describe(element) {
    const label =
      element.getAttribute("aria-label") ??
      (element.textContent ?? "").trim().slice(0, 24);
    return `${element.tagName.toLowerCase()} "${label}"`;
  }

  const gradients = inMain
    .filter((element) =>
      getComputedStyle(element).backgroundImage.includes("gradient"),
    )
    .map(describe);

  const shadows = inMain
    .filter((element) => {
      const shadow = getComputedStyle(element).boxShadow;
      return shadow !== "none" && shadow !== "";
    })
    .map(describe);

  const allCaps = inMain
    .filter(
      (element) =>
        getComputedStyle(element).textTransform === "uppercase" &&
        (element.textContent ?? "").trim() !== "",
    )
    .map(describe);

  /*
   * A transition is not motion until something triggers it, so only running
   * keyframe animations count. The reveal on /analyzing is the one screen
   * allowed to have any (docs/02, item 7), and the landing hero is the one
   * orchestrated exception the flow doc names.
   */
  const animating = inMain
    .filter((element) => getComputedStyle(element).animationName !== "none")
    .map(describe);

  return {
    horizontalOverflow: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    fullHeight: document.documentElement.scrollHeight,
    gradients,
    shadows,
    allCaps,
    animating,
    exclamations: (text.match(/!/g) ?? []).length,
    /*
     * Written as code points, not as the characters. The lint rule that bans
     * them from this repository reads source text, and a literal one here would
     * be a real hit even though it is the thing doing the checking.
     */
    dashes: (text.match(/[\u2014\u2013]/g) ?? []).length,
    arrowsAndDots: (text.match(/[→←·•]/g) ?? []).length,
    bannedWords: [],
    characters: text.length,
    __text: text.toLowerCase(),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...devices["Pixel 7"],
    viewport: { width: 390, height: 844 },
  });

  const rows = [];

  for (const screen of SCREENS) {
    const page = await context.newPage();

    if (screen.stub) {
      await page.route("**/api/jobs**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ANALYZING_JOBS),
        }),
      );
    }

    const response = await page.goto(`${BASE_URL}${screen.path}`, {
      waitUntil: "networkidle",
    });

    /*
     * Long enough for the reveal to bloom and settle (600ms plus 300ms in
     * docs/02-design-system.md, "Motion"), so the frame is the settled state
     * rather than a blur halfway through it.
     */
    await page.waitForTimeout(1_400);

    const read = await page.evaluate(readScreen);
    const scannable = read.__text.replace(NOT_A_SUPERLATIVE, "");
    read.bannedWords = BANNED_WORDS.filter((word) => scannable.includes(word));
    read.allowed = REVEAL_SCREENS[screen.name] ?? NO_EXCEPTION;
    delete read.__text;

    await page.screenshot({
      path: resolve(OUT_DIR, `${screen.name}-390.png`),
      fullPage: true,
    });
    await page.screenshot({
      path: resolve(OUT_DIR, `${screen.name}-390-fold.png`),
      fullPage: false,
    });

    rows.push({
      screen: screen.name,
      path: screen.path,
      status: response?.status() ?? 0,
      ...read,
    });

    await page.close();
  }

  await browser.close();

  const flagged = rows.filter(
    (row) =>
      row.status !== 200 ||
      row.horizontalOverflow > 0 ||
      row.gradients.length > row.allowed.gradients ||
      row.animating.length > row.allowed.animating ||
      row.shadows.length > 0 ||
      row.allCaps.length > 0 ||
      row.exclamations > 0 ||
      row.dashes > 0 ||
      row.arrowsAndDots > 0 ||
      row.bannedWords.length > 0,
  );

  const review = {
    tool: "npm run shots",
    spec: 'docs/02-design-system.md, "Anti slop checklist", the six items a browser can answer',
    baseUrl: BASE_URL,
    viewport: "390 by 844",
    takenAt: new Date().toISOString(),
    screens: rows,
    flagged: flagged.map((row) => row.screen),
    stillNeedsAPairOfEyes: [
      "Item 4: three or more identical cards in a grid.",
      "Item 6: an icon without a label, a sparkle, a star rating, an AI badge.",
      "Item 8: a spinner over a face, a shimmer on a skeleton.",
      "Item 9: a hero that is a big number with a small label.",
      "Item 12: the gold focus hairline, which e2e/a11y.spec.ts asserts but no still frame shows.",
      "Item 13: remove one thing and see whether the screen survives.",
    ],
  };

  writeFileSync(
    resolve(OUT_DIR, "review.json"),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf8",
  );

  for (const row of rows) {
    console.log(
      `${row.screen.padEnd(14)} ${String(row.status)} ` +
        `${String(row.fullHeight).padStart(5)}px tall  ` +
        `${flagged.includes(row) ? "FLAGGED" : "clean"}`,
    );
  }
  console.log(`\nFrames and review.json in ${OUT_DIR}`);
  console.log(
    flagged.length === 0
      ? "No machine checkable anti slop hit. Now open the PNGs for the other seven items."
      : `Flagged: ${flagged.map((row) => row.screen).join(", ")}`,
  );

  process.exitCode = flagged.length === 0 ? 0 : 1;
}

await main();
