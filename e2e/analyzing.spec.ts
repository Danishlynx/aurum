import { expect, test, type Page } from "@playwright/test";

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
): Promise<void> {
  await page.route("**/api/jobs**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs, complete }),
    }),
  );
}

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
