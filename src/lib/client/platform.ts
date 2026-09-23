/**
 * Which kind of device took the frame, for the calibration column and nothing
 * else.
 *
 * The one go reading rate is stratified by platform (docs/05-evals.md), because
 * the three kinds of camera behave differently: an iPhone front stream reports
 * the landscape sensor size for its first frames and then the portrait one, an
 * Android track swaps on rotation, and a laptop webcam is a wide 16:9 strip. A
 * threshold that holds on one of them can fail on another, so a stored row says
 * which one measured it.
 *
 * The user agent string is the only input and the answer is one of three words.
 * It is not a fingerprint: nothing finer than "phone from Apple, phone from
 * anyone else, or neither" is read, and the string itself is never stored.
 */

export type CapturePlatform = "ios" | "android" | "desktop";

/** Pure, so it can be tested without a browser. */
export function platformFromUserAgent(userAgent: string): CapturePlatform {
  if (/iPhone|iPad|iPod/u.test(userAgent)) {
    return "ios";
  }
  if (/Android/u.test(userAgent)) {
    return "android";
  }
  return "desktop";
}

/** The platform this code is running on, or desktop where there is no browser. */
export function currentPlatform(): CapturePlatform {
  if (typeof navigator === "undefined" || typeof navigator.userAgent !== "string") {
    return "desktop";
  }
  return platformFromUserAgent(navigator.userAgent);
}
