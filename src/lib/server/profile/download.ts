import "server-only";

import {
  findExcludedDownloadField,
  PROFILE_DOWNLOAD_FORMAT,
  profileDownloadSchema,
  type ProfileDownload,
} from "@/lib/shared/profile-view";

import { getProfile, listAllAnalyses } from "../db";
import type { Analysis, Garment, Look, Profile } from "../db/types";
import { listAllLooks } from "../looks/db";
import { isStoredGarmentMember, readStoredMembers } from "../looks/stored";
import { listGarments } from "../wardrobe/db";
import { readStoredColors } from "../wardrobe";
import { getAestheticProfile, readStoredConcerns, type AestheticProfile } from "./db";
import { readStoredHairType } from "./hair";

/**
 * "Download my data", docs/06-safety-privacy.md, "Person's controls": "returns
 * JSON of profile, analyses summaries, garments metadata, and looks."
 *
 * The shape, the exclusions, and the reasoning behind each exclusion live in
 * src/lib/shared/profile-view.ts beside the schema. This file is only the read:
 * five queries, one object, and two locks before it is handed over.
 *
 * The two locks, in order:
 *
 * 1. profileDownloadSchema.parse. Every object in it is strict, so a field
 *    nobody declared cannot travel in the file. This is what stops a storage
 *    path or a raw provider body from being added by accident later: the parse
 *    fails rather than the field shipping.
 * 2. findExcludedDownloadField over the parsed document. The schema cannot see
 *    inside a declared string, and a stored rationale or a listing title is text
 *    written elsewhere. This catches an address that arrived as a value.
 *
 * A document that fails either lock is not returned. There is no repair pass and
 * no field stripping: a data export the app is not certain about is one the
 * person should not be handed.
 *
 * Nothing here signs a URL and nothing here reads an object. The download is
 * text about what is stored, never a copy of it.
 */

/** The sentence at the top of the file, so it explains itself when opened. */
export const PROFILE_DOWNLOAD_NOTE =
  "Everything AURUM has stored for you, as text. Photos, masks, and try on renders are not in this file, and neither are the links that reach them.";

export class ProfileDownloadError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`The data export did not pass its own checks: ${reason}`);
    this.name = "ProfileDownloadError";
    this.reason = reason;
  }
}

/**
 * The reads the download makes, as one object with a default.
 *
 * Explicit rather than implicit so the unit test can hand this function a whole
 * record without a database, which is the only way the exclusions can be proved
 * on a machine with no Supabase project (CLAUDE.md: fixture first). Production
 * uses the default and passes nothing.
 */
export interface ProfileDownloadReads {
  readonly profile: (ownerId: string) => Promise<Profile | null>;
  readonly aesthetic: (ownerId: string) => Promise<AestheticProfile | null>;
  readonly analyses: (ownerId: string) => Promise<Analysis[]>;
  readonly garments: (ownerId: string) => Promise<Garment[]>;
  readonly looks: (ownerId: string) => Promise<Look[]>;
}

export const defaultProfileDownloadReads: ProfileDownloadReads = {
  profile: getProfile,
  aesthetic: getAestheticProfile,
  analyses: listAllAnalyses,
  garments: listGarments,
  looks: listAllLooks,
};

/* ------------------------------------------------------------------ */
/* Row to document                                                     */
/* ------------------------------------------------------------------ */

/** The city, and only the city. Coordinates are not what a person asked for. */
function approxCity(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const city = (value as Record<string, unknown>).city;
  return typeof city === "string" && city.length > 0 ? city : null;
}

/**
 * The concerns, without their mask paths.
 *
 * The score and the rank are the reading. The mask path is the address of a PNG
 * in a private bucket, which is exactly what the export leaves out.
 */
function toDownloadConcerns(
  profile: AestheticProfile,
): { key: string; score: number; rank: number }[] {
  return readStoredConcerns(profile).map((concern) => ({
    key: concern.key,
    score: concern.score,
    rank: concern.rank,
  }));
}

