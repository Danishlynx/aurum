import "server-only";

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Is the consented fixture face in the repository yet.
 *
 * docs/01-user-flow.md section A: the landing hero is "a slow, one time reveal
 * on a fixture face (never a stock model; use the founder's own consented selfie
 * or a synthetic face generated with Perfect Corp's tools)".
 * docs/02-design-system.md, "Imagery": "The only hero image in the product is the
 * person's own face. Landing uses a consented fixture face for the reveal
 * preview. No stock photography, no illustrations, no 3D renders, no abstract
 * 'AI' art."
 *
 * That image is not in this repository, and no build step can produce it: it is
 * a photograph of a real person who has to agree to it being published. So the
 * hero asks this module whether the file is there, and the landing screen draws
 * the reveal if it is and the quiet placeholder if it is not. Nothing is ever
 * requested from the browser that does not exist, so there is no 404 in the
 * network tab of a screen recording.
 *
 * FOR THE HUMAN, and this is the whole runbook step:
 *
 *   1. Choose the image. It has to be a face you have written consent to publish
 *      (your own is simplest), or a synthetic face made with Perfect Corp's
 *      tools. Never a stock model, never a customer, never a friend.
 *   2. Save it as public/fixtures/landing-face.jpg. Square, at least 800 by 800,
 *      face centred, evenly lit, under about 300KB so the landing screen still
 *      loads in under 3 seconds on mobile data (docs/09, pre submission
 *      checklist).
 *   3. Record the consent beside it, the way evals/fixtures/README.md records
 *      the fixture consent.
 *   4. Rebuild. The hero switches from the Basalt placeholder to the reveal by
 *      itself: masks bloom over the face for 600ms and settle for 300ms, once,
 *      and reduced motion shows the settled state with no animation
 *      (docs/02-design-system.md, "Motion"). No code has to change.
 *
 * The check runs on the server. The landing screen is prerendered, so in a
 * deployed build this is answered when the page is built, not on every request.
 */

/** Where the file goes, relative to the repository root. */
export const LANDING_FACE_FILE = "public/fixtures/landing-face.jpg";

/** What the browser would request for it. */
export const LANDING_FACE_SRC = "/fixtures/landing-face.jpg";

/**
 * The image source for the landing hero, or null when the file is not there.
 *
 * Memoized: the answer cannot change inside one build, and a landing screen
 * should not touch the file system more than once.
 */
let cached: string | null | undefined;

export function landingFaceSource(): string | null {
  if (cached === undefined) {
    cached = existsSync(join(process.cwd(), LANDING_FACE_FILE))
      ? LANDING_FACE_SRC
      : null;
  }
  return cached;
}
