/**
 * Where the back control goes, screen by screen.
 *
 * docs/02-design-system.md, "Screen skeleton", puts a back control at the top
 * left of the header row, and its iconography rule names it as one of the two
 * things allowed on screen without a visible label: "Icons never appear without
 * a text label except the shutter and the back control." docs/01-user-flow.md
 * "Screen map" is what decides where each one points, because a back control
 * that guesses is worse than none: it tells a person they came from somewhere
 * they did not.
 *
 * A pure table with one entry per screen, so the whole decision can be read in
 * one place and tested without a browser. A screen absent from the table has no
 * back control, and each absence has a reason written beside it below.
 *
 * (onboarding)
 *
 * - /welcome to "/": the person arrived from the landing screen's "Start with a
 *   selfie" or from the judge access screen. Nothing has been recorded yet, so
 *   leaving costs them nothing, and a wall of consent text with no way out is
 *   the trap this table exists to remove.
 * - /capture to /welcome: docs/01-user-flow.md section C ends on "Continue to
 *   capture", so /welcome is literally the screen behind this one. A person who
 *   wants to re read what happens to their photo, or turn the retention toggle
 *   on before the shutter, has to be able to get there.
 * - /analyzing: no back, and this is the one deliberate exception. Section E is
 *   the reveal, and its steps are "driven by job completion, not timers": by the
 *   time the screen is on, the photo is uploaded and the analyses are running.
 *   The screen ends by moving to /report on its own. A back control there offers
 *   to abandon a reading that is already paid for, between a spent analysis and
 *   no report, which is the one navigation in this app that can lose something.
 *   The way out of a reveal that failed is the "Retake photo" control the screen
 *   puts up with the error, which is a decision rather than an escape hatch.
 *
 * (app)
 *
 * - /report, /color, /makeup, /hair, /looks: no back. All five are roots of the
 *   bottom navigation (docs/01-user-flow.md "Screen map"), so a person can be on
 *   any of them without having come from anywhere. /report is also where the
 *   reveal lands and where a judge session opens. A chevron pointing at one
 *   fixed screen would be a claim about history that the tab bar disproves.
 * - /wardrobe to /looks: the one (app) screen that is not in the bottom
 *   navigation. "Wardrobe is reached from Looks", and the only link to it in the
 *   app is the one on /looks, so /looks is where it was pushed from, always.
 * - /profile: no back. "Profile is reached from the top right", and that link is
 *   on all six other (app) screens, so there are six screens behind it and no
 *   way to know which. The bottom navigation stays on screen and the top right
 *   link marks itself as current, so the way out is already drawn.
 */

/** Every screen with a back control, and the screen it points at. */
export const BACK_TARGETS: Readonly<Record<string, string>> = {
  "/welcome": "/",
  "/capture": "/welcome",
  "/wardrobe": "/looks",
};

/**
 * The back target for a path, or null when the screen has none.
 *
 * A trailing slash is dropped before the lookup, because a person who typed one
 * is on the same screen as a person who did not. Anything else unknown answers
 * null, which draws no control at all rather than a chevron pointing at a guess.
 */
export function backTargetFor(pathname: string): string | null {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return BACK_TARGETS[normalized] ?? null;
}
