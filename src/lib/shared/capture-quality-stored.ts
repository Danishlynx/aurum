/**
 * What captures.quality holds, and the one function that writes it.
 *
 * The column is the calibration half of the capture gate: every number the
 * client measured sits beside the verdict it gave, so a threshold can be checked
 * against what the engine then did with the frame. Until 2026-09-23 the route
 * wrote eight of those numbers and dropped the rest. pose, faceWidthRatio and
 * faceSource were validated by captureQualitySchema and thrown away one line
 * later, so no pose the app ever measured was stored and there was nothing to
 * calibrate against. This module is the fix: one pure function that writes
 * every validated field, tested to keep doing so.
 *
 * Keys are snake case, matching the column comment in the migrations and the
 * capture_outcomes view, which reads them with ->>. The eight original keys keep
 * their names and their meaning (exposure is meanLuminance, see the route) so an
 * older reader still finds what it read before.
 *
 * A field the client did not send is left out rather than written as null: the
 * absence says "this build did not measure it", which is a different fact from
 * "it was measured and there was nothing", and the view treats both as null
 * anyway.
 */

import { z } from "zod";

import type { CaptureQuality } from "./schemas";

/**
 * The stored shape read back, for the calibration export and the eval that
 * runs on it. Everything but the verdict is optional and nullable, because rows
 * written by older builds carry fewer keys and a row that fails to parse would
 * be a row the calibration could not count. Unknown keys are dropped.
 */
const storedNumber = () => z.number().nullable().optional();

export const storedCaptureQualitySchema = z.object({
  verdict: z.enum(["accept", "borderline", "reject"]),
  reason: z.string().nullable().optional(),
  sharpness: storedNumber(),
  exposure: storedNumber(),
  face_coverage: storedNumber(),
  blown_fraction: storedNumber(),
  crushed_fraction: storedNumber(),
  mean_luminance: storedNumber(),
  face_width_ratio: storedNumber(),
  pose: z
    .object({
      yaw_degrees: z.number(),
      pitch_degrees: z.number(),
      roll_degrees: z.number(),
    })
    .nullable()
    .optional(),
  face_source: z.string().nullable().optional(),
  measured: z.boolean().nullable().optional(),
  platform: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  attempt: z.number().nullable().optional(),
  frame: z
    .object({
      source_width: z.number(),
      source_height: z.number(),
      master_width: z.number(),
      master_height: z.number(),
    })
    .nullable()
    .optional(),
  face_bbox_ratio: storedNumber(),
  mesh_width_ratio: storedNumber(),
  face_center: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  face_luma: storedNumber(),
  face_luma_uneven: storedNumber(),
  blink: z.object({ left: z.number(), right: z.number() }).nullable().optional(),
  burst_losers: z
    .array(
      z.object({
        yaw: z.number().nullable(),
        pitch: z.number().nullable(),
        roll: z.number().nullable(),
        face_width_ratio: z.number().nullable(),
        face_luma: z.number().nullable(),
        blink_max: z.number().nullable(),
        sharpness: z.number().nullable(),
        score: z.number().nullable(),
      }),
    )
    .nullable()
    .optional(),
  landmarker_ms: storedNumber(),
  frame_geometry_version: storedNumber(),
});

export type StoredCaptureQualityRead = z.infer<typeof storedCaptureQualitySchema>;

/** A JSON value, spelled locally so this module stays free of server imports. */
export type StoredJson =
  | string
  | number
  | boolean
  | null
  | { [key: string]: StoredJson | undefined }
  | StoredJson[];

export type StoredCaptureQuality = { [key: string]: StoredJson | undefined };

/**
 * The eight keys every row carried from the column's first build to
 * 2026-09-23. exposure, mean_luminance and face_coverage are written only when
 * the client sent them, which a build from that date on does not.
 */
export const STORED_QUALITY_ORIGINAL_KEYS = [
  "sharpness",
  "exposure",
  "face_coverage",
  "verdict",
  "reason",
  "blown_fraction",
  "crushed_fraction",
  "mean_luminance",
] as const;

