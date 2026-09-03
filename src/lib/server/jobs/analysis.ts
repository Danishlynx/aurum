import "server-only";

import {
  isQualityConcern,
  mapProviderConcern,
  presenceScoreFor,
} from "@/lib/shared/concerns";
import { storedImageType } from "@/lib/shared/image-type";

import { BUCKETS, maskPath, uploadObject } from "../db/storage";
import type { AnalysisKind, Json } from "../db/types";
import {
  createTask,
  downloadResultAssets,
  getEndpoint,
  getTaskSnapshot,
  parseFacialColorTonesResult,
  parseFaceAttributesResult,
  parseHairTypeResult,
  parseSkinAnalysisResult,
  readFaceShape,
  readSkinAnalysis,
  SD_SKIN_CONCERN_KEYS,
  SKIN_TYPE_ZONE_T,
  SKIN_TYPE_ZONE_U,
  skinTypeZoneFor,
  uploadImage,
  type CreatedTask,
  type PerfectCorpEndpointKey,
  type SkinAnalysisReading,
  type TaskSnapshot,
} from "../providers/perfectcorp";
import { ENDPOINT_FOR_ANALYSIS, perfectCorpUnits } from "../credits/costs";

/**
 * The adapter between our analysis kinds and the Perfect Corp provider module.
 *
 * The provider module owns the wire format; this file owns the choice of what to
 * ask for. It exists because the jobs runner needs to start one task at a time
 * (a retry restarts a single kind, not the whole fan out), while the provider
 * module's own fan out helper starts all five together.
 *
 * The file id field name is read from endpoints.ts rather than retyped, so a
 * correction there reaches this file without an edit.
 */

/**
 * The face attributes endpoint is priced by how many attributes are asked for
 * (10 units for 1 to 5). Face shape is the only one this app reads from it:
 * skin, eye, and hair colors come from the facial color tones endpoint. Asking
 * for one attribute keeps the call in the cheapest tier.
 */
export const FACE_ATTRIBUTES_REQUESTED = ["faceShape"] as const;

/** Every SD concern. SD and HD keys cannot be mixed in one call. */
const SKIN_CONCERNS = SD_SKIN_CONCERN_KEYS;

/** Masks are stored for at most this many concerns, newest ranking first. */
const MAX_MASKS_PER_CAPTURE = 8;

export interface AnalysisPlan {
  readonly kind: AnalysisKind;
  readonly endpointKey: PerfectCorpEndpointKey;
  readonly itemCount: number;
  readonly units: number;
}

export function planFor(kind: AnalysisKind): AnalysisPlan {
  const endpointKey = ENDPOINT_FOR_ANALYSIS[kind];
  const itemCount =
    kind === "skin"
      ? SKIN_CONCERNS.length
      : kind === "face_shape"
        ? FACE_ATTRIBUTES_REQUESTED.length
        : 1;
  return {
    kind,
    endpointKey,
    itemCount,
    units: perfectCorpUnits(endpointKey, itemCount),
  };
}

/**
 * Hair type detection takes three photos of the same size (front, right, left).
 * The capture flow has one selfie, so this kind cannot run yet. Saying so here,
 * once, keeps the reason in one place.
 * Open product decision, recorded in endpoints.ts as well.
 */
export function requiresMorePhotos(kind: AnalysisKind): boolean {
  return kind === "hair_type";
}

/**
 * The request body one analysis kind sends, from the endpoint table's own field
 * names. Pure and exported so evals/golden/render-bodies.test.ts can assert the
 * shape without a network call, which is how the face shape body would have been
 * caught: it spent two days sending a field this endpoint does not have.
 */
