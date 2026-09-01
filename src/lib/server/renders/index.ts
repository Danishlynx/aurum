import "server-only";

import type {
  MakeupRenderParams,
  RenderStatus,
  RenderView,
} from "@/lib/shared/color-view";
import { copy } from "@/lib/shared/copy";

import {
  countRenders,
  findJobForSubject,
  getCapture,
  insertJob,
  updateJob,
} from "../db";
import { BUCKETS, createSignedRead, downloadObject, uploadObject } from "../db/storage";
import type { JobRecord, Json, Render, RenderKind } from "../db/types";
import { findReservation, perfectCorpUnits, reconcile, refund, reserve } from "../credits";
import { JUDGE_RENDERS_ALLOWED, providerCallsEnabled } from "../env";
import { messages } from "../http/messages";
import {
  claimForPolling,
  JOB_LIFETIME_MS,
  messageForFailure,
} from "../jobs";
import { getAestheticProfile } from "../profile/db";
import {
  createTask,
  downloadResultAssets,
  getTaskSnapshot,
  isPerfectCorpConfigured,
  parseRenderUrls,
  uploadImage,
} from "../providers/perfectcorp";
import type { AppSession } from "../session";
import {
  countOpenRenders,
  deleteRender,
  findRenderByHash,
  getRender,
  insertRender,
  updateRender,
} from "./db";
import { makeupTaskBody } from "./makeup";
import {
  canonicalMakeupParams,
  paramsHash,
  type StoredMakeupParams,
} from "./params";

/**
 * Try on renders: one shade set in, one image of the person's own face out, or
 * nothing.
 *
 * docs/01-user-flow.md section H is the screen. docs/03-architecture.md is the
 * machinery: renders are cached by (user_id, kind, params_hash), they are
 * sequential per person, and every provider call reserves credits first.
 * docs/07-payments-and-judge-mode.md caps a judge session at six of them.
 *
 * The rule that shapes every path in this file: a try on cannot be faked. With
 * no key, with the kill switch off, with the original photo already deleted, or
 * with a failed task, the answer is a typed refusal and the screen shows the
 * unedited selfie with "Preview unavailable for this shade."
 * (docs/01 section H, "Try on failed"). There is no stand in image anywhere in
 * this module.
 *
 * The job half follows the analysis jobs exactly and reuses their helpers: the
 * same compare and set poll claim, the same lifetime, the same failure to
 * sentence mapping. What differs is only what a render does on success, which is
 * to pull the image into the private renders bucket before the provider's URL
 * expires (docs/04-integrations.md, step 5).
 */

/** renders/<user_id>/<render_id>.<ext>, the convention in migration 0003. */
export function renderPath(
  ownerId: string,
  renderId: string,
  extension = "jpg",
): string {
  return `${ownerId}/${renderId}.${extension}`;
}

/** Units one makeup try on reserves. One per render, per docs/04. */
export function makeupRenderUnits(): number {
  return perfectCorpUnits("makeupTryOn");
}

export type CreateRenderRefusal =
  | "no_profile"
  | "no_capture_image"
  | "render_in_progress"
  | "judge_render_limit"
  | "not_configured"
  | "kill_switch"
  | "daily_cap"
  | "session_cap"
  | "nothing_to_render";

export type CreateRenderOutcome =
  | {
      readonly ok: true;
      /** True when the params hash already had a finished render stored. */
      readonly cached: boolean;
      readonly renderId: string;
      readonly jobId: string | null;
      readonly status: RenderStatus;
      readonly renderUrl: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: CreateRenderRefusal;
      /** Units or renders left, for the cap refusals. */
      readonly remaining?: number;
    };

export interface CreateRenderInput {
  readonly session: AppSession;
  readonly kind: Extract<RenderKind, "makeup">;
  readonly params: MakeupRenderParams;
  readonly onProviderCall?: (count: number) => void;
  readonly onCredits?: (units: number) => void;
}

async function signRender(render: Render): Promise<string | null> {
  if (render.storage_path === null) {
    return null;
  }
  try {
    return await createSignedRead(BUCKETS.renders, render.storage_path);
  } catch {
    return null;
  }
}

