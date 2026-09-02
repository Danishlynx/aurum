import { expect, test, type Page } from "@playwright/test";

import { CAPTURE_PREVIEW_KEY } from "../src/lib/client/capture-handoff";
import { copy } from "../src/lib/shared/copy";

/**
 * E. Analyzing, the dead end, docs/01-user-flow.md section E.
 *
 * The reveal is driven entirely by GET /api/jobs, so the failure shapes the live
 * API produces can be played straight into the screen with a routed response and
 * no Supabase project, no provider key, and no credit.
 *
 * What is being proved here is the half that only shows on a real screen: that a
 * settled capture with no profile behind it says which frame problem stopped the
 * reading and offers the way back to the camera, instead of the timeout line it
 * showed for every dead end before. The words come from the server, which is
 * where the provider's failure code is; these tests send the sentences the jobs
 * layer writes for the codes read live on 2026-09-02.
 */

/**
 * One transparent pixel, which is all a compositing test needs: the geometry is
 * what is being measured, not the picture. No face is involved.
 */
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** The sentence the server writes for error_face_angle_rightward. */
const FACE_ANGLE_LINE = copy.capture.facingAway;
/** The sentence the server writes for error_no_face. */
const NO_FACE_LINE = copy.capture.rejection.no_face;

interface StubJob {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly error?: string;
}

async function stubJobs(
  page: Page,
  jobs: readonly StubJob[],
  complete: boolean,
  maskUrl?: string,
): Promise<void> {
  await page.route("**/api/jobs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs, complete, maskUrl }),
    }),
  );
}

/**
 * The other half of section E: what happens when the readings do land.
 *
 * "5. Transition to /report." The screen leaves on its own, driven by the jobs
 * coming back rather than by a timer, and it offers nothing to leave with in the
 * meantime. That absence is deliberate and is written down in
 * src/lib/shared/navigation.ts: by the time this screen is on, the photo is
 * uploaded and the analyses are running, so a back control here would offer to
 * abandon a reading that is already paid for. The way out of a reveal that
 * stopped is the "Retake photo" control the tests above assert, which appears
 * only once there is nothing left to wait for.
 */
test.describe("the reveal when every reading lands", () => {
  test("takes the person to their report without being asked", async ({
    page,
  }) => {
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "succeeded" },
        { id: "job-tone", kind: "attributes", status: "succeeded" },
        { id: "job-fitz", kind: "fitzpatrick", status: "succeeded" },
      ],
      true,
    );
    await page.goto("/analyzing?capture=e2e-complete");

    await page.waitForURL("**/report");
    await expect(
      page.getByRole("heading", { name: copy.nav.report, level: 1 }),
    ).toBeVisible();
  });

  test("offers no way to abandon the reveal while it is running", async ({
    page,
  }) => {
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "succeeded" },
        { id: "job-fitz", kind: "fitzpatrick", status: "running" },
      ],
      false,
    );
    await page.goto("/analyzing?capture=e2e-no-back");

    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();
    await expect(page.getByRole("link", { name: copy.nav.back })).toHaveCount(0);
    // And nothing else to leave by either: the retake link belongs to the
    // stopped state, which this is not.
    await expect(
      page.getByRole("link", { name: copy.report.retakePhotoAction }),
    ).toHaveCount(0);
  });
});

