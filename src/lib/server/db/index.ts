import "server-only";

import {
  serviceClient,
  UNIQUE_VIOLATION,
  unwrap,
  unwrapNullable,
} from "./service";
import type {
  Analysis,
  AnalysisKind,
  Capture,
  Insert,
  JobRecord,
  JobStatus,
  Json,
  Profile,
} from "./types";

export {
  DatabaseError,
  isDatabaseError,
  serviceClient,
  UNIQUE_VIOLATION,
  unwrap,
  unwrapNullable,
} from "./service";
export type { ServiceClient } from "./service";
export { currentUserId, userClient } from "./user";
export type { UserClient } from "./user";
export {
  BUCKETS,
  capturePath,
  createSignedRead,
  createSignedUpload,
  downloadObject,
  maskPath,
  READ_URL_TTL_SECONDS,
  removeObjects,
  uploadObject,
  UPLOAD_URL_TTL_SECONDS,
} from "./storage";
export type { BucketName, SignedUpload, StoredObject } from "./storage";
export * from "./types";

/**
 * Typed table helpers.
 *
 * Every function takes the owner id explicitly. The service role client ignores
 * Row Level Security, so the owner filter in these queries is the only thing
 * standing between one person's rows and another's. It is never optional.
 */

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

export async function getProfile(userId: string): Promise<Profile | null> {
  const result = await serviceClient()
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return unwrapNullable("read profile", result);
}

export async function upsertProfileConsent(args: {
  readonly userId: string;
  readonly consentVersion: string;
  readonly keepOriginals: boolean;
}): Promise<Profile> {
  const row: Insert<"profiles"> = {
    user_id: args.userId,
    consent_at: new Date().toISOString(),
    consent_version: args.consentVersion,
    is_adult_confirmed: true,
    keep_originals: args.keepOriginals,
  };
  const result = await serviceClient()
    .from("profiles")
    .upsert(row, { onConflict: "user_id" })
    .select("*")
    .single();
  return unwrap("write consent", result);
}

// ---------------------------------------------------------------------------
// captures
// ---------------------------------------------------------------------------

export async function findCaptureBySha(
  ownerId: string,
  sha256: string,
): Promise<Capture | null> {
  const result = await serviceClient()
    .from("captures")
    .select("*")
    .eq("user_id", ownerId)
    .eq("sha256", sha256)
    .maybeSingle();
  return unwrapNullable("find capture by hash", result);
}

export async function getCapture(
  ownerId: string,
  captureId: string,
): Promise<Capture | null> {
  const result = await serviceClient()
    .from("captures")
    .select("*")
    .eq("id", captureId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return unwrapNullable("read capture", result);
}

/**
 * Every capture this person owns, newest first.
 *
 * Read by the data controls on /profile: the download counts what is stored and
 * the delete needs the storage path of every object before it removes the rows
 * that point at them (docs/06-safety-privacy.md, "Person's controls").
 */
export async function listCaptures(ownerId: string): Promise<Capture[]> {
  const result = await serviceClient()
    .from("captures")
    .select("*")
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false });
  return unwrap("list captures", result);
}

export async function insertCapture(row: Insert<"captures">): Promise<Capture> {
  const result = await serviceClient()
    .from("captures")
    .insert(row)
    .select("*")
    .single();
  return unwrap("create capture", result);
}

export async function setCaptureStoragePath(
  captureId: string,
  storagePath: string,
): Promise<void> {
  const result = await serviceClient()
    .from("captures")
    .update({ storage_path: storagePath })
    .eq("id", captureId)
    .select("id")
    .maybeSingle();
  unwrapNullable("set capture storage path", result);
}

/** Retention: clears the original object path and stamps deleted_at. */
export async function markCaptureOriginalDeleted(
  captureId: string,
): Promise<void> {
  const result = await serviceClient()
    .from("captures")
    .update({ storage_path: null, deleted_at: new Date().toISOString() })
    .eq("id", captureId)
    .select("id")
    .maybeSingle();
  unwrapNullable("mark capture original deleted", result);
}

// ---------------------------------------------------------------------------
// analyses
// ---------------------------------------------------------------------------

export async function listAnalyses(
  ownerId: string,
  captureId: string,
): Promise<Analysis[]> {
  const result = await serviceClient()
    .from("analyses")
    .select("*")
    .eq("user_id", ownerId)
    .eq("capture_id", captureId)
    .order("created_at", { ascending: true });
  return unwrap("list analyses", result);
}

/**
 * Every analysis this person owns, across every capture, oldest first.
 *
 * Read by the data controls on /profile: "Download my data" returns "analyses
 * summaries" (docs/06-safety-privacy.md, "Person's controls"), which is not
 * scoped to one capture, and the delete needs every mask path before the rows
 * that carry them are gone.
 */