/**
 * Starts a try on, or returns the one that already exists.
 *
 * The order of the gates, and why:
 * 1. the profile and the original photo, so a request with nothing to render on
 *    costs nothing
 * 2. the params hash, so a shade the person has already seen never spends a
 *    second credit (docs/03-architecture.md, "Caching")
 * 3. the key and the kill switch, which are answered from cache above and
 *    refused here
 * 4. one open render per person, then the judge render cap
 * 5. the credit reservation, last, immediately before the provider call
 */
export async function createRender(
  input: CreateRenderInput,
): Promise<CreateRenderOutcome> {
  const ownerId = input.session.id;

  const profile = await getAestheticProfile(ownerId);
  if (profile === null || profile.capture_id === null) {
    return { ok: false, reason: "no_profile" };
  }

  const capture = await getCapture(ownerId, profile.capture_id);
  if (capture === null || capture.storage_path === null) {
    // Retention deleted the original, which is the default
    // (docs/03-architecture.md step 7). There is no face to render on.
    return { ok: false, reason: "no_capture_image" };
  }

  const stored = canonicalMakeupParams({
    captureId: capture.id,
    params: input.params,
  });
  const hash = paramsHash(input.kind, stored);

  const existing = await findRenderByHash({
    ownerId,
    kind: input.kind,
    paramsHash: hash,
  });

  if (existing !== null && existing.status === "succeeded") {
    return {
      ok: true,
      cached: true,
      renderId: existing.id,
      jobId: null,
      status: "succeeded",
      renderUrl: await signRender(existing),
    };
  }

  if (
    existing !== null &&
    (existing.status === "pending" || existing.status === "running")
  ) {
    // Idempotency, the same rule the analysis jobs follow: asking again for a
    // render that is already running returns the running one.
    const job = await findJobForSubject(ownerId, existing.id);
    return {
      ok: true,
      cached: false,
      renderId: existing.id,
      jobId: job?.id ?? null,
      status: existing.status,
      renderUrl: null,
    };
  }

  if (!isPerfectCorpConfigured()) {
    return { ok: false, reason: "not_configured" };
  }
  if (!providerCallsEnabled()) {
    return { ok: false, reason: "kill_switch" };
  }

  if ((await countOpenRenders(ownerId)) > 0) {
    return { ok: false, reason: "render_in_progress" };
  }

  if (input.session.kind === "judge") {
    const used = await countRenders(ownerId);
    if (used >= JUDGE_RENDERS_ALLOWED) {
      return {
        ok: false,
        reason: "judge_render_limit",
        remaining: 0,
      };
    }
  }

  // A failed row is reused rather than replaced: (user_id, kind, params_hash) is
  // unique, so the retry is the same row moving back to pending.
  const render =
    existing ??
    (await insertRender({
      user_id: ownerId,
      kind: input.kind,
      params: stored as unknown as Json,
      params_hash: hash,
      status: "pending",
    }));
  if (existing !== null) {
    await updateRender(render.id, {
      status: "pending",
      params: stored as unknown as Json,
      provider_task_id: null,
      credits_used: 0,
    });
  }

  const units = makeupRenderUnits();
  const reservation = await reserve({
    session: input.session,
    provider: "perfectcorp",
    units,
    subjectId: render.id,
    note: `reserve ${input.kind} render`,
  });
  if (!reservation.ok) {
    if (existing === null) {
      await deleteRender(ownerId, render.id);
    }
    return {
      ok: false,
      reason: reservation.reason === "session_cap" ? "session_cap" : "daily_cap",
      remaining: reservation.remaining,
    };
  }
  input.onCredits?.(reservation.reservation.units);

  try {
    const object = await downloadObject(BUCKETS.captures, capture.storage_path);
    const uploaded = await uploadImage({
      fileName: `${capture.id}.${object.contentType === "image/png" ? "png" : "jpg"}`,
      contentType: object.contentType === "image/png" ? "image/png" : "image/jpeg",
      bytes: object.bytes,
    });
    input.onProviderCall?.(1);

    const body = makeupTaskBody({ fileId: uploaded.fileId, params: stored });
    if (body === null) {
      await refund({ session: input.session, reservation: reservation.reservation });
      if (existing === null) {
        await deleteRender(ownerId, render.id);
      }
      return { ok: false, reason: "nothing_to_render" };
    }

    const task = await createTask({
      endpointKey: "makeupTryOn",
      body,
      itemCount: stored.categories.length,
    });
    input.onProviderCall?.(1);

    await updateRender(render.id, {
      status: "running",
      provider_task_id: task.taskId,
      credits_used: reservation.reservation.units,
    });

    const previous = await findJobForSubject(ownerId, render.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const job =
      previous === null
        ? await insertJob({
            user_id: ownerId,
            subject_type: "render",
            subject_id: render.id,
            status: "running",
            provider_task_id: task.taskId,
            attempts,
          })
        : ((await updateJob(previous.id, {
            status: "running",
            provider_task_id: task.taskId,
            attempts,
            error: null,
            last_polled_at: null,
          })) ?? previous);

    console.log(
      JSON.stringify({
        event: "aurum.render_started",
        ownerType: input.session.ownerType,
        ownerId,
        kind: input.kind,
        renderId: render.id,
        categories: stored.categories.length,
        units: reservation.reservation.units,
      }),
    );

    return {
      ok: true,
      cached: false,
      renderId: render.id,
      jobId: job.id,
      status: "running",
      renderUrl: null,
    };
  } catch (thrown) {
    // Nothing was rendered, so nothing is owed. The row goes back to failed with
    // the same sentence the analysis jobs use, and the route reports the
    // provider failure.
    await refund({ session: input.session, reservation: reservation.reservation });
    await updateRender(render.id, {
      status: "failed",
      provider_task_id: null,
      credits_used: 0,
    });
    await writeRenderJobFailure({
      ownerId,
      renderId: render.id,
      message: messageForFailure(thrown),
    });
    throw thrown;
  }
}

/** Records the failure on the job row, creating one if the task never started. */
async function writeRenderJobFailure(args: {
  readonly ownerId: string;
  readonly renderId: string;
  readonly message: string;
}): Promise<void> {
  const existing = await findJobForSubject(args.ownerId, args.renderId);
  if (existing === null) {
    await insertJob({
      user_id: args.ownerId,
      subject_type: "render",
      subject_id: args.renderId,
      status: "failed",
      attempts: 1,
      error: args.message,
    });
    return;
  }
  await updateJob(existing.id, {
    status: "failed",
    error: args.message,
    attempts: existing.attempts + 1,
  });
}

// ---------------------------------------------------------------------------
// Read and poll
// ---------------------------------------------------------------------------

function viewOf(
  render: Render,
  renderUrl: string | null,
  job: JobRecord | null,
): RenderView {
  return {
    renderId: render.id,
    status: render.status,
    renderUrl,
    error: render.status === "failed" ? (job?.error ?? messages.providerRefused) : null,
  };
}

export interface PollRenderInput {
  readonly session: AppSession;
  readonly renderId: string;
  readonly onProviderCall?: (count: number) => void;
}

/**
 * One pass over one render.
 *
 * Returns null when the id is not this person's, which the route answers with a
 * 404. Nothing here waits on the provider for more than one HTTP call, so the
 * client's poll returns in time and Vercel function timeouts stay irrelevant.
 */
export async function pollRender(
  input: PollRenderInput,
): Promise<RenderView | null> {
  const ownerId = input.session.id;
  const render = await getRender(ownerId, input.renderId);
  if (render === null) {
    return null;
  }

  if (render.status === "succeeded") {
    return viewOf(render, await signRender(render), null);
  }

  const job = await findJobForSubject(ownerId, render.id);
  if (render.status === "failed") {
    return viewOf(render, null, job);
  }
  if (job === null || job.provider_task_id === null) {
    return viewOf(render, null, job);
  }

  if (Date.now() - Date.parse(job.created_at) > JOB_LIFETIME_MS) {
    await failRender({
      session: input.session,
      render,
      job,
      message: copy.errors.providerTimeout,
    });
    return {
      renderId: render.id,
      status: "failed",
      renderUrl: null,
      error: copy.errors.providerTimeout,
    };
  }

  // The kill switch stops the provider call, not the answer: a render already
  // stored still serves, and a running one stays running.
  if (!providerCallsEnabled() || !isPerfectCorpConfigured()) {
    return viewOf(render, null, job);
  }

  if (!(await claimForPolling(job))) {
    return viewOf(render, null, job);
  }

  try {
    const snapshot = await getTaskSnapshot({
      endpointKey: "makeupTryOn",
      taskId: job.provider_task_id,
    });
    input.onProviderCall?.(1);

    if (snapshot.state === "succeeded") {
      const finished = await succeedRender({
        session: input.session,
        render,
        job,
        urls: parseRenderUrls(snapshot),
      });
      return finished;
    }

    if (snapshot.state === "failed") {
      await failRender({
        session: input.session,
        render,
        job,
        message: messages.providerRefused,
      });
      return {
        renderId: render.id,
        status: "failed",
        renderUrl: null,
        error: messages.providerRefused,
      };
    }

    return viewOf(render, null, job);
  } catch (thrown) {
    const message = messageForFailure(thrown);
    await failRender({ session: input.session, render, job, message });
    return {
      renderId: render.id,
      status: "failed",
      renderUrl: null,
      error: message,
    };
  }
}

/**
 * Pulls the finished image into the private renders bucket.
 *
 * docs/04-integrations.md, step 5: "Download mask and render outputs promptly
 * (result URLs may expire) and store them in our private buckets." A download
 * that fails is a failed render, not a render pointing at a URL that will stop
 * working.
 */
async function succeedRender(args: {
  readonly session: AppSession;
  readonly render: Render;
  readonly job: JobRecord;
  readonly urls: readonly string[];
}): Promise<RenderView> {
  const url = args.urls[0];
  if (url === undefined) {
    await failRender({
      session: args.session,
      render: args.render,
      job: args.job,
      message: messages.providerRefused,
    });
    return {
      renderId: args.render.id,
      status: "failed",
      renderUrl: null,
      error: messages.providerRefused,
    };
  }

  let storagePath: string;
  try {
    const [asset] = await downloadResultAssets([url]);
    const extension = asset.contentType.includes("png") ? "png" : "jpg";
    storagePath = await uploadObject({
      bucket: BUCKETS.renders,
      storagePath: renderPath(args.session.id, args.render.id, extension),
      bytes: asset.bytes,
      contentType: asset.contentType,
    });
  } catch (thrown) {
    const message = messageForFailure(thrown);
    await failRender({
      session: args.session,
      render: args.render,
      job: args.job,
      message,
    });
    return {
      renderId: args.render.id,
      status: "failed",
      renderUrl: null,
      error: message,
    };
  }

  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.render.id,
    provider: "perfectcorp",
  });
  const units = reservation?.units ?? args.render.credits_used;
  if (reservation !== null) {
    await reconcile({
      session: args.session,
      reservation,
      actualUnits: reservation.units,
    });
  }

  const updated =
    (await updateRender(args.render.id, {
      status: "succeeded",
      storage_path: storagePath,
      credits_used: units,
    })) ?? args.render;
  await updateJob(args.job.id, { status: "succeeded", error: null });

  console.log(
    JSON.stringify({
      event: "aurum.render_succeeded",
      ownerType: args.session.ownerType,
      ownerId: args.session.id,
      kind: args.render.kind,
      renderId: args.render.id,
      units,
    }),
  );

  return {
    renderId: args.render.id,
    status: "succeeded",
    renderUrl: await signRender({ ...updated, storage_path: storagePath }),
    error: null,
  };
}

/**
 * A failed render costs nothing: "If the engine fails to process the task, the
 * task's status will change to 'error' and no unit will be consumed"
 * (docs/04-integrations.md), so the reservation goes back.
 */
async function failRender(args: {
  readonly session: AppSession;
  readonly render: Render;
  readonly job: JobRecord;
  readonly message: string;
}): Promise<void> {
  const reservation = await findReservation({
    owner: { ownerType: args.session.ownerType, ownerId: args.session.id },
    subjectId: args.render.id,
    provider: "perfectcorp",
  });
  if (reservation !== null) {
    await refund({ session: args.session, reservation });
  }
  await updateRender(args.render.id, { status: "failed", credits_used: 0 });
  await updateJob(args.job.id, {
    status: "failed",
    error: args.message,
    attempts: args.job.attempts,
  });
}

export type { StoredMakeupParams };
