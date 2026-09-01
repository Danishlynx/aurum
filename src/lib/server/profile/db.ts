import "server-only";

import { serviceClient, unwrap, unwrapNullable } from "../db";
import type { Insert, Row } from "../db/types";

/**
 * The aesthetic_profiles row: read and write.
 *
 * It lives here rather than in src/lib/server/db/index.ts because this is the
 * only layer that touches it, and because the shape of the concerns array is a
 * decision of this layer rather than of the database helper.
 *
 * Every query filters by owner id. The service role client ignores Row Level
 * Security, so that filter is the only thing keeping one person's profile away
 * from another's (the same rule the rest of src/lib/server/db follows).
 */

export type AestheticProfile = Row<"aesthetic_profiles">;

/** One entry of aesthetic_profiles.concerns, per the comment in migration 0002. */
export interface StoredConcern {
  readonly key: string;
  readonly score: number;
  readonly rank: number;
  readonly mask_path: string | null;
}

export async function getAestheticProfile(
  ownerId: string,
): Promise<AestheticProfile | null> {
  const result = await serviceClient()
    .from("aesthetic_profiles")
    .select("*")
    .eq("user_id", ownerId)
    .maybeSingle();
  return unwrapNullable("read aesthetic profile", result);
}

/**
 * Writes the profile. user_id is the primary key, so one person has one profile
 * and a rebuild replaces it rather than adding a second row.
 */
export async function upsertAestheticProfile(
  row: Insert<"aesthetic_profiles">,
): Promise<AestheticProfile> {
  const result = await serviceClient()
    .from("aesthetic_profiles")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  return unwrap("write aesthetic profile", result);
}

/** The stored concerns, or an empty list when the column holds anything else. */
export function readStoredConcerns(
  profile: AestheticProfile | null,
): StoredConcern[] {
  if (profile === null || !Array.isArray(profile.concerns)) {
    return [];
  }
  const concerns: StoredConcern[] = [];
  for (const entry of profile.concerns) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const key = record.key;
    const score = record.score;
    const rank = record.rank;
    const maskPath = record.mask_path;
    if (typeof key !== "string" || typeof score !== "number" || typeof rank !== "number") {
      continue;
    }
    concerns.push({
      key,
      score,
      rank,
      mask_path: typeof maskPath === "string" ? maskPath : null,
    });
  }
  return concerns.sort((a, b) => a.rank - b.rank);
}