test.describe("the reveal when the engine refuses the photo", () => {
  test("says the face was turned away, and offers the camera again", async ({
    page,
  }) => {
    /*
     * The refusal the live run found. The skin analyzer took this frame; the
     * tone analysis refused it on the face angle. With no Fitzpatrick reading
     * either, the core set is short and there is no report to route to.
     */
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "succeeded" },
        {
          id: "job-tone",
          kind: "attributes",
          status: "failed",
          error: FACE_ANGLE_LINE,
        },
        {
          id: "job-fitz",
          kind: "fitzpatrick",
          status: "failed",
          error: FACE_ANGLE_LINE,
        },
      ],
      true,
    );
    await page.goto("/analyzing?capture=e2e-face-angle");

    await expect(page.getByText(FACE_ANGLE_LINE)).toBeVisible();
    // Not the line that used to stand in for every failure.
    await expect(page.getByText(copy.errors.providerTimeout)).toHaveCount(0);

    const retake = page.getByRole("link", {
      name: copy.report.retakePhotoAction,
    });
    await expect(retake).toBeVisible();
    await expect(retake).toHaveAttribute("href", "/capture");
  });

  test("says the frame had no face when that is what came back", async ({
    page,
  }) => {
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "failed", error: NO_FACE_LINE },
        {
          id: "job-tone",
          kind: "attributes",
          status: "failed",
          error: NO_FACE_LINE,
        },
      ],
      true,
    );
    await page.goto("/analyzing?capture=e2e-no-face");

    await expect(page.getByText(NO_FACE_LINE)).toBeVisible();
  });

  test("falls back to the timeout line for a failure with no reason", async ({
    page,
  }) => {
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "failed" },
        { id: "job-tone", kind: "attributes", status: "failed" },
      ],
      true,
    );
    await page.goto("/analyzing?capture=e2e-silent");

    await expect(page.getByText(copy.errors.providerTimeout)).toBeVisible();
  });

  /**
   * The reveal itself, docs/01-user-flow.md section E step 2: the mask blooms
   * over the face. What is checked is the compositing, because that is the part
   * that can be wrong without looking wrong in code.
   *
   * The mask the engine returns is a full frame PNG aligned to the picture that
   * was uploaded, and the still on this screen is that same picture. So the two
   * layers have to occupy exactly the same box, and the mask has to be read as
   * alpha, which is the channel the engine draws its marks in (verified against
   * evals/fixtures/golden/raw/skin).
   */
  test("blooms the stored mask over the frame it was measured on", async ({
    page,
  }) => {
    const maskUrl = "https://masks.e2e.invalid/pigmentation.png";
    await page.route(maskUrl, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(PIXEL_PNG_BASE64, "base64"),
      }),
    );
    // The still the capture screen hands over, seeded the way it hands it.
    await page.addInitScript(
      ([key, value]) => {
        window.sessionStorage.setItem(key, value);
      },
      [
        CAPTURE_PREVIEW_KEY,
        JSON.stringify({
          captureId: "e2e-mask",
          dataUrl: `data:image/png;base64,${PIXEL_PNG_BASE64}`,
        }),
      ] as const,
    );

    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "succeeded" },
        { id: "job-fitz", kind: "fitzpatrick", status: "running" },
      ],
      false,
      maskUrl,
    );
    await page.goto("/analyzing?capture=e2e-mask");
    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();

    const still = page.locator("main img");
    await expect(still).toHaveCount(1);

    /*
     * Measured from the layout boxes rather than from the painted rectangles:
     * the bloom is a scale animation, so a client rect read mid bloom is 94
     * percent of the box and says nothing about where the mask sits.
     */
    const geometry = await page.evaluate(() => {
      const layer = Array.from(document.querySelectorAll("main *")).find(
        (candidate) => getComputedStyle(candidate).animationName !== "none",
      ) as HTMLElement | undefined;
      const photo = document.querySelector("main img") as HTMLElement | null;
      if (layer === undefined || photo === null) {
        return null;
      }
      const boxOf = (element: HTMLElement) => ({
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
        height: element.offsetHeight,
      });
      const style = getComputedStyle(layer);
      return {
        image: style.maskImage,
        mode: style.maskMode,
        size: style.maskSize,
        layer: boxOf(layer),
        photo: boxOf(photo),
        sameParent: layer.offsetParent === photo.offsetParent,
      };
    });

    expect(geometry?.image).toContain("pigmentation.png");
    expect(geometry?.mode).toBe("alpha");
    expect(geometry?.size).toBe("cover");

    // The whole of the alignment: one box, in one place, shared with the
    // picture the mask was measured on.
    expect(geometry?.sameParent).toBe(true);
    expect(geometry?.layer).toEqual(geometry?.photo);
  });

  test("holds the status line while a core reading can still land", async ({
    page,
  }) => {
    /*
     * docs/01 section E: a failed step is skipped rather than waited for, and
     * nothing fakes progress. The tone analysis is refused and Fitzpatrick is
     * still running, so the sequence has moved on to the third line and the
     * screen says nothing about a problem yet.
     */
    await stubJobs(
      page,
      [
        { id: "job-skin", kind: "skin", status: "succeeded" },
        {
          id: "job-tone",
          kind: "attributes",
          status: "failed",
          error: FACE_ANGLE_LINE,
        },
        { id: "job-fitz", kind: "fitzpatrick", status: "running" },
      ],
      false,
    );
    await page.goto("/analyzing?capture=e2e-still-running");

    await expect(page.getByText(copy.analyzing.readingTone)).toBeVisible();
    await expect(page.getByText(FACE_ANGLE_LINE)).toHaveCount(0);
  });
});
