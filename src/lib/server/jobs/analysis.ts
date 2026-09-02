import "server-only";

import { mapProviderConcern } from "@/lib/shared/concerns";

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

function bodyFor(kind: AnalysisKind, fileId: string): Record<string, unknown> {
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
    case "face_shape":
      return { [fileField]: fileId, dst_actions: [...FACE_ATTRIBUTES_REQUESTED] };
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
    body: bodyFor(args.kind, args.fileId),
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
  /** Mask images to fetch before their URLs expire. */
  readonly maskUrls: ReadonlyArray<{ readonly key: string; readonly url: string }>;
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
      const concerns = reading.concerns.map((entry) => ({
        providerType: entry.type,
        key: mapProviderConcern(entry.type),
        uiScore: entry.uiScore,
        rawScore: entry.rawScore,
      }));

      /*
       * One mask per concern key, in provider order, up to the storage budget.
       * The dedupe matters: the provider scores the upper and the lower eyelid
       * separately and both map to eyelid_droop, so without it two entries
       * would race for masks/eyelid_droop.png and the second would overwrite
       * the first while using up one of the eight slots.
       */
      const maskUrls: Array<{ key: string; url: string }> = [];
      const takenKeys = new Set<string>();
      for (const entry of reading.concerns) {
        if (maskUrls.length >= MAX_MASKS_PER_CAPTURE) {
          break;
        }
        const url = entry.maskUrls[0];
        const key = mapProviderConcern(entry.type);
        if (url === undefined || key === null || takenKeys.has(key)) {
          continue;
        }
        takenKeys.add(key);
        maskUrls.push({ key, url });
      }

      return {
        raw: toJson(result),
        summary: toJson({
          concerns,
          skinAge: reading.skinAge,
          overallScore: reading.overallScore,
          skinTypeZones: skinTypeZonesFor(reading),
        }) ?? {},
        maskUrls,
      };
    }
    case "attributes": {
      const result = parseFacialColorTonesResult(snapshot);
      return {
        raw: toJson(result),
        summary:
          toJson({
            skinColor: result.color.skin_color,
            eyeColor: result.color.eye_color,
            eyeColorName: result.color.eye_color_name,
            lipColor: result.color.lip_color,
            eyebrowColor: result.color.eyebrow_color,
            hairColor: result.color.hair_color,
            hairColorName: result.color.hair_color_name,
          }) ?? {},
        maskUrls: [],
      };
    }
    case "face_shape": {
      const result = parseFaceAttributesResult(snapshot);
      const attributeShape = result.attributes?.faceShape;
      const faceShape =
        result.faceShape ??
        result.face_shape ??
        (typeof attributeShape === "string" ? attributeShape : null);
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
 * Pulls mask images into the private masks bucket. Result URLs expire, so this
 * runs the moment a task succeeds.
 *
 * A mask that cannot be fetched is dropped rather than failing the analysis: the
 * scores are the product, the masks are the illustration.
 */
export async function persistMasks(args: {
  readonly ownerId: string;
  readonly captureId: string;
  readonly masks: ReadonlyArray<{ readonly key: string; readonly url: string }>;
}): Promise<string[]> {
  if (args.masks.length === 0) {
    return [];
  }

  let assets: Awaited<ReturnType<typeof downloadResultAssets>>;
  try {
    assets = await downloadResultAssets(args.masks.map((mask) => mask.url));
  } catch {
    return [];
  }

  const paths: string[] = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const mask = args.masks[index];
    if (asset === undefined || mask === undefined) {
      continue;
    }
    const extension = asset.contentType.includes("jpeg") ? "jpg" : "png";
    try {
      const stored = await uploadObject({
        bucket: BUCKETS.masks,
        storagePath: maskPath(args.ownerId, args.captureId, mask.key, extension),
        bytes: asset.bytes,
        contentType: asset.contentType,
      });
      paths.push(stored);
    } catch {
      // One mask that will not store is not a reason to lose the reading.
      continue;
    }
  }
  return paths;
}
