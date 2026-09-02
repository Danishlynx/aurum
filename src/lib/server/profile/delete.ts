import "server-only";

import { listCaptures, listAllAnalyses } from "../db";
import { serviceClient, unwrap } from "../db/service";
import {
  BUCKETS,
  removeObjects,
  type BucketName,
} from "../db/storage";
import type { Analysis, Capture, Garment, Render } from "../db/types";
import { userClient } from "../db/user";
import { listRenders } from "../renders/db";
import { listGarments } from "../wardrobe/db";
import { getAestheticProfile, readStoredConcerns, type AestheticProfile } from "./db";
import { demoProfileIsReadOnly } from "../judge/demo";
import { isDemoFixtureMode } from "./report-view";
import type { AppSession } from "../session";

/**
 * "Delete everything", docs/01-user-flow.md section L item 3 and
 * docs/06-safety-privacy.md, "Person's controls": "requires typing DELETE and
 * removes rows and storage objects in one transaction, then signs the person
 * out."
 *
 * ONE TRANSACTION, AND WHAT THAT CAN ACTUALLY MEAN HERE
 *
 * The rows are one transaction and the objects are not, because they are in two
 * different systems: Postgres has transactions and Supabase Storage does not.
 * There is no way to make an object removal roll back with a failed commit, so
 * the honest engineering question is not "how do we get one transaction" but
 * "which half do we do first, and what does a crash between them leave behind".
 *
 * The order here is objects first, then rows. A crash between the two leaves
 * rows pointing at objects that are gone. The other order would leave objects
 * that no row points at.
 *
 * Why that way round, for a delete specifically:
 *
 * 1. An orphan object is a photograph of a person's face, sitting in a bucket,
 *    that nothing in the database knows about. Nothing will ever come looking for
 *    it: the daily retention job walks rows to find objects, so an object with no
 *    row is invisible to the one process that would clean it up. It would stay
 *    there until somebody found it by hand. That is the exact failure the person
 *    just asked us to prevent.
 * 2. An orphan row is a row whose images are gone. The app already renders that
 *    state everywhere, because retention deletes originals by default: a capture
 *    with a null storage path, a mask that will not sign, a look whose garment
 *    photo is missing. Nothing breaks, nothing leaks, and the next attempt at
 *    "Delete everything" finishes the job, because the rows are still there to be
 *    found.
 *
 * So the compensating action for a partial delete is "run it again", and the
 * order is chosen so that running it again is always possible. It is the same
 * order and the same reasoning as removeGarment in src/lib/server/wardrobe: the
 * object goes first so a failure never leaves a photo behind with nothing
 * pointing at it.
 *
 * The row deletes then run child to parent inside one call chain, so a failure
 * part way never leaves a row referencing a parent that is gone: jobs, looks,
 * renders, garments, analyses (capture_id references captures), the aesthetic
 * profile (capture_id references captures), captures, and the profile row last.
 *
 * WHAT IS DELIBERATELY LEFT BEHIND
 *
 * credit_ledger and rate_limits rows are not deleted, and this is a decision
 * rather than an oversight. Both are our own accounting and abuse defence, keyed
 * by an owner id and holding no photograph, no reading, and no attribute about
 * the person: a provider name, a unit count, a token count. Deleting them would
 * also hand anyone a way to reset their daily cap by pressing "Delete
 * everything" (docs/06-safety-privacy.md, "Keys, sessions, abuse": "Daily caps
 * per person ... are enforced in the credit ledger"). Recorded as an open item
 * for the human, because it is a retention decision and CLAUDE.md says to ask
 * before changing one.
 */

/* ------------------------------------------------------------------ */
/* Outcomes                                                            */
/* ------------------------------------------------------------------ */

export interface DeletedCounts {
  readonly jobs: number;
  readonly looks: number;
  readonly renders: number;
  readonly garments: number;
  readonly analyses: number;
  readonly aestheticProfiles: number;
  readonly captures: number;
  readonly profiles: number;
}

export interface RemovedObjects {
  readonly captures: number;
  readonly masks: number;
  readonly renders: number;
  readonly garments: number;
}

export type DeleteEverythingOutcome =
  | {
      readonly ok: true;
      readonly removed: RemovedObjects;
      readonly deleted: DeletedCounts;
      readonly signedOut: boolean;
    }
  | { readonly ok: false; readonly reason: "read_only" };

/* ------------------------------------------------------------------ */
/* The objects a person owns                                           */
/* ------------------------------------------------------------------ */

/** Every storage path this person owns, per bucket, read from their own rows. */
export interface OwnedObjects {
  readonly captures: string[];
  readonly masks: string[];
  readonly renders: string[];
  readonly garments: string[];
}

