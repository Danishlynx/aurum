import "server-only";

import { serviceClient, unwrap, unwrapNullable } from "../db/service";
import type { Insert, JobStatus, Json, Render, RenderKind } from "../db/types";

/**
 * The renders row: read and write.
 *
 * It lives here rather than in src/lib/server/db/index.ts for the same reason
 * the aesthetic_profiles helpers live in src/lib/server/profile/db.ts: this is
 * the only layer that touches it, and the shape of params is this layer's
 * decision.
 *
 * Every query filters by owner id. The service role client ignores Row Level
 * Security, so that filter is the only thing keeping one person's renders away
 * from another's.
 */

const OPEN_STATUSES: readonly JobStatus[] = ["pending", "running"];

export async function findRenderByHash(args: {
  readonly ownerId: string;
  readonly kind: RenderKind;
  readonly paramsHash: string;
}): Promise<Render | null> {
  const result = await serviceClient()
    .from("renders")
    .select("*")
    .eq("user_id", args.ownerId)
    .eq("kind", args.kind)
    .eq("params_hash", args.paramsHash)
    .maybeSingle();
  return unwrapNullable("find render by params hash", result);
}

/**
 * Every render of one kind whose params hash is in the list.
 *
 * One query instead of one per option: /hair asks for four styles and three
 * colours at once, and a screen that reads which of them have already been
 * rendered should not cost seven round trips (docs/03-architecture.md,
 * "Caching": re selecting a style returns the stored render).
 *
 * An empty list of hashes never reaches the database.
 */
export async function findRendersByHashes(args: {
  readonly ownerId: string;
  readonly kind: RenderKind;
  readonly paramsHashes: readonly string[];
}): Promise<Render[]> {
  if (args.paramsHashes.length === 0) {
    return [];
  }
  const result = await serviceClient()
    .from("renders")
    .select("*")
    .eq("user_id", args.ownerId)
    .eq("kind", args.kind)
    .in("params_hash", [...args.paramsHashes]);
  return unwrap("find renders by params hashes", result);
}

export async function getRender(
  ownerId: string,
  renderId: string,
): Promise<Render | null> {
  const result = await serviceClient()
    .from("renders")
    .select("*")
    .eq("id", renderId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return unwrapNullable("read render", result);
}

/**
 * How many renders this owner has open.
 *
 * docs/03-architecture.md, "Concurrency": "Try on renders are sequential per
 * person (one pending render at a time) to keep credit spend predictable."
 */
export async function countOpenRenders(ownerId: string): Promise<number> {
  const result = await serviceClient()
    .from("renders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId)
    .in("status", [...OPEN_STATUSES]);
  if (result.error !== null) {
    throw new Error(`count open renders failed: ${result.error.message}`);
  }
  return result.count ?? 0;
}

export async function insertRender(row: Insert<"renders">): Promise<Render> {
  const result = await serviceClient()
    .from("renders")
    .insert(row)
    .select("*")
    .single();
  return unwrap("create render", result);
}

export async function updateRender(
  renderId: string,
  patch: {
    readonly status?: JobStatus;
    readonly params?: Json;
    readonly storage_path?: string | null;
    readonly provider_task_id?: string | null;
    readonly credits_used?: number;
  },
): Promise<Render | null> {
  const result = await serviceClient()
    .from("renders")
    .update(patch)
    .eq("id", renderId)
    .select("*")
    .maybeSingle();
  return unwrapNullable("update render", result);
}

/**
 * Removes a render that never reached the provider.
 *
 * A row left behind by a refused cap or a failed upload would count against the
 * six renders a judge session is allowed (docs/07-payments-and-judge-mode.md),
 * and no credit was ever spent on it, so it is deleted rather than kept as a
 * failure.
 */
export async function deleteRender(
  ownerId: string,
  renderId: string,
): Promise<void> {
  const result = await serviceClient()
    .from("renders")
    .delete()
    .eq("id", renderId)
    .eq("user_id", ownerId)
    .select("id")
    .maybeSingle();
  unwrapNullable("delete render", result);
}
