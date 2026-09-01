import "server-only";

import { serviceClient, unwrap, unwrapNullable } from "../db/service";
import type { Insert, Json, Look } from "../db/types";

/**
 * The looks row: read and write.
 *
 * It lives here rather than in src/lib/server/db/index.ts for the same reason
 * the renders helpers live in src/lib/server/renders/db.ts: this is the only
 * layer that touches it, and the shape of the garments column is this layer's
 * decision (src/lib/server/looks/stored.ts).
 *
 * Every query filters by owner id. The service role client ignores Row Level
 * Security, so that filter is the only thing keeping one person's looks away
 * from another's.
 */

/** Every look for one occasion, saved ones first, then newest first. */
export async function listLooksForOccasion(args: {
  readonly ownerId: string;
  readonly occasion: string;
}): Promise<Look[]> {
  const result = await serviceClient()
    .from("looks")
    .select("*")
    .eq("user_id", args.ownerId)
    .eq("occasion", args.occasion)
    .order("is_saved", { ascending: false })
    .order("created_at", { ascending: false });
  return unwrap("list looks", result);
}

export async function getLook(
  ownerId: string,
  lookId: string,
): Promise<Look | null> {
  const result = await serviceClient()
    .from("looks")
    .select("*")
    .eq("id", lookId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return unwrapNullable("read look", result);
}

export async function insertLook(row: Insert<"looks">): Promise<Look> {
  const result = await serviceClient()
    .from("looks")
    .insert(row)
    .select("*")
    .single();
  return unwrap("create look", result);
}

export async function updateLook(
  ownerId: string,
  lookId: string,
  patch: {
    readonly occasion?: string | null;
    readonly garments?: Json;
    readonly rationale?: string | null;
    readonly render_path?: string | null;
    readonly is_saved?: boolean;
  },
): Promise<Look | null> {
  const result = await serviceClient()
    .from("looks")
    .update(patch)
    .eq("id", lookId)
    .eq("user_id", ownerId)
    .select("*")
    .maybeSingle();
  return unwrapNullable("update look", result);
}

/**
 * Removes composed looks nobody saved.
 *
 * /looks recomposes on every visit, so a wardrobe change leaves rows behind for
 * combinations that no longer exist. An unsaved look is a cache of the last
 * composition, not a thing the person made, so it is deleted. A saved look is
 * never touched here: docs/01-user-flow.md section L item 2 promises saved
 * looks on the profile, and a rule change must not quietly take one away.
 */
export async function deleteUnsavedLooks(args: {
  readonly ownerId: string;
  readonly lookIds: readonly string[];
}): Promise<void> {
  if (args.lookIds.length === 0) {
    return;
  }
  const result = await serviceClient()
    .from("looks")
    .delete()
    .eq("user_id", args.ownerId)
    .eq("is_saved", false)
    .in("id", [...args.lookIds])
    .select("id");
  unwrap("delete unsaved looks", result);
}
