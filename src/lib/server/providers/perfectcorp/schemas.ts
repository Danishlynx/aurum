import "server-only";

import { z } from "zod";

/**
 * Zod for every Perfect Corp response field we read.
 * Unknown fields are dropped, per docs/03-architecture.md. If a field we depend
 * on is missing the parse fails and the job fails with the issue paths only,
 * never with the payload.
 */

/** Every response is wrapped in { status, data }. */
const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    status: z.number(),
    data,
  });

/* ------------------------------------------------------------------ */
/* File API                                                            */
/* ------------------------------------------------------------------ */

export const uploadRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});

export const fileSlotSchema = z.object({
  content_type: z.string(),
  file_name: z.string(),
  file_id: z.string(),
  requests: z.array(uploadRequestSchema).min(1),
});

export const fileResponseSchema = envelope(
  z.object({
    files: z.array(fileSlotSchema).min(1),
  }),
);

export type FileSlot = z.infer<typeof fileSlotSchema>;

/* ------------------------------------------------------------------ */
/* Task creation and polling                                           */
/* ------------------------------------------------------------------ */

export const taskCreateResponseSchema = envelope(
  z.object({
    task_id: z.string().min(1),
  }),
);

/**
 * The docs list running, success, and error. The string stays open so an
 * unrecorded intermediate state keeps the job polling instead of failing it.
 */
export const taskStatusResponseSchema = envelope(
  z.object({
    task_status: z.string(),
    error: z.string().optional(),
    error_code: z.union([z.string(), z.number()]).optional(),
    results: z.unknown().optional(),
    polling_interval: z.number().optional(),
  }),
);

export type TaskStatusResponse = z.infer<typeof taskStatusResponseSchema>;

export type NormalizedTaskState = "running" | "succeeded" | "failed";

const SUCCESS_STATES: ReadonlySet<string> = new Set(["success", "succeeded", "completed"]);
const FAILURE_STATES: ReadonlySet<string> = new Set(["error", "failed", "cancelled", "canceled"]);

export function normalizeTaskState(raw: string): NormalizedTaskState {
  const value = raw.trim().toLowerCase();
  if (SUCCESS_STATES.has(value)) {
    return "succeeded";
  }
  if (FAILURE_STATES.has(value)) {
    return "failed";
  }
  return "running";
}

/* ------------------------------------------------------------------ */
/* Render results (makeup, hair, cloth, accessory, simulation)         */
/* ------------------------------------------------------------------ */

/**
 * Confirmed for makeup, hairstyle, and cloth: data.results.url. Some endpoints
 * return a list instead, so both are accepted and normalized in index.ts.
 */
export const renderResultSchema = z.union([
  z.object({ url: z.string() }),
  z.object({ urls: z.array(z.string()).min(1) }),
  z.array(z.object({ url: z.string() })).min(1),
]);

export type RenderResult = z.infer<typeof renderResultSchema>;

/* ------------------------------------------------------------------ */
/* Skin analysis                                                       */
/* ------------------------------------------------------------------ */

export const skinConcernOutputSchema = z.object({
  type: z.string(),
  ui_score: z.number(),
  raw_score: z.number(),
  mask_urls: z.array(z.string()).optional(),
});

export const skinAnalysisResultSchema = z.object({
  output: z.array(skinConcernOutputSchema).min(1),
  skin_age: z.number().optional(),
  all: z.object({ score: z.number() }).optional(),
});

export type SkinAnalysisResult = z.infer<typeof skinAnalysisResultSchema>;

/**
 * The SD concern keys. SD and HD keys cannot be mixed in one call, so the
 * capture flow sends SD only. Confirmed on the skin analysis reference.
 */
export const SD_SKIN_CONCERN_KEYS = [
  "wrinkle",
  "pore",
  "texture",
  "acne",
  "moisture",
  "eye_bag",
  "dark_circle_v2",
  "age_spot",
  "radiance",
  "redness",
  "oiliness",
  "firmness",
  "droopy_upper_eyelid",
  "droopy_lower_eyelid",
  "tear_trough",
  "skin_type",
] as const;