/** The keys added on 2026-09-23, one per calibration field. */
export const STORED_QUALITY_CALIBRATION_KEYS = [
  "face_width_ratio",
  "pose",
  "face_source",
  "measured",
  "platform",
  "path",
  "attempt",
  "frame",
  "face_bbox_ratio",
  "mesh_width_ratio",
  "face_center",
  "face_luma",
  "face_luma_uneven",
  "blink",
  "burst_losers",
  "landmarker_ms",
  "frame_geometry_version",
] as const;

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export function storedCaptureQualityFrom(
  quality: CaptureQuality,
): StoredCaptureQuality {
  const stored: StoredCaptureQuality = {
    sharpness: quality.sharpness,
    verdict: quality.verdict,
    reason: quality.reason,
    blown_fraction: quality.blownFraction,
    crushed_fraction: quality.crushedFraction,
  };

  /*
   * Two of the original eight, optional since 2026-09-23: the gate measures
   * light over the face oval (face_luma) and reads no face box height, so a
   * row from this build onward carries neither, while a row from an earlier
   * build still writes both under the names it always had.
   */
  if (present(quality.meanLuminance)) {
    stored.exposure = quality.meanLuminance;
    stored.mean_luminance = quality.meanLuminance;
  }
  if (present(quality.faceCoverage)) {
    stored.face_coverage = quality.faceCoverage;
  }

  if (present(quality.faceWidthRatio)) {
    stored.face_width_ratio = quality.faceWidthRatio;
  }
  if (present(quality.pose)) {
    stored.pose =
      quality.pose === null
        ? null
        : {
            yaw_degrees: quality.pose.yawDegrees,
            pitch_degrees: quality.pose.pitchDegrees,
            roll_degrees: quality.pose.rollDegrees,
          };
  }
  if (present(quality.faceSource)) {
    stored.face_source = quality.faceSource;
  }
  if (present(quality.measured)) {
    stored.measured = quality.measured;
  }
  if (present(quality.platform)) {
    stored.platform = quality.platform;
  }
  if (present(quality.path)) {
    stored.path = quality.path;
  }
  if (present(quality.attempt)) {
    stored.attempt = quality.attempt;
  }
  if (present(quality.frame)) {
    stored.frame = {
      source_width: quality.frame.sourceWidth,
      source_height: quality.frame.sourceHeight,
      master_width: quality.frame.masterWidth,
      master_height: quality.frame.masterHeight,
    };
  }
  if (present(quality.faceBboxRatio)) {
    stored.face_bbox_ratio = quality.faceBboxRatio;
  }
  if (present(quality.meshWidthRatio)) {
    stored.mesh_width_ratio = quality.meshWidthRatio;
  }
  if (present(quality.faceCenter)) {
    stored.face_center =
      quality.faceCenter === null
        ? null
        : { x: quality.faceCenter.x, y: quality.faceCenter.y };
  }
  if (present(quality.faceLuma)) {
    stored.face_luma = quality.faceLuma;
  }
  if (present(quality.faceLumaUneven)) {
    stored.face_luma_uneven = quality.faceLumaUneven;
  }
  if (present(quality.blink)) {
    stored.blink =
      quality.blink === null
        ? null
        : { left: quality.blink.left, right: quality.blink.right };
  }
  if (present(quality.burstLosers)) {
    stored.burst_losers = quality.burstLosers.map((loser) => ({
      yaw: loser.yaw,
      pitch: loser.pitch,
      roll: loser.roll,
      face_width_ratio: loser.faceWidthRatio,
      face_luma: loser.faceLuma,
      blink_max: loser.blinkMax,
      sharpness: loser.sharpness,
      score: loser.score,
    }));
  }
  if (present(quality.landmarkerMs)) {
    stored.landmarker_ms = quality.landmarkerMs;
  }
  if (present(quality.frameGeometryVersion)) {
    stored.frame_geometry_version = quality.frameGeometryVersion;
  }

  return stored;
}
