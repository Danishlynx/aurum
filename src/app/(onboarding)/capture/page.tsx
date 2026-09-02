import { CaptureScreen } from "@/components/capture/CaptureScreen";
import { judgeAnalysesRemaining } from "@/lib/server/judge";
import { readJudgeSessionFromCookie } from "@/lib/server/judge/guard";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * The screen is entirely client side: the camera, the downscale, the EXIF strip,
 * the hash, and the quality gate all run in the browser so a bad frame never
 * costs a credit and a raw file never leaves the phone unmeasured.
 *
 * The one thing the server decides is whether to offer the camera at all.
 * docs/01-user-flow.md, "Judge mode across the flow": at zero remaining analyses
 * "capture is disabled" and every screen renders from the demo profile. Deciding
 * that here rather than after a photo is taken is the difference between a
 * disabled screen and a screen that lets someone frame a selfie, take it, and
 * only then be told it will not be read.
 *
 * A judge session is read from its cookie alone, never through Supabase Auth, so
 * this page still renders on a build with no project configured.
 */

/** The page reads the judge cookie, so it is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const judge = await readJudgeSessionFromCookie();
  const exhausted = judge !== null && judgeAnalysesRemaining(judge) === 0;

  return <CaptureScreen analysesExhausted={exhausted} />;
}
