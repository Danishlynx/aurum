import "server-only";

import { copy } from "@/lib/shared/copy";

/**
 * The sentences the API layer puts in an error body.
 *
 * Everything the person reads on a screen lives in src/lib/shared/copy.ts. The
 * lines below are the ones a route has to say that docs/01-user-flow.md does not
 * write, mostly refusals that the flow doc describes as a state without giving
 * it words. They follow the same voice rules: sentence case, plain verbs, no
 * exclamation marks, no dashes, cosmetic never medical, and they say what
 * happened and what to do.
 *
 * Open item for the human: approve or replace the lines in
 * SERVER_MESSAGES_NOT_IN_FLOW_DOC, add them to docs/01-user-flow.md, and move
 * them into copy.ts so this file only re exports.
 */

export const messages = {
  /** Reused from copy.ts, so the same words appear on screen and in the body. */
  providerTimeout: copy.errors.providerTimeout,
  uploadFailed: copy.errors.uploadFailed,
  judgeExhausted: copy.errors.judgeExhausted,
  judgeCodeDidNotMatch: copy.judge.codeError,
  judgeSessionExhausted: copy.judge.exhausted,
  /**
   * The try on failed state, docs/01-user-flow.md section H. Used whenever a
   * render cannot be produced, so the body carries the same sentence the screen
   * shows and no substitute image is ever implied.
   */
  tryOnUnavailable: copy.makeup.previewUnavailable,

  /** In house. No session, or a session that has ended. */
  signedOut: "Your session has ended. Open the app again to continue.",
  /** In house. docs/06-safety-privacy.md requires the 403, not its wording. */
  consentRequired:
    "Agree on the welcome screen before a photo can be read, then come back.",
  /** In house. A body that failed zod. */
  invalidRequest: "That request did not look right. Try again.",
  /** In house. A capture id that is not this person's. */
  captureNotFound: "That photo is not on this session. Take a new one.",
  /** In house. The original object is gone, so nothing can be sent. */
  captureMissingOriginal:
    "The photo for this reading is no longer stored. Take a new one.",
  /** In house. Rate limit, docs/06-safety-privacy.md "Keys, sessions, abuse". */
  tooManyRequests: "That is a lot of requests in a short time. Wait a minute and try again.",
  /** In house. Daily cap per person, docs/03-architecture.md. */
  dailyCapReached:
    "Today's readings for this account are used up. Come back tomorrow.",
  /** In house. Kill switch on, docs/03-architecture.md and docs/07. */
  providerCallsDisabled:
    "Live readings are paused right now. Exploring the saved demo profile.",
  /** In house. Anything unexpected on the server. */
  serverError: "The server could not finish that. Try again in a moment.",
  /** In house. A missing environment value. */
  notConfigured:
    "This build is missing a server setting, so that step cannot run yet.",
  /** In house. The provider refused before the task started. */
  providerRefused:
    "Perfect Corp could not read this photo. Your photo is safe. Try again with a new one.",
  /** In house. An endpoint this build cannot call yet, or one not configured. */
  analysisUnavailable:
    "This part of the reading is not available yet. The rest of your profile is unaffected.",
  /** In house. Hair type detection needs three photos, not one selfie. */
  hairTypeNeedsThreePhotos:
    "Hair type needs three photos, front and both sides, so it is skipped for a single selfie.",
  /**
   * In house. Renders are sequential per person
   * (docs/03-architecture.md, "Concurrency"), which docs/01 does not word.
   */
  renderInProgress:
    "A preview is still rendering. Wait for it to finish, then pick another shade.",
  /**
   * In house. Six renders per judge session
   * (docs/07-payments-and-judge-mode.md, "Caps"), which docs/01 does not word.
   */
  renderLimitReached:
    "This session has used its previews. The shades below still show what suits you.",
  /** In house. A colour or makeup request before any reading exists. */
  profileNotReady:
    "There is no reading on this session yet. Take a selfie to build your profile.",
  /**
   * In house. docs/07-payments-and-judge-mode.md: "The demo profile is read only
   * for judge sessions." The same holds in fixture mode, where there is no
   * database behind the demo profile at all.
   */
  demoProfileReadOnly:
    "The saved demo profile cannot be changed. Take your own selfie to adjust yours.",
} as const;

export type ServerMessages = typeof messages;

/**
 * The lines above that are not quoted from docs/01-user-flow.md. Same idea as
 * COPY_NOT_IN_FLOW_DOC in src/lib/shared/copy.ts, so a string cannot quietly be
 * promoted to "from the doc".
 */
export const SERVER_MESSAGES_NOT_IN_FLOW_DOC = [
  "signedOut",
  "consentRequired",
  "invalidRequest",
  "captureNotFound",
  "captureMissingOriginal",
  "tooManyRequests",
  "dailyCapReached",
  "providerCallsDisabled",
  "serverError",
  "notConfigured",
  "providerRefused",
  "analysisUnavailable",
  "hairTypeNeedsThreePhotos",
  "renderInProgress",
  "renderLimitReached",
  "profileNotReady",
  "demoProfileReadOnly",
] as const;
