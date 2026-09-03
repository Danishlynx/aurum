/**
 * Why an analysis task came back failed, in the vocabulary the capture screen
 * already speaks.
 *
 * Pure and shared: no I/O, no provider import, so the classification can be
 * tested against the codes the live API really sent without a key.
 *
 * What the engine sends. On 2026-09-02 three refusals were read off the wire,
 * all of them on a task that had been created and accepted:
 *
 *     error_face_angle_rightward
 *     error_face_not_forward_facing
 *     error_no_face
 *
 * The first two came from the skin tone analysis, which checks the face angle
 * strictly and refuses a head that is turned; the skin analyzer is laxer and
 * took the same frame. All three are input refusals: the engine looked at the
 * photo and would not read it, and a failed task is charged nothing, so the
 * reservation goes back and the person is asked for a better frame
 * (docs/04-integrations.md, "Input errors ... Refund the reservation").
 *
 * A fourth was read later, off a photo picked out of the phone's gallery rather
 * than taken on the capture screen:
 *
 *     error_src_face_too_small
 *
 * It lands on "frame" through the markers below and was refunded correctly, but
 * a refusal was never the right answer to it: the face in that photo was fine,
 * it was just small in the picture. The upload path now composes the frame
 * around the face before anything is sent (autoCropBoxFor in
 * src/lib/shared/quality.ts), and when the engine refuses it anyway the client
 * reframes the same photo and sends it back (src/lib/shared/reframe.ts). This
 * line stays for the photo no crop can save.
 *
 * A fifth was read on 2026-09-03, off a phone held below the face:
 *
 *     error_face_angle_downward
 *
 * It is one of a family. The engine names the direction the head is off by, and
 * every spelling of it (downward, upward, leftward, rightward, and the
 * directionless error_face_not_forward_facing) is one instruction to the person:
 * the lens is not square to the face. They all land on "face_angle" through the
 * markers below, and that reason has one line of copy which names the fix rather
 * than the direction, because nobody can act on "rightward" without being told
 * whose right it is.
 *
 * Nothing here treats the provider's text as an instruction or shows it to
 * anyone. The code is matched against the markers below and thrown away; the
 * sentence a person reads comes from copy.ts.
 */

export const ANALYSIS_FAILURE_REASONS = [
  /** The face is turned away from the camera. Confirmed live. */
  "face_angle",
  /** No face in the frame at all. Confirmed live. */
  "no_face",
  /** Something else about the photo the engine would not read. */
  "frame",
  /** Not about the photo: the provider itself refused or broke. */
  "provider",
] as const;

export type AnalysisFailureReason = (typeof ANALYSIS_FAILURE_REASONS)[number];

/**
 * Substring markers, matched in this order against the lowercased code.
 *
 * Order is load bearing: error_face_not_forward_facing carries both "face" and
 * "not_forward", and the angle line is the useful one, so the angle markers are
 * tested first. error_no_face carries "face" too, and the missing face line is
 * more useful than the generic one, so it is tested before the frame markers.
 *
 * Only the three codes in the file comment are confirmed. The rest of each list
 * is the same failure said another way, kept so an unrecorded spelling still
 * lands on a line that is true rather than on the generic refusal.
 */
const FACE_ANGLE_MARKERS = ["face_angle", "not_forward", "face_pose"] as const;

const NO_FACE_MARKERS = [
  "no_face",
  "face_not_found",
  "face_not_detect",
  "no_human_face",
] as const;

/**
 * Codes that name the photo rather than the face. A retake is still the way
 * out, so these read as a frame problem and not as a provider fault.
 */
const FRAME_MARKERS = [
  "face",
  "image",
  "photo",
  "resolution",
  "blur",
  "light",
  "too_small",
  "too_large",
] as const;

function matches(code: string, markers: readonly string[]): boolean {
  return markers.some((marker) => code.includes(marker));
}

/**
 * Classifies one provider failure code.
 *
 * Anything that is not a non empty string, and any code that names none of the
 * markers, is "provider": we do not claim a photo was bad on the strength of a
 * code we cannot read.
 */
export function analysisFailureReasonFor(
  code: string | null | undefined,
): AnalysisFailureReason {
  if (typeof code !== "string") {
    return "provider";
  }
  const normalized = code.trim().toLowerCase();
  if (normalized.length === 0) {
    return "provider";
  }
  if (matches(normalized, FACE_ANGLE_MARKERS)) {
    return "face_angle";
  }
  if (matches(normalized, NO_FACE_MARKERS)) {
    return "no_face";
  }
  if (matches(normalized, FRAME_MARKERS)) {
    return "frame";
  }
  return "provider";
}

/**
 * True when a new photo is the way out of this failure. Used to decide whether
 * the person is asked to retake, never to decide whether to refund: a task that
 * failed is charged nothing whatever the reason, so its reservation always goes
 * back.
 */
export function isRetakeFailure(reason: AnalysisFailureReason): boolean {
  return reason !== "provider";
}

/**
 * True when a tighter crop of the same photo is worth sending.
 *
 * The two reasons that qualify are the ones a frame can be wrong about rather
 * than a person: a face too small in the picture ("frame", which is where
 * error_src_face_too_small and error_src_face_position_too_small land) and a
 * face the engine could not find at all ("no_face"), which on a wide phone
 * gallery photo is often the same problem one step further along.
 *
 * A turned or tilted head is not here. No crop makes a face square to the lens,
 * and sending the same pose back would waste the person's time telling them
 * nothing. Nor is "provider": that is not the photo.
 *
 * Used only to decide whether to re submit (src/lib/client/capture-source.ts).
 * It never decides a refund: a failed task is charged nothing whatever the
 * reason, so its reservation always goes back.
 */
export function isReframeableFailure(reason: AnalysisFailureReason): boolean {
  return reason === "frame" || reason === "no_face";
}