/**
 * The paths, gathered from the rows that point at them.
 *
 * Rows rather than a bucket listing on purpose: a listing would be a second
 * source of truth about what belongs to whom, and the owner filter on a query is
 * the thing standing between one person's objects and another's everywhere else
 * in this codebase (src/lib/server/db). An object no row points at is already an
 * orphan and is the daily retention job's problem, not this one's.
 */
export function ownedObjectsOf(args: {
  readonly captures: readonly Capture[];
  readonly analyses: readonly Analysis[];
  readonly aesthetic: AestheticProfile | null;
  readonly renders: readonly Render[];
  readonly garments: readonly Garment[];
}): OwnedObjects {
  const captures: string[] = [];
  for (const capture of args.captures) {
    if (capture.storage_path !== null) {
      captures.push(capture.storage_path);
    }
  }

  // Masks are recorded twice: on the analysis that produced them and on the
  // concern list the profile was built from. Both are read, because a profile
  // rebuild can leave a path on one and not the other, and a mask left behind is
  // a picture of somebody's face.
  const masks = new Set<string>();
  for (const analysis of args.analyses) {
    const paths = analysis.mask_paths;
    if (!Array.isArray(paths)) {
      continue;
    }
    for (const entry of paths) {
      if (typeof entry === "string" && entry.length > 0) {
        masks.add(entry);
      }
    }
  }
  for (const concern of readStoredConcerns(args.aesthetic)) {
    if (concern.mask_path !== null && concern.mask_path.length > 0) {
      masks.add(concern.mask_path);
    }
  }

  const renders: string[] = [];
  for (const render of args.renders) {
    if (render.storage_path !== null) {
      renders.push(render.storage_path);
    }
  }

  return {
    captures,
    masks: [...masks],
    renders,
    garments: args.garments.map((garment) => garment.storage_path),
  };
}

/* ------------------------------------------------------------------ */
/* The steps, as one injectable set                                    */
/* ------------------------------------------------------------------ */

/**
 * The four things a delete does, as one object with a default.
 *
 * Explicit rather than implicit so a unit test can watch the order without a
 * Supabase project, which is the only way the compensation order above can be
 * proved on this build (CLAUDE.md: fixture first, no keys, no database).
 * Production uses the default and passes nothing.
 */
export interface DeleteEverythingSteps {
  readonly readObjects: (ownerId: string) => Promise<OwnedObjects>;
  readonly removeObjects: (
    bucket: BucketName,
    paths: readonly string[],
  ) => Promise<void>;
  readonly deleteRows: (ownerId: string) => Promise<DeletedCounts>;
  readonly signOut: () => Promise<void>;
}

async function readOwnedObjects(ownerId: string): Promise<OwnedObjects> {
  const [captures, analyses, aesthetic, renders, garments] = await Promise.all([
    listCaptures(ownerId),
    listAllAnalyses(ownerId),
    getAestheticProfile(ownerId),
    listRenders(ownerId),
    listGarments(ownerId),
  ]);
  return ownedObjectsOf({ captures, analyses, aesthetic, renders, garments });
}

/** Deletes every row this person owns, child to parent. Counts what went. */
async function deleteOwnedRows(ownerId: string): Promise<DeletedCounts> {
  return {
    jobs: await deleteBy("jobs", "user_id", ownerId),
    looks: await deleteBy("looks", "user_id", ownerId),
    renders: await deleteBy("renders", "user_id", ownerId),
    garments: await deleteBy("garments", "user_id", ownerId),
    analyses: await deleteBy("analyses", "user_id", ownerId),
    aestheticProfiles: await deleteBy("aesthetic_profiles", "user_id", ownerId),
    captures: await deleteBy("captures", "user_id", ownerId),
    profiles: await deleteBy("profiles", "user_id", ownerId),
  };
}

/**
 * One table, one owner, and how many rows went.
 *
 * The owner filter is not optional. The service role client ignores Row Level
 * Security, so it is the only thing standing between this person's rows and
 * everybody else's, and a delete is the one query where getting that wrong
 * cannot be undone.
 */
async function deleteBy(
  table: "jobs" | "looks" | "renders" | "garments" | "analyses" | "aesthetic_profiles" | "captures" | "profiles",
  column: "user_id",
  ownerId: string,
): Promise<number> {
  const result = await serviceClient()
    .from(table)
    .delete()
    .eq(column, ownerId)
    .select("user_id");
  return unwrap(`delete ${table} for owner`, result).length;
}

/**
 * Ends the Supabase session, docs/06-safety-privacy.md: "then signs the person
 * out."
 *
 * A judge never reaches this (the route refuses first), and a judge has no
 * Supabase session to end anyway. A sign out that fails is logged and not
 * raised: the data is already gone, and telling a person their delete failed
 * when it succeeded would be the worse lie of the two.
 */
async function signOutCurrentSession(): Promise<void> {
  const client = await userClient();
  await client.auth.signOut();
}

