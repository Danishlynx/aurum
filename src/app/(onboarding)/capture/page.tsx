import { redirect } from "next/navigation";

import { CaptureScreen } from "@/components/capture/CaptureScreen";
import { readCaptureEntry } from "@/lib/server/capture/entry";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * The screen is entirely client side: the camera, the downscale, the EXIF strip,
 * the hash, and the quality gate all run in the browser so a bad frame never
 * costs a credit and a raw file never leaves the phone unmeasured.
 *
 * The server decides two things before offering it, both in
 * src/lib/server/capture/entry.ts.
 *
 * Whether there is a consented session to send the photo to. Section C comes
 * before section D, and with open access on this page sends a device without a
 * session, or with one that has run out, to the consent screen before a photo
 * is framed. Until 2026-09-14 that person took the photo first and was told
 * "Upload did not complete" second.
 *
 * Whether to offer the camera at all. docs/01-user-flow.md, "Judge mode across
 * the flow": at zero remaining analyses "capture is disabled" and every screen
 * renders from the demo profile. Deciding that here rather than after a photo is
 * taken is the difference between a disabled screen and a screen that lets
 * someone frame a selfie, take it, and only then be told it will not be read.
 * That is the answer while JUDGE_PER_SESSION_CAPS is on (src/lib/server/env.ts).
 * With it off the camera is offered to every judge session, whatever its count
 * says, and the deployment wide Perfect Corp ceiling is what stops the spend.
 */

/** The page reads the session cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const entry = await readCaptureEntry();
  if (entry.kind === "welcome") {
    redirect("/welcome");
  }

  return <CaptureScreen analysesExhausted={entry.analysesExhausted} />;
}