export function analysisTaskBody(
  kind: AnalysisKind,
  fileId: string,
): Record<string, unknown> {
  const endpoint = getEndpoint(ENDPOINT_FOR_ANALYSIS[kind]);
  const fileField = endpoint.sourceFileFields[0] ?? "src_file_id";

  switch (kind) {
    case "skin":
      return {
        [fileField]: fileId,
        dst_actions: [...SKIN_CONCERNS],
        format: "json",
      };
    case "fitzpatrick":
      return { [fileField]: fileId };
    case "attributes":
      return { [fileField]: fileId, face_angle_strictness_level: "high" };
    /*
     * "features", not "dst_actions". The skin analyzer spells its selection
     * dst_actions and this call was sending the same word, which the server
     * answers with a 400 "features is required but wasn't included in your
     * request." So face shape never ran, on any capture, whatever the balance
     * was: /hair has been showing "your face shape was not read from this photo"
     * because the request was malformed, not because the photo was.
     * face_angle_strictness_level is the provider's own default of "high",
     * repeated here so this call and the tone call agree about which frames they
     * accept rather than one of them relying on an unstated default.
     */
    case "face_shape":
      return {
        [fileField]: fileId,
        features: [...FACE_ATTRIBUTES_REQUESTED],
        face_angle_strictness_level: "high",
      };
    case "hair_type":
      return { [fileField]: [fileId] };
  }
}

/** Uploads the selfie once. The file id is reused by every task in the fan out. */
export async function uploadCapture(args: {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly captureId: string;
}): Promise<string> {
  const contentType =
    args.contentType === "image/png" ? "image/png" : "image/jpeg";
  const extension = contentType === "image/png" ? "png" : "jpg";
  const uploaded = await uploadImage({
    fileName: `${args.captureId}.${extension}`,
    contentType,
    bytes: args.bytes,
  });
  return uploaded.fileId;
}

export async function startTask(args: {
  readonly kind: AnalysisKind;
  readonly fileId: string;
}): Promise<CreatedTask> {
  const plan = planFor(args.kind);
  return createTask({
    endpointKey: plan.endpointKey,
    body: analysisTaskBody(args.kind, args.fileId),
    itemCount: plan.itemCount,
  });
}

export async function readTask(args: {
  readonly kind: AnalysisKind;
  readonly taskId: string;
}): Promise<TaskSnapshot> {
  return getTaskSnapshot({
    endpointKey: ENDPOINT_FOR_ANALYSIS[args.kind],
    taskId: args.taskId,
  });
}

// ---------------------------------------------------------------------------
// Normalizing a finished task
// ---------------------------------------------------------------------------

/**
 * A value is stored in jsonb only if it survives a JSON round trip. Anything
 * else (a Map, a cycle, undefined) becomes null rather than a failed insert.
 */
export function toJson(value: unknown): Json | null {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) {
      return null;
    }
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