export async function listAllAnalyses(ownerId: string): Promise<Analysis[]> {
  const result = await serviceClient()
    .from("analyses")
    .select("*")
    .eq("user_id", ownerId)
    .order("created_at", { ascending: true });
  return unwrap("list all analyses", result);
}

export async function findAnalysis(
  ownerId: string,
  captureId: string,
  kind: AnalysisKind,
): Promise<Analysis | null> {
  const result = await serviceClient()
    .from("analyses")
    .select("*")
    .eq("user_id", ownerId)
    .eq("capture_id", captureId)
    .eq("kind", kind)
    .maybeSingle();
  return unwrapNullable("read analysis", result);
}

/**
 * Returns the row for one capture and kind, creating it only when it is absent.
 * (capture_id, kind) is unique, so a lost insert race is answered by reading the
 * winner rather than by overwriting it. An upsert would reset a succeeded
 * analysis back to pending, which would throw away a result we already paid for.
 */
export async function ensureAnalysis(args: {
  readonly ownerId: string;
  readonly captureId: string;
  readonly kind: AnalysisKind;
}): Promise<Analysis> {
  const existing = await findAnalysis(args.ownerId, args.captureId, args.kind);
  if (existing !== null) {
    return existing;
  }

  const row: Insert<"analyses"> = {
    capture_id: args.captureId,
    user_id: args.ownerId,
    kind: args.kind,
    status: "pending",
  };
  const result = await serviceClient()
    .from("analyses")
    .insert(row)
    .select("*")
    .maybeSingle();

  if (result.error !== null && result.error.code === UNIQUE_VIOLATION) {
    const winner = await findAnalysis(args.ownerId, args.captureId, args.kind);
    if (winner !== null) {
      return winner;
    }
  }
  return unwrap<Analysis>("create analysis", result);
}

export async function updateAnalysis(
  analysisId: string,
  patch: {
    readonly status?: JobStatus;
    readonly provider_task_id?: string | null;
    readonly raw?: Json | null;
    readonly summary?: Json | null;
    readonly mask_paths?: Json | null;
    readonly credits_used?: number;
    readonly error?: string | null;
  },
): Promise<void> {
  const result = await serviceClient()
    .from("analyses")
    .update(patch)
    .eq("id", analysisId)
    .select("id")
    .maybeSingle();
  unwrapNullable("update analysis", result);
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export async function listJobsForSubjects(
  ownerId: string,
  subjectIds: readonly string[],
): Promise<JobRecord[]> {
  if (subjectIds.length === 0) {
    return [];
  }
  const result = await serviceClient()
    .from("jobs")
    .select("*")
    .eq("user_id", ownerId)
    .in("subject_id", [...subjectIds])
    .order("created_at", { ascending: true });
  return unwrap("list jobs", result);
}

/** The most recent job for a subject, in any state. */
export async function findJobForSubject(
  ownerId: string,
  subjectId: string,
): Promise<JobRecord | null> {
  const result = await serviceClient()
    .from("jobs")
    .select("*")
    .eq("user_id", ownerId)
    .eq("subject_id", subjectId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return unwrapNullable("read job", result);
}

export async function findOpenJobForSubject(
  ownerId: string,
  subjectId: string,
): Promise<JobRecord | null> {
  const result = await serviceClient()
    .from("jobs")
    .select("*")
    .eq("user_id", ownerId)
    .eq("subject_id", subjectId)
    .in("status", ["pending", "running"])
    .maybeSingle();
  return unwrapNullable("find open job", result);
}

export async function insertJob(row: Insert<"jobs">): Promise<JobRecord> {
  const result = await serviceClient()
    .from("jobs")
    .insert(row)
    .select("*")
    .single();
  return unwrap("create job", result);
}

export async function updateJob(
  jobId: string,
  patch: {
    readonly status?: JobStatus;
    readonly provider_task_id?: string | null;
    readonly attempts?: number;
    readonly last_polled_at?: string | null;
    readonly error?: string | null;
    /**
     * Set only when a row is put back to running for a NEW provider task.
     *
     * The job lifetime is measured from created_at (src/lib/server/jobs), and a
     * reused row keeps the timestamp of its first attempt, so without this a
     * retry made more than two minutes later is failed as a timeout before its
     * first poll ever reads the provider. Found live: the second makeup try on
     * of a session was marked timed out against a task that ran fine.
     */
    readonly created_at?: string;
  },
): Promise<JobRecord | null> {
  const result = await serviceClient()
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .select("*")
    .maybeSingle();
  return unwrapNullable("update job", result);
}

// ---------------------------------------------------------------------------
// renders (read only here; the render routes land with Layer 2)
// ---------------------------------------------------------------------------

export async function countRenders(ownerId: string): Promise<number> {
  const result = await serviceClient()
    .from("renders")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId);
  if (result.error !== null) {
    throw new Error(`count renders failed: ${result.error.message}`);
  }
  return result.count ?? 0;
}