function toDownloadAesthetic(
  profile: AestheticProfile | null,
): ProfileDownload["profile"]["aesthetic"] {
  if (profile === null) {
    return null;
  }
  const zones = profile.skin_type_zones;
  const zoneRecord =
    zones !== null && typeof zones === "object" && !Array.isArray(zones)
      ? (zones as Record<string, unknown>)
      : {};
  const hairType = readStoredHairType(profile.hair_type);

  return {
    skinTypeZones: {
      tZone: typeof zoneRecord.t_zone === "string" ? zoneRecord.t_zone : null,
      cheeks: typeof zoneRecord.cheeks === "string" ? zoneRecord.cheeks : null,
    },
    concerns: toDownloadConcerns(profile),
    skinAge: profile.skin_age,
    fitzpatrick: profile.fitzpatrick,
    skinToneHex: profile.skin_tone_hex,
    undertone: profile.undertone,
    undertoneSource: profile.undertone_source,
    eyeColorHex: profile.eye_color_hex,
    hairColorHex: profile.hair_color_hex,
    faceShape: profile.face_shape,
    hairType: hairType?.curl ?? hairType?.texture ?? null,
    savedHairStyleId: profile.saved_hair_style_id,
    savedHairColorName: profile.saved_hair_color_name,
    season: profile.season,
    reading: profile.reading,
    readingModel: profile.reading_model,
    updatedAt: profile.updated_at,
  };
}

/**
 * One analysis as a summary.
 *
 * summary is the normalized object the jobs layer wrote and the profile was
 * built from. raw, provider_task_id, and mask_paths are not here: the first is
 * a provider's own response body, the second is an id inside somebody else's
 * system, and the third is a list of storage addresses.
 */
function toDownloadAnalysis(analysis: Analysis): ProfileDownload["analyses"][number] {
  return {
    kind: analysis.kind,
    status: analysis.status,
    createdAt: analysis.created_at,
    creditsUsed: analysis.credits_used,
    summary: analysis.summary,
  };
}

function toDownloadGarment(garment: Garment): ProfileDownload["garments"][number] {
  return {
    id: garment.id,
    type: garment.type,
    // Through the same reader the wardrobe screen uses, so the file holds the
    // colours the person was actually shown.
    colors: readStoredColors(garment.colors),
    pattern: garment.pattern,
    formality: garment.formality,
    userEdited: garment.user_edited,
    createdAt: garment.created_at,
  };
}

function toDownloadLook(look: Look): ProfileDownload["looks"][number] {
  const items: ProfileDownload["looks"][number]["items"] = [];
  for (const member of readStoredMembers(look.garments)) {
    if (isStoredGarmentMember(member)) {
      items.push({
        source: "garment",
        garmentId: member.garment_id,
        type: member.type ?? null,
      });
      continue;
    }
    items.push({
      source: "listing",
      type: member.type ?? null,
      title: member.title,
      priceText: member.priceText,
      store: member.store,
      url: member.url,
    });
  }

  return {
    id: look.id,
    occasion: look.occasion,
    isSaved: look.is_saved,
    rationale: look.rationale,
    createdAt: look.created_at,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

/**
 * The person's data as one document.
 *
 * Throws ProfileDownloadError when the document fails either lock, which the
 * route turns into a refusal rather than a partial file.
 */
export async function buildProfileDownload(args: {
  readonly ownerId: string;
  readonly now?: Date;
  readonly reads?: ProfileDownloadReads;
}): Promise<ProfileDownload> {
  const reads = args.reads ?? defaultProfileDownloadReads;
  const ownerId = args.ownerId;

  const [profile, aesthetic, analyses, garments, looks] = await Promise.all([
    reads.profile(ownerId),
    reads.aesthetic(ownerId),
    reads.analyses(ownerId),
    reads.garments(ownerId),
    reads.looks(ownerId),
  ]);

  const document = {
    format: PROFILE_DOWNLOAD_FORMAT,
    exportedAt: (args.now ?? new Date()).toISOString(),
    note: PROFILE_DOWNLOAD_NOTE,
    profile: {
      consentAt: profile?.consent_at ?? null,
      consentVersion: profile?.consent_version ?? null,
      isAdultConfirmed: profile?.is_adult_confirmed ?? false,
      keepOriginals: profile?.keep_originals ?? false,
      locationConsent: profile?.location_consent ?? false,
      approxLocationCity: approxCity(profile?.approx_location ?? null),
      aesthetic: toDownloadAesthetic(aesthetic),
    },
    analyses: analyses.map(toDownloadAnalysis),
    garments: garments.map(toDownloadGarment),
    looks: looks.map(toDownloadLook),
  };

  const parsed = profileDownloadSchema.safeParse(document);
  if (!parsed.success) {
    throw new ProfileDownloadError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.code}`)
        .join("; "),
    );
  }

  const excluded = findExcludedDownloadField(parsed.data);
  if (excluded !== null) {
    throw new ProfileDownloadError(excluded);
  }

  console.log(
    JSON.stringify({
      event: "aurum.profile_downloaded",
      ownerId,
      analyses: parsed.data.analyses.length,
      garments: parsed.data.garments.length,
      looks: parsed.data.looks.length,
    }),
  );

  return parsed.data;
}
