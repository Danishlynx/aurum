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
/* Credit balance                                                      */
/* ------------------------------------------------------------------ */

/**
 * One grant of units on the account. Only the three fields we display are
 * required: the endpoint also returns id and amount_dec, and a health route
 * should not break because a bookkeeping field changed shape.
 */
export const creditGrantSchema = z.object({
  type: z.string(),
  amount: z.number(),
  /** Milliseconds since epoch. */
  expiry: z.number().optional(),
});

/**
 * The one response that is not wrapped in { status, data }: the credit endpoint
 * uses { status, results }. Confirmed against the live API, see endpoints.ts.
 */
export const creditBalanceResponseSchema = z.object({
  status: z.number(),
  results: z.array(creditGrantSchema),
});

export type CreditGrantResponse = z.infer<typeof creditGrantSchema>;

/* ------------------------------------------------------------------ */
/* Task creation and polling                                           */
/* ------------------------------------------------------------------ */

export const taskCreateResponseSchema = envelope(
  z.object({
    task_id: z.string().min(1),
  }),
);

/**
 * The task status body, confirmed against the live API on 2026-09-02.
 *
 * The real envelope, from a successful skin analysis poll:
 *
 *     { "status": 200,
 *       "data": { "error": null, "results": { ... }, "task_status": "success" } }
 *
 * Two facts that cost us a task and its units the first time round:
 *
 * 1. data.error is present and null on a successful task. It is not absent.
 *    z.string().optional() accepts undefined and rejects null, so the first
 *    real response failed to parse at data.error, the poll threw
 *    invalid_response, and a task that had succeeded (and been charged) was
 *    recorded as failed. Every field the provider may send as null is nullish
 *    here for exactly that reason.
 * 2. The string stays open so an unrecorded intermediate state keeps the job
 *    polling instead of failing it.
 *
 * UNVERIFIED: only the skin analysis task has been read live. The same envelope
 * is assumed for skin-tone-analysis, face-attr-analysis, makeup-vto and
 * hair-transfer, which is recorded per endpoint in endpoints.ts. It is a safe
 * assumption to make permissive: nothing here requires a field the other task
 * APIs might not send.
 */
