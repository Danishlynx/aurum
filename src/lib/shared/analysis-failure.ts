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
  /** More than one person in the frame. */
  "multiple_faces",
  /** The face is real and readable but small in the picture. Confirmed live. */
  "face_too_small",
  /** The face runs past the edge of the picture. */
  "face_out_of_bounds",
  /** The engine could not read the photo for want of light. */
  "lighting",
  /** The picture itself is outside the resolution the endpoint accepts. */
  "image_size",
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
const FACE_ANGLE_MARKERS = [
  "face_angle",
  "not_forward",
  "face_pose",
  /* Documented on the hairstyle endpoint. Global list, read 2026-09-07. */
  "large_face_angle",
] as const;

const NO_FACE_MARKERS = [
  "no_face",
  "face_not_found",
  "face_not_detect",
  "no_human_face",
] as const;

/**
 * More than one person in the frame. Documented globally as
 * error_multiple_people, and every face endpoint we call is single face only.
 *
 * It landed on "provider" before 2026-09-07, because it names neither a face nor
 * an image, so the person was told the generic refusal instead of the one thing
 * they could actually do about it.
 */
const MULTIPLE_FACE_MARKERS = ["multiple_people", "multiple_face"] as const;

/**
 * A face that is real, readable, and small in the picture. This is the one
 * refusal a tighter crop genuinely answers, and it is the reason the reframe
 * path exists at all.
 *
 * Both spellings are needed. The skin analyzer says error_src_face_too_small and
 * every other endpoint says error_face_position_too_small, which is a difference
 * in the provider's own tables rather than in the failure.
 */
const FACE_TOO_SMALL_MARKERS = ["face_too_small", "face_position_too_small"] as const;

/**
 * The face runs off the edge of the picture. Cropping tighter is exactly the
 * wrong answer: this frame needs more around the face, not less.
 */
const FACE_OUT_OF_BOUNDS_MARKERS = [
  "out_of_bound",
  "out_of_boundary",
  "face_position_invalid",
] as const;

/**
 * Not enough light. The two endpoints that gate on it spell it differently
 * (error_lighting_dark on the skin analyzer, error_insufficient_lighting on
 * Fitzpatrick) and neither is answerable by a crop.
 */
const LIGHTING_MARKERS = ["lighting", "light_"] as const;

/**
 * The picture itself is outside the resolution the endpoint takes. Cropping
 * makes a picture smaller, so retrying a too small image with a tighter crop is
 * a guaranteed second refusal.
 */
const IMAGE_SIZE_MARKERS = [
  "min_image_size",
  "max_image_size",
  "max_filesize",
  "unsupport_ratio",
] as const;

/**
 * Codes that name the photo rather than the face, and that none of the sharper
 * lists above claimed. A retake is still the way out, so these read as a frame
 * problem and not as a provider fault.
 *
 * "blur" is kept even though the provider publishes no blur code anywhere (all
 * six OpenAPI bundles and the global error list were read on 2026-09-07 and none
 * of them has one), because a marker that never fires costs nothing and the list
 * exists to catch a spelling we have not seen.
 */
const FRAME_MARKERS = [
  "face",
  "image",
  "photo",
  "resolution",
  "blur",
  "too_small",
  "too_large",
  "face_parsing",
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
  if (matches(normalized, MULTIPLE_FACE_MARKERS)) {
    return "multiple_faces";
  }
  /*
   * Before the out of bounds list, because error_face_position_too_small and
   * error_face_position_invalid share the "face_position" stem and only the
   * first of them is answered by a crop.
   */
  if (matches(normalized, FACE_TOO_SMALL_MARKERS)) {
    return "face_too_small";
  }
  if (matches(normalized, FACE_OUT_OF_BOUNDS_MARKERS)) {
    return "face_out_of_bounds";
  }
  if (matches(normalized, LIGHTING_MARKERS)) {
    return "lighting";
  }
  if (matches(normalized, IMAGE_SIZE_MARKERS)) {
    return "image_size";
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
 * The reframe path has exactly two attempts and each one is spent the moment it
 * is tried, so what belongs here is only what a smaller frame can actually
 * answer:
 *
 * - face_too_small, which is the refusal the path was built for. The face is
 *   fine and the picture is loose around it.
 * - no_face, which on a wide phone gallery photo is usually the same problem one
 *   step further along: the face is there and too small for the detector to call
 *   it one.
 * - frame, the unnamed photo problem. A crop is free to try and we have nothing
 *   better to offer.
 *
 * What was here until 2026-09-07 and should not have been. isReframeableFailure
 * returned true for the whole "frame" class, and "frame" was where the old
 * FRAME_MARKERS list put two refusals a crop makes strictly worse:
 *
 * - lighting. error_lighting_dark carries "light", so it read as a frame problem
 *   and the client cropped the same dark photo twice and sent it twice. No crop
 *   has ever added light to a room. Both attempts were spent on a certain
 *   refusal, and the person waited through all of it to be told the same thing.
 * - image_size. error_below_min_image_size carries "image", so a picture refused
 *   for being too small was cropped smaller and sent again.
 *
 * face_out_of_bounds is refused here for the same reason read the other way: a
 * face already running past the edge needs a wider frame, and this path only
 * makes frames narrower. multiple_faces is refused because choosing which face
 * to keep is not a decision this code gets to make on somebody's behalf.
 *
 * Used only to decide whether to re submit (src/lib/client/capture-source.ts).
 * It never decides a refund: a failed task is charged nothing whatever the
 * reason, so its reservation always goes back.
 */
export function isReframeableFailure(reason: AnalysisFailureReason): boolean {
  return (
    reason === "face_too_small" || reason === "no_face" || reason === "frame"
  );
}