export interface NormalizedAnalysis {
  /** Validated provider response, image bytes excluded. */
  readonly raw: Json | null;
  /** The shape feature code reads. */
  readonly summary: Json;
  /**
   * Mask images to fetch before their URLs expire, in the order the report will
   * show their concerns. providerType is the name the mask came back under,
   * which is what lets a saved mask file be matched back to its concern without
   * reconstructing the selection rule.
   */
  readonly maskUrls: ReadonlyArray<{
    readonly key: string;
    readonly url: string;
    readonly providerType?: string;
  }>;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * UNVERIFIED. endpoints.ts records that the Fitzpatrick result field names are
 * not confirmed, so the type is looked for under the names the reference page
 * suggests and the whole payload is kept in `raw` either way.
 *
 * TODO: replace this search with the real field once the human reads a live
 * response from the API playground, and update endpoints.ts at the same time.
 */
function readFitzpatrick(results: unknown): number | null {
  if (typeof results !== "object" || results === null) {
    return null;
  }
  const record = results as Record<string, unknown>;
  const candidates = [
    record.fitzpatrick,
    record.fitzpatrick_type,
    record.skin_type,
    record.type,
    record.level,
  ];
  for (const candidate of candidates) {
    const parsed = readInteger(candidate);
    if (parsed !== null && parsed >= 1 && parsed <= 6) {
      return parsed;
    }
  }
  return null;
}

/**
 * Which masks are worth the storage budget.
 *
 * The report's mask toggles sit on the concern rows, and the rows are ordered
 * by presence, so the masks have to follow the same order: storing the first
 * eight the provider happened to list left the top concerns without a mask and
 * spent slots on the clearest skin on the face. On the measured face that meant
 * keeping redness and oiliness, both at a presence of 1, and dropping dark
 * circles, the most present concern of all.
 *
 * The order here is the first phase of rankConcernsToneFirst: presence
 * descending, ties broken by key so the same response always produces the same
 * eight. The tone first promotion is deliberately not applied, because it needs
 * a Fitzpatrick type that the skin analysis alone does not carry. It only ever
 * reorders concerns that are already within 12 points of each other, so it
 * cannot pull a concern into the top eight that this order left out.
 *
 * The two quality concerns go last whatever their level: moisture and radiance
 * are not problems to point at, so they take a mask slot only if one is spare.
 *
 * One mask per concern key. The provider scores the upper and the lower eyelid
 * separately and both map to eyelid_droop, so the more present of the two wins
 * the slot rather than the second overwriting the first and wasting it.
 */
function selectMasks(
  reading: SkinAnalysisReading,
): Array<{ key: string; url: string; providerType: string }> {
  const best = new Map<
    string,
    { key: string; url: string; providerType: string; presence: number; quality: boolean }
  >();

  for (const entry of reading.concerns) {
    const url = entry.maskUrls[0];
    const key = mapProviderConcern(entry.type);
    if (url === undefined || key === null) {
      continue;
    }
    const presence = presenceScoreFor({ key, providerUiScore: entry.uiScore });
    const existing = best.get(key);
    if (existing === undefined || presence > existing.presence) {
      best.set(key, {
        key,
        url,
        providerType: entry.type,
        presence,
        quality: isQualityConcern(key),
      });
    }
  }

  return [...best.values()]
    .sort((left, right) => {
      if (left.quality !== right.quality) {
        return left.quality ? 1 : -1;
      }
      if (left.presence !== right.presence) {
        return right.presence - left.presence;
      }
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    })
    .slice(0, MAX_MASKS_PER_CAPTURE)
    .map((entry) => ({
      key: entry.key,
      url: entry.url,
      providerType: entry.providerType,
    }));
}

/**
 * The two zones the report shows, taken from the provider's own skin type
 * output rather than derived from oiliness and moisture.
 *
 * The provider reports three regions: whole, t_zone, and u_zone. The report
 * speaks of a T zone and cheeks, and the U zone is the cheeks and jaw, so that
 * is the pairing. "whole" is not shown on its own: it is the same reading at a
 * coarser grain and it stays in `raw`.
 *
 * Returns null when neither zone carries a word we have a label for, which
 * sends src/lib/server/profile/skin-type.ts back to its derived reading instead
 * of showing a provider word the report cannot say.
 */
function skinTypeZonesFor(
  reading: SkinAnalysisReading,
): { readonly tZone: string | null; readonly cheeks: string | null } | null {
  const tZone = skinTypeZoneFor(reading, SKIN_TYPE_ZONE_T)?.label ?? null;
  const cheeks = skinTypeZoneFor(reading, SKIN_TYPE_ZONE_U)?.label ?? null;
  if (tZone === null && cheeks === null) {
    return null;
  }
  return { tZone, cheeks };
}

export function normalize(
  kind: AnalysisKind,
  snapshot: TaskSnapshot,
): NormalizedAnalysis {
  switch (kind) {
    case "skin": {
      const result = parseSkinAnalysisResult(snapshot);
      const reading = readSkinAnalysis(result);

      /*
       * The one place the provider's scale is turned into ours. ui_score is a
       * condition score (higher is healthier) and everything downstream reads a
       * score as presence, so presenceScoreFor inverts it, leaving the two
       * quality concerns alone. The whole finding, with the measured numbers, is
       * in src/lib/shared/concerns.ts. The provider's own figure is kept beside
       * ours so a stored summary can always be traced back to the response.
       */
      const concerns = reading.concerns.map((entry) => {
        const key = mapProviderConcern(entry.type);
        return {
          providerType: entry.type,
          key,
          uiScore: presenceScoreFor({ key, providerUiScore: entry.uiScore }),
          providerUiScore: entry.uiScore,
          rawScore: entry.rawScore,
        };
      });

      return {
        raw: toJson(result),
        summary: toJson({
          concerns,
          skinAge: reading.skinAge,
          overallScore: reading.overallScore,
          skinTypeZones: skinTypeZonesFor(reading),
        }) ?? {},
        maskUrls: selectMasks(reading),
      };
    }
    case "attributes": {
      const result = parseFacialColorTonesResult(snapshot);
      /*
       * Every colour but the skin is optional (the schema says why), so each one
       * is written as an explicit null rather than left off. JSON.stringify
       * drops an undefined key, and a summary whose shape changes with what the
       * provider happened to read is a summary nothing downstream can rely on.
       * The row keeps what came back and says nothing about what did not.
       */
      const color = result.color;
      return {
        raw: toJson(result),
        summary:
          toJson({
            skinColor: color.skin_color,
            eyeColor: color.eye_color ?? null,
            eyeColorName: color.eye_color_name ?? null,
            lipColor: color.lip_color ?? null,
            eyebrowColor: color.eyebrow_color ?? null,
            hairColor: color.hair_color ?? null,
            hairColorName: color.hair_color_name ?? null,
          }) ?? {},
        maskUrls: [],
      };
    }
    case "face_shape": {
      const result = parseFaceAttributesResult(snapshot);
      /*
       * results.faceshape, all lower case. Confirmed live on 2026-09-03 and
       * recorded in evals/fixtures/perfectcorp/face-attr-status.json. The
       * provider's own word is stored as it arrived ("Oval", "InvTriangle") and
       * mapped to one of our rows by normalizeFaceShape in
       * src/lib/shared/hair-rules.ts, so the summary keeps what the engine said
       * and the screen keeps our vocabulary.
       */
      const faceShape = readFaceShape(result);
      return {
        raw: toJson(result),
        summary: toJson({ faceShape }) ?? {},
        maskUrls: [],
      };
    }
    case "hair_type": {
      const result = parseHairTypeResult(snapshot);
      return {
        raw: toJson(result),
        summary:
          toJson({ mapping: result.mapping, term: result.term }) ?? {},
        maskUrls: [],
      };
    }
    case "fitzpatrick": {
      const raw = toJson(snapshot.results);
      return {
        raw,
        summary: toJson({ fitzpatrick: readFitzpatrick(snapshot.results) }) ?? {},
        maskUrls: [],
      };
    }
  }
}

/**
 * Pulls mask images into the private masks bucket. Result URLs expire two hours
 * after the task finishes, so this runs the moment a task succeeds rather than
 * being deferred to the profile build or to a later request.
 *
 * A mask that cannot be fetched is dropped rather than failing the analysis: the
 * scores are the product, the masks are the illustration.
 *
 * Each mask is fetched on its own. It used to be one downloadResultAssets call
 * over all eight URLs, which is a single Promise.all: one expired or refused URL
 * rejected the whole call and the capture kept none of its masks, including the
 * seven that were still there. Isolating them keeps the parallel fetch and loses
 * only the mask that actually failed.
 */
export async function persistMasks(args: {
  readonly ownerId: string;
  readonly captureId: string;
  readonly masks: ReadonlyArray<{ readonly key: string; readonly url: string }>;
}): Promise<string[]> {
  if (args.masks.length === 0) {
    return [];
  }

  const fetched = await Promise.all(
    args.masks.map(async (mask) => {
      try {
        const [asset] = await downloadResultAssets([mask.url]);
        return asset === undefined ? null : { mask, asset };
      } catch {
        return null;
      }
    }),
  );

  const paths: string[] = [];
  for (const entry of fetched) {
    if (entry === null) {
      continue;
    }
    /*
     * The type is decided here rather than taken from the header the result URL
     * came with. A provider asset served as "binary/octet-stream" is refused by
     * the bucket (migration 0006 allows three image types), and the catch below
     * would drop the mask without a word. src/lib/shared/image-type.ts reads the
     * URL when the header says nothing we can store.
     */
    const image = storedImageType(entry.asset.contentType, entry.mask.url);
    try {
      const stored = await uploadObject({
        bucket: BUCKETS.masks,
        storagePath: maskPath(
          args.ownerId,
          args.captureId,
          entry.mask.key,
          image.extension,
        ),
        bytes: entry.asset.bytes,
        contentType: image.contentType,
      });
      paths.push(stored);
    } catch {
      // One mask that will not store is not a reason to lose the reading.
      continue;
    }
  }
  return paths;
}