export const taskStatusResponseSchema = envelope(
  z.object({
    task_status: z.string(),
    error: z.string().nullish(),
    error_code: z.union([z.string(), z.number()]).nullish(),
    results: z.unknown().nullish(),
    polling_interval: z.number().nullish(),
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

/**
 * One entry of data.results.output, confirmed against the live API on
 * 2026-09-02. The array is not homogeneous: it mixes four kinds of entry, all
 * of them carrying only "type" in common.
 *
 * 1. A scored concern: ui_score, raw_score, mask_urls, url null.
 *    Seen for eye_bag, tear_trough, redness, oiliness, pore,
 *    droopy_lower_eyelid, droopy_upper_eyelid, dark_circle_v2, texture,
 *    firmness, radiance, age_spot, wrinkle, acne, moisture.
 * 2. skin_type, once per zone. No score at all: it carries region ("whole",
 *    "t_zone", "u_zone") and skin_type (for example "Normal"), plus a mask.
 * 3. "all" and "skin_age". Neither has a mask and neither uses ui_score: both
 *    carry their number under "score" (85.4 overall, 28 years).
 * 4. "resize_image": the frame the provider worked from, mask_urls only. Not a
 *    reading, and never shown as one.
 *
 * Every field except type is therefore optional and nullable. Nothing is
 * dropped for being unexpected: readSkinAnalysis below sorts the entries out.
 */
export const skinConcernOutputSchema = z.object({
  type: z.string(),
  /**
   * The provider's 1 to 100 condition score. Absent on the entries that carry
   * no score, and the empty string when the engine could not produce one.
   */
  ui_score: z.union([z.number(), z.literal("")]).nullish(),
  raw_score: z.number().nullish(),
  /** How "all" and "skin_age" carry their value. */
  score: z.number().nullish(),
  /** skin_type only: "whole", "t_zone", or "u_zone". */
  region: z.string().nullish(),
  /** skin_type only: the classification, for example "Normal". */
  skin_type: z.string().nullish(),
  mask_urls: z.array(z.string()).nullish(),
  url: z.string().nullish(),
});

export type SkinConcernOutput = z.infer<typeof skinConcernOutputSchema>;

/**
 * data.results for a skin analysis task.
 *
 * skin_age and all are read from the output entries above. They are also
 * accepted here as siblings of output, which is where an earlier reading of the
 * reference page put them. That shape has never been seen on the wire, so it is
 * a fallback and not a claim: UNVERIFIED, and readSkinAnalysis prefers the
 * entries.
 */
export const skinAnalysisResultSchema = z.object({
  output: z.array(skinConcernOutputSchema).min(1),
  skin_age: z.number().nullish(),
  all: z.object({ score: z.number() }).nullish(),
});

export type SkinAnalysisResult = z.infer<typeof skinAnalysisResultSchema>;

/* ------------------------------------------------------------------ */
/* Reading the skin analysis output                                    */
/* ------------------------------------------------------------------ */

/**
 * Output types that are not concerns and must never be ranked as one. Kept as a
 * set so an entry the mapping does not know can still be told apart from a
 * concern name we failed to map, which is a warning worth logging.
 */
export const SKIN_OUTPUT_NON_CONCERN_TYPES: ReadonlySet<string> = new Set([
  "all",
  "skin_age",
  "skin_type",
  "resize_image",
]);

/** The provider's zone names, from the live response. */
export const SKIN_TYPE_ZONE_WHOLE = "whole";
export const SKIN_TYPE_ZONE_T = "t_zone";
export const SKIN_TYPE_ZONE_U = "u_zone";

/**
 * The provider's skin type words, mapped into the three zone labels the report
 * speaks (src/lib/server/profile/skin-type.ts, ZONE_LABELS).
 *
 * PARTLY VERIFIED: "Normal" is the only value seen on the wire so far, on all
 * three zones of one face. The other two rows are the obvious readings of the
 * remaining words and are marked here rather than assumed elsewhere. A word
 * that is not in this table maps to null, which sends the report back to the
 * zones it derives from oiliness and moisture instead of inventing a label.
 */
export const PROVIDER_SKIN_TYPE_ZONE_LABELS: Readonly<Record<string, string>> = {
  normal: "balanced",
  oily: "oily",
  dry: "dry",
};

export function skinTypeZoneLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return PROVIDER_SKIN_TYPE_ZONE_LABELS[value.trim().toLowerCase()] ?? null;
}

export interface SkinConcernReading {
  readonly type: string;
  readonly uiScore: number;
  readonly rawScore: number;
  readonly maskUrls: readonly string[];
}

export interface SkinTypeZoneReading {
  /** The provider's own region name. */
  readonly region: string;
  /** The provider's own word, for example "Normal". */
  readonly value: string;
  /** That word in our vocabulary, or null when we do not have one for it. */
  readonly label: string | null;
}

export interface SkinAnalysisReading {
  /** Only the entries that carry a real score. Provider order is kept. */
  readonly concerns: readonly SkinConcernReading[];
  /** From the "skin_age" entry. */
  readonly skinAge: number | null;
  /** From the "all" entry: one number for the whole face. */
  readonly overallScore: number | null;
  readonly skinTypeZones: readonly SkinTypeZoneReading[];
  /** The provider's own resized frame, when it sent one. */
  readonly resizedImageUrl: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Sorts one skin analysis result into the four kinds of entry it mixes.
 *
 * Pure, so the whole shape can be tested against the recorded response with no
 * network and no key. It never throws: an entry it cannot read is left out of
 * every list rather than failing a reading that is otherwise complete.
 *
 * A note on direction, because it decides what the report says. ui_score is a
 * condition score: higher is better, so the 99 on redness here means clear
 * skin, not severe redness. The ranking in src/lib/shared/concerns.ts reads a
 * higher score as "more present", which is the opposite. Reconciling the two is
 * a change to what every report says and is deliberately not made here. It is
 * recorded as an open item on this branch and belongs with eval:consistency.
 */
export function readSkinAnalysis(result: SkinAnalysisResult): SkinAnalysisReading {
  const concerns: SkinConcernReading[] = [];
  const skinTypeZones: SkinTypeZoneReading[] = [];
  let skinAge: number | null = numberOrNull(result.skin_age);
  let overallScore: number | null = numberOrNull(result.all?.score);
  let resizedImageUrl: string | null = null;

  for (const entry of result.output) {
    const masks = entry.mask_urls ?? [];

    if (entry.type === "skin_age") {
      skinAge = numberOrNull(entry.score) ?? skinAge;
      continue;
    }
    if (entry.type === "all") {
      overallScore = numberOrNull(entry.score) ?? overallScore;
      continue;
    }
    if (entry.type === "resize_image") {
      resizedImageUrl = masks[0] ?? entry.url ?? null;
      continue;
    }
    if (entry.type === "skin_type") {
      if (typeof entry.region === "string" && typeof entry.skin_type === "string") {
        skinTypeZones.push({
          region: entry.region,
          value: entry.skin_type,
          label: skinTypeZoneLabel(entry.skin_type),
        });
      }
      continue;
    }

    const uiScore = numberOrNull(entry.ui_score);
    const rawScore = numberOrNull(entry.raw_score);
    if (uiScore === null || rawScore === null) {
      // A concern the engine returned without a score. It is not a reading, so
      // it is not carried as one.
      continue;
    }
    concerns.push({
      type: entry.type,
      uiScore,
      rawScore,
      maskUrls: [...masks],
    });
  }

  return { concerns, skinAge, overallScore, skinTypeZones, resizedImageUrl };
}

/** The zone reading for one provider region name, or null when it is absent. */
export function skinTypeZoneFor(
  reading: SkinAnalysisReading,
  region: string,
): SkinTypeZoneReading | null {
  return reading.skinTypeZones.find((zone) => zone.region === region) ?? null;
}

/**
 * The SD concern keys. SD and HD keys cannot be mixed in one call, so the
 * capture flow sends SD only. Confirmed on the skin analysis reference, and
 * then confirmed live on 2026-09-02: all 16 were accepted in one dst_actions
 * list and every one came back in data.results.output under exactly this
 * spelling. The response also carried three entries nobody asked for ("all",
 * "skin_age", "resize_image") and reported skin_type once per zone.
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
