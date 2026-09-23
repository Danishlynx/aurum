import { existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A still camera for the capture specs.
 *
 * Chromium's fake capture device synthesises whatever size the app asks for
 * (1920 by 1920 under the app's ideal constraints) and animates it: a
 * sweeping arc and a running clock, which between two samples 400ms apart
 * reads as motion 18 on the live line's scale every third sample. That is a
 * camera that never holds still, so on it the ready hold can never complete
 * and the auto capture can never fire, and the frame it sends is a size no
 * phone delivers. Handing Chromium a file instead
 * (--use-file-for-fake-video-capture) makes the camera deliver the file's
 * frames in a loop at the file's own size: a flat, evenly lit picture that
 * does not move.
 *
 * Portrait, 360 by 480, because the specs run under a phone profile: a
 * landscape track on a touch device is a phone held sideways, and the live
 * line rightly answers "Hold the phone upright" to it rather than "ready".
 * A phone's front camera hands over a portrait track, so the still camera
 * does too. Small on purpose: masterRectFor keeps the whole 360 by 480 and
 * the draw lifts it to the 480 px floor, 480 by 640, which is the floor
 * being exercised end to end.
 *
 * Flat mid grey: a face luma of 0.50 on the gate's 0 to 1 scale, inside the
 * light bands, nothing blown and nothing crushed, so the only thing the gate
 * and the line have to say about a frame is what the seam's synthetic face
 * says. No photograph of a person enters this repository
 * (docs/06-safety-privacy.md), and no binary enters it either: the file is
 * written into the temp directory when the spec loads, before the browser
 * launches.
 */

export const FLAT_CAMERA_SIZE = { width: 360, height: 480 } as const;

/** Y4M frames, identical, so a looped file is a still picture. */
const FRAMES = 3;

/** Limited range luma for mid grey: (126 minus 16) times 1.164 is about 128. */
const FLAT_LUMA = 126;
const FLAT_CHROMA = 128;

export function flatCameraFile(): string {
  const { width, height } = FLAT_CAMERA_SIZE;
  const header = Buffer.from(
    `YUV4MPEG2 W${String(width)} H${String(height)} F30:1 Ip A1:1 C420jpeg\n`,
    "ascii",
  );
  const frameHeader = Buffer.from("FRAME\n", "ascii");
  const luma = Buffer.alloc(width * height, FLAT_LUMA);
  const chroma = Buffer.alloc((width / 2) * (height / 2), FLAT_CHROMA);
  const frame = Buffer.concat([frameHeader, luma, chroma, chroma]);
  const file = Buffer.concat([header, ...Array.from({ length: FRAMES }, () => frame)]);

  const path = join(
    tmpdir(),
    `aurum-e2e-flat-camera-${String(width)}x${String(height)}.y4m`,
  );
  if (!existsSync(path) || statSync(path).size !== file.length) {
    writeFileSync(path, file);
  }
  return path;
}