export const HD_SKIN_CONCERN_KEYS = [
  "hd_wrinkle",
  "hd_pore",
  "hd_texture",
  "hd_acne",
  "hd_moisture",
  "hd_eye_bag",
  "hd_dark_circle",
  "hd_age_spot",
  "hd_radiance",
  "hd_redness",
  "hd_oiliness",
  "hd_firmness",
  "hd_droopy_upper_eyelid",
  "hd_droopy_lower_eyelid",
  "hd_tear_trough",
  "hd_skin_type",
] as const;

export type SdSkinConcernKey = (typeof SD_SKIN_CONCERN_KEYS)[number];
export type HdSkinConcernKey = (typeof HD_SKIN_CONCERN_KEYS)[number];

/* ------------------------------------------------------------------ */
/* Facial colour tones                                                 */
/* ------------------------------------------------------------------ */

export const facialColorTonesResultSchema = z.object({
  color: z.object({
    skin_color: z.string(),
    eye_color: z.string(),
    eye_color_name: z.string(),
    lip_color: z.string(),
    eyebrow_color: z.string(),
    hair_color: z.string(),
    hair_color_name: z.string(),
  }),
});

export type FacialColorTonesResult = z.infer<typeof facialColorTonesResultSchema>;

/** Face angle checking, from strict to flexible. Default is high. */
export const FACE_ANGLE_STRICTNESS_LEVELS = [
  "strict",
  "high",
  "medium",
  "low",
  "flexible",
] as const;

export type FaceAngleStrictnessLevel = (typeof FACE_ANGLE_STRICTNESS_LEVELS)[number];

/* ------------------------------------------------------------------ */
/* Face attributes and ratios                                          */
/* ------------------------------------------------------------------ */

export const FACE_SHAPE_VALUES = [
  "Triangle",
  "Diamond",
  "Heart",
  "InvTriangle",
  "Oblong",
  "Oval",
  "Round",
  "Square",
  "Unknown",
] as const;

export type FaceShapeValue = (typeof FACE_SHAPE_VALUES)[number];

export const FACE_ATTRIBUTE_NAMES = [
  "faceShape",
  "age",
  "gender",
  "eyeShape",
  "eyeSize",
  "eyeAngle",
  "eyeDistance",
  "eyelid",
  "eyebrowShape",
  "eyebrowThickness",
  "eyebrowDistance",
  "eyebrowShortness",
  "lipShape",
  "noseWidth",
  "noseLength",
  "cheekbones",
] as const;

export type FaceAttributeName = (typeof FACE_ATTRIBUTE_NAMES)[number];

/**
 * The container that holds the attribute values is not confirmed, so the values
 * are read as a flat map of name to string. The endpoint is marked unverified
 * for exactly this reason.
 */
export const faceAttributesResultSchema = z.object({
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  face_shape: z.string().optional(),
  faceShape: z.string().optional(),
});

export type FaceAttributesResult = z.infer<typeof faceAttributesResultSchema>;

/* ------------------------------------------------------------------ */
/* Hair type                                                           */
/* ------------------------------------------------------------------ */

export const hairTypeResultSchema = z.object({
  mapping: z.string(),
  term: z.string(),
});

export type HairTypeResult = z.infer<typeof hairTypeResultSchema>;

/* ------------------------------------------------------------------ */
/* Skin simulation                                                     */
/* ------------------------------------------------------------------ */

export const SIMULATABLE_CONCERNS = [
  "radiance",
  "acne",
  "oiliness",
  "eye_bags",
  "dark_circles",
  "spots",
  "pores",
  "texture",
  "wrinkles",
  "redness",
] as const;

export type SimulatableConcern = (typeof SIMULATABLE_CONCERNS)[number];