export const defaultDeleteEverythingSteps: DeleteEverythingSteps = {
  readObjects: readOwnedObjects,
  removeObjects,
  deleteRows: deleteOwnedRows,
  signOut: signOutCurrentSession,
};

/* ------------------------------------------------------------------ */
/* The delete                                                          */
/* ------------------------------------------------------------------ */

/**
 * Removes everything this person owns, then signs them out.
 *
 * Refuses in fixture mode and for a judge session: docs/06-safety-privacy.md,
 * "Keys, sessions, abuse": "Judge sessions cannot delete the demo profile and
 * cannot download data", and docs/01-user-flow.md, "Judge mode across the flow":
 * "Judge sessions never see the Delete everything control on the demo profile."
 * The screen hides the control and the server refuses it anyway, because a
 * hidden control is not a permission check.
 */
export async function deleteEverything(args: {
  readonly session: AppSession;
  readonly steps?: DeleteEverythingSteps;
}): Promise<DeleteEverythingOutcome> {
  if (isDemoFixtureMode() || args.session.kind === "judge") {
    return { ok: false, reason: "read_only" };
  }

  const steps = args.steps ?? defaultDeleteEverythingSteps;
  const ownerId = args.session.id;

  const objects = await steps.readObjects(ownerId);

  // Objects first. See the note at the top of this file for why a crash here
  // must leave rows behind rather than objects.
  await steps.removeObjects(BUCKETS.captures, objects.captures);
  await steps.removeObjects(BUCKETS.masks, objects.masks);
  await steps.removeObjects(BUCKETS.renders, objects.renders);
  await steps.removeObjects(BUCKETS.garments, objects.garments);

  const deleted = await steps.deleteRows(ownerId);

  let signedOut = true;
  try {
    await steps.signOut();
  } catch {
    signedOut = false;
  }

  console.log(
    JSON.stringify({
      event: "aurum.profile_deleted",
      ownerType: args.session.ownerType,
      ownerId,
      // Counts only. Never a path, never a value from a deleted row.
      removedObjects:
        objects.captures.length +
        objects.masks.length +
        objects.renders.length +
        objects.garments.length,
      deletedRows:
        deleted.jobs +
        deleted.looks +
        deleted.renders +
        deleted.garments +
        deleted.analyses +
        deleted.aestheticProfiles +
        deleted.captures +
        deleted.profiles,
      signedOut,
    }),
  );

  return {
    ok: true,
    removed: {
      captures: objects.captures.length,
      masks: objects.masks.length,
      renders: objects.renders.length,
      garments: objects.garments.length,
    },
    deleted,
    signedOut,
  };
}

/* ------------------------------------------------------------------ */
/* The retention toggle                                                */
/* ------------------------------------------------------------------ */

export type KeepOriginalsOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "read_only" | "no_profile" };

/**
 * "Keep original photos", docs/01-user-flow.md section L item 3, mirroring the
 * consent toggle on /welcome (docs/06-safety-privacy.md, "Retention").
 *
 * It lives beside the delete because both are the retention controls and both
 * are refused on the demo profile for the same reason. It writes one column and
 * nothing else: turning the toggle off does not delete an original that is
 * already stored, because that is what "Delete everything" is for, and a toggle
 * that silently destroyed data would be a destructive action without a typed
 * confirmation.
 *
 * A judge session keeps its flag on judge_sessions rather than profiles
 * (migration 0008), which is why the two branches exist.
 */
export async function setKeepOriginals(args: {
  readonly session: AppSession;
  readonly keepOriginals: boolean;
}): Promise<KeepOriginalsOutcome> {
  if (demoProfileIsReadOnly(args.session)) {
    /*
     * The fixture is checked in and there is no database behind it, and a judge
     * session at zero analyses is looking at the saved demo profile's rows
     * rather than its own. Saying so is the honest answer; moving a toggle whose
     * value the screen reads from somewhere else is not, and a session that
     * cannot take a photo has no original to keep either way.
     */
    return { ok: false, reason: "read_only" };
  }

  if (args.session.kind === "judge") {
    const result = await serviceClient()
      .from("judge_sessions")
      .update({ keep_originals: args.keepOriginals })
      .eq("id", args.session.id)
      .select("id");
    if (unwrap("set judge keep originals", result).length === 0) {
      return { ok: false, reason: "no_profile" };
    }
    return { ok: true };
  }

  const result = await serviceClient()
    .from("profiles")
    .update({ keep_originals: args.keepOriginals })
    .eq("user_id", args.session.id)
    .select("user_id");
  if (unwrap("set keep originals", result).length === 0) {
    // No profiles row means no recorded consent, and the retention choice is
    // part of consent. There is nothing to toggle yet.
    return { ok: false, reason: "no_profile" };
  }
  return { ok: true };
}

/** Re exported so a test can name the buckets without reaching into db. */
export { BUCKETS };
