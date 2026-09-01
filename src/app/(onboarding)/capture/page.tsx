import { CaptureScreen } from "@/components/capture/CaptureScreen";

/**
 * D. Capture, docs/01-user-flow.md section D.
 *
 * The screen is entirely client side: the camera, the downscale, the EXIF strip,
 * the hash, and the quality gate all run in the browser so a bad frame never
 * costs a credit and a raw file never leaves the phone unmeasured.
 */
export default function CapturePage() {
  return <CaptureScreen />;
}
